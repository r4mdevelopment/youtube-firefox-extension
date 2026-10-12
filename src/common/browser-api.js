import { DownloadError, checkAbort } from './errors.js';

export function getExtensionApi() {
  const api = globalThis.browser ?? globalThis.chrome;
  if (!api) throw new DownloadError('EXT_API_UNAVAILABLE', 'API расширения недоступен.');
  return api;
}

export function callApi(namespace, method, ...args) {
  const api = getExtensionApi();
  const owner = namespace.split('.').reduce((value, key) => value[key], api);
  if (globalThis.browser) return Promise.resolve(owner[method](...args));
  return new Promise((resolve, reject) => {
    owner[method](...args, result => {
      const error = api.runtime?.lastError;
      if (error) reject(new DownloadError('EXT_API_ERROR', error.message));
      else resolve(result);
    });
  });
}

// Resolve only after the browser has written the complete file, not after enqueueing.
export async function downloadBlob({ blob, filename, saveAs = true, signal }) {
  if (!(blob instanceof Blob) || !blob.size) throw new DownloadError('EMPTY_OUTPUT', 'Получен пустой файл.');
  checkAbort(signal);
  if (typeof URL.createObjectURL !== 'function') throw new DownloadError('SAVE_CONTEXT_UNAVAILABLE', 'Для сохранения требуется страница расширения.');
  const api = getExtensionApi();
  const url = URL.createObjectURL(blob);
  let id;
  let cleanup = () => {};
  try {
    await new Promise((resolve, reject) => {
      const finish = state => {
        if (state === 'complete') resolve();
        if (state === 'interrupted') reject(new DownloadError('SAVE_INTERRUPTED', 'Сохранение прервано браузером.'));
      };
      const changed = delta => { if (delta.id === id) finish(delta.state?.current); };
      const abort = () => {
        if (id !== undefined) callApi('downloads', 'cancel', id).catch(() => {});
        reject(new DownloadError('CANCELLED', 'Загрузка отменена.'));
      };
      cleanup = () => {
        api.downloads.onChanged.removeListener(changed);
        signal?.removeEventListener('abort', abort);
      };
      api.downloads.onChanged.addListener(changed);
      signal?.addEventListener('abort', abort, { once: true });
      callApi('downloads', 'download', { url, filename, saveAs, conflictAction: 'uniquify' })
        .then(async downloadId => {
          id = downloadId;
          if (signal?.aborted) { abort(); return; }
          const items = await callApi('downloads', 'search', { id });
          finish(items[0]?.state);
        }).catch(reject);
    });
    return id;
  } finally {
    cleanup();
    URL.revokeObjectURL(url);
  }
}
