import type {
  RunPodAvailability,
  RunPodCatalog,
  RunPodCloud,
  RunPodPod,
  RunPodPodStatus,
} from '../../preload/index.d';

// A small client for RunPod's REST API v2: the one GPU pod that runs the
// VoiceStudio image. https://docs.runpod.io/api-reference-v2/overview
// Nothing here runs until the user enters a RunPod API key and acts in
// Settings > Sharing > RunPod.

/** The backend's port inside the image; RunPod's proxy serves it as https://<pod>-3900.proxy.runpod.net. */
export const BACKEND_PORT = 3900;
/** deploy/Dockerfile.base builds on CUDA 12.8; hosts with an older driver cannot run it. */
export const MIN_CUDA = '12.8';
/** Where the image keeps voices, projects, settings and the Hugging Face cache. */
export const DATA_PATH = '/app/omnivoice_data';

// Overridable for tests, which talk to a fake API and a local backend.
const API_URL = process.env.VOICESTUDIO_RUNPOD_API_URL ?? 'https://api.runpod.io/v2';
const PROXY_URL =
  process.env.VOICESTUDIO_RUNPOD_PROXY_URL ?? `https://{id}-${BACKEND_PORT}.proxy.runpod.net`;

export type PodStatus = RunPodPodStatus;
export type Pod = RunPodPod;
export type Cloud = RunPodCloud;
export type Availability = RunPodAvailability;
export type Catalog = RunPodCatalog;

export interface PodSpec {
  name: string;
  image: string;
  gpu: string;
  cloud: Cloud;
  /** Data center id, e.g. "EU-RO-1"; "" lets RunPod choose. */
  dataCenter: string;
  /** Container disk in GB: the image and temporary files. */
  disk: number;
  /** A network volume to keep the data on; without one, a pod volume of volumeSize GB. */
  networkVolume: string;
  volumeSize: number;
  env: Record<string, string>;
}

export class RunPodError extends Error {
  constructor(
    message: string,
    readonly kind: 'network' | 'auth' | 'gone' | 'api' | 'timeout' | 'failed' = 'api',
  ) {
    super(message);
  }
}

export function backendUrl(podId: string): string {
  return PROXY_URL.replace('{id}', podId);
}

/** The body of POST /pods for the spec. */
export function podBody(spec: PodSpec): Record<string, unknown> {
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
    env: spec.env,
  };
}

type Json = Record<string, unknown>;

interface ApiGpu {
  id?: unknown;
  manufacturer?: string;
  memory?: number;
  secure?: boolean;
  community?: boolean;
  price?: { secure?: number; community?: number };
  availability?: Availability;
  dataCenters?: { id?: unknown }[];
}
interface ApiVolume {
  id?: unknown;
  name?: unknown;
  size?: number;
  dataCenter?: unknown;
}

export class RunPodApi {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async pod(id: string): Promise<Pod> {
    return toPod(await this.call('GET', `/pods/${encodeURIComponent(id)}`));
  }

  async create(spec: PodSpec): Promise<Pod> {
    return toPod(await this.call('POST', '/pods', podBody(spec)));
  }

  async action(id: string, action: 'start' | 'stop'): Promise<void> {
    await this.call('POST', `/pods/${encodeURIComponent(id)}/action`, { action });
  }

  /** Deletes the pod and its pod volume; a network volume stays. */
  async terminate(id: string): Promise<void> {
    await this.call('DELETE', `/pods/${encodeURIComponent(id)}`);
  }

  /** NVIDIA GPUs offered with CUDA 12.8+, cheapest first, and the account's network volumes. */
  async catalog(cloud: Cloud): Promise<Catalog> {
    const query = new URLSearchParams({
      include: 'AVAILABILITY',
      product: 'POD',
      cloud,
      minCudaVersion: MIN_CUDA,
    });
    const [gpus, volumes] = await Promise.all([
      this.call('GET', `/catalog/gpus?${query}`),
      this.call('GET', '/network-volumes'),
    ]);
    const list = <T>(data: Json, key: string) => (Array.isArray(data[key]) ? data[key] : []) as T[];
    const secure = cloud === 'SECURE';
    return {
      gpus: list<ApiGpu>(gpus, 'gpus')
        .filter(
          (g) => (secure ? g.secure : g.community) && (g.manufacturer ?? 'NVIDIA') === 'NVIDIA',
        )
        .map((g) => ({
          id: String(g.id),
          memory: Number(g.memory ?? 0),
          price: Number((secure ? g.price?.secure : g.price?.community) ?? 0),
          availability: (g.availability ?? 'NONE') as Availability,
          dataCenters: (g.dataCenters ?? []).map((d) => String(d.id)),
        }))
        .sort((a, b) => a.price - b.price),
      volumes: list<ApiVolume>(volumes, 'networkVolumes').map((v) => ({
        id: String(v.id),
        name: String(v.name ?? v.id),
        size: Number(v.size ?? 0),
        dataCenter: String(v.dataCenter ?? ''),
      })),
    };
  }

  private async call(method: string, path: string, body?: unknown): Promise<Json> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${API_URL}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new RunPodError(`RunPod is not reachable: ${(error as Error).message}`, 'network');
    }
    const text = await response.text();
    let data: Json = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      // Not JSON: the text itself is the message.
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403)
        throw new RunPodError('RunPod refused the API key', 'auth');
      if (response.status === 404 && path.startsWith('/pods/'))
        throw new RunPodError('The pod is not on RunPod any more', 'gone');
      // RFC 9457 problem details: title and detail, sometimes a list of field errors.
      const errors = Array.isArray(data.errors)
        ? data.errors.map((e) => JSON.stringify(e)).join('; ')
        : '';
      const detail =
        [data.title, data.detail, errors].filter(Boolean).join(': ') || text || response.statusText;
      throw new RunPodError(`${detail} (HTTP ${response.status})`);
    }
    return data;
  }
}

function toPod(data: Json): Pod {
  const id = String(data.id);
  const gpu = data.gpu as { id?: string; count?: number } | null | undefined;
  return {
    id,
    name: String(data.name ?? ''),
    status: (data.status as PodStatus) ?? 'PROVISIONING',
    image: String(data.image ?? ''),
    gpu: gpu?.id ? (gpu.count && gpu.count > 1 ? `${gpu.count} × ${gpu.id}` : gpu.id) : null,
    dataCenter: typeof data.dataCenterId === 'string' ? data.dataCenterId : null,
    cost: typeof data.cost === 'number' ? data.cost : null,
    url: backendUrl(id),
  };
}
