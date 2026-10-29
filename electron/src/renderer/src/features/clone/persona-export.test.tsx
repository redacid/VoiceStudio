import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({
  fetch: vi.fn(),
  save: vi.fn(),
  persona: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  bridge: null as object | null,
}));
vi.mock('@/lib/api/client', async (original) => ({
  ...(await original<object>()),
  apiFetch: mock.fetch,
}));
vi.mock('@/components/bridge', () => ({ getBridge: () => mock.bridge }));
vi.mock('sonner', () => ({ toast: { success: mock.success, error: mock.error } }));
vi.mock('@/features/gallery/imports-api', () => ({ importsApi: { persona: mock.persona } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  PersonaExport,
  personaBundle,
  VoiceExportButton,
  VoiceImportButton,
} from './persona-export';
import { ApiError } from '@/lib/api/client';
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mock.bridge = null;
});
it('sends the explicit reference choice and safely encodes profile identifiers', async () => {
  mock.fetch.mockResolvedValue({ blob: async () => new Blob(['bundle']) });
  await personaBundle('voice/id', false);
  expect(mock.fetch).toHaveBeenCalledWith('/personas/export/voice%2Fid?include_reference=false', {
    method: 'POST',
  });
});
it('keeps the reference opt-in state after an export fails and allows retry', async () => {
  mock.fetch.mockRejectedValue(new ApiError(503, 'unavailable'));
  render(<PersonaExport profile={{ id: 'voice', name: 'Voice' }} />);
  fireEvent.click(screen.getByText('voice_profile.persona_export', { selector: 'summary' }));
  const check = screen.getByRole('checkbox');
  expect(check).toBeChecked();
  fireEvent.click(check);
  fireEvent.click(screen.getByRole('button', { name: 'voice_profile.persona_export' }));
  await waitFor(() =>
    expect(screen.getByRole('alert')).toHaveTextContent('voice_profile.persona_export_no_audio'),
  );
  expect(check).not.toBeChecked();
  expect(screen.getByRole('button', { name: 'voice_profile.persona_export' })).not.toBeDisabled();
});
it('uses the native Save As path for persona bundles in Electron', async () => {
  mock.bridge = { files: { saveAudio: mock.save } };
  mock.save.mockResolvedValue({ canceled: false, path: 'C:\\Voice.ovsvoice' });
  render(<PersonaExport profile={{ id: 'voice/id', name: 'Voice' }} />);
  fireEvent.click(screen.getByText('voice_profile.persona_export', { selector: 'summary' }));
  fireEvent.click(screen.getByRole('button', { name: 'voice_profile.persona_export' }));
  await waitFor(() =>
    expect(mock.save).toHaveBeenCalledWith({
      url: '/api/personas/export/voice%2Fid?include_reference=true',
      suggestedName: 'Voice.ovsvoice',
      method: 'POST',
    }),
  );
  expect(mock.fetch).not.toHaveBeenCalled();
});
it('exports a voice card with its voice clip in one click', async () => {
  mock.bridge = { files: { saveAudio: mock.save } };
  mock.save.mockResolvedValue({ canceled: false, path: '/tmp/Voice.ovsvoice' });
  render(<VoiceExportButton profile={{ id: 'v1', name: 'Voice' }} />);
  fireEvent.click(screen.getByRole('button', { name: 'voice_profile.export_voice' }));
  await waitFor(() => expect(mock.success).toHaveBeenCalledWith('voice_profile.persona_exported'));
  expect(mock.save).toHaveBeenCalledWith(
    expect.objectContaining({ url: '/api/personas/export/v1?include_reference=true' }),
  );
});
it('imports a voice bundle and refreshes the saved voices', async () => {
  mock.persona.mockResolvedValue({ name: 'Voice', verified_own_voice: true });
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  render(
    <QueryClientProvider client={client}>
      <VoiceImportButton />
    </QueryClientProvider>,
  );
  const file = new File(['zip'], 'Voice.ovsvoice');
  fireEvent.change(screen.getByLabelText('voice_profile.import_voice'), {
    target: { files: [file] },
  });
  await waitFor(() => expect(mock.success).toHaveBeenCalledWith('gallery.persona_imported'));
  expect(mock.persona).toHaveBeenCalledWith(file);
  expect(invalidate).toHaveBeenCalled();
});
