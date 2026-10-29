# Maintainer shortcuts; product development uses bun/uv directly.
# `make help` lists every target.

.PHONY: help release release-dry release-publish virustotal \
	setup dev web api \
	docker-build docker-build-rocm docker-build-cuda-arm64 docker-build-all \
	docker-run docker-push

.DEFAULT_GOAL := help

PYTHON ?= python3

# ── Docker image settings (override on the command line) ─────────────────
# make docker-build IMAGE=ghcr.io/me/voicestudio IMAGE_TAG=dev
VERSION      := $(shell sed -nE 's/^[[:space:]]*"version":[[:space:]]*"([^"]+)".*/\1/p' package.json | head -n1)
BUILD_COMMIT ?= $(shell git rev-parse HEAD 2>/dev/null || echo unknown)
IMAGE        ?= voicestudio
IMAGE_TAG    ?= $(VERSION)
# CUDA and ROCm images are x86-64; pin the platform so Apple Silicon hosts
# build the image GPU clouds actually run.
PLATFORM     ?= linux/amd64
DOCKER       ?= docker
DOCKER_BUILD_ARGS ?=
ROCM_BASE_IMAGE ?= rocm/pytorch:rocm7.2.4_ubuntu24.04_py3.12_pytorch_release_2.8.0

# docker-run settings
PORT        ?= 3900
DATA_VOLUME ?= omnivoice-data
GPU         ?= cuda

help: ## Show this help
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z0-9_-]+:.*## / {printf "  \033[36m%-24s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

# ── Local run ────────────────────────────────────────────────────────────

setup: ## Install JS deps and prepare the Python backend (run once)
	bun install
	bun run setup:api

dev: ## Run the Electron desktop app with hot reload
	bun run dev

web: ## Run backend (:3900) + renderer in a browser (:3901)
	bun run dev:web

api: ## Run only the backend API with auto-reload (:3900)
	bun run dev:api

# ── Docker images ────────────────────────────────────────────────────────

docker-build: ## Build the CUDA image: IMAGE:IMAGE_TAG (default voicestudio:<version>)
	$(DOCKER) build -f deploy/Dockerfile --platform $(PLATFORM) \
		--build-arg BUILD_COMMIT=$(BUILD_COMMIT) $(DOCKER_BUILD_ARGS) \
		-t $(IMAGE):$(IMAGE_TAG) .

docker-build-rocm: ## Build the AMD ROCm image: IMAGE:IMAGE_TAG-rocm
	$(DOCKER) build -f deploy/Dockerfile --platform $(PLATFORM) \
		--build-arg BASE_IMAGE=$(ROCM_BASE_IMAGE) --build-arg GPU_FLAVOR=rocm \
		--build-arg BUILD_COMMIT=$(BUILD_COMMIT) $(DOCKER_BUILD_ARGS) \
		-t $(IMAGE):$(IMAGE_TAG)-rocm .

docker-build-cuda-arm64: ## Build the arm64 NVIDIA image (DGX Spark/Grace): IMAGE:IMAGE_TAG-cuda-arm64
	$(DOCKER) build -f deploy/Dockerfile --platform linux/arm64 \
		--build-arg BASE_IMAGE=cuda-arm64-base --build-arg GPU_FLAVOR=cuda \
		--build-arg BUILD_COMMIT=$(BUILD_COMMIT) $(DOCKER_BUILD_ARGS) \
		-t $(IMAGE):$(IMAGE_TAG)-cuda-arm64 .

docker-build-all: docker-build docker-build-rocm docker-build-cuda-arm64 ## Build every image variant

docker-run: ## Run a built image locally: make docker-run [GPU=cuda|rocm|cpu]
	@test -n "$$OMNIVOICE_API_KEY" || { echo "export a long random OMNIVOICE_API_KEY first"; exit 2; }
	$(DOCKER) run --rm -it --name voicestudio \
		$(if $(filter cuda,$(GPU)),--gpus all) \
		$(if $(filter rocm,$(GPU)),--device /dev/kfd --device /dev/dri) \
		-p 127.0.0.1:$(PORT):3900 \
		-e OMNIVOICE_API_KEY -e HF_TOKEN \
		-v $(DATA_VOLUME):/app/omnivoice_data \
		$(IMAGE):$(IMAGE_TAG)$(if $(filter rocm,$(GPU)),-rocm)

docker-push: ## Push IMAGE:IMAGE_TAG to its registry (set IMAGE=registry/user/voicestudio)
	$(DOCKER) push $(IMAGE):$(IMAGE_TAG)

# ── Release ──────────────────────────────────────────────────────────────

release: ## Cut a release: asks stable/beta, draft/publish, then confirms
	uv run python scripts/release.py

release-dry: ## Show the release plan, change nothing
	uv run python scripts/release.py --dry-run

release-publish: ## Publish an existing draft: make release-publish TAG=v0.5.8
	@test -n "$(TAG)" || { echo "usage: make release-publish TAG=vX.Y.Z[-beta.N]"; exit 2; }
	uv run python scripts/release.py --publish $(TAG)

virustotal: export VIRUSTOTAL_FILE = $(FILE)
virustotal: ## Upload committed HEAD source ZIP, or make virustotal FILE=/path/to/public/file
	$(PYTHON) scripts/virustotal.py
