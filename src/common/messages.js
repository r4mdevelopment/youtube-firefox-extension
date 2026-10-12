export const YTDL_PAGE_BRIDGE_MESSAGE = 'YTDL_PAGE_BRIDGE_MESSAGE';
export const YTDL_PAGE_BRIDGE_REQUEST = 'YTDL_PAGE_BRIDGE_REQUEST';
const types = new Set(['INJECT_BRIDGE', 'VIDEO_METADATA', 'VIDEO_CHANGED', 'GET_CURRENT_VIDEO', 'START_DOWNLOAD', 'CANCEL_DOWNLOAD', 'RETRY_DOWNLOAD', 'JOB_UPDATED', 'REFRESH_STREAMS']);
const textFields = ['url', 'mimeType', 'contentLength', 'qualityLabel', 'audioQuality', 'signatureCipher', 'cipher', 'lastModified', 'xtags'];
const numberFields = ['itag', 'width', 'height', 'fps', 'bitrate', 'averageBitrate', 'audioSampleRate', 'audioChannels', 'approxDurationMs'];

function plain(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  // Firefox postMessage data retains the page realm's Object.prototype.
  if (prototype !== Object.prototype) {
    if (!prototype || Object.getPrototypeOf(prototype) !== null) return false;
    const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor');
    if (!constructor || !('value' in constructor) || typeof constructor.value !== 'function' ||
        Function.prototype.toString.call(constructor.value) !== Function.prototype.toString.call(Object)) return false;
  }
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(d => 'value' in d);
}
function ownData(value) {
  const result = Object.create(null);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) result[key] = descriptor.value;
  return result;
}
export function isMediaUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      (url.hostname === 'googlevideo.com' || url.hostname.endsWith('.googlevideo.com'));
  } catch { return false; }
}
export function parsePageMessage(value) {
  try {
    if (!plain(value)) return null;
    value = ownData(value);
    if (value.type !== YTDL_PAGE_BRIDGE_MESSAGE || !/^[\w-]{11}$/.test(value.videoId) ||
        !Number.isSafeInteger(value.generation) || value.generation < 0 || !plain(value.payload)) return null;
    const p = ownData(value.payload);
    if (typeof p.title !== 'string' || p.title.length > 5000 || !Number.isFinite(p.duration) || p.duration < 0 || p.duration > 864000) return null;
    const project = list => {
      if (!Array.isArray(list) || list.length > 500) throw new Error('invalid formats');
      return list.map(format => {
        if (!plain(format)) throw new Error('invalid format');
        format = ownData(format);
        if (!Number.isSafeInteger(format.itag) || format.itag < 0) throw new Error('invalid format');
        const clean = {};
        for (const key of textFields) if (format[key] !== undefined) {
          if (typeof format[key] !== 'string' || format[key].length > (key === 'url' || key === 'signatureCipher' || key === 'cipher' ? 16384 : 256)) throw new Error('invalid field');
          clean[key] = format[key];
        }
        for (const key of numberFields) if (format[key] !== undefined) {
          const n = Number(format[key]);
          if (!Number.isFinite(n) || n < 0 || n > Number.MAX_SAFE_INTEGER) throw new Error('invalid number');
          clean[key] = n;
        }
        if (clean.url && !isMediaUrl(clean.url)) throw new Error('invalid media host');
        return clean;
      });
    };
    return { type: YTDL_PAGE_BRIDGE_MESSAGE, videoId: value.videoId, generation: value.generation,
      payload: { title: p.title, duration: p.duration, status: ['OK', 'UNAVAILABLE', 'LIVE'].includes(p.status) ? p.status : 'UNAVAILABLE',
        sabrConfig: typeof p.sabrConfig === 'string' && p.sabrConfig.length <= 65536 && /^[A-Za-z0-9_+\/=-]+$/.test(p.sabrConfig) ? p.sabrConfig : undefined,
        transport: p.transport === 'SABR' ? 'SABR' : 'DIRECT',
        formats: project(p.formats), adaptiveFormats: project(p.adaptiveFormats) } };
  } catch { return null; }
}
export function makeExtensionMessage(type, payload = {}) {
  if (!types.has(type)) throw new Error('Unknown extension message');
  return { type, payload };
}
