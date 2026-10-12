import { readFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { Input, ALL_FORMATS, BlobSource, EncodedPacketSink } from 'mediabunny';
import { muxMp4 } from '../../src/mux/muxer.js';
const fixture = async name => new Blob([await readFile(new URL(`../fixtures/${name}`, import.meta.url))]);
const open = blob => new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
it('rejects incompatible actual codecs before starting output', async () => {
  await expect(muxMp4({ videoBlob: await fixture('unsupported.webm'), audioBlob: await fixture('audio-only.mp4') })).rejects.toMatchObject({ code: 'MUX_UNSUPPORTED_CODEC' });
});
it('remuxes playable tracks with exact encoded samples and timestamps', async () => {
  const videoBlob = await fixture('video-only.mp4'); const audioBlob = await fixture('audio-only.mp4');
  const output = await muxMp4({ videoBlob, audioBlob });
  expect(output.type).toBe('video/mp4'); expect(output.size).toBeGreaterThan(0);
  const result = open(output); const videoInput = open(videoBlob); const audioInput = open(audioBlob);
  try {
    expect(await result.getVideoTracks()).toHaveLength(1); expect(await result.getAudioTracks()).toHaveLength(1);
    expect(await result.computeDuration()).toBeCloseTo(1, 1);
    for (const [source, kind] of [[videoInput, 'Video'], [audioInput, 'Audio']]) {
      const packets = async track => {
        const all = [];
        for await (const packet of new EncodedPacketSink(track).packets()) all.push({ data: Array.from(packet.data), timestamp: packet.timestamp, duration: packet.duration });
        return all;
      };
      expect(await packets(await result[`getPrimary${kind}Track`]())).toEqual(await packets(await source[`getPrimary${kind}Track`]()));
    }
  } finally { result.dispose(); videoInput.dispose(); audioInput.dispose(); }
});
it('honors cancellation before and during mux', async () => {
  const videoBlob = await fixture('video-only.mp4'); const audioBlob = await fixture('audio-only.mp4');
  const controller = new AbortController(); controller.abort();
  await expect(muxMp4({ videoBlob, audioBlob, signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
  const mid = new AbortController();
  await expect(muxMp4({ videoBlob, audioBlob, signal: mid.signal, onProgress: () => mid.abort() })).rejects.toMatchObject({ code: 'CANCELLED' });
});
it('reads the original blobs through slices without copying whole input buffers', async () => {
  const videoBlob = await fixture('video-only.mp4'); const audioBlob = await fixture('audio-only.mp4');
  videoBlob.arrayBuffer = () => { throw new Error('full input copy'); };
  audioBlob.arrayBuffer = () => { throw new Error('full input copy'); };
  expect((await muxMp4({ videoBlob, audioBlob })).size).toBeGreaterThan(0);
});
it('reports invalid MP4 as a typed mux error', async () => {
  await expect(muxMp4({ videoBlob: new Blob(['broken']), audioBlob: await fixture('audio-only.mp4') })).rejects.toMatchObject({ code: 'MUX_FAILED' });
});
it('finishes remux while background timers are unavailable and bounds progress updates', async () => {
  const videoBlob=await fixture('background-video.mp4');const audioBlob=await fixture('background-audio.mp4');
  const progress=[];
  const timer=vi.spyOn(globalThis,'setTimeout').mockImplementation(()=>{throw new Error('background timer cannot run');});
  let output;
  try {output=await muxMp4({videoBlob,audioBlob,onProgress:p=>progress.push(p)});}
  finally {timer.mockRestore();}
  const result=open(output);
  try {expect(await result.computeDuration()).toBeCloseTo(20,1);}
  finally {result.dispose();}
  expect(progress.at(-1)).toBe(1);expect(progress.length).toBeLessThan(100);
});
it('accepts cancellation from a queued browser task while processing a longer clip', async () => {
  const videoBlob=await fixture('background-video.mp4');const audioBlob=await fixture('background-audio.mp4');
  const controller=new AbortController();let channel;
  await expect(muxMp4({videoBlob,audioBlob,signal:controller.signal,onProgress:()=>{
    if(channel)return;channel=new MessageChannel();channel.port1.onmessage=()=>{channel.port1.close();channel.port2.close();controller.abort();};channel.port2.postMessage(null);
  }})).rejects.toMatchObject({code:'CANCELLED'});
});
