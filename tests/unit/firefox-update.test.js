import { afterEach, describe, expect, it } from 'vitest';
import AdmZip from 'adm-zip';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const id = 'youtube-mp4-downloader@local.invalid';
const updateUrl = 'https://raw.githubusercontent.com/r4mdevelopment/youtube-firefox-extension/main/updates/firefox.json';
const downloadUrl = 'https://github.com/r4mdevelopment/youtube-firefox-extension/releases/download/v0.1.12/youtube-mp4-downloader-firefox-0.1.12.xpi';
const folders = [];
function fixture({ signed = true, version = '0.1.12', addonId = id, channel = updateUrl } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'firefox-update-'));
  folders.push(dir);
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify({ manifest_version: 2, version,
    browser_specific_settings: { gecko: { id: addonId, strict_min_version: '142.0', update_url: channel } } })));
  // Signature-shaped fixture exercises packaging gates; Firefox verifies actual Mozilla signatures.
  if (signed) for (const name of ['manifest.mf', 'mozilla.sf', 'mozilla.rsa']) zip.addFile(`META-INF/${name}`, Buffer.from('fixture'));
  const xpi = join(dir, 'addon.xpi');
  writeFileSync(xpi, zip.toBuffer());
  return { dir, xpi, output: join(dir, 'firefox.json') };
}
function run(f, { url = downloadUrl, tag = 'v0.1.12' } = {}) {
  return spawnSync(process.execPath, ['scripts/firefox-update.mjs', '--xpi', f.xpi, '--url', url, '--tag', tag, '--output', f.output], { encoding: 'utf8' });
}
afterEach(() => { for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('Firefox update publication', () => {
  it('publishes the package version, exact download hash and Firefox compatibility', () => {
    const f = fixture();
    const result = run(f);
    expect(result.status, result.stderr).toBe(0);
    const entry = JSON.parse(readFileSync(f.output, 'utf8')).addons[id].updates[0];
    expect(entry).toEqual({ version: '0.1.12', update_link: downloadUrl,
      update_hash: `sha256:${createHash('sha256').update(readFileSync(f.xpi)).digest('hex')}`,
      applications: { gecko: { strict_min_version: '142.0' } } });
  });
  it.each([
    ['unsigned packages', { signed: false }, {}, 'signature'],
    ['another extension', { addonId: 'other@example.com' }, {}, 'ID'],
    ['a release with a different version', { version: '0.1.11' }, {}, 'version'],
    ['a package without the update channel', { channel: null }, {}, 'channel'],
    ['an external download host', {}, { url: 'https://example.com/addon.xpi' }, 'URL'],
    ['an unsigned ZIP release asset', {}, { url: downloadUrl.replace('.xpi', '.zip') }, 'URL'],
  ])('rejects %s without writing an update', (_, options, args, message) => {
    const f = fixture(options);
    const result = run(f, args);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
    expect(existsSync(f.output)).toBe(false);
  });
  it('does not replace an existing feed with an older version', () => {
    const f = fixture();
    const previous = JSON.stringify({ addons: { [id]: { updates: [{ version: '0.1.13' }] } } });
    writeFileSync(f.output, previous);
    const result = run(f);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('older');
    expect(readFileSync(f.output, 'utf8')).toBe(previous);
  });
  it('allows republishing the identical signed package', () => {
    const f = fixture();
    expect(run(f).status).toBe(0);
    const previous = readFileSync(f.output, 'utf8');
    expect(run(f).status).toBe(0);
    expect(readFileSync(f.output, 'utf8')).toBe(previous);
  });
  it('rejects replacing a published version with different bytes', () => {
    const f = fixture();
    expect(run(f).status).toBe(0);
    const previous = readFileSync(f.output, 'utf8');
    const zip = new AdmZip(f.xpi);
    zip.addFile('changed.js', Buffer.from('changed'));
    zip.writeZip(f.xpi);
    expect(run(f).status).not.toBe(0);
    expect(readFileSync(f.output, 'utf8')).toBe(previous);
  });
});
