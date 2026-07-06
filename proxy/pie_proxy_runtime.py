from __future__ import annotations

import asyncio
import json
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, AsyncIterator

from fastapi import Request
from fastapi.responses import JSONResponse


@dataclass
class ProviderMetric:
    provider: str
    model_info_id: str
    max_concurrent_requests: int
    semaphore: "TrackedSemaphore"


class TrackedSemaphore(asyncio.Semaphore):
    """Semaphore with exact active + queued counters.

    LiteLLM gates `max_parallel_requests` with an `asyncio.Semaphore`. The
    proxy indicator needs exact counts, so we wrap that semaphore and track:

    - active requests: acquired slots currently held
    - queued requests: coroutines currently blocked waiting for a slot
    """

    def __init__(self, value: int):
        super().__init__(value)
        self.initial_value = value
        self.waiting = 0

    async def acquire(self) -> bool:
        if self._value <= 0:
            self.waiting += 1
            try:
                return await super().acquire()
            finally:
                self.waiting -= 1
        return await super().acquire()

    @property
    def active(self) -> int:
        return max(0, self.initial_value - self._value)


_PROVIDER_METRICS: dict[str, ProviderMetric] = {}
_PROVIDER_CONFIG_CACHE: dict[str, tuple[str, int]] | None = None
_PATCHED = False


def _agent_dir() -> Path:
    return Path(__file__).resolve().parent.parent


def _load_provider_config() -> dict[str, tuple[str, int]]:
    global _PROVIDER_CONFIG_CACHE
    if _PROVIDER_CONFIG_CACHE is not None:
        return _PROVIDER_CONFIG_CACHE

    settings_path = _agent_dir() / "settings.json"
    provider_map: dict[str, tuple[str, int]] = {}
    try:
        raw = json.loads(settings_path.read_text(encoding="utf-8"))
        providers = ((raw or {}).get("proxy") or {}).get("providers") or {}
        if isinstance(providers, dict):
            for provider, value in providers.items():
                if not isinstance(value, dict):
                    continue
                model_info_id = value.get("litellmModelInfoId")
                max_concurrent = value.get("maxConcurrentRequests")
                if isinstance(model_info_id, str) and model_info_id:
                    provider_map[model_info_id] = (
                        provider,
                        int(max_concurrent) if isinstance(max_concurrent, (int, float)) and max_concurrent >= 1 else 1,
                    )
    except Exception:
        provider_map = {}

    _PROVIDER_CONFIG_CACHE = provider_map
    return provider_map


def _provider_for_model(model: dict[str, Any]) -> tuple[str, int, str]:
    model_info = model.get("model_info") or {}
    model_info_id = str(model_info.get("id") or "")
    provider_map = _load_provider_config()
    configured = provider_map.get(model_info_id)
    if configured is not None:
        provider, max_concurrent = configured
        return provider, max_concurrent, model_info_id

    litellm_params = model.get("litellm_params") or {}
    fallback_max = litellm_params.get("max_parallel_requests")
    model_name = str(model.get("model_name") or model_info_id or "unknown")
    provider = model_name.split("-")[0] if "-" in model_name else model_name
    max_concurrent = int(fallback_max) if isinstance(fallback_max, (int, float)) and fallback_max >= 1 else 1
    return provider, max_concurrent, model_info_id or model_name


def install_proxy_metrics_patch() -> None:
    global _PATCHED
    if _PATCHED:
        return
    _PATCHED = True

    from litellm.router_utils.client_initalization_utils import InitalizeCachedClient
    from litellm.utils import calculate_max_parallel_requests

    def set_max_parallel_requests_client(litellm_router_instance: Any, model: dict[str, Any]) -> None:
        litellm_params = model.get("litellm_params", {})
        model_id = model["model_info"]["id"]
        rpm = litellm_params.get("rpm", None)
        tpm = litellm_params.get("tpm", None)
        max_parallel_requests = litellm_params.get("max_parallel_requests", None)
        calculated = calculate_max_parallel_requests(
            rpm=rpm,
            max_parallel_requests=max_parallel_requests,
            tpm=tpm,
            default_max_parallel_requests=litellm_router_instance.default_max_parallel_requests,
        )
        if calculated:
            semaphore = TrackedSemaphore(calculated)
            cache_key = f"{model_id}_max_parallel_requests_client"
            litellm_router_instance.cache.set_cache(
                key=cache_key,
                value=semaphore,
                local_only=True,
            )
            provider, max_concurrent, model_info_id = _provider_for_model(model)
            _PROVIDER_METRICS[provider] = ProviderMetric(
                provider=provider,
                model_info_id=model_info_id,
                max_concurrent_requests=max_concurrent,
                semaphore=semaphore,
            )

    InitalizeCachedClient.set_max_parallel_requests_client = staticmethod(set_max_parallel_requests_client)


