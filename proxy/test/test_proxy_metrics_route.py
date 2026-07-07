"""Behavior + accuracy test for the /health/proxy_metrics route
(`register_proxy_metrics_route` in proxy/pie_proxy_runtime.py).

Why this file exists
--------------------
The existing ``test_proxy_metrics.py`` is misnamed — it actually tests
``TrackedSemaphore`` (its only import is ``TrackedSemaphore`` and it asserts
``active``/``waiting`` counts). The route handler itself, and the
``_authorized`` gate that protects it, had NO test coverage. This file fills
that gap with the exact contract the host TS ``ProxyMetricsService`` (and the
user-facing proxy status strip) depend on:

  * ``_authorized`` accepts a matching ``Bearer <key>`` and a matching raw
    ``<key>`` header, and rejects a missing key env, a missing header, a wrong
    header, and a non-matching bearer token.
  * The route returns ``401 {"error": "unauthorized"}`` when unauthorized so the
    host fetch (httpGetJson) sees a non-200 and surfaces [] — never stale/
    garbage numbers.
  * When authorized but no providers are configured, the route returns
    ``200`` with ``providers: []`` (and a ``generatedAt`` ISO timestamp).
  * When authorized with configured providers, the route returns ``200`` with
    one entry per provider, SORTED by provider name, and each entry exposes
    EXACTLY the camelCase keys + values the host ``ProxyProviderMetrics``
    interface expects (provider, modelInfoId, activeRequests, queuedRequests,
    maxConcurrentRequests) — sourced from the live semaphore. This is the
    accuracy contract: the numbers users see must equal the source-derived
    counts.

The route is exercised without a running server: we register it on a tiny
fake app whose ``.get(path, ...)`` captures the async handler, then invoke the
handler directly with a minimal fake ``Request`` exposing ``headers.get``.
``_PROVIDER_METRICS`` (module-global) is seeded with real ``ProviderMetric``
objects backed by ``TrackedSemaphore`` so the active/queued derivations are
real, and reset between tests.

Run:  cd proxy && uv run python test/test_proxy_metrics_route.py
"""

from __future__ import annotations

import json
import os
import sys
import unittest
from pathlib import Path
from typing import Any, Awaitable, Callable

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pie_proxy_runtime as rt  # noqa: E402
from pie_proxy_runtime import (  # noqa: E402
    ProviderMetric,
    TrackedSemaphore,
    _authorized,
    register_proxy_metrics_route,
)

MASTER_KEY_ENV = "PIE_PROXY_MASTER_KEY"


class FakeRequest:
    """Minimal stand-in for fastapi.Request — only ``headers.get`` is read by
    ``_authorized``."""

    def __init__(self, auth_header: str | None):
        self._auth = auth_header

    @property
    def headers(self) -> "dict[str, str]":
        return {"authorization": self._auth} if self._auth is not None else {}


class FakeApp:
    """Captures the route handler registered by ``register_proxy_metrics_route``."""

    def __init__(self) -> None:
        self.handler: Callable[[FakeRequest], Awaitable[Any]] | None = None

    def get(self, path: str, **kwargs: Any):  # noqa: ANN201 - decorator factory
        def decorator(fn):  # noqa: ANN202
            if path == "/health/proxy_metrics":
                self.handler = fn
            return fn

        return decorator


def _make_metric(provider: str, model_info_id: str, max_concurrent: int, *, active: int = 0, waiting: int = 0) -> ProviderMetric:
    sem = TrackedSemaphore(max_concurrent)
    # Drive the semaphore into the requested active/waiting state so the
    # route reads the real derived counts (not hard-coded fields).
    for _ in range(active):
        # Each acquire consumes one slot; active = initial - _value.
        sem._value -= 1  # type: ignore[attr-defined] — simulate a held slot
    sem.waiting = waiting
    return ProviderMetric(
        provider=provider,
        model_info_id=model_info_id,
        max_concurrent_requests=max_concurrent,
        semaphore=sem,
    )


