import { isMp4RemuxCompatible } from '../mux/compatibility.js';

export function buildDownloadChoices(representations, targetHeights = [144, 240, 360, 480, 720, 1080]) {
  const audio = representations.filter(r => r.hasAudio && !r.hasVideo)
    .sort((a, b) => b.bitrate - a.bitrate || a.itag - b.itag);
  const choices = representations.filter(r => r.hasVideo && Number.isSafeInteger(r.height) && r.height > 0 && targetHeights.includes(r.qualityHeight ?? r.height)).flatMap(video => {
    const progressive = video.hasAudio;
    if (progressive && video.transport === 'SABR') return [];
    const track = progressive ? video : audio.find(a => (a.transport ?? 'DIRECT') === (video.transport ?? 'DIRECT') && isMp4RemuxCompatible(video, a).ok);
    if (!isMp4RemuxCompatible(video, track).ok) return [];
    const estimatedBytes = video.expectedBytes && (progressive || track.expectedBytes)
      ? video.expectedBytes + (progressive ? 0 : track.expectedBytes) : null;
    return [{ id: `${video.itag}:${progressive ? 'progressive' : track.itag}`, height: video.qualityHeight ?? video.height, fps: video.fps,
      transport: video.transport ?? 'DIRECT',
      container: 'mp4', videoCodec: video.videoCodec, audioCodec: track.audioCodec,
      mode: progressive ? 'progressive' : 'adaptive', video, audio: progressive ? null : track, estimatedBytes, recommended: false }];
  }).sort((a, b) => b.height - a.height || b.fps - a.fps || (a.transport === 'SABR' ? 0 : 1) - (b.transport === 'SABR' ? 0 : 1) || (a.mode === 'progressive' ? -1 : 1) - (b.mode === 'progressive' ? -1 : 1) || a.video.itag - b.video.itag);
  const seen = new Set();
  return choices.filter(c => {
    if (seen.has(c.id)) return false;
    seen.add(c.id); return true;
  }).map((c, i) => ({ ...c, recommended: i === 0 }));
}
