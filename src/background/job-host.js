import { DownloadError } from '../common/errors.js';
import { createJobContextProxy } from '../common/job-context.js';
import { createDownloadManager } from '../download/manager.js';
import { createStreamRefresher } from '../youtube/stream-refresh.js';

// Firefox owns media in its persistent background; MV3 uses a hidden document.
export function createBackgroundJobHost({ persistent, initialJobs = [], openRunner, send,
  downloadStream, downloadSabr, mux, save, refreshMetadata, getSabrSession }) {
  if (!persistent) return createJobContextProxy({ initialJobs, openRunner, send });
  const manager = createDownloadManager({ initialJobs, downloadStream, downloadSabr, mux, save,
    refreshStreams: async request => {
      const job = manager.list().find(j => (request.jobId ? j.id === request.jobId : j.videoId === request.videoId) && !['complete', 'failed', 'cancelled'].includes(j.state));
      const updated = await createStreamRefresher({ requestMetadata: () => refreshMetadata(job?.tabId, request.videoId) })(request);
      if (updated.transport === 'SABR') updated.sabrSession = await getSabrSession(job?.tabId, request.videoId);
      return updated;
    } });
  return { ...manager, async hydrate() { /* Already lives in this persistent document. */ } };
}

export function createOffscreenOpener(api) {
  let creating;
  return async () => {
    if (!api.offscreen?.createDocument || !api.runtime.getContexts)
      throw new DownloadError('OFFSCREEN_UNAVAILABLE', 'Обновите Chromium-браузер: скрытая обработка недоступна.');
    const contexts = await api.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [api.runtime.getURL('offscreen/offscreen.html')] });
    if (contexts.length) return;
    if (!creating) creating = api.offscreen.createDocument({ url: 'offscreen/offscreen.html', reasons: ['BLOBS'],
      justification: 'Merge downloaded MP4 tracks and keep Blob URLs alive until files are saved.' }).finally(() => { creating = null; });
    await creating;
  };
}