class AuthorizedTests(unittest.TestCase):
    def setUp(self) -> None:
        self._prev = os.environ.get(MASTER_KEY_ENV)

    def tearDown(self) -> None:
        if self._prev is None:
            os.environ.pop(MASTER_KEY_ENV, None)
        else:
            os.environ[MASTER_KEY_ENV] = self._prev

    def test_no_master_key_env_means_unauthorized(self):
        os.environ.pop(MASTER_KEY_ENV, None)
        self.assertFalse(_authorized(FakeRequest("Bearer anything")))

    def test_missing_auth_header_rejected(self):
        os.environ[MASTER_KEY_ENV] = "secret"
        self.assertFalse(_authorized(FakeRequest(None)))

    def test_matching_bearer_header_accepted(self):
        os.environ[MASTER_KEY_ENV] = "secret"
        self.assertTrue(_authorized(FakeRequest("Bearer secret")))

    def test_matching_raw_header_accepted(self):
        # _authorized also accepts a bare key (no "Bearer " prefix).
        os.environ[MASTER_KEY_ENV] = "secret"
        self.assertTrue(_authorized(FakeRequest("secret")))

    def test_wrong_bearer_token_rejected(self):
        os.environ[MASTER_KEY_ENV] = "secret"
        self.assertFalse(_authorized(FakeRequest("Bearer wrong")))

    def test_leading_trailing_whitespace_on_key_env_and_header_tolerated(self):
        # _authorized .strip()s both the env key and the whole auth header, so
        # surrounding whitespace (e.g. a trailing newline in the env, leading/
        # trailing spaces in the header) must still match. Internal spacing in
        # the bearer token is NOT collapsed — the host sends a single-space
        # `Bearer <key>`, which this asserts.
        os.environ[MASTER_KEY_ENV] = "  secret  "
        self.assertTrue(_authorized(FakeRequest("   Bearer secret   \n")))


class RouteHandlerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self._prev_key = os.environ.get(MASTER_KEY_ENV)
        os.environ[MASTER_KEY_ENV] = "test-master-key"
        self._prev_metrics = dict(rt._PROVIDER_METRICS)
        rt._PROVIDER_METRICS.clear()

    async def asyncTearDown(self) -> None:
        if self._prev_key is None:
            os.environ.pop(MASTER_KEY_ENV, None)
        else:
            os.environ[MASTER_KEY_ENV] = self._prev_key
        rt._PROVIDER_METRICS.clear()
        rt._PROVIDER_METRICS.update(self._prev_metrics)

    async def _invoke(self, request: FakeRequest) -> Any:
        app = FakeApp()
        register_proxy_metrics_route(app)
        assert app.handler is not None, "route handler was not registered"
        return await app.handler(request)

    async def test_unauthorized_returns_401_with_error_body(self):
        response = await self._invoke(FakeRequest("Bearer wrong"))
        self.assertEqual(response.status_code, 401)
        body = json.loads(response.body.decode("utf-8"))
        self.assertEqual(body, {"error": "unauthorized"})

    async def test_unauthorized_when_no_auth_header(self):
        response = await self._invoke(FakeRequest(None))
        self.assertEqual(response.status_code, 401)

    async def test_authorized_empty_providers_returns_200_empty_list(self):
        response = await self._invoke(FakeRequest("Bearer test-master-key"))
        self.assertEqual(response.status_code, 200)
        body = json.loads(response.body.decode("utf-8"))
        self.assertEqual(body["providers"], [])
        # generatedAt must be an ISO 8601 string so the host can display it.
        self.assertIsInstance(body["generatedAt"], str)
        self.assertIn("T", body["generatedAt"])

    async def test_authorized_returns_exact_provider_fields_sourced_from_semaphore(self):
        # Seed providers out of alphabetical order to prove the route sorts.
        rt._PROVIDER_METRICS["zeta"] = _make_metric("zeta", "z-shared", 4, active=2, waiting=0)
        rt._PROVIDER_METRICS["alpha"] = _make_metric("alpha", "a-shared", 8, active=1, waiting=3)
        rt._PROVIDER_METRICS["beta"] = _make_metric("beta", "b-shared", 2, active=2, waiting=1)

        response = await self._invoke(FakeRequest("Bearer test-master-key"))
        self.assertEqual(response.status_code, 200)
        body = json.loads(response.body.decode("utf-8"))
        providers = body["providers"]

        # Exactly one entry per configured provider.
        self.assertEqual([p["provider"] for p in providers], ["alpha", "beta", "zeta"])

        # Each entry exposes EXACTLY the six camelCase keys the host contract
        # expects (proxy-metrics-field-contract.test.ts pins field-name parity;
        # this pins the VALUES + that no extra keys leak). `afterburnSeconds`
        # was added by the afterburn-pool feature.
        for entry in providers:
            self.assertEqual(
                set(entry.keys()),
                {"provider", "modelInfoId", "activeRequests", "queuedRequests", "maxConcurrentRequests", "afterburnSeconds"},
                f"unexpected keys in {entry}",
            )

        # Values equal the live semaphore-derived counts (accuracy contract).
        # afterburnSeconds is 0.0 because _make_metric seeds no afterburn pool.
        alpha = next(p for p in providers if p["provider"] == "alpha")
        self.assertEqual(alpha, {
            "provider": "alpha",
            "modelInfoId": "a-shared",
            "activeRequests": 1,
            "queuedRequests": 3,
            "maxConcurrentRequests": 8,
            "afterburnSeconds": 0.0,
        })
        beta = next(p for p in providers if p["provider"] == "beta")
        self.assertEqual(beta, {
            "provider": "beta",
            "modelInfoId": "b-shared",
            "activeRequests": 2,
            "queuedRequests": 1,
            "maxConcurrentRequests": 2,
            "afterburnSeconds": 0.0,
        })
        zeta = next(p for p in providers if p["provider"] == "zeta")
        self.assertEqual(zeta, {
            "provider": "zeta",
            "modelInfoId": "z-shared",
            "activeRequests": 2,
            "queuedRequests": 0,
            "maxConcurrentRequests": 4,
            "afterburnSeconds": 0.0,
        })

    async def test_authorized_idle_provider_surfaces_zero_counts(self):
        # An idle provider (active=0, queued=0) must still be listed so the
        # host status strip does not flicker (matches the host fetchMetrics
        # "keep idle providers" contract).
        rt._PROVIDER_METRICS["umans"] = _make_metric("umans", "umans-shared", 4, active=0, waiting=0)
        response = await self._invoke(FakeRequest("Bearer test-master-key"))
        self.assertEqual(response.status_code, 200)
        providers = json.loads(response.body.decode("utf-8"))["providers"]
        self.assertEqual(providers, [{
            "provider": "umans",
            "modelInfoId": "umans-shared",
            "activeRequests": 0,
            "queuedRequests": 0,
            "maxConcurrentRequests": 4,
            "afterburnSeconds": 0.0,
        }])

    async def test_route_hidden_from_openapi_schema(self):
        # The route is registered with include_in_schema=False so it does not
        # clutter the proxy's OpenAPI docs surfaced to users. We assert the
        # decorator was called with that kwarg by re-registering on a spy app
        # that records the kwargs.
        recorded: dict[str, Any] = {}

        class SpyApp:
            def get(self, path: str, **kwargs: Any):  # noqa: ANN201
                recorded["path"] = path
                recorded["kwargs"] = kwargs

                def decorator(fn):
                    return fn

                return decorator

        register_proxy_metrics_route(SpyApp())
        self.assertEqual(recorded["path"], "/health/proxy_metrics")
        self.assertEqual(recorded["kwargs"].get("include_in_schema"), False)


if __name__ == "__main__":
    unittest.main(verbosity=2)