#!/usr/bin/env node
// ──────────────────────────────────────────────────────────────────────────
// runpod.mjs — create, start, stop and terminate one RunPod pod that runs the
// VoiceStudio GPU image, from the command line (`make runpod-*`).
//
// Talks to RunPod's REST API v2 (https://docs.runpod.io/api-reference-v2/overview)
// with RUNPOD_API_KEY. Nothing is sent anywhere until you run a command.
//
// Settings come from the environment or the git-ignored `.env`:
//   RUNPOD_API_KEY         required; runpod.io > Settings > API Keys (All)
//   RUNPOD_IMAGE           default redacid/voicestudio:<version>-gpu
//   RUNPOD_GPU             default "NVIDIA GeForce RTX 4090" (see `gpus`)
//   RUNPOD_CLOUD           SECURE (default) or COMMUNITY
//   RUNPOD_DATA_CENTER     e.g. EU-RO-1; empty lets RunPod choose
//   RUNPOD_NETWORK_VOLUME  network volume id to keep data on; else a pod volume
//   RUNPOD_VOLUME_SIZE     pod volume in GB (default 50)
//   RUNPOD_DISK            container disk in GB (default 40)
//   RUNPOD_POD_NAME        default voicestudio
//   HF_TOKEN               passed to the pod for gated models
//
// The pod gets a newly generated OMNIVOICE_API_KEY. Its id and that key are kept
// in the git-ignored `.runpod.json` (mode 0600), so later commands know the pod.
// Connect the app to it under Settings > Remote backend with the URL and key that
// `make runpod-status` prints.
// ──────────────────────────────────────────────────────────────────────────

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The backend's port inside the image (deploy/Dockerfile.app EXPOSE). */
export const BACKEND_PORT = 3900;
/** deploy/Dockerfile.base builds on CUDA 12.8; older host drivers cannot run it. */
export const MIN_CUDA = "12.8";
/** Where the image keeps voices, projects, settings and the Hugging Face cache. */
export const DATA_PATH = "/app/omnivoice_data";

export function apiUrl(env = process.env) {
  return env.RUNPOD_API_URL || "https://api.runpod.io/v2";
}

export function backendUrl(podId, env = process.env) {
  return (env.RUNPOD_PROXY_URL || `https://{id}-${BACKEND_PORT}.proxy.runpod.net`).replace("{id}", podId);
}

