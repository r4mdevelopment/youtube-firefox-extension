import { expect, it } from 'vitest';
import { createPlaybackCache } from '../../src/content/playback-cache.js';
it('keeps two captures in page memory and matches equivalent Base64 configs',()=>{
 const c=createPlaybackCache();c.put({config:'/w==',request:{marker:1}});c.put({config:'AQID',request:{marker:2}});
 expect(c.get('_w')).toEqual({marker:1});expect(c.get('other')).toBeNull();
 c.put({config:'BAUG',request:{marker:3}});expect(c.get('/w==')).toBeNull();
});
it('expires proof and does not share mutable references',()=>{
 let now=0;const c=createPlaybackCache({now:()=>now});const request={value:1};c.put({config:'AQID',request});request.value=9;
 expect(c.get('AQID')).toEqual({value:1});now=600001;expect(c.get('AQID')).toBeNull();
});
