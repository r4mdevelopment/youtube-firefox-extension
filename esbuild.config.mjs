import { build } from 'esbuild';
import { mkdir, copyFile, rm } from 'node:fs/promises';
const target = process.argv[2];
if (!['firefox', 'chromium'].includes(target)) throw new Error('Expected firefox or chromium');
const outdir = `dist/${target}`;
// Remove obsolete generated runner files when updating an existing build.
for (const name of ['runner/runner.js', 'runner/runner.html']) await rm(`${outdir}/${name}`, { force: true });
await mkdir(`${outdir}/popup`, { recursive: true });
if (target === 'chromium') await mkdir(`${outdir}/offscreen`, { recursive: true });
await build({
  entryPoints: { background: 'src/background/background.js', content: 'src/content/content.js', 'site-ui': 'src/content/site-entry.js', 'page-bridge': 'src/content/page-bridge.js', 'popup/popup': 'src/popup/popup.js', ...(target === 'chromium' ? { 'offscreen/offscreen': 'src/offscreen/offscreen.js' } : {}) },
  outdir, bundle: true, format: 'iife', platform: 'browser', target: 'es2021', legalComments: 'eof',
});
await copyFile(`manifest.${target}.json`, `${outdir}/manifest.json`);
for (const name of ['popup.html', 'popup.css']) await copyFile(`src/popup/${name}`, `${outdir}/popup/${name}`);
if (target === 'chromium') await copyFile('src/offscreen/offscreen.html', `${outdir}/offscreen/offscreen.html`);
await copyFile('THIRD_PARTY_NOTICES.txt', `${outdir}/THIRD_PARTY_NOTICES.txt`);
console.log(`Built ${outdir}`);
