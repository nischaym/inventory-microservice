# syntax=docker/dockerfile:1
# Build for the evaluator's platform with:
#   docker buildx build --platform linux/amd64 --load -t inventory-service:local .

# Node 24 LTS on Debian slim (glibc), pinned by digest for reproducible builds.
ARG NODE_IMAGE=node:24.22.1-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
# No dependency needs an install script; skipping them removes a supply-chain vector.
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080 \
    LOG_LEVEL=info \
    NODE_OPTIONS=--max-old-space-size=384
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
# /data must exist and be owned by the runtime user so a fresh named volume inherits
# that ownership (Docker copies image content and ownership into an empty volume).
RUN mkdir -p /data && chown 10001:10001 /data
USER 10001:10001
EXPOSE 8080
VOLUME /data
# Slim images have no curl, so the probe uses Node's built-in fetch.
HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
# Node runs as PID 1 and handles SIGTERM itself (graceful shutdown in src/main.ts).
CMD ["node", "dist/main.js"]
