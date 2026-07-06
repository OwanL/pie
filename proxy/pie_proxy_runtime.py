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
    """Install a Starlette ``BaseHTTPMiddleware`` that wraps streaming
    chat-completion responses so a stalled upstream (no chunk within the idle
    window) is terminated with an explicit SSE error event + close.

    This is the transport-layer liveness check (Slice C): the SDK then sees a
    terminal error on the stream instead of hanging on the next chunk forever.
    Non-SSE (JSON) responses are left untouched here — a stalled non-streaming
    request is caught by the SDK's own request timeout / the settlement net in
    ``execute.ts``; the proxy only owns the streaming path.

    Idempotent: a second call is a no-op.
    """
    global _STREAM_LIVENESS_PATCHED
    if _STREAM_LIVENESS_PATCHED:
        return
    _STREAM_LIVENESS_PATCHED = True

    from starlette.middleware.base import BaseHTTPMiddleware
    from starlette.requests import Request as StarletteRequest
    from starlette.responses import StreamingResponse

    class StreamLivenessMiddleware(BaseHTTPMiddleware):
        async def dispatch(self, request: StarletteRequest, call_next):  # type: ignore[override]
            response = await call_next(request)
            # Only SSE chat-completion streams need wrapping. The body_iterator
            # is the async generator backing a Starlette StreamingResponse; we
            # replace it with the liveness-wrapped version so each chunk fetch is
            # bounded by the idle timeout. Non-streaming / non-SSE responses
            # pass through unchanged (their bodies are already buffered and
            # bound by the request timeout).
            media_type = getattr(response, "media_type", None)
            body_iterator = getattr(response, "body_iterator", None)
            if (
                media_type == "text/event-stream"
                and body_iterator is not None
                and hasattr(body_iterator, "__anext__")
            ):
                idle = resolve_stream_idle_timeout_s()
                # Extract a model hint for logs from the request path/body if
                # cheaply available (best-effort; falls back to "unknown").
                model = "unknown"
                try:
                    path = getattr(request, "url", None)
                    if path is not None:
                        path_str = str(path)
                        # /v1/chat/completions or /chat/completions — no model in
                        # path; leave as "unknown". A body parse would be too
                        # invasive here (consumes the stream).
                        if "chat/completions" not in path_str and "completions" not in path_str:
                            # Not a chat-completion stream — leave it unwrapped.
                            return response
                except Exception:
                    pass
                if idle > 0:
                    wrapped = wrap_stream_with_liveness(
                        body_iterator, idle, model=model
                    )
                    response.body_iterator = wrapped  # type: ignore[attr-defined]
            return response

    app.add_middleware(StreamLivenessMiddleware)
