import { afterEach, describe, expect, it, vi } from 'vitest';
import { getExtensionApi, downloadBlob } from '../../src/common/browser-api.js';
import { sanitizeFilename } from '../../src/common/utils.js';

afterEach(() => vi.unstubAllGlobals());
describe('extension API selection', () => {
  it('prefers Firefox when both APIs exist', () => {
    const browser = { runtime: {} };
    vi.stubGlobal('browser', browser);
    vi.stubGlobal('chrome', { runtime: {} });
    expect(getExtensionApi()).toBe(browser);
  });
  it('uses Chromium when Firefox API is absent', () => {
    vi.stubGlobal('browser', undefined);
    const chrome = { runtime: {} };
    vi.stubGlobal('chrome', chrome);
    expect(getExtensionApi()).toBe(chrome);
  });
  it('reports missing extension context', () => {
    vi.stubGlobal('browser', undefined);
    vi.stubGlobal('chrome', undefined);
    expect(getExtensionApi).toThrow(expect.objectContaining({ code: 'EXT_API_UNAVAILABLE' }));
  });
});
describe('filenames', () => {
  it('keeps Cyrillic and removes Windows-invalid characters', () => {
    expect(sanitizeFilename('Привет: мир / тест?*<>|"\\')).toBe('Привет мир тест');
  });
  it.each(['CON', 'aux.txt', 'LPT1', 'nul'])('protects reserved name %s', title => {
    expect(sanitizeFilename(title)).toMatch(/^_/);
  });
  it('provides a name for punctuation-only titles', () => {
    expect(sanitizeFilename('...<>')).toBe('video');
  });
});
it('rejects empty output before calling privileged downloads API', async () => {
  await expect(downloadBlob({ blob: new Blob([]), filename: 'test.mp4' })).rejects.toMatchObject({ code: 'EMPTY_OUTPUT' });
});
it('keeps the blob URL until Firefox reports completed download', async () => {
  let listener;
  const revoke = vi.fn();
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:test', revokeObjectURL: revoke });
  vi.stubGlobal('browser', { downloads: {
    onChanged: { addListener: cb => { listener = cb; }, removeListener: () => {} },
    download: async options => { expect(options.filename).toBe('тест.mp4'); return 7; },
    search: async () => [{ id: 7, state: 'in_progress' }],
  } });
  const saving = downloadBlob({ blob: new Blob(['media']), filename: 'тест.mp4' });
  await vi.waitFor(() => expect(listener).toBeTypeOf('function'));
  expect(revoke).not.toHaveBeenCalled();
  listener({ id: 7, state: { current: 'complete' } });
  await expect(saving).resolves.toBe(7);
  expect(revoke).toHaveBeenCalledWith('blob:test');
});
it('normalizes Chromium callbacks and reports save interruption', async () => {
  let listener;
  vi.stubGlobal('browser', undefined);
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:test', revokeObjectURL: () => {} });
  vi.stubGlobal('chrome', { runtime: {}, downloads: {
    onChanged: { addListener: cb => { listener = cb; }, removeListener: () => {} },
    download: (_options, callback) => callback(9),
    search: (_query, callback) => callback([{ id: 9, state: 'interrupted' }]),
  } });
  await expect(downloadBlob({ blob: new Blob(['media']), filename: 'test.mp4' })).rejects.toMatchObject({ code: 'SAVE_INTERRUPTED' });
});
