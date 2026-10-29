import { CloudIcon, KeyRoundIcon, LoaderCircleIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { getBridge } from '@/components/bridge';
import { ConfirmDialog } from '@/features/clone/confirm-dialog';
import type {
  RunPodCatalog,
  RunPodPublicState,
  RunPodSettings as Settings,
} from '../../../../preload/index.d';
import { SettingsRow, SettingsSection } from './settings-layout';

const NO_VOLUME = '__none__';
const BUSY = new Set(['creating', 'starting', 'waiting', 'connecting', 'stopping']);

/** Rent a RunPod GPU pod running the VoiceStudio image and use it as the backend. */
export function RunPodSettings({
  reload = () => window.location.reload(),
}: {
  reload?: () => void;
}) {
  const { t } = useTranslation();
  // Older or partial bridges (the browser build, test doubles) have no RunPod.
  const bridge = getBridge()?.runpod ? getBridge() : null;
  const queryClient = useQueryClient();
  const state = useQuery({
    queryKey: ['runpod'],
    queryFn: () => bridge!.runpod.refresh(),
    enabled: Boolean(bridge),
    // An IPC call; RunPod itself is only asked once the user saved a key.
    networkMode: 'always',
  });
  const [apiKey, setApiKey] = useState('');
  const [catalog, setCatalog] = useState<RunPodCatalog | null>(null);
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmTerminate, setConfirmTerminate] = useState(false);
  const wasConnected = useRef<boolean | null>(null);

  useEffect(() => {
    if (!bridge) return;
    return bridge.runpod.onState((next) => queryClient.setQueryData(['runpod'], next));
  }, [bridge, queryClient]);

  const data = state.data;
  // The backend changed under the renderer (connected to the pod, or back to
  // local after stopping it): reload, as Save & reload does for a remote.
  useEffect(() => {
    if (!data) return;
    if (wasConnected.current !== null && wasConnected.current !== data.connected) reload();
    wasConnected.current = data.connected;
  }, [data, reload]);

  if (!bridge) return null;

  const run = async (action: () => Promise<RunPodPublicState | RunPodCatalog | void>) => {
    if (busy) return;
    setBusy(true);
    setFailure('');
    try {
      const result = await action();
      if (result && 'phase' in result) queryClient.setQueryData(['runpod'], result);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const save = (changes: Partial<Settings>) => run(() => bridge.runpod.saveSettings(changes));
  const loadCatalog = (cloud = data?.settings.cloud ?? 'SECURE') =>
    run(async () => setCatalog(await bridge.runpod.catalog(cloud)));

  const settings = data?.settings;
  const phase = data?.phase ?? 'idle';
  const working = busy || BUSY.has(phase);
  const pod = data?.pod;
  const active = pod && ['PROVISIONING', 'STARTING', 'RUNNING'].includes(pod.status);
  const gpuItems = (catalog?.gpus ?? []).map((gpu) => ({
    value: gpu.id,
    label: t('runpod.gpu_option', {
      gpu: gpu.id,
      memory: gpu.memory,
      price: gpu.price.toFixed(2),
      availability: t(`runpod.availability_${gpu.availability.toLowerCase()}`),
    }),
  }));
  if (settings?.gpu && !gpuItems.some((item) => item.value === settings.gpu))
    gpuItems.unshift({ value: settings.gpu, label: settings.gpu });
  const volumeItems = [
    { value: NO_VOLUME, label: t('runpod.volume_none', { size: settings?.volumeSize ?? 50 }) },
    ...(catalog?.volumes ?? []).map((volume) => ({
      value: volume.id,
      label: t('runpod.volume_option', {
        name: volume.name,
        size: volume.size,
        dataCenter: volume.dataCenter,
      }),
    })),
  ];
  if (settings?.networkVolume && !volumeItems.some((item) => item.value === settings.networkVolume))
    volumeItems.push({ value: settings.networkVolume, label: settings.networkVolume });
  const cloudItems = [
    { value: 'SECURE', label: t('runpod.cloud_secure') },
    { value: 'COMMUNITY', label: t('runpod.cloud_community') },
  ];
  const error = data?.error
    ? t(`runpod.error_${data.error.kind}`, { message: data.error.message })
    : failure;

  return (
    <SettingsSection icon={CloudIcon} title={t('runpod.title')}>
      <SettingsRow
        id="runpod-key"
        title={t('runpod.api_key')}
        description={t('runpod.api_key_desc')}
      >
        <KeyRoundIcon aria-hidden="true" className="size-4 text-muted-foreground" />
        <Input
          type="password"
          value={apiKey}
          className="min-w-64"
          aria-label={t('runpod.api_key')}
          placeholder={data?.apiKeySet ? t('runpod.api_key_saved') : ''}
          autoComplete="off"
          disabled={working}
          onChange={(event) => setApiKey(event.target.value)}
        />
        <Button
          size="sm"
          disabled={working || !apiKey.trim()}
          onClick={() =>
            void run(async () => {
              const next = await bridge.runpod.setApiKey(apiKey);
              setApiKey('');
              return next;
            })
          }
        >
          {t('runpod.save_key')}
        </Button>
        {data?.apiKeySet && (
          <Button
            variant="ghost"
            size="sm"
            disabled={working}
            onClick={() => void run(() => bridge.runpod.setApiKey(''))}
          >
            {t('runpod.clear_key')}
          </Button>
        )}
      </SettingsRow>
      {data?.apiKeySet && !data.persistent && (
        <p className="px-4 pb-2 text-xs text-muted-foreground">{t('runpod.not_persistent')}</p>
      )}

      {settings && (
        <>
          <SettingsRow
            id="runpod-image"
            title={t('runpod.image')}
            description={t('runpod.image_desc')}
          >
            <Input
              key={settings.image}
              defaultValue={settings.image}
              className="min-w-64 font-mono"
              aria-label={t('runpod.image')}
              spellCheck={false}
              disabled={working || Boolean(data?.podId)}
              onBlur={(event) => {
                const image = event.target.value.trim();
                if (image && image !== settings.image) void save({ image });
              }}
            />
          </SettingsRow>
          <SettingsRow id="runpod-gpu" title={t('runpod.gpu')} description={t('runpod.gpu_desc')}>
            <Select
              items={cloudItems}
              value={settings.cloud}
              disabled={working || Boolean(data?.podId)}
              onValueChange={(value) => {
                if (value === 'SECURE' || value === 'COMMUNITY') {
                  void save({ cloud: value });
                  if (catalog) void loadCatalog(value);
                }
              }}
            >
              <SelectTrigger aria-label={t('runpod.cloud')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {cloudItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              items={gpuItems}
              value={settings.gpu}
              disabled={working || Boolean(data?.podId)}
              onValueChange={(value) => {
                if (typeof value === 'string') void save({ gpu: value });
              }}
            >
              <SelectTrigger className="min-w-64" aria-label={t('runpod.gpu')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {gpuItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              disabled={working || !data?.apiKeySet}
              onClick={() => void loadCatalog()}
            >
              {t('runpod.load_catalog')}
            </Button>
          </SettingsRow>
          <SettingsRow
            id="runpod-volume"
            title={t('runpod.volume')}
            description={t('runpod.volume_desc')}
          >
            <Select
              items={volumeItems}
              value={settings.networkVolume || NO_VOLUME}
              disabled={working || Boolean(data?.podId)}
              onValueChange={(value) => {
                if (typeof value !== 'string') return;
                const volume = catalog?.volumes.find((item) => item.id === value);
                void save(
                  value === NO_VOLUME
                    ? { networkVolume: '', dataCenter: '' }
                    : // A network volume ties the pod to its data center.
                      {
                        networkVolume: value,
                        dataCenter: volume?.dataCenter ?? settings.dataCenter,
                      },
                );
              }}
            >
              <SelectTrigger className="min-w-64" aria-label={t('runpod.volume')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {volumeItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsRow>
          <SettingsRow
            id="runpod-stop-on-quit"
            title={t('runpod.stop_on_quit')}
            description={t('runpod.stop_on_quit_desc')}
          >
            <Switch
              checked={settings.stopOnQuit}
              aria-label={t('runpod.stop_on_quit')}
              disabled={working}
              onCheckedChange={(stopOnQuit) => void save({ stopOnQuit })}
            />
          </SettingsRow>
        </>
      )}

      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        {!data?.podId ? (
          <Button
            size="sm"
            disabled={working || !data?.apiKeySet || !settings?.gpu}
            onClick={() => void run(() => bridge.runpod.create())}
          >
            {t('runpod.create')}
          </Button>
        ) : (
          <>
            <Badge
              variant="outline"
              className={pod?.status === 'RUNNING' ? 'text-emerald-500' : undefined}
            >
              {pod ? t(`runpod.status_${pod.status.toLowerCase()}`) : data.podId}
            </Badge>
            {pod?.gpu && <span className="text-xs text-muted-foreground">{pod.gpu}</span>}
            {pod?.cost != null && (
              <span className="text-xs text-muted-foreground">
                {t('runpod.cost', { cost: pod.cost.toFixed(2) })}
              </span>
            )}
            {!data.connected && (
              <Button
                size="sm"
                disabled={working}
                onClick={() => void run(() => bridge.runpod.connect())}
              >
                {active ? t('runpod.connect') : t('runpod.start')}
              </Button>
            )}
            {active && (
              <Button
                variant="outline"
                size="sm"
                disabled={working}
                onClick={() => void run(() => bridge.runpod.stop())}
              >
                {t('runpod.stop')}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              disabled={working}
              onClick={() => setConfirmTerminate(true)}
            >
              {t('runpod.terminate')}
            </Button>
          </>
        )}
        {BUSY.has(phase) && (
          <span role="status" className="flex items-center gap-1 text-xs text-muted-foreground">
            <LoaderCircleIcon className="size-3 animate-spin" />
            {t(`runpod.phase_${phase}`)}
          </span>
        )}
        {data?.connected && (
          <Badge role="status" variant="outline" className="text-emerald-500">
            {t('runpod.connected')}
          </Badge>
        )}
        {error && (
          <Badge role="alert" variant="destructive">
            {error}
          </Badge>
        )}
      </div>
      {pod && (
        <p className="px-4 pb-3 font-mono text-xs break-all text-muted-foreground">{pod.url}</p>
      )}

      <ConfirmDialog
        open={confirmTerminate}
        onOpenChange={setConfirmTerminate}
        title={t('runpod.terminate_confirm_title')}
        description={t('runpod.terminate_confirm')}
        confirmLabel={t('runpod.terminate')}
        destructive
        onConfirm={async () => {
          setConfirmTerminate(false);
          await run(() => bridge.runpod.terminate());
        }}
      />
    </SettingsSection>
  );
}
