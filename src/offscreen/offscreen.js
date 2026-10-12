import { getExtensionApi, callApi, saveBlobViaBackground } from '../common/browser-api.js';
import { createDownloadManager } from '../download/manager.js';
import { downloadStream } from '../download/stream-downloader.js';
import { downloadSabr } from '../download/sabr-downloader.js';
import { muxMp4 } from '../mux/muxer.js';
import { createStreamRefresher } from '../youtube/stream-refresh.js';
const api = getExtensionApi();
const manager = createDownloadManager({ downloadStream, downloadSabr, mux: muxMp4, save: saveBlobViaBackground, refreshStreams: async request => {
  const job = manager.list().find(j => (request.jobId ? j.id === request.jobId : j.videoId === request.videoId) && !['complete', 'failed', 'cancelled'].includes(j.state));
  const updated = await createStreamRefresher({ requestMetadata: async () => {
    const result = await callApi('runtime', 'sendMessage', { type: 'REFRESH_JOB_STREAMS', payload: { ...request, tabId: job.tabId } });
    if (result?.error) throw Object.assign(new Error(result.error.message), result.error);
    return result;
  } })(request);
  if (updated.transport === 'SABR') {
    const result = await callApi('runtime', 'sendMessage', { type: 'GET_SABR_SESSION', payload: { videoId: request.videoId, tabId: job.tabId } });
    if (result?.error) throw Object.assign(new Error(result.error.message), result.error);
    updated.sabrSession = result.session;
  }
  return updated;
} });
manager.subscribe(job => {
  callApi('runtime', 'sendMessage', { type: 'JOB_UPDATED', payload: job }).catch(() => {});
});
api.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== api.runtime.id || sender.tab || sender.url === api.runtime.getURL('popup/popup.html')) return false;
  if (message?.type === 'RUNNER_STATE') { respond({ jobs: manager.list() }); return false; }
  if (message?.type === 'RUNNER_CANCEL') { manager.cancel(message.payload.jobId); respond({ cancelled: true }); return false; }
  if (message?.type !== 'RUNNER_START') return false;
  manager.start(message.payload).then(jobId => respond({ jobId }), error => respond({ error: { code: error.code, message: error.message } }));
  return true;
});
// Keep routing/session state available during active media work. No idle heartbeat.
setInterval(() => {
  if (manager.list().some(job => !['complete', 'failed', 'cancelled'].includes(job.state)))
    callApi('runtime', 'sendMessage', { type: 'MEDIA_HEARTBEAT' }).catch(() => {});
}, 20000);
