from __future__ import annotations

import sys

from pie_proxy_runtime import (
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

if __name__ == "__main__":
    proxy_cli.run_server.main(args=sys.argv[1:], standalone_mode=False)
