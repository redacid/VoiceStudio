import { join } from 'node:path';
import { app, BrowserWindow, clipboard, ipcMain, safeStorage } from 'electron';
import { assertTrustedMainFrame } from '../ipc';
import { sendToLiveWindow } from '../window-safety';
import { RunPodController, type BackendLike } from './runpod-controller';
import { RunPodStore } from './runpod-store';

export const RUNPOD_CHANNELS = {
  get: 'runpod:get',
  refresh: 'runpod:refresh',
  saveSettings: 'runpod:save-settings',
  setApiKey: 'runpod:set-api-key',
  catalog: 'runpod:catalog',
  create: 'runpod:create',
  connect: 'runpod:connect',
  stop: 'runpod:stop',
  terminate: 'runpod:terminate',
  copyBackendKey: 'runpod:copy-backend-key',
  state: 'runpod:state',
} as const;

/**
 * RunPod pods for the backend (Settings > Sharing > RunPod). Calls RunPod only
 * after the user enters an API key and acts; returns what quitting needs.
 */
export function startRunPod(
  backend: BackendLike,
  getMainWindow: () => BrowserWindow | null,
): { resume: () => void; stopOnQuit: () => Promise<void>; close: () => void } {
  const store = new RunPodStore(
    join(app.getPath('userData'), 'runpod.json'),
    safeStorage,
    app.getVersion(),
  );
  const ctl = new RunPodController({ store, backend });
  function trusted(event: Electron.IpcMainInvokeEvent): void {
    assertTrustedMainFrame(event, getMainWindow());
  }
  const unsubscribe = ctl.onChange((state) => {
    for (const win of BrowserWindow.getAllWindows())
      sendToLiveWindow(win, RUNPOD_CHANNELS.state, state);
  });
  ipcMain.handle(RUNPOD_CHANNELS.get, (e) => (trusted(e), ctl.state()));
  ipcMain.handle(RUNPOD_CHANNELS.refresh, (e) => (trusted(e), ctl.refresh()));
  ipcMain.handle(RUNPOD_CHANNELS.saveSettings, (e, raw) => (trusted(e), ctl.saveSettings(raw)));
  ipcMain.handle(RUNPOD_CHANNELS.setApiKey, (e, raw) => (trusted(e), ctl.setApiKey(raw)));
  ipcMain.handle(RUNPOD_CHANNELS.catalog, (e, cloud) => (trusted(e), ctl.catalog(cloud)));
  ipcMain.handle(RUNPOD_CHANNELS.create, (e) => (trusted(e), ctl.create()));
  // Answers at once; progress arrives as state events while the pod starts.
  ipcMain.handle(RUNPOD_CHANNELS.connect, (e) => {
    trusted(e);
    const state = ctl.state();
    if (!state.apiKeySet || !state.podId) throw new Error('Create a pod first');
    void ctl.connect().catch(() => {});
    return ctl.state();
  });
  ipcMain.handle(RUNPOD_CHANNELS.stop, (e) => (trusted(e), ctl.stop()));
  ipcMain.handle(RUNPOD_CHANNELS.terminate, (e) => (trusted(e), ctl.terminate()));
  // The key goes to the clipboard, never to the renderer.
  ipcMain.handle(RUNPOD_CHANNELS.copyBackendKey, (e) => {
    trusted(e);
    const key = store.get().backendKey;
    if (key) clipboard.writeText(key);
    return Boolean(key);
  });
  return {
    /** After the backend starts: a pod that was the app's backend is started and re-authenticated. */
    resume: () => void ctl.resume().catch(() => {}),
    stopOnQuit: () => ctl.stopOnQuit(),
    close: () => {
      unsubscribe();
      for (const channel of Object.values(RUNPOD_CHANNELS)) ipcMain.removeHandler(channel);
    },
  };
}
