# Maintainer shortcuts; product development uses bun/uv directly.
# `make help` lists every target.

.PHONY: help release release-dry release-publish virustotal \
	setup dev web api \
	docker-base docker-base-cpu docker-base-gpu docker-app docker-app-cpu docker-app-gpu \
	docker-build docker-push-base docker-push-app docker-push docker-run

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

docker-run: ## Run an app image locally: make docker-run [FLAVOR=cpu|gpu]
	@test -n "$$OMNIVOICE_API_KEY" || { echo "export a long random OMNIVOICE_API_KEY first"; exit 2; }
	$(DOCKER) run --rm -it --name voicestudio \
		$(if $(filter gpu,$(FLAVOR)),--gpus all) \
		-p 127.0.0.1:$(PORT):3900 \
		-e OMNIVOICE_API_KEY -e HF_TOKEN \
		-v $(DATA_VOLUME):/app/omnivoice_data \
		$(IMAGE):$(IMAGE_TAG)-$(FLAVOR)

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
