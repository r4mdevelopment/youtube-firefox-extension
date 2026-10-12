export class DownloadError extends Error {
  constructor(code, message = code, details = {}) {
    super(message);
    this.name = 'DownloadError';
    this.code = code;
    Object.assign(this, details);
  }
}
export function checkAbort(signal) {
  if (signal?.aborted) throw new DownloadError('CANCELLED', 'Загрузка отменена.');
}
