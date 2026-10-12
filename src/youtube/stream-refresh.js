import { normalizeRepresentations } from './extractor.js';
import { buildDownloadChoices } from './formats.js';
import { DownloadError } from '../common/errors.js';
export function createStreamRefresher({ requestMetadata }) {
  return async ({ videoId, choiceId }) => {
    const metadata = await requestMetadata(videoId);
    if (metadata?.videoId !== videoId) throw new DownloadError('STALE_VIDEO', 'Текущий ролик изменился. Начните загрузку заново.');
    const choice = buildDownloadChoices(normalizeRepresentations(metadata.payload)).find(c => c.id === choiceId);
    if (!choice) throw new DownloadError('FORMAT_UNAVAILABLE', 'Выбранный формат больше не доступен.');
    return { ...choice, videoId, duration: metadata.payload.duration, title: metadata.payload.title };
  };
}
