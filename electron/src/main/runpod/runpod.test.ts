import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DATA_PATH, MIN_CUDA, podBody, RunPodApi, RunPodError, type Pod } from './runpod-api';
import { RunPodController, type BackendLike } from './runpod-controller';
import { defaultSettings, parseSettings, RunPodStore } from './runpod-store';

const safe = {
  isEncryptionAvailable: () => true,
  encryptString: (plain: string) => Buffer.from(`enc:${plain}`),
  decryptString: (buffer: Buffer) => buffer.toString().replace(/^enc:/, ''),
};

function storePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'runpod-')), 'runpod.json');
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('podBody', () => {
  const spec = {
    ...defaultSettings('1.2.3'),
    name: 'voicestudio',
    env: { OMNIVOICE_API_KEY: 'k' },
  };

  it('exposes the backend port, asks for CUDA 12.8 and mounts the data folder', () => {
    const body = podBody(spec);
    expect(body.image).toBe('redacid/voicestudio:1.2.3-gpu');
    expect(body.ports).toEqual(['3900/http']);
    expect(body.gpu).toEqual({ id: 'NVIDIA GeForce RTX 4090', count: 1, minCudaVersion: MIN_CUDA });
    expect(body.mounts).toEqual({ persistent: { size: 50, path: DATA_PATH } });
    expect(body).not.toHaveProperty('dataCenterIds');
  });

  it('puts the data on a network volume in its data center when one is chosen', () => {
    const body = podBody({ ...spec, networkVolume: 'vol1', dataCenter: 'EU-RO-1' });
    expect(body.mounts).toEqual({ network: [{ volumeId: 'vol1', path: DATA_PATH }] });
    expect(body.dataCenterIds).toEqual(['EU-RO-1']);
  });
});

describe('RunPodApi', () => {
  it('lists NVIDIA GPUs of the chosen cloud, most available first, then cheapest', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).includes('/catalog/gpus')
        ? json(200, {
            gpus: [
              {
                id: 'A100',
                manufacturer: 'NVIDIA',
                memory: 80,
                secure: true,
                price: { secure: 1.9 },
                availability: 'LOW',
              },
              {
                id: 'H100',
                manufacturer: 'NVIDIA',
                memory: 80,
                secure: true,
                price: { secure: 2.5 },
                availability: 'HIGH',
              },
              {
                id: '5090',
                manufacturer: 'NVIDIA',
                memory: 32,
                secure: true,
                price: { secure: 0.6 },
              },
              {
                id: '4090',
                manufacturer: 'NVIDIA',
                memory: 24,
                secure: true,
                price: { secure: 0.7 },
                availability: 'LOW',
              },
              { id: 'MI300', manufacturer: 'AMD', memory: 192, secure: true, price: { secure: 2 } },
              { id: 'L4', manufacturer: 'NVIDIA', memory: 24, secure: false, community: true },
            ],
          })
        : json(200, {
            networkVolumes: [{ id: 'v', name: 'data', size: 100, dataCenter: 'EU-RO-1' }],
          }),
    );
    const catalog = await new RunPodApi('key', fetchImpl as typeof fetch).catalog('SECURE');
    // H100 is free now; 5090 (no availability reported) is not, so it goes last.
    expect(catalog.gpus.map((gpu) => gpu.id)).toEqual(['H100', '4090', 'A100', '5090']);
    expect(catalog.volumes).toEqual([{ id: 'v', name: 'data', size: 100, dataCenter: 'EU-RO-1' }]);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain(`minCudaVersion=${MIN_CUDA}`);
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer key');
  });

  it('names refused keys and deleted pods', async () => {
    const api = (status: number) =>
      new RunPodApi('key', (async () => json(status, {})) as typeof fetch);
    await expect(api(401).pod('p')).rejects.toMatchObject({ kind: 'auth' });
    await expect(api(404).pod('p')).rejects.toMatchObject({ kind: 'gone' });
    await expect(api(500).pod('p')).rejects.toBeInstanceOf(RunPodError);
  });
});

describe('RunPodStore', () => {
  it('keeps the keys encrypted on disk and reads them back', () => {
    const path = storePath();
    new RunPodStore(path, safe, '1.0.0').update({
      apiKey: 'rp-secret',
      backendKey: 'vs-secret',
      podId: 'p1',
    });
    const raw = readFileSync(path, 'utf8');
    expect(raw).not.toContain('rp-secret');
    expect(raw).not.toContain('vs-secret');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const again = new RunPodStore(path, safe, '1.0.0').get();
    expect(again).toMatchObject({ apiKey: 'rp-secret', backendKey: 'vs-secret', podId: 'p1' });
  });

  it('never writes keys in plain text without a keychain', () => {
    const path = storePath();
    const plain = { ...safe, isEncryptionAvailable: () => false };
    new RunPodStore(path, plain, '1.0.0').update({ apiKey: 'rp-secret' });
    expect(readFileSync(path, 'utf8')).not.toContain('rp-secret');
    expect(new RunPodStore(path, plain, '1.0.0').get().apiKey).toBe('');
  });

  it('refuses malformed settings from the renderer', () => {
    const current = defaultSettings('1.0.0');
    expect(parseSettings({ gpu: 'A40', stopOnQuit: false }, current)).toMatchObject({
      gpu: 'A40',
      stopOnQuit: false,
    });
    expect(() => parseSettings({ cloud: 'MOON' }, current)).toThrow();
    expect(() => parseSettings({ disk: 1 }, current)).toThrow();
    expect(() => parseSettings({ image: '' }, current)).toThrow();
    expect(() => parseSettings([], current)).toThrow();
  });
});

