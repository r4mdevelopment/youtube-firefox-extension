import { DownloadError, checkAbort } from '../common/errors.js';
import { sanitizeFilename } from '../common/utils.js';
import { isMp4RemuxCompatible } from '../mux/compatibility.js';
const terminalStates = new Set(['complete', 'cancelled', 'failed']);
const allowed = {
  queued: ['downloading', 'cancelled', 'failed'], downloading: ['retrying', 'muxing', 'saving', 'cancelled', 'failed'],
  retrying: ['downloading', 'cancelled', 'failed'], muxing: ['saving', 'cancelled', 'failed'],
  saving: ['complete', 'cancelled', 'failed'],
};

export function createDownloadManager({ downloadStream, downloadSabr, mux, save, refreshStreams, initialJobs = [], maxActiveJobs = 4 }) {
  const jobs = new Map(); const listeners = new Set();
  for (const snapshot of initialJobs) {
    const restored = structuredClone(snapshot);
    if (!terminalStates.has(restored.state)) {
      restored.state = 'failed'; restored.error = { code: 'BACKGROUND_RESTARTED', message: 'Фоновый процесс перезапущен. Начните загрузку заново.' };
    }
    jobs.set(restored.id, { snapshot: restored });
  }
  const publish = job => {
    for (const listener of listeners) { try { listener(structuredClone(job.snapshot)); } catch { /* A view cannot fail the job. */ } }
  };
  const transition = (job, state) => {
    if (terminalStates.has(job.snapshot.state)) return false;
    if (state !== job.snapshot.state && !allowed[job.snapshot.state]?.includes(state)) throw new Error(`Illegal transition ${job.snapshot.state}→${state}`);
    job.snapshot.state = state; publish(job); return true;
  };
  const execute = async job => {
    const signal = job.controller.signal;
    try {
      let output;
      for (;;) {
        checkAbort(signal); transition(job, 'downloading');
        const track = async (representation, phase) => {
          checkAbort(signal);
          job.snapshot.phase = phase;
          return downloadStream({ url: representation.url, expectedBytes: representation.expectedBytes, signal,
            onRetry: retry => {
              if (signal.aborted || terminalStates.has(job.snapshot.state)) return;
              job.snapshot.retryAttempt = retry.attempt; transition(job, 'retrying');
            }, onProgress: progress => {
              if (signal.aborted || terminalStates.has(job.snapshot.state)) return;
              job.snapshot.progress[phase] = progress; transition(job, 'downloading');
            } });
        };
        try {
          let sabr;
          if (job.choice.transport === 'SABR') sabr = await downloadSabr({ choice: job.choice, signal,
            onRetry: retry => { if (!signal.aborted && !terminalStates.has(job.snapshot.state)) { job.snapshot.retryAttempt = retry.attempt; transition(job, 'retrying'); } },
            onProgress: (phase, progress) => { if (!signal.aborted && !terminalStates.has(job.snapshot.state)) { job.snapshot.phase = phase; job.snapshot.progress[phase] = progress; transition(job, 'downloading'); } } });
          let video = sabr?.video ?? await track(job.choice.video, 'video'); checkAbort(signal);
          if (job.choice.mode === 'adaptive') {
            // A retry may succeed without reporting progress (dependency-specific).
            transition(job, 'downloading');
            let audio = sabr?.audio ?? await track(job.choice.audio, 'audio'); checkAbort(signal);
            transition(job, 'downloading'); transition(job, 'muxing');
            job.snapshot.phase = 'mux';
            output = await mux({ videoBlob: video.blob, audioBlob: audio.blob, signal, onProgress: progress => {
              if (!signal.aborted && job.snapshot.state === 'muxing') { job.snapshot.progress.mux = progress; publish(job); }
            } });
            video = null; audio = null; sabr = null;
          } else { output = video.blob; transition(job, 'downloading'); }
          break;
        } catch (error) {
          checkAbort(signal);
          if (error.code !== 'URL_EXPIRED' || job.refreshed) throw error;
          job.refreshed = true; transition(job, 'retrying');
          const updated = await refreshStreams({ videoId: job.choice.videoId, choiceId: job.choice.id, jobId: job.snapshot.id, tabId: job.snapshot.tabId });
          checkAbort(signal);
          if (updated.videoId !== job.choice.videoId || updated.id !== job.choice.id) throw new DownloadError('STALE_VIDEO', 'Обновлённые потоки относятся к другому ролику.');
          job.choice = { ...updated, title: job.choice.title }; job.snapshot.progress = {};
        }
      }
      checkAbort(signal);
      if (!(output instanceof Blob) || !output.size) throw new DownloadError('EMPTY_OUTPUT', 'Не удалось собрать непустой MP4.');
      transition(job, 'saving'); job.snapshot.phase = 'save';
      job.snapshot.downloadId = await save({ blob: output, filename: `${sanitizeFilename(job.choice.title)}.mp4`, saveAs: true, signal });
      checkAbort(signal); transition(job, 'complete');
    } catch (error) {
      if (terminalStates.has(job.snapshot.state)) return;
      job.snapshot.error = { code: error.code ?? 'DOWNLOAD_FAILED', message: error.message ?? 'Не удалось скачать видео.' };
      transition(job, signal.aborted || error.code === 'CANCELLED' ? 'cancelled' : 'failed');
    } finally {
      // Snapshots retain metadata only; release signed URLs, tracks and controllers.
      job.choice = null; job.controller = null;
    }
  };
  return {
    async start(choice) {
      const active = [...jobs.values()].filter(j => !terminalStates.has(j.snapshot.state));
      const duplicate = active.find(j => j.snapshot.choiceId === choice.id && j.snapshot.videoId === choice.videoId && j.snapshot.tabId === choice.tabId);
      if (duplicate) return duplicate.snapshot.id;
      if (active.length >= maxActiveJobs) throw new DownloadError('JOB_BUSY', `Уже выполняются ${maxActiveJobs} загрузки. Дождитесь завершения одной из них.`);
      if (!choice?.videoId || !isMp4RemuxCompatible(choice.video, choice.mode === 'progressive' ? choice.video : choice.audio).ok) throw new DownloadError('MUX_UNSUPPORTED_CODEC', 'Формат не поддерживается.');
      const id = crypto.randomUUID();
      const job = { choice: structuredClone(choice), controller: new AbortController(), refreshed: false,
        snapshot: { id, choiceId: choice.id, videoId: choice.videoId, title: choice.title, tabId: choice.tabId, state: 'queued', progress: {}, error: null, createdAt: Date.now() } };
      jobs.set(id, job); publish(job); queueMicrotask(() => execute(job)); return id;
    },
    cancel(id) {
      const job = jobs.get(id);
      if (!job || terminalStates.has(job.snapshot.state)) return;
      job.controller.abort(); transition(job, 'cancelled');
    },
    get(id) { const job = jobs.get(id); return job ? structuredClone(job.snapshot) : null; },
    list() { return [...jobs.values()].map(j => structuredClone(j.snapshot)); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}
