"""
Regression test for the pie LiteLLM proxy concurrency governor.

Why this exists
---------------
The proxy is supposed to cap umans at 4 concurrent in-flight requests
(account-wide) and QUEUE a 5th instead of 429-ing upstream. Two past bugs
silently disabled that protection:

  1. The limit was placed under a per-entry `router_settings.max_concurrent_requests`
     key. LiteLLM does NOT read that — it reads `litellm_params.max_parallel_requests`
     (litellm/types/router.py). The wrong key was silently dropped, so no
     semaphore was ever created.
  2. Even with the right key, each umans variant got its own semaphore (keyed
     by `model_info.id`). umans' limit is account-wide, not per-model, so
     8 variants × 4 = a 32-concurrent burst. Sharing one `model_info.id`
     (`umans-shared`) across all variants makes LiteLLM create a SINGLE
     Semaphore(4) — a true global queue.

This test loads the real `litellm_config.yaml` through LiteLLM's `Router`
(the same path `proxy_server.py` uses at boot) and asserts both fixes hold,
so the protection cannot silently regress again.

Run:  cd proxy && uv run python test/test_config.py
       (or:  uv run pytest test/test_config.py   if pytest is installed)
"""

import asyncio
import os
import sys
from pathlib import Path

import yaml
from litellm import Router

PROXY_DIR = Path(__file__).resolve().parent.parent
CONFIG_PATH = PROXY_DIR / "litellm_config.yaml"


def _load_model_list() -> list[dict]:
    cfg = yaml.safe_load(CONFIG_PATH.read_text())
    return cfg["model_list"]


def _make_router() -> Router:
    # os.environ/UMANS_API_KEY is resolved by the proxy at boot from the real
    # env; for Router init here we only need a non-None placeholder so the
    # openai client config doesn't short-circuit. Concurrency semaphores are
    # created from the config shape, not from a live upstream call.
    os.environ.setdefault("UMANS_API_KEY", "sk-test-placeholder")
    return Router(model_list=_load_model_list(), ignore_invalid_deployments=True)


def _force_semaphore(router: Router, deployment: dict):
    """Trigger the same lazy semaphore init the router uses on a real call."""
    return router._get_client(deployment, {}, client_type="max_parallel_requests")


def test_no_legacy_router_settings_block():
    """The ignored `router_settings.max_concurrent_requests` key must be gone."""
    for m in _load_model_list():
        assert "router_settings" not in m, (
            f"model_name={m.get('model_name')} still has a per-entry "
            f"`router_settings` block — LiteLLM ignores it. Move concurrency "
            f"to `litellm_params.max_parallel_requests`."
        )


def test_max_parallel_requests_is_four_on_every_umans_entry():
    for m in _load_model_list():
        mpr = m["litellm_params"].get("max_parallel_requests")
        assert mpr == 4, (
            f"model_name={m.get('model_name')} litellm_params.max_parallel_requests "
            f"= {mpr!r}, expected 4."
        )


def test_all_umans_variants_share_one_semaphore():
    router = _make_router()
    deployments = router.get_model_list()
    assert deployments, "Router loaded zero deployments — config is broken."

    semaphores = {
        d["model_name"]: _force_semaphore(router, d) for d in deployments
    }

    # Every variant must have a real asyncio.Semaphore (not None).
    for name, sem in semaphores.items():
        assert isinstance(sem, asyncio.Semaphore), (
            f"model_name={name} has no max_parallel_requests semaphore — "
            f"the concurrency governor is NOT wired up for it."
        )

    # AND they must all be the SAME object (the shared-id fix). Different
    # objects mean per-variant limits that don't protect the account-wide cap.
    distinct = {id(sem) for sem in semaphores.values()}
    assert len(distinct) == 1, (
        f"Expected one shared semaphore across all umans variants, got "
        f"{len(distinct)} distinct objects: "
        + ", ".join(f"{n}={id(s)}" for n, s in semaphores.items())
    )

    # The shared semaphore must be a 4-slot queue.
    shared = next(iter(semaphores.values()))
    assert getattr(shared, "_value", None) == 4, (
        f"Shared semaphore value={getattr(shared, '_value', None)!r}, expected 4."
    )


def test_all_umans_variants_share_model_info_id():
    ids = {m.get("model_info", {}).get("id") for m in _load_model_list()}
    assert ids == {"umans-shared"}, (
        f"Expected all umans variants to share model_info.id='umans-shared', "
        f"got {ids!r}. Without a shared id LiteLLM creates per-variant "
        f"semaphores and the account-wide 4-concurrent cap is not enforced."
    )


def test_models_json_routes_umans_through_proxy():
    """Traffic must actually reach the proxy, or the governor is bypassed."""
    models = yaml.safe_load  # noqa: just to keep yaml imported for readers
    import json

    models_json = json.loads((PROXY_DIR.parent / "models.json").read_text())
    umans = models_json["providers"]["umans"]
    assert umans["baseUrl"] == "http://localhost:4000/v1", (
        f"models.json umans.baseUrl={umans['baseUrl']!r} — must point at the "
        f"local LiteLLM proxy or umans traffic bypasses the concurrency limit."
    )


if __name__ == "__main__":
    # Run without pytest: invoke each test_* function and exit non-zero on failure.
    failures = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"PASS  {name}")
            except AssertionError as e:
                failures += 1
                print(f"FAIL  {name}: {e}")
            except Exception as e:  # pragma: no cover - surface infra errors
                failures += 1
                print(f"ERROR {name}: {type(e).__name__}: {e}")
    sys.exit(1 if failures else 0)