/** KEY=value lines; quotes stripped, comments and blanks skipped. */
export function parseEnvFile(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    out[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

function appVersion() {
  return JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
}

/** Pod settings from the environment, with `.env` filling in what is unset. */
export function settings(env = process.env, dotenv = {}) {
  const get = (key, fallback = "") => (env[key] ?? dotenv[key] ?? fallback).trim();
  const number = (key, fallback) => {
    const value = Number.parseInt(get(key, String(fallback)), 10);
    if (!Number.isInteger(value) || value <= 0) throw new Error(`${key} must be a positive number of GB`);
    return value;
  };
  const cloud = get("RUNPOD_CLOUD", "SECURE").toUpperCase();
  if (cloud !== "SECURE" && cloud !== "COMMUNITY") throw new Error("RUNPOD_CLOUD must be SECURE or COMMUNITY");
  return {
    apiKey: get("RUNPOD_API_KEY"),
    image: get("RUNPOD_IMAGE") || `redacid/voicestudio:${appVersion()}-gpu`,
    gpu: get("RUNPOD_GPU", "NVIDIA GeForce RTX 4090"),
    cloud,
    dataCenter: get("RUNPOD_DATA_CENTER"),
    networkVolume: get("RUNPOD_NETWORK_VOLUME"),
    volumeSize: number("RUNPOD_VOLUME_SIZE", 50),
    disk: number("RUNPOD_DISK", 40),
    name: get("RUNPOD_POD_NAME", "voicestudio"),
    hfToken: get("HF_TOKEN"),
  };
}

/** The body of POST /pods for these settings and the pod's backend key. */
export function podBody(spec, backendKey) {
  const env = { OMNIVOICE_API_KEY: backendKey };
  if (spec.hfToken) env.HF_TOKEN = spec.hfToken;
  return {
    name: spec.name,
    image: spec.image,
    gpu: { id: spec.gpu, count: 1, minCudaVersion: MIN_CUDA },
    cloud: spec.cloud,
    ...(spec.dataCenter ? { dataCenterIds: [spec.dataCenter] } : {}),
    disk: spec.disk,
    ports: [`${BACKEND_PORT}/http`],
    // A network volume outlives the pod; a pod volume is kept while the pod is
    // stopped and deleted with it.
    mounts: spec.networkVolume
      ? { network: [{ volumeId: spec.networkVolume, path: DATA_PATH }] }
      : { persistent: { size: spec.volumeSize, path: DATA_PATH } },
    env,
  };
}

/** The same body with secrets replaced, for --dry-run and logs. */
export function redacted(body) {
  return { ...body, env: Object.fromEntries(Object.keys(body.env).map((k) => [k, "<hidden>"])) };
}

export class RunPodError extends Error {}
export class PodGone extends RunPodError {}

export class RunPod {
  constructor(apiKey, env = process.env) {
    if (!apiKey) throw new RunPodError("Set RUNPOD_API_KEY (environment or .env): runpod.io > Settings > API Keys");
    this.apiKey = apiKey;
    this.base = apiUrl(env);
  }

  pod(id) {
    return this.call("GET", `/pods/${encodeURIComponent(id)}`);
  }

  create(body) {
    return this.call("POST", "/pods", body);
  }

  action(id, action) {
    return this.call("POST", `/pods/${encodeURIComponent(id)}/action`, { action });
  }

  terminate(id) {
    return this.call("DELETE", `/pods/${encodeURIComponent(id)}`);
  }

  async gpus(cloud) {
    const query = new URLSearchParams({ include: "AVAILABILITY", product: "POD", cloud, minCudaVersion: MIN_CUDA });
    const data = await this.call("GET", `/catalog/gpus?${query}`);
    const secure = cloud === "SECURE";
    return (Array.isArray(data.gpus) ? data.gpus : [])
      .filter((g) => (secure ? g.secure : g.community) && (g.manufacturer ?? "NVIDIA") === "NVIDIA")
      .map((g) => ({
        id: String(g.id),
        memory: Number(g.memory ?? 0),
        price: Number((secure ? g.price?.secure : g.price?.community) ?? 0),
        availability: String(g.availability ?? "NONE"),
      }))
      .sort((a, b) => a.price - b.price);
  }

  async call(method, route, body) {
    let response;
    try {
      response = await fetch(`${this.base}${route}`, {
        method,
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new RunPodError(`RunPod is not reachable: ${error.message}`);
    }
    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      // Not JSON: the text itself is the message.
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403)
        throw new RunPodError("RunPod refused RUNPOD_API_KEY: it needs All permissions");
      if (response.status === 404 && route.startsWith("/pods/"))
        throw new PodGone(`The pod ${decodeURIComponent(route.split("/")[2])} is not on RunPod any more`);
      const errors = Array.isArray(data.errors) ? data.errors.map((e) => JSON.stringify(e)).join("; ") : "";
      const detail = [data.title, data.detail, errors].filter(Boolean).join(": ") || text || response.statusText;
      throw new RunPodError(`RunPod: ${detail} (HTTP ${response.status})`);
    }
    return data;
  }
}

// ── state: the one pod this checkout manages ─────────────────────────────

export function stateFile(env = process.env) {
  return env.RUNPOD_STATE_FILE || path.join(ROOT, ".runpod.json");
}

export function loadState(file) {
  try {
    const state = JSON.parse(readFileSync(file, "utf8"));
    return state && typeof state.podId === "string" && state.podId ? state : null;
  } catch {
    return null;
  }
}

function saveState(file, state) {
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

// ── commands ─────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until the pod runs and the backend's /health answers. */
export async function waitReady(runpod, podId, { env = process.env, timeoutMs = 20 * 60_000, intervalMs = 5_000, print = console.log } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  for (;;) {
    const pod = await runpod.pod(podId);
    const status = String(pod.status ?? "PROVISIONING");
    if (status === "TERMINATED") throw new RunPodError(`The pod ${podId} was terminated`);
    if (status === "ERROR") throw new RunPodError(`The pod ${podId} failed to start; see its logs on runpod.io`);
    if (status === "RUNNING") {
      try {
        const health = await fetch(`${backendUrl(podId, env)}/health`, { signal: AbortSignal.timeout(10_000) });
        if (health.ok) return pod;
        if (last !== "health") print(`Pod running; waiting for the backend (first start downloads models)…`);
        last = "health";
      } catch {
        if (last !== "health") print(`Pod running; waiting for the backend (first start downloads models)…`);
        last = "health";
      }
    } else if (status !== last) {
      print(`Pod ${status.toLowerCase()}…`);
      last = status;
    }
    if (Date.now() > deadline) throw new RunPodError(`The pod ${podId} was not ready in time; try make runpod-status later`);
    await sleep(intervalMs);
  }
}

function describe(pod, state, env) {
  const gpu = pod.gpu?.id ? `${pod.gpu.count > 1 ? `${pod.gpu.count} × ` : ""}${pod.gpu.id}` : "-";
  return [
    `Pod:      ${pod.id} (${pod.name ?? ""})`,
    `Status:   ${pod.status}`,
    `Image:    ${pod.image ?? "-"}`,
    `GPU:      ${gpu}${pod.dataCenterId ? ` in ${pod.dataCenterId}` : ""}`,
    ...(typeof pod.cost === "number" ? [`Cost:     $${pod.cost.toFixed(3)}/h while running`] : []),
    `URL:      ${backendUrl(pod.id, env)}`,
    `API key:  ${state?.apiKey ?? "(not created here)"}`,
  ].join("\n");
}

export async function main(argv = process.argv.slice(2), env = process.env, print = console.log) {
  const [command = "help", ...rest] = argv;
  const flags = new Set(rest);
  const dotenvPath = path.join(ROOT, ".env");
  const dotenv = existsSync(dotenvPath) ? parseEnvFile(readFileSync(dotenvPath, "utf8")) : {};
  const spec = settings(env, dotenv);
  const file = stateFile(env);
  const state = loadState(file);
  const needPod = () => {
    if (!state) throw new RunPodError("No pod yet: make runpod-create");
    return state.podId;
  };

  switch (command) {
    case "create": {
      if (state && !flags.has("--force"))
        throw new RunPodError(`Pod ${state.podId} already exists: make runpod-start, or make runpod-terminate first`);
      const backendKey = randomBytes(24).toString("base64url");
      const body = podBody(spec, backendKey);
      if (flags.has("--dry-run")) {
        print(`POST ${apiUrl(env)}/pods`);
        print(JSON.stringify(redacted(body), null, 2));
        return;
      }
      const runpod = new RunPod(spec.apiKey, env);
      print(`Creating pod ${spec.name}: ${spec.image} on ${spec.gpu} (${spec.cloud})…`);
      const pod = await runpod.create(body);
      saveState(file, { podId: String(pod.id), apiKey: backendKey, image: spec.image, createdAt: new Date().toISOString() });
      print(`Created pod ${pod.id}`);
      if (!flags.has("--no-wait")) await waitReady(runpod, String(pod.id), { env, print });
      print(describe(await runpod.pod(String(pod.id)), { apiKey: backendKey }, env));
      return;
    }
    case "start": {
      const id = needPod();
      const runpod = new RunPod(spec.apiKey, env);
      const pod = await runpod.pod(id);
      if (pod.status !== "RUNNING") {
        print(`Starting pod ${id}…`);
        await runpod.action(id, "start");
      }
      if (!flags.has("--no-wait")) await waitReady(runpod, id, { env, print });
      print(describe(await runpod.pod(id), state, env));
      return;
    }
    case "stop": {
      const id = needPod();
      await new RunPod(spec.apiKey, env).action(id, "stop");
      print(`Stopped pod ${id} (billing stops; its volume is kept)`);
      return;
    }
    case "terminate": {
      const id = needPod();
      try {
        await new RunPod(spec.apiKey, env).terminate(id);
      } catch (error) {
        if (!(error instanceof PodGone)) throw error;
      }
      rmSync(file, { force: true });
      print(`Terminated pod ${id} and its pod volume (a network volume stays)`);
      return;
    }
    case "status": {
      const id = needPod();
      try {
        print(describe(await new RunPod(spec.apiKey, env).pod(id), state, env));
      } catch (error) {
        if (error instanceof PodGone) rmSync(file, { force: true });
        throw error;
      }
      return;
    }
    case "gpus": {
      const gpus = await new RunPod(spec.apiKey, env).gpus(spec.cloud);
      print(`GPUs in ${spec.cloud} cloud with CUDA ${MIN_CUDA}+ (set RUNPOD_GPU to an id):`);
      for (const g of gpus)
        print(`  ${g.id.padEnd(36)} ${String(g.memory).padStart(4)} GB  $${g.price.toFixed(2)}/h  ${g.availability}`);
      return;
    }
    default:
      print("usage: node scripts/runpod.mjs create [--dry-run|--no-wait|--force] | start | stop | status | terminate | gpus");
      if (command !== "help") process.exitCode = 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof RunPodError ? error.message : error);
    process.exitCode = 1;
  });
}
