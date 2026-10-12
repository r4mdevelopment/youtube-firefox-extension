import { createJobContextProxy } from '../common/job-context.js';
import { createDownloadManager } from '../download/manager.js';
import { createStreamRefresher } from '../youtube/stream-refresh.js';

// Firefox's persistent background document owns media; MV3 keeps its task tab.
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
