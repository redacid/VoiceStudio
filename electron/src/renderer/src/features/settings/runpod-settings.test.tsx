import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import type { RunPodPublicState } from '../../../../preload/index.d';

const mock = vi.hoisted(() => ({
  refresh: vi.fn(),
  setApiKey: vi.fn(),
  create: vi.fn(),
  stop: vi.fn(),
  terminate: vi.fn(),
  connect: vi.fn(),
  saveSettings: vi.fn(),
  catalog: vi.fn(),
  listener: null as ((state: RunPodPublicState) => void) | null,
  reload: vi.fn(),
}));

vi.mock('@/components/bridge', () => ({
  getBridge: () => ({
    runpod: {
      refresh: mock.refresh,
      setApiKey: mock.setApiKey,
      create: mock.create,
      stop: mock.stop,
      terminate: mock.terminate,
      connect: mock.connect,
      saveSettings: mock.saveSettings,
      catalog: mock.catalog,
      onState: (cb: (state: RunPodPublicState) => void) => {
        mock.listener = cb;
        return () => {};
      },
    },
  }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { RunPodSettings } from './runpod-settings';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function state(over: Partial<RunPodPublicState> = {}): RunPodPublicState {
  return {
    settings: {
      image: 'redacid/voicestudio:1.0.0-gpu',
      gpu: 'NVIDIA GeForce RTX 4090',
      cloud: 'SECURE',
      dataCenter: '',
      networkVolume: '',
      volumeSize: 50,
      disk: 40,
      stopOnQuit: true,
    },
    apiKeySet: false,
    persistent: true,
    podId: '',
    pod: null,
    phase: 'idle',
    error: null,
    connected: false,
    ...over,
  };
}

function renderSettings(initial: RunPodPublicState) {
  mock.refresh.mockResolvedValue(initial);
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <RunPodSettings reload={mock.reload} />
    </QueryClientProvider>,
  );
}

it('saves the RunPod key through main and clears it from the renderer', async () => {
  mock.setApiKey.mockResolvedValue(state({ apiKeySet: true }));
  renderSettings(state());
  await screen.findByText('runpod.create');
  const input = document.querySelector<HTMLInputElement>('input[type="password"]')!;
  expect(screen.getByText('runpod.create').closest('button')).toBeDisabled();
  fireEvent.change(input, { target: { value: 'rp-secret' } });
  fireEvent.click(screen.getByText('runpod.save_key'));
  await waitFor(() => expect(mock.setApiKey).toHaveBeenCalledWith('rp-secret'));
  await waitFor(() => expect(input.value).toBe(''));
  expect(screen.getByText('runpod.create').closest('button')).toBeEnabled();
});

it('creates a pod and reloads once the app is connected to it', async () => {
  const pod = {
    id: 'pod1',
    name: 'voicestudio',
    status: 'RUNNING' as const,
    image: 'img',
    gpu: '4090',
    dataCenter: null,
    cost: 0.69,
    url: 'https://pod1-3900.proxy.runpod.net',
  };
  mock.create.mockResolvedValue(state({ apiKeySet: true, podId: 'pod1', pod, phase: 'starting' }));
  renderSettings(state({ apiKeySet: true }));
  const create = (await screen.findByText('runpod.create')).closest('button')!;
  await waitFor(() => expect(create).toBeEnabled());
  fireEvent.click(create);
  await waitFor(() => expect(mock.create).toHaveBeenCalled());
  expect(await screen.findByText('runpod.phase_starting')).toBeInTheDocument();
  expect(mock.reload).not.toHaveBeenCalled();
  act(() =>
    mock.listener?.(
      state({ apiKeySet: true, podId: 'pod1', pod, phase: 'connected', connected: true }),
    ),
  );
  await waitFor(() => expect(mock.reload).toHaveBeenCalledTimes(1));
});

it('terminates only after confirmation', async () => {
  mock.terminate.mockResolvedValue(state({ apiKeySet: true }));
  renderSettings(state({ apiKeySet: true, podId: 'pod1' }));
  fireEvent.click(await screen.findByText('runpod.terminate'));
  expect(mock.terminate).not.toHaveBeenCalled();
  const buttons = await screen.findAllByText('runpod.terminate');
  fireEvent.click(buttons[buttons.length - 1]);
  await waitFor(() => expect(mock.terminate).toHaveBeenCalled());
});
