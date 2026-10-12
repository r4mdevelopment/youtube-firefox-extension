import { callApi } from '../common/browser-api.js';
import { renderPopup } from './view.js';
let state = { choices: [] }; let tabId; let busy = false; let actionError = '';
const error = e => { actionError = e.message || 'Не удалось связаться с расширением.'; document.querySelector('#error').textContent = actionError; };
async function send(type, payload = {}) {
  const result = await callApi('runtime', 'sendMessage', { type, payload: { ...payload, tabId } });
  if (result?.error) throw new Error(`${result.error.message} (${result.error.code})`);
  return result;
}
async function update() {
  if (tabId === undefined || busy) return;
  const next = await send('GET_CURRENT_VIDEO');
  if (next.videoId !== state.videoId) actionError = '';
  state = next; renderPopup(document, { ...state, actionError });
}
for (const [selector, type] of [['#download', 'START_DOWNLOAD'], ['#cancel', 'CANCEL_DOWNLOAD'], ['#retry', 'RETRY_DOWNLOAD']]) {
  document.querySelector(selector).addEventListener('click', async () => {
    if (busy) return;
    busy = true; document.querySelector(selector).disabled = true;
    actionError = '';
    try { await send(type, { choiceId: document.querySelector('#quality').value, videoId: state.videoId, generation: state.generation, jobId: state.activeJob?.id }); }
    catch (e) { error(e); }
    finally { busy = false; document.querySelector(selector).disabled = false; await update().catch(error); }
  });
}
callApi('tabs', 'query', { active: true, currentWindow: true }).then(async tabs => {
  tabId = tabs[0]?.id; await update();
  setInterval(() => update().catch(error), 750);
}).catch(error);
