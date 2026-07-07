from __future__ import annotations

import sys

from pie_proxy_runtime import (
    install_account_pause_circuit_breaker,
    install_afterburn_middleware,
    install_proxy_metrics_patch,
    install_stream_liveness_middleware,
    register_proxy_metrics_route,
)

install_proxy_metrics_patch()

from litellm.proxy import proxy_cli  # noqa: E402
from litellm.proxy.proxy_server import app  # noqa: E402

# Slice C: surface a dead upstream stream as a terminal SSE error so the SDK
# sees stream termination instead of hanging forever on the next chunk. Must be
# installed AFTER `app` is imported (it adds a Starlette middleware to it).
install_stream_liveness_middleware(app)
register_proxy_metrics_route(app)
# Afterburn (per-session sticky concurrency slots). Installed AFTER the
# stream-liveness middleware so it is outer to it (it observes the full
# downstream response, including the terminal body of a stream) and BEFORE
# the account-pause circuit breaker (installed next, outermost) so a
# paused-account short-circuit never reaches afterburn. Pure pass-through when
# afterburn is disabled for the resolved provider (default).
install_afterburn_middleware(app)
# Outermost: account-pause circuit breaker. Installed LAST so it wraps every
# other middleware — a paused upstream is short-circuited before the stream-
# liveness middleware or the LiteLLM router do any work (no retry storm, no
# deepened pause). Learns the pause from suspended-account 429/403 responses.
install_account_pause_circuit_breaker(app)

if __name__ == "__main__":
    proxy_cli.run_server.main(args=sys.argv[1:], standalone_mode=False)
