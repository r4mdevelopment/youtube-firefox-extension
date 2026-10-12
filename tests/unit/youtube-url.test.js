import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { isYouTubeUrl } from '../../src/common/youtube-url.js';
it.each(['https://youtube.com/watch?v=abcdefghijk','https://www.youtube.com/'])('accepts supported origin %s', url => {
 expect(isYouTubeUrl(url)).toBe(true);
});
it.each(['https://youtube.com.evil.test/','https://www.youtube.com.evil.test/','http://youtube.com/','https://m.youtube.com/','https://youtube.com:8443/','https://user@youtube.com/','not a URL',undefined])('rejects unsupported source %s', url => {
 expect(isYouTubeUrl(url)).toBe(false);
});
it.each(['firefox','chromium'])('injects metadata collection on both supported hosts in %s', browser => {
 const manifest=JSON.parse(readFileSync(new URL(`../../manifest.${browser}.json`,import.meta.url),'utf8'));
 expect(manifest.content_scripts.find(entry=>entry.js.includes('content.js')).matches).toEqual(['https://www.youtube.com/*','https://youtube.com/*']);
});
