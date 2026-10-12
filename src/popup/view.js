const labels = { queued: 'В очереди', downloading: 'Загрузка', retrying: 'Повторная попытка', muxing: 'Объединение дорожек', saving: 'Сохранение файла', complete: 'Файл сохранён', cancelled: 'Загрузка отменена', failed: 'Ошибка загрузки' };
const terminal = new Set(['complete', 'failed', 'cancelled']);
export function renderPopup(doc, state) {
  const q = selector => doc.querySelector(selector);
  q('#title').textContent = state.title || 'Откройте видео на YouTube';
  const seconds = Math.round(state.duration || 0);
  q('#duration').textContent = seconds ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : '';
  const quality = q('#quality');
  const selected = quality.value;
  const desired = (state.choices ?? []).map(choice => {
    const size = choice.estimatedBytes ? ` · ${(choice.estimatedBytes / 1048576).toFixed(1)} МБ` : '';
    return { value: choice.id, label: `${choice.height}p · ${choice.fps} fps · MP4 · H.264/AAC · ${choice.mode === 'adaptive' ? 'видео + аудио' : 'готовый поток'}${size}` };
  });
  // Recreating options while Firefox's native picker is open resets its hover.
  const existing = Array.from(quality.options);
  if (existing.length !== desired.length || desired.some((option, i) => existing[i]?.value !== option.value || existing[i]?.textContent !== option.label)) {
    quality.replaceChildren(...desired.map(({ value, label }) => {
      const option = doc.createElement('option'); option.value = value; option.textContent = label; return option;
    }));
    if (desired.some(option => option.value === selected)) quality.value = selected;
  }
  const job = state.activeJob; const active = job && !terminal.has(job.state);
  q('#download').disabled = active || !(state.choices?.length);
  if (quality.disabled !== Boolean(active)) quality.disabled = Boolean(active);
  q('#cancel').hidden = !active;
  q('#retry').hidden = !(job && ['failed', 'cancelled'].includes(job.state));
  q('#status').textContent = job ? labels[job.state] ?? '' : state.unavailableReason || (state.choices?.length ? 'Выберите качество' : state.videoId ? 'Ожидание доступных форматов…' : 'Поддерживаются страницы youtube.com/watch');
  q('#error').textContent = state.actionError || (job?.error ? `${job.error.message} (${job.error.code})` : '');
  q('#job-title').textContent = active && job.title !== state.title ? job.title : '';
  q('#progress').replaceChildren();
  for (const [phase, value] of Object.entries(job?.progress ?? {})) {
    const line = doc.createElement('p'); const name = { video: 'Видео', audio: 'Аудио', mux: 'Объединение' }[phase] ?? phase;
    const fraction = typeof value === 'number' ? value : value.expectedBytes ? value.bytesReceived / value.expectedBytes : null;
    line.textContent = fraction === null ? `${name}: ${(value.bytesReceived / 1048576).toFixed(1)} МБ` : `${name}: ${Math.round(Math.min(1, fraction) * 100)}%`;
    const bar = doc.createElement('progress'); bar.max = 1; if (fraction !== null) bar.value = fraction;
    line.append(bar); q('#progress').append(line);
  }
}
