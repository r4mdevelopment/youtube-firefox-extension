import { callApi } from '../common/browser-api.js';
import { createSiteUi } from './site-ui.js';
if (window.top === window && !document.querySelector('#ytdl-widget-host')) {
  const ui = createSiteUi({ doc: document, send: async (type, payload = {}) => {
    const result = await callApi('runtime', 'sendMessage', { type, payload });
    if (result?.error) throw new Error(`${result.error.message} (${result.error.code})`);
    return result;
  } });
  const update = () => ui.refresh().catch(() => {});
  update();
  let timer = setInterval(update, 1000);
  window.addEventListener('pagehide', () => clearInterval(timer));
  window.addEventListener('pageshow', event => { if (event.persisted) { clearInterval(timer);update();timer = setInterval(update, 1000); } });
}