describe('RunPodController', () => {
  function setup(statuses: Pod['status'][] = ['STARTING', 'RUNNING']) {
    const store = new RunPodStore(storePath(), safe, '1.0.0');
    store.update({ apiKey: 'rp-key' });
    const pod = (status: Pod['status']): Pod => ({
      id: 'pod1',
      name: 'voicestudio',
      status,
      image: 'img',
      gpu: '4090',
      dataCenter: null,
      cost: 0.7,
      url: 'https://pod1-3900.proxy.runpod.net',
    });
    const queue = [...statuses];
    const api = {
      create: vi.fn(async () => pod('PROVISIONING')),
      pod: vi.fn(async () => pod(queue.length > 1 ? queue.shift()! : queue[0])),
      action: vi.fn(async () => {}),
      terminate: vi.fn(async () => {}),
      catalog: vi.fn(),
    };
    let remote: string | null = null;
    const backend: BackendLike = {
      get connection() {
        return {
          remote: Boolean(remote),
          url: remote ?? 'http://127.0.0.1:3900',
          authenticated: Boolean(remote),
        };
      },
      useRemote: vi.fn(async (url: string) => {
        remote = url;
        return { ok: true as const, detail: '', target: url, authenticated: true };
      }),
      useLocal: vi.fn(async () => {
        remote = null;
        return backend.connection;
      }),
    };
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    const ctl = new RunPodController({
      store,
      backend,
      api: () => api as unknown as RunPodApi,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => {},
    });
    return { ctl, store, api, backend, fetchImpl };
  }

  it('creates a pod with a fresh backend key, waits for /health and connects to it', async () => {
    const { ctl, store, api, backend, fetchImpl } = setup();
    await ctl.create();
    await vi.waitFor(() => expect(ctl.state().connected).toBe(true));
    const key = store.get().backendKey;
    expect(key.length).toBeGreaterThan(20);
    expect(api.create).toHaveBeenCalledWith(
      expect.objectContaining({
        image: 'redacid/voicestudio:1.0.0-gpu',
        env: { OMNIVOICE_API_KEY: key },
      }),
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://pod1-3900.proxy.runpod.net/health',
      expect.anything(),
    );
    expect(backend.useRemote).toHaveBeenCalledWith('https://pod1-3900.proxy.runpod.net', key);
    expect(ctl.state()).toMatchObject({ podId: 'pod1', phase: 'connected' });
  });

  it('starts a stopped pod before connecting', async () => {
    const { ctl, store, api } = setup(['EXITED', 'STARTING', 'RUNNING']);
    store.update({ podId: 'pod1', backendKey: 'k' });
    await ctl.connect();
    expect(api.action).toHaveBeenCalledWith('pod1', 'start');
    expect(ctl.state().connected).toBe(true);
  });

  it('stopping the connected pod switches the app back to the local backend', async () => {
    const { ctl, store, api, backend } = setup(['RUNNING']);
    store.update({ podId: 'pod1', backendKey: 'k' });
    await ctl.connect();
    await ctl.stop();
    expect(api.action).toHaveBeenCalledWith('pod1', 'stop');
    expect(backend.useLocal).toHaveBeenCalled();
    expect(ctl.state().connected).toBe(false);
  });

  it('terminating forgets the pod even when RunPod no longer has it', async () => {
    const { ctl, store, api } = setup(['RUNNING']);
    store.update({ podId: 'pod1', backendKey: 'k' });
    api.terminate.mockRejectedValueOnce(new RunPodError('gone', 'gone'));
    await ctl.terminate();
    expect(store.get()).toMatchObject({ podId: '', backendKey: '' });
  });

  it('stops a running pod on quit only when asked to', async () => {
    const { ctl, store, api } = setup(['RUNNING']);
    store.update({ podId: 'pod1', backendKey: 'k' });
    await ctl.stopOnQuit();
    expect(api.action).toHaveBeenCalledWith('pod1', 'stop');
    api.action.mockClear();
    store.update({ settings: { ...store.get().settings, stopOnQuit: false } });
    await ctl.stopOnQuit();
    expect(api.action).not.toHaveBeenCalled();
  });

  it('resumes only a pod that was the app backend', async () => {
    const { ctl, store, backend } = setup(['RUNNING']);
    store.update({ podId: 'pod1', backendKey: 'k' });
    await ctl.resume();
    expect(backend.useRemote).not.toHaveBeenCalled();
  });

  it('a failed pod is reported, not connected', async () => {
    const { ctl, store, backend } = setup(['ERROR']);
    store.update({ podId: 'pod1', backendKey: 'k' });
    await ctl.connect();
    expect(ctl.state()).toMatchObject({ phase: 'error', error: { kind: 'failed' } });
    expect(backend.useRemote).not.toHaveBeenCalled();
  });
});