def _authorized(request: Request) -> bool:
    expected = (os.environ.get("PIE_PROXY_MASTER_KEY") or "").strip()
    if not expected:
        return False
    auth = (request.headers.get("authorization") or "").strip()
    return auth == expected or auth == f"Bearer {expected}"


def register_proxy_metrics_route(app: Any) -> None:
    @app.get("/health/proxy_metrics", include_in_schema=False)
    async def pie_proxy_metrics(request: Request) -> JSONResponse:
        if not _authorized(request):
            return JSONResponse({"error": "unauthorized"}, status_code=401)

        providers = []
        for metric in sorted(_PROVIDER_METRICS.values(), key=lambda item: item.provider):
            providers.append(
                {
                    "provider": metric.provider,
                    "modelInfoId": metric.model_info_id,
                    "activeRequests": metric.semaphore.active,
                    "queuedRequests": metric.semaphore.waiting,
                    "maxConcurrentRequests": metric.max_concurrent_requests,
                }
            )

        return JSONResponse(
            {
                "generatedAt": datetime.now(timezone.utc).isoformat(),
                "providers": providers,
            }
        )


# =============================================================================
# Stream liveness: surface a dead upstream stream as a terminal SSE error
# =============================================================================
#
# Hang class 2 (mid-stream dead provider): a provider emits a `thinking` block
# then the upstream stream stalls — no chunk, no `message_end`, no error. The
# pie litellm proxy forwards the streaming `body_iterator` as-is, so the SDK's
# `session.prompt()` awaits the next chunk forever and the parent session
# dangles. This is the transport's job, not a runner timer: a liveness check at
# the transport layer terminates the SSE stream with an explicit error event so
# the SDK sees termination instead of a hang. (Slice C of the hardening plan; the
# settlement net in execute.ts is the last-resort backstop if this ever misses.)


def _proxy_log(message: str) -> None:
    """Loud, flush-based log so it reaches the proxy console immediately."""
    print(f"[pie:proxy] {message}", flush=True)


# Environment key for the per-chunk idle timeout (seconds). 0 disables.
STREAM_IDLE_TIMEOUT_ENV = "PIE_PROXY_STREAM_IDLE_TIMEOUT_S"
# Default idle timeout (seconds): the gap that, if exceeded mid-stream, is
# treated as a dead upstream. Generous enough for thinking/prefill pauses on
# slow providers, short enough that a truly dead stream surfaces in ~2 min.
DEFAULT_STREAM_IDLE_TIMEOUT_S = 120


def resolve_stream_idle_timeout_s() -> float:
    """Resolve the streaming idle-timeout window in seconds.

    Reads ``PIE_PROXY_STREAM_IDLE_TIMEOUT_S``: unset/empty → default; ``0``
    → disabled (no liveness check); positive → the window. Invalid (NaN /
    negative) → default.
    """
    raw = os.environ.get(STREAM_IDLE_TIMEOUT_ENV, "")
    if raw == "":
        return float(DEFAULT_STREAM_IDLE_TIMEOUT_S)
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return float(DEFAULT_STREAM_IDLE_TIMEOUT_S)
    if value < 0:
        return float(DEFAULT_STREAM_IDLE_TIMEOUT_S)
    return value


# Environment key for the header-phase timeout (seconds). 0 disables.
HEADER_TIMEOUT_ENV = "PIE_PROXY_HEADER_TIMEOUT_S"
# Default header-phase timeout (seconds): the max wait for the upstream to
# START responding (headers). Generous for slow prefill, but bounded so a
# stalled upstream before headers can't wedge the uvicorn event loop (which
# would also block /health/liveness and make the proxy look dead).
DEFAULT_HEADER_TIMEOUT_S = 120


def resolve_header_timeout_s() -> float:
    """Resolve the header-phase timeout window in seconds.

    Reads ``PIE_PROXY_HEADER_TIMEOUT_S``: unset/empty → default; ``0`` →
    disabled (no header-phase bound); positive → the window. Invalid (NaN /
    negative) → default.
    """
    raw = os.environ.get(HEADER_TIMEOUT_ENV, "")
    if raw == "":
        return float(DEFAULT_HEADER_TIMEOUT_S)
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return float(DEFAULT_HEADER_TIMEOUT_S)
    if value < 0:
        return float(DEFAULT_HEADER_TIMEOUT_S)
    return value


