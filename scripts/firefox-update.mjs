import AdmZip from 'adm-zip';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const repository = 'r4mdevelopment/youtube-firefox-extension';
const id = 'youtube-mp4-downloader@local.invalid';
const updateUrl = `https://raw.githubusercontent.com/${repository}/main/updates/firefox.json`;
const versionPattern = /^\d+\.\d+\.\d+$/;
const compareVersions = (a, b) => {
  if (!versionPattern.test(a) || !versionPattern.test(b)) throw new Error('Invalid version');
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  return 0;
};

// Only the publisher's Mozilla-signed release assets belong in this channel.
// Signature files are a packaging check; Firefox verifies the Mozilla signature at installation.
export function buildUpdate(xpi, { tag, url, previous = { addons: {} } }) {
  const version = tag?.replace(/^v/, '');
  if (!versionPattern.test(version) || tag !== `v${version}`) throw new Error('Invalid release version');
  const expectedUrl = `https://github.com/${repository}/releases/download/${tag}/youtube-mp4-downloader-firefox-${version}.xpi`;
  if (url !== expectedUrl) throw new Error('Invalid signed XPI download URL');
  const zip = new AdmZip(xpi);
  for (const name of ['manifest.mf', 'mozilla.sf', 'mozilla.rsa']) {
    if (!zip.getEntry(`META-INF/${name}`) || !zip.readFile(`META-INF/${name}`)?.length) throw new Error('Missing Mozilla signature files');
  }
  const manifests = zip.getEntries().filter(entry => entry.entryName === 'manifest.json');
  if (manifests.length !== 1) throw new Error('Expected one manifest');
  const manifest = JSON.parse(zip.readAsText(manifests[0]));
  const gecko = manifest.browser_specific_settings?.gecko;
  if (gecko?.id !== id) throw new Error('Incorrect extension ID');
  if (manifest.version !== version) throw new Error('Package and release version differ');
  if (gecko.update_url !== updateUrl) throw new Error('Package must use the permanent update channel');
  if (typeof gecko.strict_min_version !== 'string') throw new Error('Missing Firefox compatibility');
  const update = { version, update_link: url,
    update_hash: `sha256:${createHash('sha256').update(xpi).digest('hex')}`,
    applications: { gecko: { strict_min_version: gecko.strict_min_version } } };
  for (const entry of previous.addons?.[id]?.updates ?? []) {
    const order = compareVersions(entry.version, version);
    if (order > 0) throw new Error('Refusing to publish an older version');
    if (order === 0 && (entry.update_hash !== update.update_hash || entry.update_link !== url)) throw new Error('Published version cannot be replaced');
  }
  return { addons: { [id]: { updates: [update] } } };
}

async function fetchRelease(tag, optional) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag ?? '')) throw new Error('Invalid release version');
  const response = await fetch(`https://api.github.com/repos/${repository}/releases/tags/${tag}`, {
    headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Release lookup failed: HTTP ${response.status}`);
  const release = await response.json();
  if (release.draft || release.prerelease || release.tag_name !== tag) throw new Error('Expected a published stable release');
  const name = `youtube-mp4-downloader-firefox-${tag.slice(1)}.xpi`;
  const asset = release.assets.find(item => item.name === name && item.state === 'uploaded');
  if (!asset) {
    if (optional) { console.log(`No signed XPI for ${tag}; update channel unchanged`); return null; }
    throw new Error(`Signed asset ${name} is not uploaded yet`);
  }
  const url = `https://github.com/${repository}/releases/download/${tag}/${name}`;
  if (asset.browser_download_url !== url) throw new Error('Invalid release asset URL');
  const downloaded = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!downloaded.ok) throw new Error(`XPI download failed: HTTP ${downloaded.status}`);
  return { xpi: Buffer.from(await downloaded.arrayBuffer()), url };
}

async function main() {
  const { values } = parseArgs({ options: {
    tag: { type: 'string' }, xpi: { type: 'string' }, url: { type: 'string' },
    output: { type: 'string', default: 'updates/firefox.json' },
    'if-signed': { type: 'boolean', default: false },
  } });
  const { tag, output } = values;
  const downloaded = values.xpi ? { xpi: await readFile(values.xpi), url: values.url } : await fetchRelease(tag, values['if-signed']);
  if (!downloaded) return;
  const { xpi, url } = downloaded;
  let previous;
  try { previous = JSON.parse(await readFile(output, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const feed = buildUpdate(xpi, { tag, url, previous });
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(feed, null, 2)}\n`, 'utf8');
  console.log(`Firefox update channel: ${tag}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
