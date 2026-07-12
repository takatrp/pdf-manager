import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(resolve(rootDir, 'package.json'), 'utf8'));

const packages = [
  {
    name: 'pdf-lib',
    version: packageJson.dependencies['pdf-lib'],
    files: [
      ['node_modules/pdf-lib/dist/pdf-lib.min.js', 'vendor/pdf-lib/pdf-lib.min.js'],
    ],
    license: ['node_modules/pdf-lib/LICENSE.md', 'vendor/licenses/pdf-lib-LICENSE'],
  },
  {
    name: 'heic2any',
    version: packageJson.dependencies.heic2any,
    files: [
      ['node_modules/heic2any/dist/heic2any.min.js', 'vendor/heic2any/heic2any.min.js'],
    ],
    license: ['node_modules/heic2any/LICENSE.md', 'vendor/licenses/heic2any-LICENSE'],
  },
  {
    name: 'pdfjs-dist',
    version: packageJson.dependencies['pdfjs-dist'],
    files: [
      ['node_modules/pdfjs-dist/build/pdf.min.mjs', 'vendor/pdfjs/pdf.min.mjs'],
      ['node_modules/pdfjs-dist/build/pdf.worker.min.mjs', 'vendor/pdfjs/pdf.worker.min.mjs'],
    ],
    license: ['node_modules/pdfjs-dist/LICENSE', 'vendor/licenses/pdfjs-LICENSE'],
  },
];

async function copyRequiredFile(sourceFile, servedFile) {
  const sourcePath = resolve(rootDir, sourceFile);
  const servedPath = resolve(rootDir, servedFile);
  const bytes = await readFile(sourcePath);
  await mkdir(dirname(servedPath), { recursive: true });
  await copyFile(sourcePath, servedPath);
  return {
    sourceFile,
    servedFile,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

const manifest = { packages: {} };

for (const packageEntry of packages) {
  const fileEntries = [];
  for (const [sourceFile, servedFile] of packageEntry.files) {
    fileEntries.push(await copyRequiredFile(sourceFile, servedFile));
  }

  const [licenseSource, licenseTarget] = packageEntry.license;
  await copyRequiredFile(licenseSource, licenseTarget);

  manifest.packages[packageEntry.name] = {
    version: packageEntry.version,
    sourcePackage: packageEntry.name,
    ...(fileEntries.length === 1 ? fileEntries[0] : { files: fileEntries }),
  };
}

await mkdir(resolve(rootDir, 'vendor'), { recursive: true });
await writeFile(
  resolve(rootDir, 'vendor/manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
  'utf8',
);

console.log('Vendor files, licenses, and SHA-256 manifest are synchronized.');
