export function isMp4RemuxCompatible(video, audio) {
  if (!video?.hasVideo || !audio?.hasAudio) return { ok: false, reason: 'Отсутствует видео или аудиодорожка.' };
  if (video.container !== 'mp4' || audio.container !== 'mp4') return { ok: false, reason: 'Поддерживается контейнер MP4.' };
  if (!/^avc[13](?:\.|$)/i.test(video.videoCodec ?? '') || !/^mp4a\.40\.(2|5|29)$/i.test(audio.audioCodec ?? '')) {
    return { ok: false, reason: 'Для MP4 требуется H.264 и AAC. Перекодирование не поддерживается.' };
  }
  return { ok: true };
}
