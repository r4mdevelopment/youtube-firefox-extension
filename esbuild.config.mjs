import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
const target = process.argv[2];
if (!['firefox', 'chromium'].includes(target)) throw new Error('Expected firefox or chromium');
const outdir = `dist/${target}`;
await mkdir(`${outdir}/popup`, { recursive: true });
await mkdir(`${outdir}/runner`, { recursive: true });
await build({
  entryPoints: { background: 'src/background/background.js', content: 'src/content/content.js', 'site-ui': 'src/content/site-entry.js', 'page-bridge': 'src/content/page-bridge.js', 'popup/popup': 'src/popup/popup.js', 'runner/runner': 'src/runner/runner.js' },
  outdir, bundle: true, format: 'iife', platform: 'browser', target: 'es2021', legalComments: 'eof',
});
await copyFile(`manifest.${target}.json`, `${outdir}/manifest.json`);
for (const name of ['popup.html', 'popup.css']) await copyFile(`src/popup/${name}`, `${outdir}/popup/${name}`);
await copyFile('src/runner/runner.html', `${outdir}/runner/runner.html`);
await copyFile('THIRD_PARTY_NOTICES.txt', `${outdir}/THIRD_PARTY_NOTICES.txt`);
console.log(`Built ${outdir}`);
