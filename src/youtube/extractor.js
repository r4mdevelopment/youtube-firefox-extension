import { isMediaUrl } from '../common/messages.js';

export function normalizeRepresentations(raw) {
  if (!raw || raw.status === 'UNAVAILABLE' || raw.status === 'LIVE') return [];
  const lists = [raw.formats ?? [], raw.adaptiveFormats ?? []];
  return lists.flatMap(list => Array.isArray(list) ? list : []).flatMap(f => {
    const sabr = raw.transport === 'SABR' && !f?.url;
    if (!f || !Number.isSafeInteger(f.itag) || typeof f.mimeType !== 'string' ||
        (sabr ? !/^\d{1,20}$/.test(f.lastModified ?? '') : !isMediaUrl(f.url))) return [];
    const match = /^(video|audio)\/(mp4|webm)\s*;\s*codecs="([^"]+)"/i.exec(f.mimeType);
    if (!match) return [];
    const codecs = match[3].split(',').map(c => c.trim());
    const hasVideo = match[1].toLowerCase() === 'video';
    const audioCodec = codecs.find(c => /^(mp4a|opus|vorbis)/i.test(c)) ?? null;
    const videoCodec = hasVideo ? codecs.find(c => !/^(mp4a|opus|vorbis)/i.test(c)) ?? null : null;
    const length = Number(f.contentLength);
    // YouTube quality labels describe the rendition even when encoded frames are cropped.
    const qualityLabel = /^(\d{2,4})p(?:\d{1,3})?$/.exec(f.qualityLabel ?? '');
    return [{ id: String(f.itag), itag: f.itag, url: f.url, mimeType: f.mimeType,
      transport: sabr ? 'SABR' : 'DIRECT', lastModified: f.lastModified, xtags: f.xtags ?? '',
      container: match[2].toLowerCase(), hasVideo, hasAudio: Boolean(audioCodec), videoCodec, audioCodec,
      height: Number(f.height) || 0, qualityHeight: qualityLabel ? Number(qualityLabel[1]) : Number(f.height) || 0, fps: Number(f.fps) || 0, bitrate: Number(f.bitrate) || 0,
      expectedBytes: Number.isSafeInteger(length) && length > 0 ? length : null }];
  });
}
