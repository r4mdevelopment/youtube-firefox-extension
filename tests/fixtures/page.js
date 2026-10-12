export const videoId = 'abcdefghijk';
export function pageEnvelope() {
  return { type: 'YTDL_PAGE_BRIDGE_MESSAGE', videoId, generation: 1, payload: {
    title: 'Видео / пример', duration: 12, status: 'OK',
    formats: [{ itag: 18, url: 'https://r1.googlevideo.com/videoplayback?id=sample', mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"', height: 360, fps: 30, contentLength: '100', audioQuality: 'AUDIO_QUALITY_LOW' }],
    adaptiveFormats: [], tracking: { secret: true },
  } };
}
