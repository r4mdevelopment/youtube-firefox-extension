import { getExtensionApi, callApi, downloadBlob } from '../common/browser-api.js';
import { createBackgroundController } from './controller.js';
import { createBackgroundJobHost } from './job-host.js';
import { downloadStream } from '../download/stream-downloader.js';
import { downloadSabr } from '../download/sabr-downloader.js';
import { muxMp4 } from '../mux/muxer.js';
import { DownloadError } from '../common/errors.js';
import { createSabrSessionStore } from '../youtube/sabr-session.js';
const api = getExtensionApi();
const manifest = api.runtime.getManifest();
const persistent = manifest.manifest_version === 2 && manifest.background?.persistent === true;
const sabrSessions = createSabrSessionStore();
api.webRequest.onBeforeRequest.addListener(details => { sabrSessions.observe(details); }, { urls: ['https://*.googlevideo.com/videoplayback*'] }, ['requestBody']);
async function getSabrSession(tabId, videoId) {
  const current = await metadata(tabId);
  if (current.state?.videoId !== videoId) throw new DownloadError('STALE_VIDEO', 'Ролик изменился. Обновите список форматов.');
  const session = sabrSessions.get(tabId, videoId, current.metadata?.payload?.sabrConfig);
  if (!session) throw new DownloadError('SABR_SESSION_REQUIRED', 'Запустите видео на странице YouTube, затем повторите загрузку.');
  return session;
}
const popupUrl = api.runtime.getURL('popup/popup.html');
const runnerUrl = api.runtime.getURL('runner/runner.html');
let proxy;
const isRunner = sender => !persistent && sender.id === api.runtime.id && sender.url === runnerUrl;
async function metadata(tabId, refresh = false) {
  const result = await callApi('tabs', 'sendMessage', tabId, { type: refresh ? 'REFRESH_STREAMS' : 'GET_CURRENT_METADATA' });
  if (result?.error) throw new DownloadError(result.error.code, result.error.message);
  return result;
}
async function openRunner() {
  await callApi('tabs', 'create', { url: runnerUrl, active: false });
  for (let n = 0; n < 100; n++) {
    const state = await callApi('runtime', 'sendMessage', { type: 'RUNNER_STATE' }).catch(() => null);
    if (state?.jobs) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new DownloadError('RUNNER_UNAVAILABLE', 'Не удалось открыть страницу загрузки.');
}
let lastBroadcast = 0;
let persistTimer; let pendingSnapshots; let writeQueue = Promise.resolve();
function persist(snapshots) {
  pendingSnapshots = snapshots.slice(-20);
  clearTimeout(persistTimer);
  const flush = () => { const value = pendingSnapshots; writeQueue = writeQueue.then(() => callApi('storage.local', 'set', { jobs: value })).catch(() => {}); };
  if (snapshots.some(j => ['complete', 'failed', 'cancelled'].includes(j.state))) flush();
  else persistTimer = setTimeout(flush, 250);
}
const ready = callApi('storage.local', 'get', 'jobs').catch(() => ({ jobs: [] })).then(saved => {
  proxy = createBackgroundJobHost({ persistent, initialJobs: saved.jobs ?? [], openRunner, send: message => callApi('runtime', 'sendMessage', message),
    downloadStream, downloadSabr, mux: muxMp4, save: downloadBlob,
    refreshMetadata: (tabId, _videoId) => metadata(tabId, true), getSabrSession });
  const controller = createBackgroundController({ extensionId: api.runtime.id, popupUrl, initialJobs: saved.jobs ?? [], managerFactory: () => proxy,
    persist, getSabrSession, refreshMetadata: (tabId, _videoId) => metadata(tabId, true), broadcast: message => {
      if (Date.now() - lastBroadcast < 250 && ['downloading', 'muxing'].includes(message.payload.state)) return;
      lastBroadcast = Date.now(); callApi('runtime', 'sendMessage', message).catch(() => {});
    } });
  return controller;
});
api.runtime.onMessage.addListener((message, sender, respond) => {
  if (!message?.type || message.type.startsWith('RUNNER_') || message.type === 'JOB_UPDATED' && !isRunner(sender)) return false;
  const execute = async () => {
    const controller = await ready;
    if (message.type === 'JOB_UPDATED' && isRunner(sender)) { proxy.accept(message.payload); return { accepted: true }; }
    if (message.type === 'REFRESH_JOB_STREAMS' && isRunner(sender)) return metadata(message.payload.tabId, true);
    if (message.type === 'GET_SABR_SESSION') {
      if (!isRunner(sender) || !proxy.list().some(j => j.videoId === message.payload.videoId && j.tabId === message.payload.tabId && !['complete', 'failed', 'cancelled'].includes(j.state)))
        throw new DownloadError('UNAUTHORIZED_MESSAGE', 'Недопустимый источник команды.');
      return { session: await getSabrSession(message.payload.tabId, message.payload.videoId) };
    }
    if (message.type === 'INJECT_BRIDGE') {
      if (sender.id !== api.runtime.id || sender.frameId !== 0 || !Number.isInteger(sender.tab?.id) || !/^https:\/\/www\.youtube\.com\//.test(sender.url ?? '')) throw new DownloadError('UNAUTHORIZED_MESSAGE', 'Недопустимый источник команды.');
      await callApi('scripting', 'executeScript', { target: { tabId: sender.tab.id }, world: 'MAIN', files: ['page-bridge.js'] });
      return { ready: true };
    }
    const siteView = message.type === 'GET_SITE_VIEW' && sender.id === api.runtime.id && sender.frameId === 0 && Number.isInteger(sender.tab?.id) && /^https?:\/\//.test(sender.url ?? '');
    if (siteView) await proxy.hydrate();
    if ((message.type === 'GET_CURRENT_VIDEO' && sender.url === popupUrl && sender.id === api.runtime.id) || (siteView && /^https:\/\/www\.youtube\.com\//.test(sender.url))) {
      const tabId = siteView ? sender.tab.id : message.payload.tabId;
      if (!siteView) await proxy.hydrate();
      try {
        const current = await metadata(tabId);
        if (current?.state) {
          const contentSender = { id: api.runtime.id, frameId: 0, tab: { id: tabId }, url: `https://www.youtube.com/watch?v=${current.state.videoId}`, documentId: current.documentId };
          const changed = await controller.handle({ type: 'VIDEO_CHANGED', payload: current.state }, contentSender);
          if (changed.accepted) sabrSessions.setVideo(tabId, current.state.videoId);
          if (current.metadata) await controller.handle({ type: 'VIDEO_METADATA', payload: current.metadata }, contentSender);
        }
      } catch { /* A non-YouTube tab has no content script. */ }
    }
    const result = await controller.handle(message, sender);
    if (message.type === 'VIDEO_CHANGED' && result.accepted) sabrSessions.setVideo(sender.tab.id, message.payload.videoId);
    return result;
  };
  execute().then(respond, error => respond({ error: { code: error.code ?? 'EXT_API_ERROR', message: error.message } }));
  return true;
});
api.tabs.onRemoved.addListener(tabId => { sabrSessions.forgetTab(tabId); ready.then(controller => controller.forgetTab(tabId)); });
