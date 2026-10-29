import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SafeStorageLike } from '../account/token-store';
import type { RunPodSettings } from '../../preload/index.d';

export type { RunPodSettings };

export interface RunPodSaved {
  settings: RunPodSettings;
  /** The pod this app created, once created. */
  podId: string;
  /** The user's RunPod API key. */
  apiKey: string;
  /** The OMNIVOICE_API_KEY given to the pod's backend; generated with the pod. */
  backendKey: string;
}

export function defaultSettings(version: string): RunPodSettings {
  return {
    image: `redacid/voicestudio:${version}-gpu`,
    gpu: 'NVIDIA GeForce RTX 4090',
    cloud: 'SECURE',
    dataCenter: '',
    networkVolume: '',
    volumeSize: 50,
    disk: 40,
    stopOnQuit: true,
  };
}

/** Validates settings from the renderer; unknown or malformed fields are refused. */
export function parseSettings(raw: unknown, current: RunPodSettings): RunPodSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('Invalid RunPod settings');
  const input = raw as Record<string, unknown>;
  const text = (key: keyof RunPodSettings, max = 512) => {
    const value = input[key];
    if (value === undefined) return current[key] as string;
    if (typeof value !== 'string' || value.length > max) throw new Error(`Invalid RunPod ${key}`);
    return value.trim();
  };
  const size = (key: 'volumeSize' | 'disk') => {
    const value = input[key];
    if (value === undefined) return current[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 10 || value > 4000)
      throw new Error(`Invalid RunPod ${key}`);
    return value;
  };
  const cloud = input.cloud ?? current.cloud;
  if (cloud !== 'SECURE' && cloud !== 'COMMUNITY') throw new Error('Invalid RunPod cloud');
  const stopOnQuit = input.stopOnQuit ?? current.stopOnQuit;
  if (typeof stopOnQuit !== 'boolean') throw new Error('Invalid RunPod stopOnQuit');
  const image = text('image');
  if (!image) throw new Error('Invalid RunPod image');
  return {
    image,
    gpu: text('gpu'),
    cloud,
    dataCenter: text('dataCenter', 64),
    networkVolume: text('networkVolume', 128),
    volumeSize: size('volumeSize'),
    disk: size('disk'),
    stopOnQuit,
  };
}

/**
 * Settings in plain JSON; both keys encrypted with the OS keychain
 * (safeStorage). Without a usable keychain the keys live in memory only and
 * have to be entered again after a restart, never as plain text on disk.
 */
export class RunPodStore {
  readonly persistent: boolean;
  private saved: RunPodSaved;

  constructor(
    private readonly path: string,
    private readonly safe: SafeStorageLike,
    version: string,
    platform: NodeJS.Platform = process.platform,
  ) {
    this.persistent =
      safe.isEncryptionAvailable() &&
      !(platform === 'linux' && safe.getSelectedStorageBackend?.() === 'basic_text');
    this.saved = { settings: defaultSettings(version), podId: '', apiKey: '', backendKey: '' };
    try {
      const file = JSON.parse(readFileSync(path, 'utf8'));
      if (file?.v !== 1) return;
      this.saved = {
        settings: parseSettings(file.settings ?? {}, this.saved.settings),
        podId: typeof file.podId === 'string' ? file.podId : '',
        apiKey: this.decrypt(file.apiKey),
        backendKey: this.decrypt(file.backendKey),
      };
    } catch {
      // Nothing saved yet, or unreadable: start from the defaults.
    }
  }

  get(): RunPodSaved {
    return { ...this.saved, settings: { ...this.saved.settings } };
  }

  update(changes: Partial<RunPodSaved>): RunPodSaved {
    this.saved = { ...this.saved, ...changes };
    this.write();
    return this.get();
  }

  private decrypt(value: unknown): string {
    if (!this.persistent || typeof value !== 'string' || !value) return '';
    try {
      return this.safe.decryptString(Buffer.from(value, 'base64'));
    } catch {
      return ''; // Encrypted by another user or machine: has to be entered again.
    }
  }

  private encrypt(value: string): string {
    return this.persistent && value ? this.safe.encryptString(value).toString('base64') : '';
  }

  private write(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    const body = {
      v: 1,
      settings: this.saved.settings,
      podId: this.saved.podId,
      apiKey: this.encrypt(this.saved.apiKey),
      backendKey: this.encrypt(this.saved.backendKey),
    };
    writeFileSync(temporary, JSON.stringify(body, null, 2), { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, this.path);
  }
}