def _terminal_sse_error(idle_seconds: float) -> bytes:
    """Build the terminal SSE error event + ``[DONE]`` sentinel to emit when a
    stream stalls. Emits an OpenAI-style ``error`` payload so clients/SDKs that
    parse SSE ``data:`` lines see a structured terminal error rather than a
    silent close, then a ``[DONE]`` so stream consumers stop waiting."""
    payload = {
        "error": {
            "message": f"upstream stream stalled: no chunk for {idle_seconds:.0f}s",
            "type": "upstream_stream_stalled",
        }
    }
    return f"data: {json.dumps(payload)}\n\ndata: [DONE]\n\n".encode("utf-8")


async def wrap_stream_with_liveness(
    body_iterator: Any,
    idle_timeout_s: float,
    *,
    model: str = "unknown",
) -> AsyncIterator[bytes]:
    """Wrap an SSE ``body_iterator`` so a stalled upstream surfaces as a
    terminal error instead of hanging forever.

    For each chunk ``await asyncio.wait_for(chunk, timeout=idle_timeout_s)`` is
    bounded: on :class:`asyncio.TimeoutError` the wrapper yields a terminal SSE
    error event + ``[DONE]`` and stops, so the SDK sees stream termination
    (not a hang). On a natural end (``StopAsyncIteration``) it just stops. A
    ``0`` (or non-positive) ``idle_timeout_s`` disables the check and forwards
    chunks unchanged.

    The wrapper is a pure async generator over the input iterator — no Starlette
    / litellm dependency — so it is unit-testable in isolation
    (``test/test_stream_liveness.py``) and reused by the middleware.
    """
    if idle_timeout_s <= 0:
        async for chunk in body_iterator:
            yield chunk
        return

    stalled = False
    while True:
        try:
            chunk = await asyncio.wait_for(body_iterator.__anext__(), timeout=idle_timeout_s)
        except StopAsyncIteration:
            return
        except asyncio.TimeoutError:
            stalled = True
            _proxy_log(
                f"stream stalled: no chunk for {idle_timeout_s:.0f}s "
                f"(model={model}); surfacing terminal SSE error"
            )
            yield _terminal_sse_error(idle_timeout_s)
            return
        except Exception as exc:  # upstream raised — pass through then stop
            _proxy_log(f"stream body_iterator raised: {exc!r} (model={model})")
            raise
        yield chunk
    # (unreachable; kept to satisfy type checkers that async generators fall
    # through — the loop returns above.)
    _ = stalled


_STREAM_LIVENESS_PATCHED = False


def install_stream_liveness_middleware(app: Any) -> None:
    """Install a raw ASGI middleware that bounds the header phase so a stalled
    upstream can't hang a uvicorn worker (the reused-proxy hang root cause).

    Why raw ASGI, not Starlette BaseHTTPMiddleware:
    BaseHTTPMiddleware backs `call_next` with a size-0 anyio memory stream
    (rendezvous) and runs the downstream as a child task of the dispatch task
    group. If the downstream (litellm router → httpx) stalls before sending
    http.response.start, `recv_stream.receive()` parks, `dispatch` can't
    return, and the task group's `__aexit__` blocks waiting for the child
    (which is parked in httpx for the full router timeout). The middleware
    task holds an event-loop slot + an httpx connection + a semaphore slot
    for up to 600s per stalled request; enough of these saturates the single
    worker and /health/liveness stops responding. `asyncio.wait_for` on
    `call_next` cancels the host task which *usually* propagates to the child
    via the task-group cancel scope, but if the stall is inside a litellm
    `asyncio.shield` (retry/callback path) the cancel bounces and the task
    still pins.

    The raw ASGI middleware owns the downstream task directly: on header
    timeout it sends a 504 to the client, then cancels + shielded-reaps the
    downstream task so the slot is released regardless of litellm shielding.
    The body phase is bounded by wrap_stream_with_liveness (unchanged — it
    wraps the streaming body_iterator which Starlette exposes once headers
    are sent, and at that point the rendezvous is satisfied so the body
    wrapper is cancellation-clean).

    Idempotent: a second call is a no-op.
    """
    global _STREAM_LIVENESS_PATCHED
    if _STREAM_LIVENESS_PATCHED:
        return
    _STREAM_LIVENESS_PATCHED = True

    # Header phase: raw ASGI middleware (durable — owns the downstream task,
    # can preempt the client with a 504 even when litellm shields the stalled
    # call, which would defeat BaseHTTPMiddleware's task-group cancel).
    app.add_middleware(StreamLivenessASGIMiddleware)

    # Body phase: BaseHTTPMiddleware is safe here because by the time
    # dispatch returns the rendezvous is already satisfied (http.response.start
    # was sent), so the task group exits cleanly. The wrapper replaces the
    # StreamingResponse body_iterator with a liveness-bounded one so a stalled
    # mid-stream chunk surfaces as a terminal SSE error instead of hanging.
    _install_body_liveness_middleware(app)


