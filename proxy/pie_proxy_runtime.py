from __future__ import annotations

import asyncio
import json
import os
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
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
    # Per-provider sticky-slot pool armed when afterburn is enabled for this
    # provider (``afterburn_s > 0``); ``None`` when disabled. When present the
    # metrics endpoint reports active/queued from the pool (the pool is the
    # real concurrency gate; LiteLLM's semaphore stays as a harmless hard-cap
    # backstop that never blocks because the pool already gated to N).
    afterburn_pool: "AfterburnPool | None" = None


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
            wait_s = resolve_queue_wait_s()
            self.waiting += 1
            try:
                if wait_s <= 0:
                    # Disabled bound - unbounded queue (pre-bound behaviour).
                    return await super().acquire()
                try:
                    return await asyncio.wait_for(super().acquire(), timeout=wait_s)
                except asyncio.TimeoutError:
                    # Queue bound exceeded - surface a retryable 503 +
                    # Retry-After so the client backs off cleanly instead of
                    # the opaque 120s-then-504 from the header-phase middleware.
                    # The inner super().acquire() was cancelled by wait_for;
                    # CPython's asyncio.Semaphore is cancellation-safe (the
                    # waiter is removed from the FIFO and no permit is held), so
                    # no slot leaks here.
                    _proxy_log(
                        f"queue wait bound exceeded: no slot within {wait_s:g}s "
                        f"(active={self.active}, queued={self.waiting - 1}, "
                        f"max={self.initial_value}); surfacing 503 + Retry-After"
                    )
                    raise _queue_timeout_error(wait_s) from None
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
                        _resolve_provider_afterburn_s(value),
                    )
    except Exception:
        provider_map = {}

    _PROVIDER_CONFIG_CACHE = provider_map
    return provider_map


