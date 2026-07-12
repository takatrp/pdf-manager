import { createHash } from 'node:crypto';
import { readFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const rootDir = process.cwd();
const indexPath = resolve(rootDir, 'index.html');
const forbiddenCdns = ['unpkg.com', 'cdn.jsdelivr.net', 'cdnjs.cloudflare.com'];
const vendorFiles = [
  'vendor/pdf-lib/pdf-lib.min.js',
  'vendor/heic2any/heic2any.min.js',
  'vendor/pdfjs/pdf.min.mjs',
  'vendor/pdfjs/pdf.worker.min.mjs',
];

test('PDFライブラリは固定版を自己ホストし、CDNへフォールバックしない', async () => {
  const html = await readFile(indexPath, 'utf8');
  const packageJson = JSON.parse(await readFile(resolve(rootDir, 'package.json'), 'utf8'));

  for (const host of forbiddenCdns) expect(html).not.toContain(host);
  for (const uploadPrimitive of ['fetch(', 'XMLHttpRequest', 'sendBeacon', 'WebSocket']) {
    expect(html).not.toContain(uploadPrimitive);
  }
  for (const file of vendorFiles) {
    await expect(access(resolve(rootDir, file))).resolves.toBeUndefined();
    expect(html).toContain(`./${file}`);
  }

  expect(packageJson.dependencies).toEqual({
    heic2any: '0.0.4',
    'pdf-lib': '1.17.1',
    'pdfjs-dist': '4.5.136',
  });
  expect(packageJson.devDependencies['@playwright/test']).toMatch(/^\d+\.\d+\.\d+$/);
  for (const version of [
    ...Object.values(packageJson.dependencies),
    ...Object.values(packageJson.devDependencies),
  ]) {
    expect(version).not.toMatch(/[~^*xX]/);
  }

  for (const licenseFile of [
    'vendor/licenses/pdf-lib-LICENSE',
    'vendor/licenses/heic2any-LICENSE',
    'vendor/licenses/pdfjs-LICENSE',
  ]) {
    await expect(access(resolve(rootDir, licenseFile))).resolves.toBeUndefined();
  }
});

test('vendor manifestのSHA-256が実ファイルと一致する', async () => {
  const manifest = JSON.parse(await readFile(resolve(rootDir, 'vendor/manifest.json'), 'utf8'));
  const entries = Object.values(manifest.packages).flatMap((packageEntry) =>
    packageEntry.files || [packageEntry],
  );

  expect(entries).toHaveLength(4);
  for (const entry of entries) {
    const bytes = await readFile(resolve(rootDir, entry.servedFile));
    const digest = createHash('sha256').update(bytes).digest('hex');
    expect(entry.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(digest).toBe(entry.sha256);
  }
});

test('CSPは全スクリプトより前にあり、許可先を最小限に制限する', async () => {
  const html = await readFile(indexPath, 'utf8');
  const cspMatch = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"\s*\/>/i);
  expect(cspMatch).not.toBeNull();

  const charsetIndex = html.indexOf('<meta charset="utf-8"');
  const cspIndex = html.indexOf('http-equiv="Content-Security-Policy"');
  const firstScriptIndex = html.indexOf('<script');
  expect(charsetIndex).toBeGreaterThanOrEqual(0);
  expect(cspIndex).toBeGreaterThan(charsetIndex);
  expect(cspIndex).toBeLessThan(firstScriptIndex);

  const csp = cspMatch[1];
  const directives = Object.fromEntries(csp.split(';')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [name, ...values] = entry.split(/\s+/);
      return [name, values];
    }));
  expect(directives).toEqual({
    'default-src': ["'self'"],
    'script-src': ["'self'", "'unsafe-inline'", "'unsafe-eval'", 'https://www.googletagmanager.com'],
    'worker-src': ["'self'", 'blob:'],
    'connect-src': ["'self'", 'https://www.google-analytics.com', 'https://region1.google-analytics.com'],
    'img-src': ["'self'", 'blob:', 'data:', 'https://www.google-analytics.com'],
    'style-src': ["'self'", "'unsafe-inline'"],
    'font-src': ["'self'", 'data:'],
    'object-src': ["'none'"],
    'base-uri': ["'none'"],
    'form-action': ["'none'"],
    'manifest-src': ["'self'"],
  });
  for (const directive of [
    "default-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "worker-src 'self' blob:",
  ]) expect(csp).toContain(directive);
  expect(csp).toContain('https://www.googletagmanager.com');
  expect(csp).toContain('https://www.google-analytics.com');
  expect(csp).toContain('https://region1.google-analytics.com');
  expect(Object.keys(directives).sort()).toEqual([
    'base-uri',
    'connect-src',
    'default-src',
    'font-src',
    'form-action',
    'img-src',
    'manifest-src',
    'object-src',
    'script-src',
    'style-src',
    'worker-src',
  ]);
  expect(directives['script-src']).toEqual([
    "'self'",
    "'unsafe-inline'",
    "'unsafe-eval'",
    'https://www.googletagmanager.com',
  ]);
  expect(directives['connect-src']).toEqual([
    "'self'",
    'https://www.google-analytics.com',
    'https://region1.google-analytics.com',
  ]);
  expect(directives['img-src']).toEqual([
    "'self'",
    'blob:',
    'data:',
    'https://www.google-analytics.com',
  ]);
  // heic2any 0.0.4のBlob Worker内にあるlibheifコードがnew Function()を実行するために必要。
  expect(csp).toContain("script-src 'self' 'unsafe-inline' 'unsafe-eval'");
  expect(csp).not.toMatch(/(?:^|[;\s])\*(?:[;\s]|$)/);
  expect(csp).not.toMatch(/(?:^|\s)https:(?:\s|;|$)/);
  for (const host of forbiddenCdns) expect(csp).not.toContain(host);
});

test('PDF.jsの全読み込みはisEvalSupported:falseの共通ヘルパーを通る', async () => {
  const html = await readFile(indexPath, 'utf8');
  expect(html).toContain('function createPdfJsLoadingTask(pdfjsLib, data)');
  expect(html).toContain('isEvalSupported: false');
  expect(html.match(/pdfjsLib\.getDocument\s*\(/g) || []).toHaveLength(1);
  expect(html.match(/createPdfJsLoadingTask\s*\(/g) || []).toHaveLength(5);
});
