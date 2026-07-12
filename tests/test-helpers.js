import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';

export const fixturesDir = resolve(process.cwd(), 'tests/fixtures');
export const fixture = (name) => resolve(fixturesDir, name);

export async function openApp(page) {
  await page.route('https://**/*', (route) => route.abort());
  page.on('dialog', async (dialog) => {
    if (dialog.type() === 'prompt') await dialog.accept('test-output');
    else await dialog.dismiss();
  });
  await page.goto('./', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#feature-home')).toHaveClass(/active/);
}

export async function openFeature(page, featureName) {
  await page.locator(`[data-feature-target="${featureName}"]`).click();
  const panel = page.locator(`.feature-panel[data-feature="${featureName}"]`);
  await expect(panel).toHaveClass(/active/);
  return panel;
}

export async function clickAndReadPdfDownload(page, button) {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    button.click(),
  ]);
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const bytes = Buffer.concat(chunks);
  expect(bytes.length).toBeGreaterThan(0);
  return {
    bytes,
    pdf: await PDFDocument.load(bytes),
    suggestedFilename: download.suggestedFilename(),
  };
}

export async function loadFixturePdf(name) {
  return PDFDocument.load(await readFile(fixture(name)));
}
