import { isYouTubeUrl } from '../common/youtube-url.js';
import { parsePageMessage } from '../common/messages.js';
import { DownloadError } from '../common/errors.js';
import { normalizeRepresentations } from '../youtube/extractor.js';
import { buildDownloadChoices } from '../youtube/formats.js';
import { createStreamRefresher } from '../youtube/stream-refresh.js';
import { createDownloadManager } from '../download/manager.js';

export function createBackgroundController({ extensionId, popupUrl, downloadStream, mux, save, refreshMetadata, getSabrSession, broadcast = () => {}, persist = () => {}, initialJobs = [], now = Date.now, managerFactory = createDownloadManager }) {
  const tabs = new Map();
  const retiredDocuments = new Map();
  const manager = managerFactory({ downloadStream, mux, save, initialJobs, refreshStreams: async request => {
    const job = manager.list().find(j => (request.jobId ? j.id === request.jobId : j.videoId === request.videoId) && !['complete', 'failed', 'cancelled'].includes(j.state));
    return createStreamRefresher({ requestMetadata: () => refreshMetadata(job?.tabId, request.videoId) })(request);
  } });
  const dismissedJobs = new Set(initialJobs.filter(j => ['complete','failed','cancelled'].includes(j.state)).map(j => j.id));
  let widgetSettledAt = null;
  const expireWidget = () => {
    if (widgetSettledAt !== null && now() - widgetSettledAt >= 3000) {
      for (const job of manager.list()) if (['complete','failed','cancelled'].includes(job.state)) dismissedJobs.add(job.id);
      widgetSettledAt = null;
    }
  };
  manager.subscribe(job => {
    expireWidget();
    if (manager.list().some(j => !['complete','failed','cancelled'].includes(j.state))) widgetSettledAt = null;
    else if (widgetSettledAt === null) widgetSettledAt = now();
    persist(manager.list()); broadcast({ type: 'JOB_UPDATED', payload: job }); });
  const contentSender = sender => sender.id === extensionId && sender.frameId === 0 && Number.isInteger(sender.tab?.id) && isYouTubeUrl(sender.url);
  const siteSender = sender => sender.id === extensionId && sender.frameId === 0 && Number.isInteger(sender.tab?.id) && /^https?:\/\//.test(sender.url ?? '');
  const popupSender = sender => sender.id === extensionId && sender.url === popupUrl && !sender.tab;
  const stateFor = tabId => tabs.get(tabId);
  const latestJob = tabId => manager.list().filter(j => j.tabId === tabId && (j.videoId === stateFor(tabId)?.videoId || !['complete','failed','cancelled'].includes(j.state))).at(-1) ?? null;
  const view = tabId => {
    const state = stateFor(tabId); const p = state?.metadata?.payload;
    const choices = p ? buildDownloadChoices(normalizeRepresentations(p)) : [];
    const publicChoices = choices.map(({ video, audio, ...metadata }) => metadata);
    return { videoId: state?.videoId ?? null, generation: state?.generation ?? 0, title: p?.title ?? '', duration: p?.duration ?? null,
      choices: publicChoices, activeJob: latestJob(tabId), status: p?.status ?? 'LOADING',
      unavailableReason: p && !choices.length ? p.status === 'LIVE' ? 'Прямые трансляции не поддерживаются.' : p.transport === 'SABR' ?
        'В SABR-потоках этого ролика нет доступных совместимых дорожек H.264/AAC.' :
        'Нет доступных MP4-потоков H.264/AAC. Подписанные и защищённые форматы пока не поддерживаются.' : null };
  };
  return { manager, forgetTab(tabId) { tabs.delete(tabId); retiredDocuments.delete(tabId); }, async handle(message, sender) {
    if (!message || typeof message.type !== 'string') throw new DownloadError('INVALID_MESSAGE', 'Некорректное сообщение.');
    let p = message.payload ?? {};
    if (message.type === 'VIDEO_CHANGED' || message.type === 'VIDEO_METADATA') {
      if (!contentSender(sender)) throw new DownloadError('UNAUTHORIZED_MESSAGE', 'Недопустимый источник метаданных.');
      const tabId = sender.tab.id; const old = tabs.get(tabId);
      const documentToken = p.documentToken ?? sender.documentId;
      const retired = retiredDocuments.get(tabId) ?? new Set();
      if (documentToken && retired.has(documentToken)) return { accepted: false };
      if (message.type === 'VIDEO_CHANGED') {
        if (!(p.videoId === null || /^[\w-]{11}$/.test(p.videoId ?? '')) || !Number.isSafeInteger(p.generation) || p.generation < 0) return { accepted: false };
        if (old && old.documentToken === documentToken && old.generation > p.generation) return { accepted: false };
        if (old && old.documentToken === documentToken && old.generation === p.generation && old.videoId === p.videoId) return { accepted: true };
        if (old?.documentToken && old.documentToken !== documentToken) {
          retired.add(old.documentToken); retiredDocuments.set(tabId, retired);
        }
        tabs.set(tabId, { videoId: p.videoId, generation: p.generation, documentToken, metadata: null });
      } else {
        const metadata = parsePageMessage(p);
        if (!metadata || !old || old.documentToken !== documentToken || old.videoId !== metadata.videoId || old.generation !== metadata.generation) return { accepted: false };
        old.metadata = metadata;
      }
      return { accepted: true };
    }
    if (message.type === 'GET_SITE_VIEW' || message.type === 'SITE_CANCEL_DOWNLOAD' || message.type === 'SITE_DISMISS_JOB' || message.type === 'SITE_HIDE_WIDGET') {
      if (!siteSender(sender)) throw new DownloadError('UNAUTHORIZED_MESSAGE', 'Недопустимый источник команды.');
      expireWidget();
      if (message.type === 'SITE_HIDE_WIDGET') { for (const job of manager.list()) dismissedJobs.add(job.id);return { hidden: true }; }
      if (message.type === 'GET_SITE_VIEW') {
        const all = manager.list().filter(j => !dismissedJobs.has(j.id));
        const jobs = [...all.filter(j => !['complete','failed','cancelled'].includes(j.state)), ...all.filter(j => ['complete','failed','cancelled'].includes(j.state)).slice(-8)];
        return { video: contentSender(sender) ? view(sender.tab.id) : null, widgetHideAfterMs: widgetSettledAt === null ? null : Math.max(0, 3000 - (now() - widgetSettledAt)),
          jobs: jobs.map(j => ({ id: j.id, title: j.title, state: j.state, progress: j.progress, error: j.error })) };
      }
      const job = manager.get(p.jobId);
      if (!job) throw new DownloadError('INVALID_JOB', 'Загрузка не найдена.');
      if (message.type === 'SITE_DISMISS_JOB') {
        if (!['complete','failed','cancelled'].includes(job.state)) throw new DownloadError('INVALID_JOB_STATE', 'Загрузка ещё выполняется.');
        dismissedJobs.add(job.id);return { hidden: true };
      }
      await manager.cancel(job.id); return { cancelled: true };
    }
    const inlineStart = message.type === 'SITE_START_DOWNLOAD' && contentSender(sender);
    if (inlineStart) { message = { ...message, type: 'START_DOWNLOAD' }; p = { ...p, tabId: sender.tab.id }; }
    if (!popupSender(sender) && !inlineStart) throw new DownloadError('UNAUTHORIZED_MESSAGE', 'Команда разрешена только интерфейсу расширения.');
    if (!Number.isInteger(p.tabId)) throw new DownloadError('INVALID_MESSAGE', 'Не выбрана вкладка YouTube.');
    if (message.type === 'GET_CURRENT_VIDEO') return view(p.tabId);
    if (message.type === 'START_DOWNLOAD' || message.type === 'RETRY_DOWNLOAD') {
      const state = stateFor(p.tabId);
      const previous = message.type === 'RETRY_DOWNLOAD' ? manager.get(p.jobId) : null;
      if (message.type === 'RETRY_DOWNLOAD' && (!previous || !['failed', 'cancelled'].includes(previous.state) || previous.tabId !== p.tabId)) throw new DownloadError('INVALID_JOB_STATE', 'Повтор недоступен.');
      const videoId = previous?.videoId ?? p.videoId;
      if (!state?.metadata || videoId !== state.videoId || (!previous && p.generation !== state.generation)) throw new DownloadError('STALE_VIDEO', 'Ролик изменился. Обновите список форматов.');
      const choiceId = previous?.choiceId ?? p.choiceId;
      const choice = buildDownloadChoices(normalizeRepresentations(state.metadata.payload)).find(c => c.id === choiceId);
      if (!choice) throw new DownloadError('FORMAT_UNAVAILABLE', 'Выбранный формат недоступен.');
      const sabrSession = choice.transport === 'SABR' ? await getSabrSession?.(p.tabId, state.videoId) : undefined;
      if (stateFor(p.tabId) !== state) throw new DownloadError('STALE_VIDEO', 'Ролик изменился. Обновите список форматов.');
      if (choice.transport === 'SABR' && !sabrSession) throw new DownloadError('SABR_SESSION_REQUIRED', 'Запустите видео на странице YouTube, затем повторите загрузку.');
      const jobId = await manager.start({ ...choice, sabrSession, videoId: state.videoId, duration: state.metadata.payload.duration, title: state.metadata.payload.title, tabId: p.tabId });
      return { jobId };
    }
    if (message.type === 'CANCEL_DOWNLOAD') {
      const job = manager.get(p.jobId);
      if (!job || job.tabId !== p.tabId) throw new DownloadError('INVALID_JOB', 'Загрузка не найдена.');
      await manager.cancel(p.jobId); return { cancelled: true };
    }
    throw new DownloadError('INVALID_MESSAGE', 'Неизвестная команда.');
  } };
}
