import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { DATA_PATH, MIN_CUDA, main, parseEnvFile, podBody, redacted, settings } from "./runpod.mjs";

const spec = (overrides = {}) => ({ ...settings({ RUNPOD_IMAGE: "me/vs:1-gpu" }, {}), ...overrides });

test("pod body exposes the backend port, asks for CUDA 12.8 and mounts the data folder", () => {
  const body = podBody(spec({ hfToken: "hf_x" }), "key");
  assert.deepEqual(body.ports, ["3900/http"]);
  assert.deepEqual(body.gpu, { id: "NVIDIA GeForce RTX 4090", count: 1, minCudaVersion: MIN_CUDA });
  assert.deepEqual(body.mounts, { persistent: { size: 50, path: DATA_PATH } });
  assert.deepEqual(body.env, { OMNIVOICE_API_KEY: "key", HF_TOKEN: "hf_x" });
  assert.equal(body.dataCenterIds, undefined);
});

test("a network volume replaces the pod volume and pins nothing else", () => {
  const body = podBody(spec({ networkVolume: "vol1", dataCenter: "EU-RO-1" }), "key");
  assert.deepEqual(body.mounts, { network: [{ volumeId: "vol1", path: DATA_PATH }] });
  assert.deepEqual(body.dataCenterIds, ["EU-RO-1"]);
  assert.equal("HF_TOKEN" in body.env, false);
});

test("redacted hides every env value", () => {
  assert.deepEqual(redacted(podBody(spec({ hfToken: "hf_x" }), "key")).env, {
    OMNIVOICE_API_KEY: "<hidden>",
    HF_TOKEN: "<hidden>",
  });
});

test("environment wins over .env; bad values are refused", () => {
  const s = settings({ RUNPOD_GPU: "A40" }, parseEnvFile("RUNPOD_GPU=L4\nRUNPOD_API_KEY='rp'\n# c\nexport RUNPOD_DISK=60"));
  assert.equal(s.gpu, "A40");
  assert.equal(s.apiKey, "rp");
  assert.equal(s.disk, 60);
  assert.throws(() => settings({ RUNPOD_CLOUD: "moon" }, {}), /SECURE or COMMUNITY/);
  assert.throws(() => settings({ RUNPOD_DISK: "0" }, {}), /positive/);
});

test("create → status → stop → terminate against a fake RunPod API", async (t) => {
  const pods = new Map();
  const calls = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    calls.push(`${req.method} ${req.url}`);
    const send = (code, data) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(data));
    if (req.url === "/health") return send(200, { status: "ok" });
    if (req.headers.authorization !== "Bearer rp-key") return send(401, {});
    if (req.method === "POST" && req.url === "/pods") {
      const pod = { id: "pod1", status: "RUNNING", ...JSON.parse(raw) };
      pods.set(pod.id, pod);
      return send(201, pod);
    }
    const match = req.url.match(/^\/pods\/([^/]+)(\/action)?$/);
    const pod = match && pods.get(match[1]);
    if (!pod) return send(404, { title: "Not found" });
    if (match[2]) pod.status = JSON.parse(raw).action === "stop" ? "EXITED" : "RUNNING";
    if (req.method === "DELETE") pods.delete(pod.id);
    return send(200, pod);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = mkdtempSync(path.join(tmpdir(), "runpod-"));
  const env = {
    RUNPOD_API_KEY: "rp-key",
    RUNPOD_API_URL: base,
    RUNPOD_PROXY_URL: base, // the fake also answers /health
    RUNPOD_STATE_FILE: path.join(dir, "state.json"),
    RUNPOD_IMAGE: "me/vs:1-gpu",
  };
  const out = [];
  const print = (line) => out.push(line);

  await main(["create"], env, print);
  const state = JSON.parse(readFileSync(env.RUNPOD_STATE_FILE, "utf8"));
  assert.equal(state.podId, "pod1");
  assert.equal(statSync(env.RUNPOD_STATE_FILE).mode & 0o777, 0o600);
  assert.equal(pods.get("pod1").env.OMNIVOICE_API_KEY, state.apiKey);
  assert.match(out.join("\n"), new RegExp(`API key:  ${state.apiKey}`));

  await assert.rejects(main(["create"], env, print), /already exists/);

  await main(["stop"], env, print);
  assert.equal(pods.get("pod1").status, "EXITED");
  await main(["start"], env, print);
  assert.equal(pods.get("pod1").status, "RUNNING");

  await main(["terminate"], env, print);
  assert.equal(pods.size, 0);
  assert.equal(existsSync(env.RUNPOD_STATE_FILE), false);
  assert.ok(calls.includes("DELETE /pods/pod1"));
});
