# Maintainer shortcuts; product development uses bun/uv directly.
# `make help` lists every target.

.PHONY: help release release-dry release-publish virustotal \
	setup dev web api \
	docker-base docker-base-cpu docker-base-gpu docker-app docker-app-cpu docker-app-gpu \
	docker-build docker-push-base docker-push-app docker-push \
	docker-run docker-run-cpu docker-run-gpu docker-up docker-logs docker-stop

.DEFAULT_GOAL := help

PYTHON ?= python3

# ── Docker image settings (override on the command line) ─────────────────
# Two layers: a base image per flavor (system + Python deps, rebuilt rarely)
# and an app image for the current version on top of it.
#   redacid/voicestudio:base-cpu      redacid/voicestudio:base-gpu
#   redacid/voicestudio:<version>-cpu redacid/voicestudio:<version>-gpu
#   (+ latest-cpu / latest-gpu)
VERSION      := $(shell sed -nE 's/^[[:space:]]*"version":[[:space:]]*"([^"]+)".*/\1/p' package.json | head -n1)
BUILD_COMMIT ?= $(shell git rev-parse HEAD 2>/dev/null || echo unknown)
IMAGE        ?= redacid/voicestudio
IMAGE_TAG    ?= $(VERSION)
# GPU clouds run x86-64; pin it so Apple Silicon hosts build the same image.
PLATFORM     ?= linux/amd64
DOCKER       ?= docker
DOCKER_BUILD_ARGS ?=
BASE_FROM_cpu ?= python:3.12-slim-bookworm
BASE_FROM_gpu ?= pytorch/pytorch:2.8.0-cuda12.8-cudnn9-runtime
FLAVORS      := cpu gpu
# Dockerfile.base's torch flavor for each image flavor.
torch_flavor = $(if $(filter gpu,$(1)),cuda,cpu)

# docker-run settings
FLAVOR      ?= cpu
PORT        ?= 3900
DATA_VOLUME ?= omnivoice-data
CONTAINER   ?= voicestudio
DOCKER_RUN_ARGS ?=

help: ## Show this help
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z0-9_ -]+:.*## / {printf "  \033[36m%-34s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

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

docker-base: $(addprefix docker-base-,$(FLAVORS)) ## Build both base images (cpu + gpu)

docker-base-cpu docker-base-gpu: docker-base-%: ## Build one base image: IMAGE:base-cpu / base-gpu
	$(DOCKER) build -f deploy/Dockerfile.base --platform $(PLATFORM) \
		--build-arg BASE_IMAGE=$(BASE_FROM_$*) --build-arg FLAVOR=$(call torch_flavor,$*) \
		$(DOCKER_BUILD_ARGS) -t $(IMAGE):base-$* .

docker-app: $(addprefix docker-app-,$(FLAVORS)) ## Build both app images for the current version

docker-app-cpu docker-app-gpu: docker-app-%: ## Build one app image on IMAGE:base-*: IMAGE:<version>-cpu / -gpu
	$(DOCKER) build -f deploy/Dockerfile.app --platform $(PLATFORM) \
		--build-arg BASE_IMAGE=$(IMAGE):base-$* \
		--build-arg BUILD_COMMIT=$(BUILD_COMMIT) $(DOCKER_BUILD_ARGS) \
		-t $(IMAGE):$(IMAGE_TAG)-$* -t $(IMAGE):latest-$* .

docker-build: docker-base docker-app ## Build everything: both bases, then both app images

docker-push-base: ## Push both base images
	$(foreach f,$(FLAVORS),$(DOCKER) push $(IMAGE):base-$(f) &&) true

docker-push-app: ## Push both app images (<version>-* and latest-*)
	$(foreach f,$(FLAVORS),$(DOCKER) push $(IMAGE):$(IMAGE_TAG)-$(f) && $(DOCKER) push $(IMAGE):latest-$(f) &&) true

docker-push: docker-push-base docker-push-app ## Push all images to Docker Hub (run docker login first)

# Local runs reuse one admin key, generated on first run and kept in the
# git-ignored .env (an exported OMNIVOICE_API_KEY wins).
API_KEY_FILE := .env
define ensure_api_key
	@if [ -z "$$OMNIVOICE_API_KEY" ] && ! grep -qs '^OMNIVOICE_API_KEY=' $(API_KEY_FILE); then \
		echo "OMNIVOICE_API_KEY=$$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')" >> $(API_KEY_FILE); \
		echo "Generated OMNIVOICE_API_KEY in $(API_KEY_FILE)"; \
	fi
endef
api_key = $${OMNIVOICE_API_KEY:-$$(sed -n 's/^OMNIVOICE_API_KEY=//p' $(API_KEY_FILE) | head -n1)}

docker_run = $(DOCKER) run --rm --name $(CONTAINER) \
		$(if $(filter gpu,$(1)),--gpus all) \
		-p 127.0.0.1:$(PORT):3900 \
		-e OMNIVOICE_API_KEY="$(api_key)" -e HF_TOKEN \
		-v $(DATA_VOLUME):/app/omnivoice_data \
		$(IMAGE):$(IMAGE_TAG)-$(1)

docker-run: docker-run-$(FLAVOR) ## Run the local app image in the foreground: make docker-run [FLAVOR=cpu|gpu]

docker-run-cpu docker-run-gpu: docker-run-%: ## Run the local cpu / gpu app image in the foreground (Ctrl+C stops)
	$(ensure_api_key)
	@echo "VoiceStudio: http://localhost:$(PORT)"
	$(subst --rm ,--rm -it ,$(call docker_run,$*)) $(DOCKER_RUN_ARGS)

docker-up: ## Start the local app image in the background: make docker-up [FLAVOR=cpu|gpu]
	$(ensure_api_key)
	$(subst --rm ,--rm -d ,$(call docker_run,$(FLAVOR))) $(DOCKER_RUN_ARGS)
	@echo "VoiceStudio: http://localhost:$(PORT)  (make docker-logs / make docker-stop)"

docker-logs: ## Follow logs of the background container
	$(DOCKER) logs -f $(CONTAINER)

docker-stop: ## Stop the background container (data volume is kept)
	$(DOCKER) stop $(CONTAINER)

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
