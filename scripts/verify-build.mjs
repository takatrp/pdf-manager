import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = await readFile(resolve(rootDir, 'index.html'), 'utf8');
const manifest = JSON.parse(await readFile(resolve(rootDir, 'vendor/manifest.json'), 'utf8'));
const forbiddenCdns = ['unpkg.com', 'cdn.jsdelivr.net', 'cdnjs.cloudflare.com'];

for (const host of forbiddenCdns) {
  if (html.includes(host)) throw new Error(`External library CDN remains in index.html: ${host}`);
}

const manifestFiles = Object.values(manifest.packages).flatMap((entry) =>
  entry.files || [{
    sourceFile: entry.sourceFile,
    servedFile: entry.servedFile,
    sha256: entry.sha256,
  }],
);

for (const fileEntry of manifestFiles) {
  const filePath = resolve(rootDir, fileEntry.servedFile);
  await access(filePath);
  const digest = createHash('sha256').update(await readFile(filePath)).digest('hex');
  if (digest !== fileEntry.sha256) {
    throw new Error(`Vendor hash mismatch: ${fileEntry.servedFile}`);
  }
}

console.log('Static build verification passed.');
