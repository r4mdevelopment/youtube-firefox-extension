export function isYouTubeUrl(value) {
  try {
    const url = new URL(value);
    return !url.username && !url.password &&
      (url.origin === 'https://youtube.com' || url.origin === 'https://www.youtube.com');
  } catch { return false; }
}
