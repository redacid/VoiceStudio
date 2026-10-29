# ──────────────────────────────────────────────────────────────
#  VoiceStudio — app image for the current version
#
#  Built on top of a base image from deploy/Dockerfile.base:
#    make docker-build-app FLAVOR=cpu|cuda
#  Adds the browser UI, backend and omnivoice sources; dependencies come from
#  the base, so this rebuilds in minutes.
# ──────────────────────────────────────────────────────────────
ARG BASE_IMAGE=redacid/voicestudio:base-cpu

# Keep in lockstep with package.json packageManager (tests/test_bun_toolchain_pins.py).
FROM oven/bun:1.4.2-alpine AS frontend-builder
WORKDIR /app
COPY package.json bun.lock ./
COPY electron/package.json ./electron/
COPY config/ ./config/
RUN bun install --frozen-lockfile
COPY frontend/ ./frontend/
COPY electron/ ./electron/
RUN bun run --cwd electron build:web

FROM ${BASE_IMAGE} AS runtime
WORKDIR /app

ENV HF_HOME=/app/omnivoice_data/huggingface \
    PYTHONPATH=/app/backend \
    OMNIVOICE_SERVER_MODE=1

# The omnivoice package itself; its dependencies are already in the base.
COPY pyproject.toml README.md ./
COPY omnivoice/ ./omnivoice/
RUN uv pip install --python "$(command -v python3)" --no-cache --no-deps .

COPY backend/ ./backend/
COPY config/ ./config/
COPY alembic.ini ./
COPY --from=frontend-builder /app/frontend/dist ./frontend/dist

EXPOSE 3900
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=5 \
  CMD ["python3", "backend/docker_entrypoint.py", "--health-check"]
VOLUME ["/app/omnivoice_data"]

ENV OMNIVOICE_BIND_HOST=0.0.0.0
# Late on purpose: changes every commit, must not invalidate earlier layers.
ARG BUILD_COMMIT=unknown
ENV OMNIVOICE_BUILD_COMMIT=${BUILD_COMMIT}
ENTRYPOINT ["python3", "backend/docker_entrypoint.py"]
