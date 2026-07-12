import { expect, test } from '@playwright/test';
import {
  clickAndReadPdfDownload,
  fixture,
  loadFixturePdf,
  openApp,
  openFeature,
} from './test-helpers.js';

test.beforeEach(async ({ page }) => {
  await openApp(page);
});

test('PDF結合でページ数を合算して保存する', async ({ page }) => {
  const panel = await openFeature(page, 'merge');
  await page.locator('#merge-files').setInputFiles([
    fixture('simple-2pages.pdf'),
    fixture('simple-3pages.pdf'),
  ]);
  await expect(page.locator('#merge-list .merge-item')).toHaveCount(2);
  const result = await clickAndReadPdfDownload(page, panel.getByRole('button', { name: '結合して保存' }));
  expect(result.pdf.getPageCount()).toBe(5);
  expect(result.suggestedFilename).toBe('test-output.pdf');
});

test('日本語情報を含むPDFをプレビューし、指定範囲を抽出して保存する', async ({ page }) => {
  const panel = await openFeature(page, 'extract');
  await page.locator('#extract-file').setInputFiles(fixture('japanese-text.pdf'));
  await expect(page.locator('#extract-preview .single-page-item')).toHaveCount(2);
  await page.locator('#extract-start').fill('1');
  await page.locator('#extract-end').fill('2');
  const result = await clickAndReadPdfDownload(page, panel.getByRole('button', { name: '抽出して保存' }));
  expect(result.pdf.getPageCount()).toBe(2);
});

test('ページ挿入で指定位置に全ページを追加する', async ({ page }) => {
  const panel = await openFeature(page, 'insert');
  await page.locator('#insert-base-file').setInputFiles(fixture('simple-2pages.pdf'));
  await page.locator('#insert-add-file').setInputFiles(fixture('simple-3pages.pdf'));
  await expect(page.locator('#insert-base-preview .single-page-item')).toHaveCount(2);
  await expect(page.locator('#insert-add-preview .single-page-item')).toHaveCount(3);
  await page.locator('#insert-position').fill('2');
  const result = await clickAndReadPdfDownload(page, panel.getByRole('button', { name: '追加して保存' }));
  expect(result.pdf.getPageCount()).toBe(5);
  expect(result.pdf.getPages().map((pdfPage) => pdfPage.getWidth())).toEqual([440, 440, 460, 480, 460]);
});

test('ページ削除で指定ページを除外する', async ({ page }) => {
  const panel = await openFeature(page, 'delete');
  await page.locator('#delete-file').setInputFiles(fixture('simple-3pages.pdf'));
  await expect(page.locator('#delete-preview .single-page-item')).toHaveCount(3);
  await page.locator('#delete-page').fill('2');
  const result = await clickAndReadPdfDownload(page, panel.getByRole('button', { name: '削除して保存' }));
  expect(result.pdf.getPageCount()).toBe(2);
});

test('ページ並べ替えで実UIの移動操作を出力順へ反映する', async ({ page }) => {
  const panel = await openFeature(page, 'reorder');
  await page.locator('#reorder-file').setInputFiles(fixture('simple-3pages.pdf'));
  await expect(page.locator('#reorder-list .merge-item')).toHaveCount(3);
  await page.locator('#reorder-list .merge-item').nth(1).getByTitle('上に移動').click();
  const result = await clickAndReadPdfDownload(page, panel.getByRole('button', { name: '並び替えて保存' }));
  expect(result.pdf.getPages().map((pdfPage) => pdfPage.getWidth())).toEqual([460, 440, 480]);
});

test('ページ回転で選択ページだけを90度回転する', async ({ page }) => {
  const panel = await openFeature(page, 'rotate');
  await page.locator('#rotate-file').setInputFiles(fixture('simple-3pages.pdf'));
  await expect(page.locator('#rotate-preview .single-page-item')).toHaveCount(3);
  await page.locator('#rotate-preview .single-page-item').first().locator('[data-role="select"]').click();
  const result = await clickAndReadPdfDownload(page, panel.getByRole('button', { name: '回転して保存' }));
  expect(result.pdf.getPage(0).getRotation().angle).toBe(90);
  expect(result.pdf.getPage(1).getRotation().angle).toBe(0);
});

test('JPG・PNGをプレビューし、2ページのPDFに変換する', async ({ page }) => {
  const panel = await openFeature(page, 'image2pdf');
  await page.locator('#image2pdf-files').setInputFiles([
    fixture('sample.jpg'),
    fixture('sample.png'),
  ]);
  await expect(page.locator('#image2pdf-list .merge-item')).toHaveCount(2);
  const imageCanvases = page.locator('#image2pdf-list canvas');
  await expect(imageCanvases).toHaveCount(2);
  await expect.poll(() => imageCanvases.evaluateAll((canvases) =>
    canvases.every((canvas) => canvas.dataset.previewState === 'ready'),
  )).toBe(true);
  const result = await clickAndReadPdfDownload(page, panel.getByRole('button', { name: 'PDF化して保存' }));
  expect(result.pdf.getPageCount()).toBe(2);
});

test('HEICをプレビューし、1ページのPDFに変換する', async ({ page }) => {
  const cspViolations = [];
  page.on('console', (message) => {
    if (/content security policy/i.test(message.text())) cspViolations.push(message.text());
  });
  const panel = await openFeature(page, 'image2pdf');
  await page.locator('#image2pdf-files').setInputFiles(fixture('sample.heic'));
  await expect(page.locator('#image2pdf-list .merge-item')).toHaveCount(1);
  const heicCanvas = page.locator('#image2pdf-list canvas');
  await expect(heicCanvas).toHaveCount(1);
  await expect(heicCanvas).toHaveAttribute('data-preview-state', 'ready', { timeout: 60_000 });
  expect(cspViolations).toEqual([]);
  const result = await clickAndReadPdfDownload(page, panel.getByRole('button', { name: 'PDF化して保存' }));
  expect(result.pdf.getPageCount()).toBe(1);
});

test('PDF圧縮で小さくなった出力を保存する', async ({ page }) => {
  const panel = await openFeature(page, 'compress');
  await page.locator('#compress-file').setInputFiles(fixture('compression-source.pdf'));
  await expect(page.locator('#compress-preview canvas')).toHaveCount(1);
  await page.locator('input[name="compress-level"][value="high"]').check();
  const result = await clickAndReadPdfDownload(page, panel.getByRole('button', { name: '圧縮して保存' }));
  expect(result.pdf.getPageCount()).toBe(2);
  const source = await loadFixturePdf('compression-source.pdf');
  expect(result.bytes.length).toBeLessThan((await source.save()).length);
});

test('圧縮後が大きい場合は保存せず、理由を表示する', async ({ page }) => {
  const panel = await openFeature(page, 'compress');
  await page.locator('#compress-file').setInputFiles(fixture('simple-2pages.pdf'));
  await panel.getByRole('button', { name: '圧縮して保存' }).click();
  await expect(page.locator('#action-status')).toContainText('圧縮後の方が大きくなるため保存しませんでした', {
    timeout: 60_000,
  });
});
