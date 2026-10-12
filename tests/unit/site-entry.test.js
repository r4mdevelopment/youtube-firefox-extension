import { JSDOM } from 'jsdom';
import { expect, it, vi } from 'vitest';
it('stops polling on every pagehide across repeated back-forward cache restores',async()=>{
 const dom=new JSDOM('<body></body>',{url:'https://example.org/'});let requests=0;
 vi.useFakeTimers();vi.stubGlobal('window',dom.window);vi.stubGlobal('document',dom.window.document);vi.stubGlobal('browser',{runtime:{sendMessage:async()=>{requests++;return {video:null,jobs:[]};}}});vi.resetModules();
 try{
  await import('../../src/content/site-entry.js');await vi.advanceTimersByTimeAsync(1000);
  for(let i=0;i<3;i++){
   const before=requests;dom.window.dispatchEvent(new dom.window.Event('pagehide'));await vi.advanceTimersByTimeAsync(1500);expect(requests).toBe(before);
   const show=new dom.window.Event('pageshow');Object.defineProperty(show,'persisted',{value:true});dom.window.dispatchEvent(show);await vi.advanceTimersByTimeAsync(1000);expect(requests).toBe(before+2);
  }
 }finally{vi.useRealTimers();vi.unstubAllGlobals();vi.resetModules();dom.window.close();}
});
