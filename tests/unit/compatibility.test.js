import { expect, it } from 'vitest';
import { isMp4RemuxCompatible } from '../../src/mux/compatibility.js';
const video = { container: 'mp4', videoCodec: 'avc1.640028', hasVideo: true, hasAudio: false };
const audio = { container: 'mp4', audioCodec: 'mp4a.40.2', hasAudio: true, hasVideo: false };
it('accepts MP4 AVC with AAC', () => expect(isMp4RemuxCompatible(video, audio)).toEqual({ ok: true }));
it('rejects VP9 and Opus with an explicit reason', () => expect(isMp4RemuxCompatible({ ...video, videoCodec: 'vp09' }, { ...audio, audioCodec: 'opus' })).toMatchObject({ ok: false, reason: expect.any(String) }));
it('rejects missing track metadata', () => expect(isMp4RemuxCompatible(video, null).ok).toBe(false));
it('rejects mislabeled WebM AVC', () => expect(isMp4RemuxCompatible({ ...video, container: 'webm' }, audio).ok).toBe(false));
