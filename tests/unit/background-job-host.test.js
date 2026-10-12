import { readFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { createBackgroundJobHost } from '../../src/background/job-host.js';
import { normalizeRepresentations } from '../../src/youtube/extractor.js';
import { buildDownloadChoices } from '../../src/youtube/formats.js';
import adaptive from '../fixtures/adaptive-1080.json';
const choice = () => ({ ...buildDownloadChoices(normalizeRepresentations(adaptive))[0], videoId: 'abcdefghijk', tabId: 7, title: 'Фоновый тест' });
const data = () => ({ blob: new Blob(['media']), bytesReceived: 5 });
const defaults = () => ({ persistent: true, openRunner: vi.fn(), send: vi.fn(), downloadStream: vi.fn(async () => data()), downloadSabr: vi.fn(async () => ({ video: data(), audio: data() })), mux: vi.fn(async () => new Blob(['muxed'])), save: vi.fn(async () => 42) });
const terminal = async (host, id) => { await vi.waitFor(() => expect(['complete','cancelled','failed']).toContain(host.get(id).state)); return host.get(id); };
it('runs adaptive media to completion without creating or messaging a task tab', async () => {
  const deps=defaults();const host=createBackgroundJobHost(deps);const states=[];host.subscribe(j=>states.push(j.state));
  const id=await host.start(choice());await host.hydrate();
  expect((await terminal(host,id)).state).toBe('complete');expect(states).toContain('muxing');expect(deps.save).toHaveBeenCalledOnce();
  expect(deps.openRunner).not.toHaveBeenCalled();expect(deps.send).not.toHaveBeenCalled();
});
it('cancels an in-flight SABR job without a runner and does not save partial media', async () => {
  const deps=defaults();let signal;
  deps.downloadSabr=vi.fn(async options=>{signal=options.signal;await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));return {video:data(),audio:data()};});
  const host=createBackgroundJobHost(deps);const id=await host.start({...choice(),transport:'SABR',sabrSession:{poToken:'secret'}});
  await vi.waitFor(()=>expect(signal).toBeDefined());host.cancel(id);expect((await terminal(host,id)).state).toBe('cancelled');expect(signal.aborted).toBe(true);
  expect(deps.save).not.toHaveBeenCalled();expect(deps.openRunner).not.toHaveBeenCalled();expect(JSON.stringify(host.list())).not.toContain('secret');
});
it('restores interrupted snapshots as failed without erasing completed history', async () => {
  const host=createBackgroundJobHost({...defaults(),initialJobs:[{id:'old',state:'muxing'},{id:'saved',state:'complete',downloadId:42}]});
  await host.hydrate();expect(host.get('old')).toMatchObject({state:'failed',error:{code:'BACKGROUND_RESTARTED'}});expect(host.get('saved')).toMatchObject({state:'complete',downloadId:42});
});
it('retains the Chromium proxy path', async () => {
  const deps=defaults();deps.persistent=false;deps.send=vi.fn(async message=>message.type==='RUNNER_STATE'?{jobs:[]}:{jobId:'remote'});
  const host=createBackgroundJobHost(deps);expect(await host.start(choice())).toBe('remote');expect(deps.send).toHaveBeenCalledWith({type:'RUNNER_START',payload:choice()});expect(deps.downloadStream).not.toHaveBeenCalled();
});
it('declares a persistent hidden Firefox background, while Chromium remains MV3', async () => {
  const read=async name=>JSON.parse(await readFile(new URL('../../manifest.'+name+'.json',import.meta.url),'utf8'));
  const firefox=await read('firefox');const chromium=await read('chromium');
  expect(firefox.manifest_version).toBe(2);expect(firefox.background.persistent).toBe(true);expect(firefox.browser_action.default_popup).toBe('popup/popup.html');
  expect(firefox.permissions).toContain('https://*.googlevideo.com/*');expect(firefox.host_permissions).toBeUndefined();
  expect(chromium.manifest_version).toBe(3);expect(chromium.background.service_worker).toBe('background.js');
});

it('refreshes expired media and attaches a fresh SABR session for the same tab', async () => {
  const deps=defaults();deps.downloadStream.mockRejectedValueOnce({code:'URL_EXPIRED'});
  const raw={...adaptive,transport:'SABR',title:'Фоновый тест',duration:20,adaptiveFormats:adaptive.adaptiveFormats.map(({url,...f})=>({...f,lastModified:'123'}))};
  deps.refreshMetadata=vi.fn(async()=>({videoId:'abcdefghijk',payload:raw}));deps.getSabrSession=vi.fn(async()=>({poToken:'fresh secret'}));
  const host=createBackgroundJobHost(deps);const id=await host.start(choice());
  expect((await terminal(host,id)).state).toBe('complete');expect(deps.refreshMetadata).toHaveBeenCalledWith(7,'abcdefghijk');
  expect(deps.downloadSabr.mock.calls[0][0].choice.sabrSession).toEqual({poToken:'fresh secret'});
  expect(JSON.stringify(host.list())).not.toContain('fresh secret');expect(deps.openRunner).not.toHaveBeenCalled();
});