def _install_body_liveness_middleware(app: Any) -> None:
    """Install a BaseHTTPMiddleware that wraps SSE body iterators with a
    liveness bound. Safe (unlike the header phase) because by the time
    ``dispatch`` returns the http.response.start rendezvous is satisfied, so
    the task group exits cleanly — there's no stall-before-headers window.
    """
    from starlette.middleware.base import BaseHTTPMiddleware
    from starlette.requests import Request as StarletteRequest

    class BodyLivenessMiddleware(BaseHTTPMiddleware):
        async def dispatch(self, request: StarletteRequest, call_next):  # type: ignore[override]
            response = await call_next(request)
            media_type = getattr(response, "media_type", None)
            body_iterator = getattr(response, "body_iterator", None)
            if (
                media_type == "text/event-stream"
                and body_iterator is not None
                and hasattr(body_iterator, "__anext__")
            ):
                idle = resolve_stream_idle_timeout_s()
                path = str(getattr(request, "url", ""))
                if "chat/completions" not in path and "completions" not in path:
                    return response
                if idle > 0:
                    response.body_iterator = wrap_stream_with_liveness(  # type: ignore[attr-defined]
                        body_iterator, idle, model="unknown"
                    )
            return response

    app.add_middleware(BodyLivenessMiddleware)


class StreamLivenessASGIMiddleware:
    """Raw ASGI middleware: bounds the upstream header phase.

    Spawns the downstream (litellm router) as a task we own, and interposes
    on `send` to detect http.response.start. If the downstream never starts
    within the header timeout, we send a 504 directly to the client, then
    cancel + shielded-reap the downstream so it doesn't leak a worker slot
    + httpx connection + semaphore permit — even if litellm shielded the
    stalled call (which would defeat BaseHTTPMiddleware's task-group cancel).
    """

    def __init__(self, app: Any):
        self.app = app

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return

        header_timeout = resolve_header_timeout_s()
        if header_timeout <= 0:
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "")
        started = False
        header_fail = False

        async def downstream_send(message: dict) -> None:
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        downstream_task = asyncio.ensure_future(
            self.app(scope, receive, downstream_send)
        )

        try:
            await asyncio.wait_for(asyncio.shield(downstream_task), timeout=header_timeout)
            return  # downstream completed cleanly (started + finished)
        except asyncio.TimeoutError:
            header_fail = True
            if started:
                # Downstream started the response but didn't finish within the
                # header window — let the body phase (wrap_stream_with_liveness)
                # handle it; don't send a conflicting response.start.
                _proxy_log(
                    f"header phase timeout but response already started "
                    f"(path={path}); deferring to body-phase liveness"
                )
                return
            _proxy_log(
                f"header phase stalled: no response start within "
                f"{header_timeout:.0f}s (path={path}); surfacing 504"
            )
            await send(
                {
                    "type": "http.response.start",
                    "status": 504,
                    "headers": [(b"content-type", b"application/json")],
                }
            )
            await send(
                {
                    "type": "http.response.body",
                    "body": json.dumps(
                        {
                            "error": {
                                "message": f"upstream header phase stalled: no response start within {header_timeout:.0f}s",
                                "type": "upstream_header_stalled",
                            }
                        }
                    ).encode("utf-8"),
                }
            )
        except Exception:
            if not started:
                raise
            return
        finally:
            if header_fail and not downstream_task.done():
                downstream_task.cancel()
                # Shielded reap so we don't await a shielded downstream forever
                # — give it a short grace to unwind, then drop it.
                try:
                    await asyncio.wait_for(asyncio.shield(downstream_task), timeout=5)
                except (asyncio.TimeoutError, asyncio.CancelledError):
                    _proxy_log(
                        f"downstream did not cancel within 5s grace "
                        f"(path={path}); leaked task will be reaped by router timeout"
                    )
                except Exception:
                    pass