def _provider_for_model(model: dict[str, Any]) -> tuple[str, int, str, float]:
    model_info = model.get("model_info") or {}
    model_info_id = str(model_info.get("id") or "")
    provider_map = _load_provider_config()
    configured = provider_map.get(model_info_id)
    if configured is not None:
        provider, max_concurrent, afterburn_s = configured
        return provider, max_concurrent, model_info_id, afterburn_s

    litellm_params = model.get("litellm_params") or {}
    fallback_max = litellm_params.get("max_parallel_requests")
    model_name = str(model.get("model_name") or model_info_id or "unknown")
    provider = model_name.split("-")[0] if "-" in model_name else model_name
    max_concurrent = int(fallback_max) if isinstance(fallback_max, (int, float)) and fallback_max >= 1 else 1
    return provider, max_concurrent, model_info_id or model_name, resolve_afterburn_default_s()


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
            provider, max_concurrent, model_info_id, afterburn_s = _provider_for_model(model)
            afterburn_pool = None
            if afterburn_s > 0:
                # Link the pool created eagerly at startup (_init_afterburn_pools)
                # so the metrics endpoint reports the SAME instance the middleware
                # gates on. Fall back to creating one if startup somehow didn't.
                afterburn_pool = _AFTERBURN_POOLS.get(provider)
                if afterburn_pool is None:
                    afterburn_pool = AfterburnPool(max_concurrent, afterburn_s)
                    _AFTERBURN_POOLS[provider] = afterburn_pool
            _PROVIDER_METRICS[provider] = ProviderMetric(
                provider=provider,
                model_info_id=model_info_id,
                max_concurrent_requests=max_concurrent,
                semaphore=semaphore,
                afterburn_pool=afterburn_pool,
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
            pool = metric.afterburn_pool
            if pool is not None:
                active_requests = pool.active
                queued_requests = pool.waiting
            else:
                active_requests = metric.semaphore.active
                queued_requests = metric.semaphore.waiting
            providers.append(
                {
                    "provider": metric.provider,
                    "modelInfoId": metric.model_info_id,
                    "activeRequests": active_requests,
                    "queuedRequests": queued_requests,
                    "maxConcurrentRequests": metric.max_concurrent_requests,
                    "afterburnSeconds": (pool.afterburn_s if pool is not None else 0.0),
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


# -----------------------------------------------------------------------------
# Queue-wait bound: surface a saturated concurrency pool as a retryable 503
# -----------------------------------------------------------------------------
#
# LiteLLM gates each provider's `max_parallel_requests` with an
# `asyncio.Semaphore` (wrapped as :class:`TrackedSemaphore` so the metrics
# endpoint can report active + queued). When the pool is full, a new request
# QUEUES on `semaphore.acquire()` with no built-in bound — it parks until a
# slot frees, up to the router timeout (600s). The header-phase ASGI
# middleware (below) turns a stalled downstream into a 504 at 120s, but that
# conflates *queued* with *stalled*: a legitimately-queued 4th request waiting
# for one of 3 slots gets the same 504 as a dead upstream, after a 120s wait,
# with no `Retry-After`. The client (pi-ai) retries the 504 (it matches the
# retry classifier) but each retry re-queues onto an already-saturated pool,
# so a burst becomes 6 × (120s wait + backoff) of thrash before giving up.
#
# This bounds the QUEUE wait at the semaphore: if a slot isn't acquired within
# `PIE_PROXY_QUEUE_WAIT_S` (default 20s), `acquire()` raises a
# `ProxyException(503, Retry-After)` so FastAPI's exception handler returns a
# prompt, clearly-retryable 503 + `Retry-After` instead of the opaque 120s-
# then-504. The router still applies its own `num_retries` (2) on top, so the
# proxy-level ceiling is ~`(1 + num_retries) * queue_wait` (≈60s) before the
# 503 reaches the client — bounded, loud, and retry-friendly. `0` disables the
# bound (restores the unbounded queue behaviour).

QUEUE_WAIT_ENV = "PIE_PROXY_QUEUE_WAIT_S"
DEFAULT_QUEUE_WAIT_S = 20.0


def resolve_queue_wait_s() -> float:
    """Resolve the per-acquire queue-wait bound in seconds.

    Reads ``PIE_PROXY_QUEUE_WAIT_S``: unset/empty -> default; ``0`` ->
    disabled (unbounded queue, the pre-bound behaviour); positive -> the bound.
    Invalid (NaN / negative) -> default.
    """
    raw = os.environ.get(QUEUE_WAIT_ENV, "")
    if raw == "":
        return float(DEFAULT_QUEUE_WAIT_S)
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return float(DEFAULT_QUEUE_WAIT_S)
    if value < 0:
        return float(DEFAULT_QUEUE_WAIT_S)
    return value


def _queue_timeout_error(wait_s: float) -> Exception:
    """Build the exception raised when a semaphore acquire exceeds the queue
    bound. A :class:`ProxyException` with ``code=503`` + ``Retry-After`` so the
    proxy's FastAPI exception handler returns a clearly-retryable 503 (which
    pi-ai's retry classifier matches via ``503``) with a backoff hint, instead
    of the opaque 120s-then-504 from the header-phase middleware. Imported
    lazily so a unit test that never trips the bound doesn't pull in the full
    litellm proxy package."""
    from litellm.proxy._types import ProxyException  # noqa: WPS433

    retry_after = max(1, int(wait_s))
    return ProxyException(
        message=(
            f"proxy concurrency pool saturated: no slot acquired within "
            f"{wait_s:g}s (queue wait bound). Retry shortly."
        ),
        type="proxy_concurrency_saturated",
        param=None,
        code=503,
        headers={"Retry-After": str(retry_after)},
    )


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
            _proxy_log(
                f"stream ended naturally: upstream closed SSE body without "
                f"terminal error (model={model})"
            )
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


# =============================================================================
# Account-pause circuit breaker
# =============================================================================
#
# Root cause of the recurring "proxy keeps failing / Connection error." under
# nested-subagent fan-out: the umans UPSTREAM suspends the account
# (`account_suspended`, `reason: cap_abuse`) for "repeatedly exceeding rate
# limits", returning a 403 that LiteLLM wraps as a 429. The proxy itself stays
# healthy — it is faithfully forwarding umans' account suspension. The problem
# is that pie keeps sending requests (main session + subagents + skill-pruner
# prepasses + LiteLLM's own 429 retries) against an already-suspended account,
# which deepens/lengthens the pause (the continued traffic is itself what umans
# counts as cap_abuse) and surfaces to the user as an opaque 429/Connection
# storm that looks like "the proxy crashed".
#
# This middleware is the transport-level fix: when the upstream says the account
# is paused, it parses the reactivation time and SHORT-CIRCUITS subsequent
# chat/completions requests with a 429 + Retry-After WITHOUT calling the
# upstream — so the retry storm stops and the account can reactivate cleanly.
# It also stops LiteLLM retrying the 429 (see router_settings.retry_policy in
# litellm_config.yaml: RateLimitErrorRetries: 0).
#
# The breaker is per-process state (a single uvicorn worker, which is the pie
# default). It is best-effort: if the reactivation time can't be parsed it falls
# back to a bounded cooldown and re-probes the upstream on the next request
# after it expires.


# Module-level pause state. Writes are guarded by an asyncio.Lock so concurrent
# responses racing to set the pause don't corrupt it; reads of a float are
# atomic in CPython so the request-side check needs no lock.
_ACCOUNT_PAUSE_LOCK: asyncio.Lock | None = None
_ACCOUNT_PAUSED_UNTIL: float = 0.0  # unix seconds; 0.0 = not paused
_ACCOUNT_PAUSE_MESSAGE: str = ""
# Fallback cooldown when the reactivation time can't be parsed from the body —
# bounded so we re-probe the upstream rather than wedging forever.
DEFAULT_PAUSE_COOLDOWN_S = 60.0

_PAUSE_REACTIVATION_RE = re.compile(
    r"reactivates automatically at\s+"
    r"(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?)\s*UTC",
    re.IGNORECASE,
)

# Body signatures that identify an account-suspension response. The upstream
# sends `account_suspended` / `cap_abuse`; LiteLLM wraps it as RateLimitError.
_PAUSE_BODY_SIGNATURES = (b"account_suspended", b"access is paused", b"cap_abuse")


def _account_pause_lock() -> asyncio.Lock:
    global _ACCOUNT_PAUSE_LOCK
    if _ACCOUNT_PAUSE_LOCK is None:
        _ACCOUNT_PAUSE_LOCK = asyncio.Lock()
    return _ACCOUNT_PAUSE_LOCK


def _extract_pause_until(body: bytes) -> tuple[float, str] | None:
    """Parse the upstream reactivation time from a suspended-account response
    body. Returns ``(unix_seconds, message_snippet)`` or ``None`` if this is not
    a suspension response / the time can't be parsed."""
    if not any(sig in body for sig in _PAUSE_BODY_SIGNATURES):
        return None
    m = _PAUSE_REACTIVATION_RE.search(body.decode("utf-8", errors="ignore"))
    if not m:
        return None
    stamp = m.group(1).replace(" ", "T")
    # Normalise missing seconds for fromisoformat.
    if len(stamp) == 16:  # "YYYY-MM-DDTHH:MM"
        stamp += ":00"
    try:
        dt = datetime.fromisoformat(stamp).replace(tzinfo=timezone.utc)
    except ValueError:
        return None
    snippet = body.decode("utf-8", errors="ignore")
    # Trim to the message field if present, else a bounded slice.
    msg_match = re.search(r"['\"]message['\"]\s*:\s*['\"](.+?)['\"]", snippet)
    message = msg_match.group(1) if msg_match else snippet[:200]
    return dt.timestamp(), message


async def _set_account_pause(until_unix: float, message: str) -> None:
    lock = _account_pause_lock()
    async with lock:
        global _ACCOUNT_PAUSED_UNTIL, _ACCOUNT_PAUSE_MESSAGE
        # Keep the LATEST reactivation time (umans can extend the pause on
        # continued traffic). If a new pause extends beyond the current one,
        # update; if it's earlier, keep the longer pause.
        if until_unix > _ACCOUNT_PAUSED_UNTIL:
            _ACCOUNT_PAUSED_UNTIL = until_unix
            _ACCOUNT_PAUSE_MESSAGE = message
            _proxy_log(
                f"account paused by upstream until {datetime.fromtimestamp(until_unix, tz=timezone.utc).isoformat()}: "
                f"{message[:160]} — short-circuiting subsequent proxied requests"
            )


def _account_paused_now() -> float:
    """Return remaining pause seconds (>0 if paused, 0 if not)."""
    global _ACCOUNT_PAUSED_UNTIL, _ACCOUNT_PAUSE_MESSAGE
    until = _ACCOUNT_PAUSED_UNTIL
    if until <= 0:
        return 0.0
    remaining = until - datetime.now(timezone.utc).timestamp()
    if remaining <= 0:
        # Pause expired — clear it so the next request re-probes the upstream.
        _ACCOUNT_PAUSED_UNTIL = 0.0
        _ACCOUNT_PAUSE_MESSAGE = ""
        return 0.0
    return remaining


def _is_proxied_llm_path(path: str) -> bool:
    return "chat/completions" in path or "/completions" in path or "/embeddings" in path


def install_account_pause_circuit_breaker(app: Any) -> None:
    """Install the outermost ASGI middleware that short-circuits requests while
    the upstream account is paused, and learns the pause from suspended-account
    responses. Idempotent."""
    if getattr(app, "_pie_account_pause_cb_installed", False):
        return
    app._pie_account_pause_cb_installed = True  # type: ignore[attr-defined]
    app.add_middleware(AccountPauseCircuitBreaker)


class AccountPauseCircuitBreaker:
    """Raw ASGI middleware: short-circuit proxied LLM requests while the
    upstream account is paused, and learn the pause from 429/403 responses.

    Request side: if the account is currently paused, return 429 +
    ``Retry-After`` directly without invoking the downstream (so LiteLLM's router
    + the upstream never see the request — no retry storm, no deepening the
    pause). Health/models/metrics endpoints pass through so the proxy stays
    observable while paused.

    Response side: intercept the downstream response. For non-streaming 429/403
    bodies, buffer and inspect for the suspension signature; if found, parse the
    reactivation time and arm the pause. Streaming 2xx responses pass through
    unchanged (a suspension is a non-streaming error, never a streamed chunk)."""

    def __init__(self, app: Any):
        self.app = app

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "")

        # Request-side short-circuit for proxied LLM endpoints only.
        if _is_proxied_llm_path(path):
            remaining = _account_paused_now()
            if remaining > 0:
                await self._send_paused_response(send, remaining)
                return

        # Response-side learning: interpose on send to inspect error bodies.
        await self._observe_response(scope, receive, send)

    async def _observe_response(self, scope: dict, receive: Any, send: Any) -> None:
        path = scope.get("path", "")
        buffering = False
        buffered_status = 0
        buffered_body = bytearray()

        async def observed_send(message: dict) -> None:
            nonlocal buffering, buffered_status, buffered_body
            mtype = message.get("type")
            if mtype == "http.response.start":
                status = int(message.get("status", 0))
                # Only error responses can carry a suspension; streaming 2xx
                # success passes through untouched.
                if status in (429, 403):
                    buffering = True
                    buffered_status = status
                    buffered_body = bytearray()
                await send(message)
                return
            if mtype == "http.response.body" and buffering:
                body = message.get("body") or b""
                if isinstance(body, (bytes, bytearray)):
                    buffered_body.extend(body)
                more = bool(message.get("more_body"))
                if not more:
                    # Final body of an error response — inspect for suspension.
                    extracted = _extract_pause_until(bytes(buffered_body))
                    if extracted is None and any(
                        sig in bytes(buffered_body) for sig in _PAUSE_BODY_SIGNATURES
                    ):
                        # Suspension signature present but no parseable
                        # reactivation time — bounded fallback cooldown.
                        until = (datetime.now(timezone.utc) + timedelta(seconds=DEFAULT_PAUSE_COOLDOWN_S)).timestamp()
                        msg = buffered_body.decode("utf-8", errors="ignore")[:200]
                        await _set_account_pause(until, msg)
                    elif extracted is not None:
                        until, msg = extracted
                        await _set_account_pause(until, msg)
                    buffering = False
                    buffered_body = bytearray()
                await send(message)
                return
            await send(message)

        await self.app(scope, receive, observed_send)

    async def _send_paused_response(self, send: Any, remaining_s: float) -> None:
        retry_after = max(1, int(remaining_s) + 1)
        payload = {
            "error": {
                "message": (
                    f"upstream account is paused for exceeding rate limits; "
                    f"reactivates in ~{int(remaining_s)}s. "
                    f"({_ACCOUNT_PAUSE_MESSAGE[:160]}) "
                    f"The pie proxy short-circuited this request to avoid deepening the pause."
                ),
                "type": "upstream_account_paused",
            }
        }
        body = json.dumps(payload).encode("utf-8")
        await send(
            {
                "type": "http.response.start",
                "status": 429,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"retry-after", str(retry_after).encode("ascii")),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})


# =============================================================================
# Afterburn: per-session sticky concurrency slots
# =============================================================================
#
# The problem this solves (and the LiteLLM semaphore can't): a provider enforces
# an *account-wide* concurrency limit (umans: N concurrent active sessions) and
# ALSO rate-limits bursts. pie respects the concurrency cap, but a single
# bursty session — especially a nested sub-agent fan-out that fires many rapid
# LLM calls separated by short tool-call pauses — keeps grabbing and releasing
# the one concurrency slot, so a second waiting session's calls interleave with
# the burst (A B A B A B ...). The provider sees a dense request rate from the
# account even though concurrency is respected, and trips its rate limiter.
#
# Afterburn makes a concurrency slot *sticky* to the session that last used it:
# when a session's LLM call finishes, the slot it held is reserved for THAT
# session for ``afterburn`` seconds (the "afterburn" — the slot keeps burning
# for its session). If the same session sends another call within the window
# (e.g. a sub-agent's follow-up right after a short tool call) it reuses its
# reserved slot immediately — no re-acquire, no interleaving with other
# sessions. If ``afterburn`` elapses with no call from the holder, the slot is
# released to queued sessions (``session A gets queued/paused, session B turns
# active`` in the feature description).
#
# This is per-SLOT affinity (it generalises to ``maxConcurrentRequests \u003e 1``):
# each of the N slots independently sticks to its last session for
# ``afterburn`` seconds after that session's call completes.
#
# Architecture note (why a middleware, not the LiteLLM semaphore):
# LiteLLM gates ``max_parallel_requests`` with ``async with semaphore:`` around
# ``litellm.acompletion(...)``. For STREAMING responses ``acompletion`` returns
# the stream wrapper as soon as the upstream STARTS responding, so the
# ``async with`` block exits and the permit is released at first-byte — long
# before the response finishes. Arming the afterburn hold at the semaphore's
# release point would hold the slot from first-byte, not from
# response-completion, which is not the intended "pause after the response"
# semantics. Instead, afterburn is a raw ASGI middleware layered OUTSIDE the
# stream-liveness middleware (so it observes the full downstream response,
# including the terminal body of a stream). It manages its own per-provider
# sticky slot-pool, and arms a slot's hold only when the response actually
# completes (body-end). LiteLLM's existing ``TrackedSemaphore`` is left
# untouched as a harmless hard-cap backstop: when afterburn is active the pool
# already gates to N in-flight, so LiteLLM's semaphore never blocks (it has a
# free permit whenever the pool gave a slot). When afterburn is disabled
# (``afterburn_s == 0``, the default) the middleware is a pure pass-through —
# zero behaviour change.
#
# Session identity: pi sends an ``x-session-affinity`` header (derived from the
# session id) on every proxied request when the provider's
# ``compat.sendSessionAffinityHeaders`` is true (set on the umans provider in
# models.yaml, propagated to models.json by sync-models). The middleware reads
# that header. Requests without a session id never arm a hold (the slot is
# released free), so afterburn degrades to a plain bounded gate for anonymous
# traffic.

import time  # noqa: E402

AFTERBURN_ENV = "PIE_PROXY_AFTERBURN_S"
DEFAULT_AFTERBURN_S = 0.0


def resolve_afterburn_default_s() -> float:
    """Resolve the global afterburn default in seconds (env var).

    Reads ``PIE_PROXY_AFTERBURN_S``: unset/empty -> default (0.0 = disabled);
    ``0`` -> disabled; positive -> the hold window. Invalid (NaN / negative) ->
    default. Per-provider ``proxy.providers.<name>.afterburnSeconds`` in
    settings.json overrides this default (see ``_resolve_provider_afterburn_s``).
    """
    raw = os.environ.get(AFTERBURN_ENV, "")
    if raw == "":
        return float(DEFAULT_AFTERBURN_S)
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return float(DEFAULT_AFTERBURN_S)
    if value < 0:
        return float(DEFAULT_AFTERBURN_S)
    return value


def _resolve_provider_afterburn_s(provider_cfg: dict[str, Any]) -> float:
    """Resolve afterburn for one provider from its settings.json entry.

    ``proxy.providers.<name>.afterburnSeconds`` (non-negative number) overrides
    the global env default; absent/invalid -> the global default.
    """
    value = provider_cfg.get("afterburnSeconds")
    if isinstance(value, (int, float)) and value >= 0:
        return float(value)
    return resolve_afterburn_default_s()


# ---------------------------------------------------------------------------
# AfterburnPool: N sticky slots with per-slot holder + hold deadline
# ---------------------------------------------------------------------------


@dataclass
class _AfterburnSlot:
    index: int
    in_flight: bool = False  # an active request holds this slot
    holder: str | None = None  # session id that holds/recently held this slot
    hold_until: float = 0.0  # unix ts until which `holder` has priority; 0 = none


class AfterburnPool:
    """A pool of N concurrency slots with per-slot session affinity.

    ``acquire(session)`` returns a slot index the caller now holds in-flight.
    ``release(index, session, success)`` either arms a sticky hold for
    ``session`` (success + afterburn \u003e 0 + session present) or frees the slot.

    Acquisition priority:
      1. Reuse one of THIS session's held (in-flight=False, within afterburn)
         slots — a follow-up call keeps its turn without re-queueing.
      2. Take a free slot (never held, or its hold expired).
      3. Otherwise wait (on an asyncio.Condition) until a slot frees or a hold
         expires, then re-evaluate.

    The acquire wait is bounded by ``afterburn_s + queue_wait_s`` (the
    legitimate afterburn hold + the existing queue-wait bound for in-flight
    saturation); on exceed it raises ``_AfterburnSaturated`` so the middleware
    returns a retryable 503 + Retry-After. When ``queue_wait_s`` is 0 (disabled)
    the bound is disabled (unbounded queue, matching the pre-bound semaphore
    behaviour); the afterburn hold itself still expires so a waiter proceeds
    within \u2264 ``afterburn_s`` of a hold.

    Concurrency: all state mutations happen under ``self.condition``.
    """

    def __init__(self, size: int, afterburn_s: float):
        self.size = max(1, int(size))
        self.afterburn_s = float(afterburn_s)
        self.slots: list[_AfterburnSlot] = [_AfterburnSlot(index=i) for i in range(self.size)]
        self.condition = asyncio.Condition()
        self._active = 0  # in-flight slots
        self._waiting = 0  # coroutines parked in acquire()

    @property
    def active(self) -> int:
        return self._active

    @property
    def waiting(self) -> int:
        return self._waiting

    def _now(self) -> float:
        return time.monotonic()

    async def acquire(self, session: str | None) -> int:
        # Fast path: reuse a held slot for this session (no queueing).
        async with self.condition:
            if session:
                now = self._now()
                for s in self.slots:
                    if (
                        not s.in_flight
                        and s.holder == session
                        and s.hold_until > now
                    ):
                        s.in_flight = True
                        s.hold_until = 0.0
                        self._active += 1
                        return s.index
            # Compute the overall acquire deadline (afterburn + queue wait).
            queue_wait = resolve_queue_wait_s()
            bound = (self.afterburn_s + queue_wait) if queue_wait > 0 else 0.0
            deadline = (self._now() + bound) if bound > 0 else 0.0
            while True:
                now = self._now()
                free_slot: _AfterburnSlot | None = None
                for s in self.slots:
                    if s.in_flight:
                        continue
                    if s.holder is not None and s.hold_until > now:
                        continue  # held by someone, still within afterburn
                    # Free or expired hold -> available.
                    s.holder = None
                    s.hold_until = 0.0
                    if free_slot is None:
                        free_slot = s
                if free_slot is not None:
                    free_slot.in_flight = True
                    free_slot.holder = session
                    free_slot.hold_until = 0.0
                    self._active += 1
                    return free_slot.index
                # No free slot. Wait for a release/hold-expiry or the deadline.
                # Next wake opportunity: the soonest expiring hold.
                next_hold = min(
                    (s.hold_until for s in self.slots if not s.in_flight and s.hold_until > now),
                    default=now + 1.0,
                )
                wait_for_s = max(0.0, next_hold - now)
                if deadline > 0:
                    wait_for_s = min(wait_for_s, max(0.0, deadline - now))
                self._waiting += 1
                try:
                    try:
                        await asyncio.wait_for(self.condition.wait(), timeout=wait_for_s)
                    except asyncio.TimeoutError:
                        if deadline > 0 and self._now() >= deadline:
                            raise _AfterburnSaturated(self.afterburn_s + queue_wait) from None
                        # A hold expired (or a near-zero wait) -> re-evaluate.
                        continue
                finally:
                    self._waiting -= 1

    async def release(self, index: int, session: str | None, success: bool) -> None:
        async with self.condition:
            s = self.slots[index]
            was_in_flight = s.in_flight
            s.in_flight = False
            if was_in_flight:
                self._active = max(0, self._active - 1)
            if success and self.afterburn_s > 0 and session:
                # Arm the sticky hold: this slot stays reserved for `session`.
                s.holder = session
                s.hold_until = self._now() + self.afterburn_s
            else:
                # Free the slot (failure, disabled, or anonymous request).
                s.holder = None
                s.hold_until = 0.0
            self.condition.notify_all()


class _AfterburnSaturated(Exception):
    """Raised by ``AfterburnPool.acquire`` when no slot is acquired within the
    afterburn + queue-wait bound. The middleware turns this into a retryable
    503 + Retry-After (same shape as the queue-wait-bound 503)."""

    def __init__(self, wait_s: float):
        super().__init__(f"afterburn pool saturated after {wait_s:g}s")
        self.wait_s = wait_s


# ---------------------------------------------------------------------------
# Config + pool registry for the middleware
# ---------------------------------------------------------------------------

# provider name -> AfterburnPool, populated eagerly at proxy startup by
# `_init_afterburn_pools` (called from `install_afterburn_middleware`) so the
# middleware can gate the very first request. `set_max_parallel_requests_client`
# (patched, runs at LiteLLM client init) links the existing pool into
# `_PROVIDER_METRICS` for the metrics endpoint.
_AFTERBURN_POOLS: dict[str, AfterburnPool] = {}
# provider name -> (max_concurrent, afterburn_s) and model_name -> provider,
# lazily loaded + cached from settings.json proxy.providers.
_AFTERBURN_CFG_CACHE: tuple[dict[str, tuple[int, float]], dict[str, str]] | None = None


def _load_afterburn_config() -> tuple[dict[str, tuple[int, float]], dict[str, str]]:
    """Load per-provider afterburn config + a model_name -> provider map.

    Returns ``(provider_cfg, model_name_to_provider)`` where ``provider_cfg`` is
    ``{provider: (max_concurrent, afterburn_s)}`` and ``model_name_to_provider``
    maps every entry in each provider's ``modelListOrder`` (model ids + alias
    keys) to that provider. Cached. Reads settings.json directly (same source
    ``_load_provider_config`` uses).
    """
    global _AFTERBURN_CFG_CACHE
    if _AFTERBURN_CFG_CACHE is not None:
        return _AFTERBURN_CFG_CACHE

    provider_cfg: dict[str, tuple[int, float]] = {}
    model_name_to_provider: dict[str, str] = {}
    try:
        raw = json.loads((_agent_dir() / "settings.json").read_text(encoding="utf-8"))
        providers = ((raw or {}).get("proxy") or {}).get("providers") or {}
        if isinstance(providers, dict):
            for provider, value in providers.items():
                if not isinstance(value, dict):
                    continue
                max_concurrent = value.get("maxConcurrentRequests")
                mc = int(max_concurrent) if isinstance(max_concurrent, (int, float)) and max_concurrent >= 1 else 1
                provider_cfg[provider] = (mc, _resolve_provider_afterburn_s(value))
                for name in value.get("modelListOrder") or []:
                    if isinstance(name, str):
                        model_name_to_provider[name] = provider
    except Exception:
        provider_cfg = {}
        model_name_to_provider = {}

    _AFTERBURN_CFG_CACHE = (provider_cfg, model_name_to_provider)
    return _AFTERBURN_CFG_CACHE


def _init_afterburn_pools() -> None:
    """Create the per-provider ``AfterburnPool`` instances from settings.json
    at proxy startup (called from ``install_afterburn_middleware``).

    Pools are created eagerly — independent of LiteLLM's lazy client init — so
    the middleware can gate the very first request and so metrics can reference
    the same pool instance. ``set_max_parallel_requests_client`` (patched, runs
    at LiteLLM client init) links the existing pool into ``_PROVIDER_METRICS``.
    """
    provider_cfg, _ = _load_afterburn_config()
    for provider, (max_concurrent, afterburn_s) in provider_cfg.items():
        if afterburn_s > 0 and _AFTERBURN_POOLS.get(provider) is None:
            _AFTERBURN_POOLS[provider] = AfterburnPool(max_concurrent, afterburn_s)


# ---------------------------------------------------------------------------
# ASGI middleware
# ---------------------------------------------------------------------------


def _session_id_from_scope(scope: dict) -> str | None:
    """Read the session id from the request headers.

    pi sends ``x-session-affinity`` (plus ``session_id`` and
    ``x-client-request-id``) when ``compat.sendSessionAffinityHeaders`` is set.
    Accept any of the three; ``x-session-affinity`` is preferred.
    """
    headers = scope.get("headers") or []
    # ASGI headers are lowercased bytes. Prefer x-session-affinity, then
    # session_id, then x-client-request-id.
    found: dict[str, str] = {}
    for key, value in headers:
        if not isinstance(key, (bytes, bytearray)):
            continue
        k = key.decode("latin-1").lower()
        if k in ("x-session-affinity", "session_id", "x-client-request-id"):
            found[k] = value.decode("utf-8", errors="ignore")
    return found.get("x-session-affinity") or found.get("session_id") or found.get("x-client-request-id")


async def _buffer_request_body(receive: Any) -> tuple[bytes, Any]:
    """Buffer the full ASGI request body and return (body_bytes, replay_receive).

    The returned ``replay`` callable replays the buffered body to the
    downstream, then signals body-complete, so the downstream sees an
    identical request stream.
    """
    body = bytearray()
    more = True
    while more:
        message = await receive()
        if message.get("type") == "http.request":
            chunk = message.get("body") or b""
            if isinstance(chunk, (bytes, bytearray)):
                body.extend(chunk)
            more = bool(message.get("more_body", False))
        elif message.get("type") == "http.disconnect":
            # Client gone; surface an empty body so the downstream can bail.
            break

    body_bytes = bytes(body)
    sent = False

    async def replay() -> dict:
        nonlocal sent
        if not sent:
            sent = True
            return {"type": "http.request", "body": body_bytes, "more_body": False}
        # After replaying the full body, delegate to the original ASGI
        # ``receive`` so downstream apps see ``http.disconnect`` only when the
        # client ACTUALLY disconnects. Returning a synthetic ``http.disconnect``
        # here prematurely aborts streaming responses (LiteLLM treats it as
        # client-gone → error_code=499), and returning a second
        # ``http.request`` trips Starlette's BaseHTTPMiddleware receive wrapper
        # (``RuntimeError: Unexpected message received``). The original receive
        # blocks until the true client disconnect, matching the ASGI contract
        # for an exhausted request body stream.
        return await receive()

    return body_bytes, replay


def _resolve_pool_for_request(body: bytes) -> AfterburnPool | None:
    """Resolve the afterburn pool for an incoming request, or ``None`` if
    afterburn is disabled / the model is unknown.

    Parses the request body's ``model`` field, maps it to a provider via the
    ``modelListOrder`` config, and looks up that provider's pool.
    """
    try:
        payload = json.loads(body.decode("utf-8")) if body else {}
    except (ValueError, TypeError):
        return None
    model = payload.get("model") if isinstance(payload, dict) else None
    if not isinstance(model, str) or not model:
        return None
    _, model_name_to_provider = _load_afterburn_config()
    provider = model_name_to_provider.get(model)
    if provider is None:
        return None
    return _AFTERBURN_POOLS.get(provider)


_AFTERBURN_MW_PATCHED = False


def install_afterburn_middleware(app: Any) -> None:
    """Install the afterburn ASGI middleware (per-session sticky slots).

    Layered OUTSIDE the stream-liveness middleware (installed before this) so
    it observes the full downstream response including the terminal body of a
    stream, and INSIDE the account-pause circuit breaker (installed after
    this, outermost) so a paused-account short-circuit never reaches afterburn.
    Idempotent. Pure pass-through when afterburn is disabled for the resolved
    provider (``afterburn_s == 0``), so the default behaviour is unchanged.
    """
    global _AFTERBURN_MW_PATCHED
    if _AFTERBURN_MW_PATCHED:
        return
    _AFTERBURN_MW_PATCHED = True
    # Create the per-provider pools eagerly from settings.json so the middleware
    # can gate the very first request and metrics reference the same instances.
    _init_afterburn_pools()
    app.add_middleware(AfterburnASGIMiddleware)


class AfterburnASGIMiddleware:
    """Raw ASGI middleware: per-session sticky concurrency slots (afterburn).

    On a proxied LLM request (chat/completions, completions):
      1. Buffer + parse the request body to resolve the provider's
         ``AfterburnPool`` (or pass through if afterburn is disabled / the model
         is unknown).
      2. Read the session id from ``x-session-affinity``.
      3. Acquire a slot from the pool (reusing this session's held slot if
         within afterburn, else a free slot, else queue — bounded by
         afterburn + queue-wait, raising ``_AfterburnSaturated`` on timeout).
      4. Forward to the downstream, interpose on ``send`` to detect response
         completion (the final ``http.response.body`` with ``more_body=False``,
         or the downstream task returning — whichever first).
      5. On completion release the slot: arm a sticky hold for the session on a
         2xx response (success + afterburn > 0 + session), else free it.

    A ``finally`` releases the slot if the downstream raises or finishes
    without sending a final body (defensive; the slot never leaks).
    """

    def __init__(self, app: Any):
        self.app = app

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "")
        if not _is_proxied_llm_path(path):
            await self.app(scope, receive, send)
            return

        # Zero-cost fast path: if afterburn is disabled for EVERY provider the
        # pool registry is empty, so skip body buffering/parsing entirely and
        # pass through unchanged (default behaviour). This keeps the disabled
        # case truly free on the hot path.
        if not _AFTERBURN_POOLS:
            await self.app(scope, receive, send)
            return

        body_bytes, replay_receive = await _buffer_request_body(receive)
        pool = _resolve_pool_for_request(body_bytes)
        if pool is None:
            # Afterburn disabled for this provider / unknown model -> pass
            # through unchanged (default behaviour). The buffered body is
            # replayed via replay_receive so the downstream sees the request.
            await self.app(scope, replay_receive, send)
            return

        session = _session_id_from_scope(scope)
        try:
            slot_index = await pool.acquire(session)
        except _AfterburnSaturated as exc:
            await self._send_503(send, exc.wait_s)
            return

        released = False
        status_holder = {"status": 0}

        async def send_wrap(message: dict) -> None:
            nonlocal released
            mtype = message.get("type")
            if mtype == "http.response.start":
                status_holder["status"] = int(message.get("status", 0))
            await send(message)
            if (
                mtype == "http.response.body"
                and not message.get("more_body", False)
                and not released
            ):
                released = True
                await pool.release(
                    slot_index,
                    session,
                    success=(200 <= status_holder["status"] < 300),
                )

        try:
            await self.app(scope, replay_receive, send_wrap)
        finally:
            if not released:
                # Downstream finished/raised without a final body — free the
                # slot (no hold armed) so it never leaks.
                await pool.release(slot_index, session, success=False)

    async def _send_503(self, send: Any, wait_s: float) -> None:
        retry_after = max(1, int(wait_s))
        payload = {
            "error": {
                "message": (
                    f"proxy concurrency pool saturated: no slot acquired within "
                    f"{wait_s:g}s (afterburn hold). Retry shortly."
                ),
                "type": "proxy_concurrency_saturated",
            }
        }
        body = json.dumps(payload).encode("utf-8")
        await send(
            {
                "type": "http.response.start",
                "status": 503,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"retry-after", str(retry_after).encode("ascii")),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})
