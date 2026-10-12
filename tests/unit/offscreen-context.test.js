import { afterEach, expect, it, vi } from 'vitest';
import * as host from '../../src/background/job-host.js';
import * as browserApi from '../../src/common/browser-api.js';
afterEach(() => vi.unstubAllGlobals());
it('creates one hidden media document for concurrent starts and never opens a tab', async () => {
  expect(host.createOffscreenOpener).toBeTypeOf('function');
  const documents = []; let created = 0;
  const api = { runtime: { getURL: p => 'chrome-extension://test/' + p, getContexts: async () => documents },
    offscreen: { createDocument: async options => { await Promise.resolve(); created++; documents.push({ documentUrl: options.url }); } },
    tabs: { create: () => { throw new Error('Visible task tab is forbidden'); } } };
  const open = host.createOffscreenOpener(api);
  await Promise.all([open(), open(), open()]); await open();
  expect(created).toBe(1); expect(documents).toHaveLength(1);
});
it('retries hidden context creation after a failure', async () => {
  expect(host.createOffscreenOpener).toBeTypeOf('function');
  let attempts = 0;
  const api = { runtime: { getURL: p => p, getContexts: async () => [] }, offscreen: { createDocument: async () => { if (++attempts === 1) throw new Error('Unavailable'); } } };
  const open = host.createOffscreenOpener(api);
  await expect(open()).rejects.toThrow('Unavailable'); await open(); expect(attempts).toBe(2);
});
it('reports an unsupported browser rather than opening a fallback tab', async () => {
  expect(host.createOffscreenOpener).toBeTypeOf('function');
  const open = host.createOffscreenOpener({ runtime: {} });
  await expect(open()).rejects.toMatchObject({ code: 'OFFSCREEN_UNAVAILABLE' });
});
it('holds the offscreen blob until the background confirms complete saving', async () => {
  expect(browserApi.saveBlobViaBackground).toBeTypeOf('function');
  let state = 'in_progress'; const revoked = [];
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:chrome-extension://test/media', revokeObjectURL: url => revoked.push(url) });
  const saving = browserApi.saveBlobViaBackground({ blob: new Blob(['mp4']), filename: 'тест.mp4', pollInterval: 1,
    send: async message => message.type === 'SAVE_BLOB' ? { downloadId: 4 } : { state } });
  await new Promise(resolve => setTimeout(resolve, 5)); expect(revoked).toEqual([]);
  state = 'complete'; await expect(saving).resolves.toBe(4); expect(revoked).toEqual(['blob:chrome-extension://test/media']);
});
it('cancels browser saving and frees the offscreen blob on abort', async () => {
  expect(browserApi.saveBlobViaBackground).toBeTypeOf('function');
  const controller = new AbortController(); const commands = []; const revoked = [];
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:chrome-extension://test/media', revokeObjectURL: url => revoked.push(url) });
  const saving = browserApi.saveBlobViaBackground({ blob: new Blob(['mp4']), filename: 'test.mp4', signal: controller.signal, pollInterval: 1,
    send: async message => { commands.push(message.type); return message.type === 'SAVE_BLOB' ? { downloadId: 5 } : { state: 'in_progress' }; } });
  const result = expect(saving).rejects.toMatchObject({ code: 'CANCELLED' });
  await new Promise(resolve => setTimeout(resolve, 5)); controller.abort(); await result;
  expect(commands).toContain('CANCEL_SAVE'); expect(revoked).toHaveLength(1);
});
it('propagates background saving errors instead of reporting completion', async () => {
  expect(browserApi.saveBlobViaBackground).toBeTypeOf('function');
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:test', revokeObjectURL: () => {} });
  await expect(browserApi.saveBlobViaBackground({ blob: new Blob(['mp4']), filename: 'test.mp4',
    send: async () => ({ error: { code: 'SAVE_INTERRUPTED', message: 'Interrupted' } }) })).rejects.toMatchObject({ code: 'SAVE_INTERRUPTED' });
});

it('aborts saving immediately while the browser save dialog is pending', async () => {
  let finish; const revoked = []; const controller = new AbortController(); const commands = [];
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:test', revokeObjectURL: url => revoked.push(url) });
  const pending = new Promise(resolve => {finish=resolve;});
  const saving = browserApi.saveBlobViaBackground({blob:new Blob(['large output']),filename:'test.mp4',signal:controller.signal,
    send: message => {commands.push(message);return message.type==='SAVE_BLOB'?pending:Promise.resolve({cancelled:true});}});
  const result=expect(saving).rejects.toMatchObject({code:'CANCELLED'});controller.abort();
  await vi.waitFor(()=>expect(revoked).toEqual(['blob:test']),{timeout:100});await result;
  finish({downloadId:8});await new Promise(resolve=>setTimeout(resolve,0));
  expect(commands.some(m=>m.type==='CANCEL_SAVE'&&m.payload.downloadId===8)).toBe(true);
});
