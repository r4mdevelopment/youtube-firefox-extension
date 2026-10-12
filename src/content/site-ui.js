import { isYouTubeUrl } from '../common/youtube-url.js';
import { placeQualityMenu } from './menu-placement.js';
const terminal = new Set(['complete', 'failed', 'cancelled']);
const labels = { queued: 'Подготовка', downloading: 'Загрузка', retrying: 'Повторная попытка', muxing: 'Объединение', saving: 'Сохранение', complete: 'Скачано ✓', cancelled: 'Отменено', failed: 'Ошибка загрузки' };
const css = `:host{font:14px/1.4 Arial,sans-serif;color:#fff;color-scheme:dark}*{box-sizing:border-box}[hidden]{display:none!important}button{font:inherit;cursor:pointer;border:0;border-radius:18px;padding:8px 14px;color:#fff;background:#303030}button:hover{background:#454545}button:focus-visible{outline:2px solid #8bb5ff;outline-offset:2px}button:disabled{opacity:.5;cursor:default}.panel{background:#202124;color:#fff;border:1px solid #505050;border-radius:14px;box-shadow:0 6px 24px #0006;padding:12px;width:320px;max-width:calc(100vw - 24px)}header{display:flex;align-items:center;justify-content:space-between;gap:8px;font-weight:bold}header button{padding:4px 9px}h3{font-size:14px;margin:8px 0;overflow-wrap:anywhere}.jobs{max-height:40vh;overflow:auto}.job{padding:10px 0;border-top:1px solid #444}.row{display:flex;align-items:center;justify-content:space-between;gap:8px}.status{font-size:13px;color:#ccc;margin:6px 0}.error{color:#ff9b9b;overflow-wrap:anywhere}.quality{display:block;width:100%;text-align:left;border-radius:8px;margin:3px 0}.small{font-size:12px}progress{display:block;width:100%;height:6px;margin:4px 0 8px;accent-color:#78a8ff}.progress{font-size:12px;color:#ccc}.menu{position:relative;z-index:2147483647;max-height:60vh;overflow:auto}`;

