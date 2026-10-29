import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { DownloadIcon, UploadIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { getBridge } from '@/components/bridge';
import { importsApi } from '@/features/gallery/imports-api';
import { apiFetch, apiPath, ApiError, describeError } from '@/lib/api/client';
import { saveBackendFile } from '@/lib/native-save';
import { queryKeys } from '@/lib/query';

function exportPath(profileId: string, includeReference: boolean): string {
  return (
    '/personas/export/' +
    encodeURIComponent(profileId) +
    '?include_reference=' +
    String(includeReference)
  );
}

export async function personaBundle(profileId: string, includeReference: boolean): Promise<Blob> {
  const response = await apiFetch(exportPath(profileId, includeReference), { method: 'POST' });
  return response.blob();
}
function bundleName(name: string): string {
  return (
    (name
      .replace(/[<>:"/\\|?*\p{Cc}]/gu, '_')
      .trim()
      .slice(0, 100) || 'persona') + '.ovsvoice'
  );
}

/** Saves the voice as a .ovsvoice bundle; false when the user cancels the save dialog. */
export async function exportVoiceBundle(
  profile: { id: string; name: string },
  includeReference: boolean,
): Promise<boolean> {
  const suggestedName = bundleName(profile.name);
  if (getBridge()) {
    const saved = await saveBackendFile({
      url: apiPath(exportPath(profile.id, includeReference)),
      suggestedName,
      method: 'POST',
    });
    return !saved?.canceled;
  }
  const blob = await personaBundle(profile.id, includeReference);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = suggestedName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Let Chromium's download consume the blob before releasing it.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

function exportIssue(error: unknown): string {
  return error instanceof ApiError && error.status === 503
    ? 'voice_profile.persona_export_no_audio'
    : 'voice_profile.persona_export_failed';
}

/** One-click export from a voice card: the bundle keeps the voice clip, so it clones the same on import. */
export function VoiceExportButton({ profile }: { profile: { id: string; name: string } }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      disabled={busy}
      aria-label={t('voice_profile.export_voice')}
      title={t('voice_profile.export_voice')}
      onClick={async (event) => {
        event.stopPropagation();
        setBusy(true);
        try {
          if (await exportVoiceBundle(profile, true))
            toast.success(t('voice_profile.persona_exported'));
        } catch (error) {
          toast.error(t(exportIssue(error)));
        } finally {
          setBusy(false);
        }
      }}
    >
      <DownloadIcon />
    </Button>
  );
}

/** Adds a voice from a .ovsvoice (or legacy .omnivoice) bundle exported by any VoiceStudio. */
export function VoiceImportButton() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const importBundle = async (file: File) => {
    setBusy(true);
    try {
      const result = await importsApi.persona(file);
      await client.invalidateQueries({ queryKey: queryKeys.profiles });
      toast.success(
        t('gallery.persona_imported', {
          name: result.name,
          unverified: result.verified_own_voice ? '' : t('gallery.persona_unverified_suffix'),
        }),
      );
    } catch (error) {
      toast.error(
        error instanceof ApiError && error.status === 413
          ? t('gallery.persona_too_large')
          : `${t('gallery.persona_import_failed')} ${describeError(error)}`,
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        disabled={busy}
        title={t('gallery.import_persona')}
        onClick={() => input.current?.click()}
      >
        <UploadIcon />
        <span className="hidden sm:inline">{t('voice_profile.import_voice')}</span>
      </Button>
      <input
        ref={input}
        type="file"
        accept=".ovsvoice,.omnivoice"
        hidden
        aria-label={t('voice_profile.import_voice')}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void importBundle(file);
        }}
      />
    </>
  );
}

export function PersonaExport({
  profile,
  disabled = false,
}: {
  profile: { id: string; name: string };
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const lock = useRef(false);
  const [includeReference, setIncludeReference] = useState(true);
  const [busy, setBusy] = useState(false);
  const [issue, setIssue] = useState('');
  const exportVoice = async () => {
    if (lock.current || disabled) return;
    lock.current = true;
    setBusy(true);
    setIssue('');
    try {
      if (await exportVoiceBundle(profile, includeReference))
        toast.success(t('voice_profile.persona_exported'));
    } catch (error) {
      setIssue(exportIssue(error));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return (
    <details className="space-y-3 border-t border-border/50 pt-3">
      <summary className="cursor-pointer text-sm font-medium">
        {t('voice_profile.persona_export')}
      </summary>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={includeReference}
          disabled={busy || disabled}
          onChange={(event) => setIncludeReference(event.target.checked)}
          className="accent-primary"
        />
        {t('voice_profile.persona_include_ref')}
      </label>
      <p className="text-xs leading-5 text-muted-foreground">
        {t('voice_profile.persona_include_ref_hint')}
      </p>
      {issue && (
        <p role="alert" className="text-xs text-destructive">
          {t(issue)}
        </p>
      )}
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={busy || disabled}
        onClick={() => void exportVoice()}
      >
        <DownloadIcon />
        {t(busy ? 'voice_profile.persona_exporting' : 'voice_profile.persona_export')}
      </Button>
    </details>
  );
}
