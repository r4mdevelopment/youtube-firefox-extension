export function sanitizeFilename(title) {
  let name = String(title ?? '').normalize('NFC')
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '');
  if (!name) name = 'video';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
  return Array.from(name).slice(0, 100).join('').replace(/[. ]+$/g, '');
}
