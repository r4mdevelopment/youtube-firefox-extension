import { JSDOM } from 'jsdom';
import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderPopup } from '../../src/popup/view.js';
function document() { return new JSDOM(readFileSync(new URL('../../src/popup/popup.html', import.meta.url), 'utf8')).window.document; }
it('renders real qualities and handles page titles as text', () => {
  const doc = document();
  renderPopup(doc, { videoId: 'abcdefghijk', title: '<img src=x onerror=alert(1)>', duration: 12, choices: [{ id: '18:progressive', height: 360, fps: 30, container: 'mp4', videoCodec: 'avc1.42001E', audioCodec: 'mp4a.40.2', mode: 'progressive', estimatedBytes: 100 }], activeJob: null });
  expect(doc.querySelector('#title').textContent).toBe('<img src=x onerror=alert(1)>');
  expect(doc.querySelector('#title img')).toBeNull();
  expect(Array.from(doc.querySelectorAll('#quality option')).map(o => o.textContent)).toEqual([expect.stringContaining('360p')]);
  expect(doc.querySelector('#download').disabled).toBe(false);
});
it('shows cancellation and errors from manager snapshots', () => {
  const doc = document();
  renderPopup(doc, { choices: [], activeJob: { state: 'failed', error: { code: 'HTTP_ERROR', message: 'HTTP 404' }, progress: {} } });
  expect(doc.querySelector('#error').textContent).toContain('HTTP 404'); expect(doc.querySelector('#retry').hidden).toBe(false);
  renderPopup(doc, { choices: [], activeJob: { state: 'cancelled', progress: {} } });
  expect(doc.querySelector('#status').textContent).toContain('отменена'); expect(doc.querySelector('#cancel').hidden).toBe(true);
});
it('keeps command errors visible after state refresh', () => {
  const doc = document();
  renderPopup(doc, { choices: [], activeJob: null, actionError: 'Дождитесь текущей загрузки (JOB_BUSY)' });
  expect(doc.querySelector('#error').textContent).toContain('JOB_BUSY');
});

const qualities = () => [{id:'137:140',height:1080,fps:30,mode:'adaptive',estimatedBytes:1000},{id:'136:140',height:720,fps:30,mode:'adaptive',estimatedBytes:500}];
it('does not recreate or mutate identical quality options during periodic progress refresh', () => {
  const doc=document();const state={videoId:'abcdefghijk',choices:qualities(),activeJob:null};renderPopup(doc,state);
  const select=doc.querySelector('#quality');select.value='136:140';select.focus();const nodes=[...select.options];
  const observer=new doc.defaultView.MutationObserver(()=>{});observer.observe(select,{childList:true,subtree:true,characterData:true});
  for(let i=0;i<4;i++)renderPopup(doc,structuredClone(state));
  expect([...select.options]).toEqual(nodes);expect(select.options[0]).toBe(nodes[0]);expect(select.options[1]).toBe(nodes[1]);
  expect(observer.takeRecords()).toHaveLength(0);observer.disconnect();expect(select.value).toBe('136:140');expect(doc.activeElement).toBe(select);
});
it('refreshes changed quality labels and availability while keeping a still-valid selection', () => {
  const doc=document();renderPopup(doc,{choices:qualities()});const select=doc.querySelector('#quality');select.value='136:140';
  const changed=qualities();changed[0].estimatedBytes=2097152;renderPopup(doc,{choices:changed});
  expect(select.options[0].textContent).toContain('2.0');expect(select.value).toBe('136:140');
  renderPopup(doc,{choices:[changed[0]]});expect(select.options).toHaveLength(1);expect(select.value).toBe('137:140');
});