export function createSiteUi({ doc, send }) {
  const element = (tag, text, attrs = {}) => {
    const node = doc.createElement(tag); if (text !== undefined) node.textContent = text;
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    return node;
  };
  const trusted = fn => event => { if (event.isTrusted) fn(event); };
  const shadowHost = id => {
    const host = element('div', undefined, { id });
    const root = host.attachShadow({ mode: 'open' }); root.append(element('style', css));
    return { host, root };
  };
  const progress = (container, values = {}) => {
    container.replaceChildren();
    for (const phase of ['audio', 'video', 'mux']) {
      const value = values[phase]; if (value === undefined) continue;
      const fraction = typeof value === 'number' ? value : value.expectedBytes ? value.bytesReceived / value.expectedBytes : null;
      const title = { audio: 'Аудио', video: 'Видео', mux: 'Объединение' }[phase];
      const text = fraction === null ? `${(Number(value.bytesReceived || 0) / 1048576).toFixed(1)} МБ` : `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
      const line = element('div', `${title}: ${text}`); const bar = element('progress');bar.max = 1;
      if (fraction !== null) bar.value = Math.max(0, Math.min(1, fraction));
      line.append(bar);container.append(line);
    }
  };
  let current = null; let pending = false; let error = ''; let collapsed = false;
  const rows = new Map(); let expiryTimer;
  const widget = shadowHost('ytdl-widget-host');widget.host.hidden = true;
  widget.host.style.cssText = 'position:fixed!important;right:16px!important;bottom:16px!important;z-index:2147483647!important;display:none!important;margin:0!important;padding:0!important;width:auto!important;';
  const panel = element('section', undefined, { class: 'panel', 'aria-label': 'Загрузки видео' });
  const heading = element('header');const count = element('span', 'Загрузки видео');
  const fold = element('button', '−', { title: 'Свернуть', 'aria-expanded': 'true' });
  const jobs = element('div', undefined, { class: 'jobs' });const globalError = element('div', '', { class: 'error', role: 'status' });
  const hideWidget = element('button', '×', { title: 'Закрыть на всех вкладках', 'data-role': 'hide-widget' });
  hideWidget.addEventListener('click', trusted(() => action('SITE_HIDE_WIDGET', {})));
  const headerActions = element('div');headerActions.append(fold, hideWidget);
  heading.append(count, headerActions);panel.append(heading, jobs, globalError);widget.root.append(panel);
  fold.addEventListener('click', trusted(() => { collapsed = !collapsed;jobs.hidden = collapsed;fold.textContent = collapsed ? '+' : '−';fold.title = collapsed ? 'Развернуть' : 'Свернуть';fold.setAttribute('aria-expanded', String(!collapsed)); }));
  const inline = shadowHost('ytdl-inline-host');inline.host.style.cssText = 'display:inline-block!important;flex-shrink:0!important;margin-right:8px!important;position:relative!important;';
  const toggle = element('button', 'Скачать', { 'data-role': 'toggle', 'aria-expanded': 'false', 'aria-haspopup': 'true' });
  const menu = element('section', undefined, { class: 'panel menu', 'aria-label': 'Качество видео' });menu.hidden = true;
  const menuHeader = element('header', 'Скачать MP4');const close = element('button', '×', { title: 'Закрыть' });menuHeader.append(close);
  const qualities = element('div');const inlineStatus = element('div', '', { class: 'status', role: 'status' });
  const inlineProgress = element('div', undefined, { class: 'progress' });
  const cancel = element('button', 'Отменить', { 'data-role': 'cancel' });cancel.hidden = true;
  menu.append(menuHeader, qualities, inlineStatus, inlineProgress, cancel);inline.root.append(toggle);
  const menuPortal = shadowHost('ytdl-quality-host');menuPortal.host.style.cssText = 'position:fixed!important;z-index:2147483647!important;display:none!important;margin:0!important;padding:0!important;';menuPortal.root.append(menu);
  const positionMenu = () => {
    if(menu.hidden || !inline.host.isConnected)return;
    const rect = toggle.getBoundingClientRect();const win = doc.defaultView;
    if(rect.bottom < 0 || rect.top > win.innerHeight){ setOpen(false);return; }
    menu.style.maxHeight = `${Math.max(40, win.innerHeight - 24)}px`;
    const size = menu.getBoundingClientRect();
    const placement = placeQualityMenu(rect, { width: size.width || 320, height: size.height || 200 }, { width: win.innerWidth, height: win.innerHeight });
    menuPortal.host.style.setProperty('left', `${placement.left}px`, 'important');menuPortal.host.style.setProperty('top', `${placement.top}px`, 'important');menu.style.maxHeight = `${placement.maxHeight}px`;
  };
  const setOpen = open => {
    menu.hidden = !open;toggle.setAttribute('aria-expanded', String(open));menuPortal.host.style.setProperty('display', open ? 'block' : 'none', 'important');
    if(open){ if(!menuPortal.host.isConnected)doc.body.append(menuPortal.host);positionMenu(); }
  };
  doc.addEventListener('scroll', positionMenu, true);doc.defaultView.addEventListener('resize', positionMenu);
  toggle.addEventListener('click', trusted(() => { setOpen(menu.hidden);refresh().catch(() => {}); }));
  close.addEventListener('click', trusted(() => setOpen(false)));
  doc.addEventListener('keydown', event => { if (event.isTrusted && event.key === 'Escape') setOpen(false); });
  doc.addEventListener('click', trusted(event => { if (!event.composedPath().includes(inline.host) && !event.composedPath().includes(menuPortal.host)) setOpen(false); }));
  async function action(type, payload) {
    if (pending) return;
    pending = true;error = '';
    try { await send(type, payload); } catch (e) { error = e.message || 'Не удалось выполнить команду.'; }
    finally { pending = false;await refresh().catch(() => {}); }
  }
  cancel.addEventListener('click', trusted(() => { if(current?.video?.activeJob) action('SITE_CANCEL_DOWNLOAD', { jobId: current.video.activeJob.id }); }));
  function render(value) {
    const previousId = current?.video?.videoId;current = value;
    if(previousId !== value.video?.videoId){ error = '';setOpen(false); }
    if(doc.body && !widget.host.isConnected) doc.body.append(widget.host);
    if(doc.body && !menuPortal.host.isConnected) doc.body.append(menuPortal.host);
    clearTimeout(expiryTimer);
    if (value.widgetHideAfterMs !== null && value.widgetHideAfterMs !== undefined) expiryTimer = setTimeout(() => refresh().catch(() => {}), value.widgetHideAfterMs);
    const visibleJobs = value.jobs || [];widget.host.hidden = !visibleJobs.length;widget.host.style.setProperty('display', visibleJobs.length ? 'block' : 'none', 'important');
    count.textContent = `Загрузки видео · ${visibleJobs.filter(j => !terminal.has(j.state)).length}`;globalError.textContent = error;
    for (const [id, row] of rows) if(!visibleJobs.some(j => j.id === id)){ row.node.remove();rows.delete(id); }
    for(const job of visibleJobs){
      let row = rows.get(job.id);
      if(!row){
        const node = element('article', undefined, { class: 'job', 'data-job': job.id });
        const title = element('h3');const line = element('div', undefined, { class: 'row' });const status = element('div', '', { class: 'status' });
        const button = element('button');const bars = element('div', undefined, { class: 'progress' });const failure = element('div', '', { class: 'error small' });
        line.append(status, button);node.append(title, line, bars, failure);jobs.append(node);row = { node, title, status, button, bars, failure };rows.set(job.id, row);
        button.addEventListener('click', trusted(() => { const latest = current.jobs.find(j => j.id === job.id);if(!latest)return;if(terminal.has(latest.state)){ action('SITE_DISMISS_JOB', { jobId: job.id }); }else action('SITE_CANCEL_DOWNLOAD', { jobId: job.id }); }));
      }
      row.title.textContent = job.title || 'Видео';row.status.textContent = labels[job.state] || job.state;
      row.button.textContent = terminal.has(job.state) ? '×' : 'Отменить';row.button.title = terminal.has(job.state) ? 'Скрыть' : 'Отменить загрузку';row.button.disabled = pending;
      if(terminal.has(job.state)) row.button.removeAttribute('data-cancel');else row.button.dataset.cancel = job.id;
      row.failure.textContent = job.error ? `${job.error.message} (${job.error.code})` : '';progress(row.bars, job.progress);
    }
    const url = new URL(doc.URL);const video = value.video;
    const onVideo = isYouTubeUrl(url) && url.pathname === '/watch';
    const mount = doc.querySelector('ytd-watch-metadata #top-level-buttons-computed, #top-level-buttons-computed');
    if(!onVideo || !mount){ inline.host.remove();setOpen(false);return; }
    if(inline.host.parentElement !== mount) mount.prepend(inline.host);
    const matches = video?.videoId === url.searchParams.get('v');
    const active = video?.activeJob && !terminal.has(video.activeJob.state);
    const choices = matches ? video.choices || [] : [];
    const desired = choices.map(c => ({ id: c.id, label: `${c.height}p · ${c.fps} fps${c.mode === 'adaptive' ? ' · видео + аудио' : ''}${c.estimatedBytes ? ` · ${(c.estimatedBytes / 1048576).toFixed(1)} МБ` : ''}` }));
    if(JSON.stringify(desired) !== qualities.dataset.signature){
      qualities.dataset.signature = JSON.stringify(desired);qualities.replaceChildren();
      for(const choice of desired){ const button = element('button', choice.label, { class: 'quality', 'data-choice': choice.id });
        button.addEventListener('click', trusted(() => {
          const selected = current?.video;const actualId = new URL(doc.URL).searchParams.get('v');
          if(!selected || selected.videoId !== actualId){ error = 'Ролик изменился. Откройте список качеств заново.';inlineStatus.textContent = error;return; }
          action('SITE_START_DOWNLOAD', { choiceId: choice.id, videoId: selected.videoId, generation: selected.generation });
        }));qualities.append(button);
      }
    }
    for(const button of qualities.children) button.disabled = pending || Boolean(active);
    cancel.hidden = !active;cancel.disabled = pending;
    inlineStatus.textContent = error || (active ? `${labels[video.activeJob.state]}${video.activeJob.title !== video.title ? `: ${video.activeJob.title}` : ''}` : matches ? video.unavailableReason || (choices.length ? 'Нажмите на качество для загрузки' : 'Ожидание доступных форматов…') : 'Ожидание данных текущего ролика…');
    progress(inlineProgress, active ? video.activeJob.progress : {});positionMenu();
  }
  let refreshing = false;
  async function refresh() {
    if(refreshing)return;refreshing = true;
    try { const value = await send('GET_SITE_VIEW');render(value); }
    finally { refreshing = false; }
  }
  return { refresh };
}
