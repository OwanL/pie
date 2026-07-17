FROM node:24.16.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/pie/extension
COPY scripts/experiments/container/package.json scripts/experiments/container/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
WORKDIR /opt/pie/runtime/worker
COPY scripts/experiments/trial-worker.mjs ./agent.mjs
COPY scripts/experiments/broker-container.mjs scripts/experiments/broker.mjs ./
COPY scripts/experiments/lib/policy.mjs scripts/experiments/lib/runtime-support.mjs ./lib/
RUN chown -R root:root /opt/pie && chmod -R a-w /opt/pie
ARG PIE_CONTAINER_SOURCE_DIGEST
LABEL pie.source-digest=$PIE_CONTAINER_SOURCE_DIGEST
USER node
ENTRYPOINT ["node"]
