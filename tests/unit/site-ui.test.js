import { JSDOM } from 'jsdom';
import { expect, it } from 'vitest';
import { createSiteUi } from '../../src/content/site-ui.js';
const state=()=>({video:{videoId:'abcdefghijk',generation:1,title:'Video',choices:[{id:'137:140',height:1080,fps:30,mode:'adaptive'}],activeJob:null},jobs:[]});
const setup=()=>{const dom=new JSDOM('<div id="top-level-buttons-computed"><div id="segmented-like-button"></div></div>',{url:'https://www.youtube.com/watch?v=abcdefghijk'});let value=state();const ui=createSiteUi({doc:dom.window.document,send:async()=>value});return {doc:dom.window.document,ui,set:v=>{value=v;}};};
it('places one download control before likes and shows compatible quality choices',async()=>{
 const {doc,ui}=setup();await ui.refresh();await ui.refresh();const container=doc.querySelector('#top-level-buttons-computed');expect(container.firstElementChild.id).toBe('ytdl-inline-host');expect(doc.querySelectorAll('#ytdl-inline-host')).toHaveLength(1);
 const root=container.firstElementChild.shadowRoot;expect(root.querySelector('[data-role="toggle"]').textContent).toContain('Скачать');expect(doc.querySelector('#ytdl-quality-host')?.shadowRoot.querySelector('[data-choice]').textContent).toContain('1080p');
});
it('updates quality buttons after SPA and reconnects after YouTube replaces action controls',async()=>{
 const {doc,ui,set}=setup();await ui.refresh();doc.defaultView.history.replaceState(null,'','/watch?v=lmnopqrstuv');set({...state(),video:{...state().video,videoId:'lmnopqrstuv',generation:2,choices:[{id:'22',height:720,fps:30}]}});await ui.refresh();expect(doc.querySelector('#ytdl-quality-host').shadowRoot.querySelector('[data-choice]').dataset.choice).toBe('22');
 doc.querySelector('#top-level-buttons-computed').replaceChildren(doc.createElement('div'));await ui.refresh();expect(doc.querySelectorAll('#ytdl-inline-host')).toHaveLength(1);
});
it('shows all jobs on another site, marks completion, and renders hostile titles as text',async()=>{
 const dom=new JSDOM('<body></body>',{url:'https://example.org/'});let value={video:null,jobs:[{id:'a',title:'<img src=x onerror=alert(1)>',state:'downloading',progress:{video:{bytesReceived:50,expectedBytes:100}}},{id:'b',title:'Second',state:'complete',progress:{mux:1}}]};const ui=createSiteUi({doc:dom.window.document,send:async()=>value});await ui.refresh();const root=dom.window.document.querySelector('#ytdl-widget-host').shadowRoot;
 expect(root.textContent).toContain('50%');expect(root.textContent).toContain('Скачано');expect(root.querySelectorAll('[data-job]')).toHaveLength(2);expect(root.querySelector('img')).toBeNull();expect(root.querySelector('[data-cancel]').dataset.cancel).toBe('a');expect(root.querySelectorAll('[data-cancel]')).toHaveLength(1);
 value={video:null,jobs:[]};await ui.refresh();expect(dom.window.document.querySelector('#ytdl-widget-host').hidden).toBe(true);expect(dom.window.getComputedStyle(dom.window.document.querySelector('#ytdl-widget-host')).display).toBe('none');
});
