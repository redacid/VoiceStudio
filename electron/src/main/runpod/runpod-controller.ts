import { randomBytes } from 'node:crypto';
import type {
  BackendConnection,
  RemoteBackendProbe,
  RunPodPhase,
  RunPodPublicState,
} from '../../preload/index.d';
import {
  backendUrl,
  RunPodApi,
  RunPodError,
  type Catalog,
  type Cloud,
  type Pod,
} from './runpod-api';

export type { RunPodPublicState };
import { parseSettings, type RunPodStore } from './runpod-store';

export interface BackendLike {
  readonly connection: BackendConnection;
  useRemote(url: string, apiKey: string): Promise<RemoteBackendProbe>;
  useLocal(): Promise<BackendConnection>;
}

interface Deps {
  store: RunPodStore;
  backend: BackendLike;
  api?: (apiKey: string) => RunPodApi;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** How long a pod may take to start, pull the image and answer /health. */
  readyTimeoutMs?: number;
  pollMs?: number;
}

const ACTIVE = new Set(['PROVISIONING', 'STARTING', 'RUNNING']);

export class RunPodController {
  private phase: RunPodPhase = 'idle';
  private error: RunPodPublicState['error'] = null;
  private pod: Pod | null = null;
  /** What the pod's backend reports on /health: the way to tell a CUDA backend from a CPU one. */
  private device: string | null = null;
  private generation = 0;
  private readonly listeners = new Set<(state: RunPodPublicState) => void>();
  private readonly api: (apiKey: string) => RunPodApi;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: Deps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.api = deps.api ?? ((key) => new RunPodApi(key, this.fetchImpl));
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  onChange(listener: (state: RunPodPublicState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  state(): RunPodPublicState {
    const saved = this.deps.store.get();
    const connection = this.deps.backend.connection;
    const connected =
      Boolean(saved.podId) && connection.remote && connection.url === backendUrl(saved.podId);
    return {
      settings: saved.settings,
      apiKeySet: Boolean(saved.apiKey),
      persistent: this.deps.store.persistent,
      podId: saved.podId,
      pod: this.pod,
      phase: this.phase === 'connected' && !connected ? 'idle' : this.phase,
      error: this.error,
      connected,
      backendDevice: saved.podId ? this.device : null,
    };
  }

  /** Re-reads the pod from RunPod; a pod deleted on runpod.io is forgotten. */
  async refresh(): Promise<RunPodPublicState> {
    const saved = this.deps.store.get();
    if (saved.podId && saved.apiKey) {
      try {
        this.pod = await this.api(saved.apiKey).pod(saved.podId);
      } catch (error) {
        this.fail(error);
      }
    }
    return this.emit();
  }

  saveSettings(raw: unknown): RunPodPublicState {
    const saved = this.deps.store.get();
    this.deps.store.update({ settings: parseSettings(raw, saved.settings) });
    return this.emit();
  }

  setApiKey(key: unknown): RunPodPublicState {
    if (typeof key !== 'string' || key.length > 512) throw new Error('Invalid RunPod API key');
    this.deps.store.update({ apiKey: key.trim() });
    this.error = null;
    return this.emit();
  }

  async catalog(cloud: unknown): Promise<Catalog> {
    if (cloud !== 'SECURE' && cloud !== 'COMMUNITY') throw new Error('Invalid RunPod cloud');
    return this.api(this.requireKey()).catalog(cloud as Cloud);
  }

  async create(): Promise<RunPodPublicState> {
    const saved = this.deps.store.get();
    const apiKey = this.requireKey();
    if (saved.podId) throw new Error('A pod already exists; terminate it first');
    if (!saved.settings.gpu) throw new Error('Choose a GPU first');
    const backendKey = randomBytes(24).toString('base64url');
    this.begin('creating');
    try {
      this.pod = await this.api(apiKey).create({
        ...saved.settings,
        name: 'voicestudio',
        env: { OMNIVOICE_API_KEY: backendKey },
      });
    } catch (error) {
      this.fail(error);
      return this.emit();
    }
    this.deps.store.update({ podId: this.pod.id, backendKey });
    void this.connect();
    return this.emit();
  }

  /** Starts the pod if it is stopped, waits for its backend, and makes it the app's backend. */
  async connect(): Promise<RunPodPublicState> {
    const saved = this.deps.store.get();
    const apiKey = this.requireKey();
    if (!saved.podId || !saved.backendKey) throw new Error('Create a pod first');
    const generation = this.begin('starting');
    // A restarted pod may land on another machine.
    this.device = null;
    const api = this.api(apiKey);
    const deadline = Date.now() + (this.deps.readyTimeoutMs ?? 20 * 60_000);
    try {
      let pod = await api.pod(saved.podId);
      if (pod.status === 'TERMINATED') throw new RunPodError('The pod was terminated', 'gone');
      if (pod.status === 'EXITED') {
        await api.action(pod.id, 'start');
        pod = { ...pod, status: 'STARTING' };
      }
      for (;;) {
        if (generation !== this.generation) return this.state();
        this.pod = pod;
        if (pod.status === 'ERROR') throw new RunPodError('The pod failed to start', 'failed');
        if (pod.status === 'RUNNING') {
          this.set(generation, 'waiting');
          if (await this.healthy(pod.url)) break;
        } else this.set(generation, 'starting');
        if (Date.now() > deadline)
          throw new RunPodError('The pod was not ready in time', 'timeout');
        await this.sleep(this.deps.pollMs ?? 5000);
        pod = await api.pod(saved.podId);
      }
      this.set(generation, 'connecting');
      const probe = await this.deps.backend.useRemote(pod.url, saved.backendKey);
      if (!probe.ok) {
        this.error = { kind: 'connect', message: probe.kind };
        this.set(generation, 'error');
      } else {
        this.set(generation, 'connected');
        void this.watchDevice(generation, pod.url);
      }
    } catch (error) {
      if (generation === this.generation) this.fail(error);
    }
    return this.emit();
  }

  async stop(): Promise<RunPodPublicState> {
    const saved = this.deps.store.get();
    const apiKey = this.requireKey();
    if (!saved.podId) return this.state();
    const wasConnected = this.state().connected;
    this.begin('stopping');
    try {
      await this.api(apiKey).action(saved.podId, 'stop');
      this.pod = this.pod ? { ...this.pod, status: 'EXITED' } : null;
      if (wasConnected) await this.deps.backend.useLocal();
      this.phase = 'idle';
    } catch (error) {
      this.fail(error);
    }
    return this.emit();
  }

  async terminate(): Promise<RunPodPublicState> {
    const saved = this.deps.store.get();
    const apiKey = this.requireKey();
    if (!saved.podId) return this.state();
    const wasConnected = this.state().connected;
    this.begin('stopping');
    try {
      await this.api(apiKey).terminate(saved.podId);
    } catch (error) {
      if (!(error instanceof RunPodError && error.kind === 'gone')) {
        this.fail(error);
        return this.emit();
      }
    }
    this.forget();
    if (wasConnected) await this.deps.backend.useLocal();
    return this.emit();
  }

  /** At app start: a pod that was the app's backend is started again and re-authenticated. */
  async resume(): Promise<void> {
    const saved = this.deps.store.get();
    if (!saved.apiKey || !saved.backendKey || !saved.podId) return;
    const connection = this.deps.backend.connection;
    if (!connection.remote || connection.url !== backendUrl(saved.podId)) return;
    await this.connect();
  }

  /** On quit: a running pod is stopped when the settings say so, so it is not billed. */
  async stopOnQuit(): Promise<void> {
    const saved = this.deps.store.get();
    if (!saved.settings.stopOnQuit || !saved.podId || !saved.apiKey) return;
    this.generation += 1;
    const api = this.api(saved.apiKey);
    try {
      const pod = await api.pod(saved.podId);
      if (ACTIVE.has(pod.status)) await api.action(pod.id, 'stop');
    } catch {
      // Best effort: the user can still stop it on runpod.io.
    }
  }

  private async healthy(url: string): Promise<boolean> {
    try {
      const response = await this.fetchImpl(`${url}/health`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return false;
      const body = (await response.json().catch(() => ({}))) as { device?: unknown };
      if (typeof body.device === 'string' && body.device !== 'unknown') this.device = body.device;
      return true;
    } catch {
      return false;
    }
  }

  /** The backend names its device only after torch loads, so /health says "unknown" at first. */
  private async watchDevice(generation: number, url: string): Promise<void> {
    for (let attempt = 0; attempt < 24 && !this.device; attempt += 1) {
      await this.sleep(this.deps.pollMs ?? 5000);
      if (generation !== this.generation) return;
      await this.healthy(url);
    }
    if (generation === this.generation) this.emit();
  }

  private requireKey(): string {
    const key = this.deps.store.get().apiKey;
    if (!key) throw new Error('Enter your RunPod API key first');
    return key;
  }

  private forget(): void {
    this.deps.store.update({ podId: '', backendKey: '' });
    this.pod = null;
    this.device = null;
    this.phase = 'idle';
  }

  private begin(phase: RunPodPhase): number {
    this.generation += 1;
    this.error = null;
    this.phase = phase;
    this.emit();
    return this.generation;
  }

  private set(generation: number, phase: RunPodPhase): void {
    if (generation !== this.generation || this.phase === phase) return;
    this.phase = phase;
    this.emit();
  }

  private fail(error: unknown): void {
    if (error instanceof RunPodError && error.kind === 'gone') {
      this.forget();
      this.error = { kind: 'gone', message: error.message };
      return;
    }
    const kind = error instanceof RunPodError ? error.kind : 'api';
    this.error = { kind, message: (error as Error).message };
    this.phase = 'error';
  }

  private emit(): RunPodPublicState {
    const state = this.state();
    for (const listener of this.listeners) listener(state);
    return state;
  }
}
