import { expect, test } from '@playwright/test';
import { PDFDocument, PDFName, PDFNumber, StandardFonts, degrees, rgb } from 'pdf-lib';
import { clickAndReadPdfDownload, fixture, openApp, openFeature } from './test-helpers.js';

const rows = (page) => page.locator('#workspace-pages .workspace-page');
const canvasData = (page) => page.locator('#workspace-canvas').evaluate((canvas) => canvas.toDataURL());

async function openWorkspace(page) {
  await openApp(page);
  return openFeature(page, 'workspace');
}

async function addFiles(page, files, count) {
  await page.locator('#workspace-files').setInputFiles(files);
  await expect(rows(page)).toHaveCount(count);
  await expect(page.locator('#workspace-preview-save')).toBeEnabled();
  await expect(page.locator('#workspace-canvas')).toHaveAttribute('data-ready', 'true');
}

async function save(page, filename) {
  await page.locator('#workspace-preview-save').click();
  await expect(page.locator('#workspace-save-dialog')).toBeVisible();
  if (filename) await page.locator('#workspace-filename').fill(filename);
  const result = await clickAndReadPdfDownload(page, page.locator('#workspace-save-confirm'));
  await expect(page.locator('#workspace-save-dialog')).not.toBeVisible();
  return result;
}

async function readPdf(page, bytes, { render = false, width = 1200 } = {}) {
  return page.evaluate(async ({ bytes, render, width }) => {
    const lib = await getPdfJsLib();
    const pdf = await createPdfJsLoadingTask(lib, new Uint8Array(bytes)).promise;
    try {
      const info = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const base = page.getViewport({ scale: 1 });
        const text = (await page.getTextContent()).items.map((item) => item.str).join(' ');
        const item = { text, rotation: page.rotate, width: base.width * page.userUnit, height: base.height * page.userUnit };
        if (render) {
          const viewport = page.getViewport({ scale: Math.min(width / base.width, 1800 / base.height) });
          const canvas = document.createElement('canvas');
          canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
          await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
          item.dataUrl = canvas.toDataURL();
        }
        info.push(item);
      }
      return info;
    } finally { await pdf.destroy(); }
  }, { bytes: Array.from(bytes), render, width });
}

async function compareImages(page, before, after) {
  return page.evaluate(async ({ before, after }) => {
    async function pixels(dataUrl) {
      const image = new Image(); image.src = dataUrl; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      canvas.getContext('2d').drawImage(image, 0, 0);
      return { width: image.width, height: image.height, data: canvas.getContext('2d').getImageData(0, 0, image.width, image.height).data };
    }
    const a = await pixels(before), b = await pixels(after);
    if (a.width !== b.width || a.height !== b.height) return { dimensionsMatch: false };
    let error = 0, changed = 0;
    for (let i = 0; i < a.data.length; i++) { const diff = Math.abs(a.data[i] - b.data[i]); error += diff; if (diff > 40) changed++; }
    return { dimensionsMatch: true, meanError: error / a.data.length, changedRatio: changed / a.data.length };
  }, { before, after });
}

async function addMark(page, kind, text, point = { x: .24, y: .22 }) {
  await page.locator('#workspace-mark').selectOption(kind);
  if (text) await page.locator('#workspace-note').fill(text);
  const before = await canvasData(page);
  await page.locator('#workspace-add-note').click();
  const canvas = page.locator('#workspace-canvas');
  await expect(canvas).toHaveClass(/placing/);
  await expect(canvas).toHaveAttribute('data-ready', 'true');
  const box = await canvas.boundingBox();
  await canvas.click({ position: { x: box.width * point.x, y: box.height * point.y } });
  await expect(page.locator('#workspace-status')).toContainText('書き込みを追加');
  await expect(canvas).not.toHaveClass(/placing/);
  await expect(canvas).toHaveAttribute('data-ready', 'true');
  await expect.poll(() => canvasData(page)).not.toBe(before);
}

test('複数PDFを追加・挿入・並べ替え、複数選択の回転と削除をundo/redoして保存後も編集できる', async ({ page }) => {
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await openWorkspace(page);
  await addFiles(page, [fixture('simple-2pages.pdf'), fixture('simple-3pages.pdf')], 5);
  // [A1,A2,B1,B2,B3] -> [A2,A1,B1,B2,B3].
  await rows(page).nth(1).getByRole('button', { name: '2ページを前へ移動' }).click();
  await page.locator('#workspace-deselect').click();
  await rows(page).nth(0).getByRole('checkbox').check();
  await rows(page).nth(2).getByRole('checkbox').check();
  await page.locator('#workspace-rotate-right').click();
  await page.locator('#workspace-delete').click();
  await expect(rows(page)).toHaveCount(3);
  await page.locator('#workspace-undo').click();
  await expect(rows(page)).toHaveCount(5);
  await page.locator('#workspace-redo').click();
  await expect(rows(page)).toHaveCount(3);
  await page.locator('#workspace-undo').click();
  await page.locator('#workspace-preview-save').click();
  await expect(page.locator('#workspace-save-summary')).toContainText('5ページ');
  await expect(page.locator('#workspace-output-position')).toHaveText('1 / 5ページ');
  await expect(page.locator('#workspace-output-prev')).toBeDisabled();
  await page.locator('#workspace-output-next').click();
  await expect(page.locator('#workspace-output-position')).toHaveText('2 / 5ページ');
  await page.locator('#workspace-save-cancel').click();
  await expect(page.locator('#workspace-save-dialog')).not.toBeVisible();
  const result = await save(page, 'merged-edit.pdf');
  expect(result.suggestedFilename).toBe('merged-edit.pdf');
  expect(result.pdf.getPages().map((p) => p.getWidth())).toEqual([460, 440, 440, 460, 480]);
  expect(result.pdf.getPages().map((p) => p.getRotation().angle)).toEqual([90, 0, 90, 0, 0]);
  const info = await readPdf(page, result.bytes);
  expect(info.map((p) => p.text)).toEqual([
    'Two-page fixture - page 2', 'Two-page fixture - page 1', 'Three-page fixture - page 1',
    'Three-page fixture - page 2', 'Three-page fixture - page 3',
  ]);
  // Insertion after the active page is a continued edit, with a second save.
  await rows(page).nth(1).getByRole('button', { name: '2ページをプレビュー' }).click();
  await page.locator('#workspace-insert').selectOption('after');
  await addFiles(page, fixture('japanese-text.pdf'), 7);
  const continued = await save(page, 'continued');
  expect(continued.suggestedFilename).toBe('continued.pdf');
  const continuedText = (await readPdf(page, continued.bytes)).map((p) => p.text);
  expect(continuedText.slice(2, 4)).toEqual(['Japanese text fixture - page 1', 'Japanese text fixture - page 2']);
  expect(continuedText[4]).toBe('Three-page fixture - page 1');
  expect(errors).toEqual([]);
});

test('先頭挿入・全選択削除・空状態・元に戻す・確定クリアを繰り返せる', async ({ page }) => {
  await openWorkspace(page);
  await addFiles(page, fixture('simple-2pages.pdf'), 2);
  await page.locator('#workspace-insert').selectOption('start');
  await addFiles(page, fixture('simple-3pages.pdf'), 5);
  await expect(rows(page).first()).toContainText('simple-3pages.pdf');
  await page.locator('#workspace-select-all').click();
  await expect(rows(page).locator('input:checked')).toHaveCount(5);
  await page.locator('#workspace-delete').click();
  await expect(rows(page)).toHaveCount(0);
  await expect(page.locator('#workspace-preview-save')).toBeDisabled();
  await page.locator('#workspace-undo').click();
  await expect(rows(page)).toHaveCount(5);
  // Default test dialog handler cancels first, then explicitly accept a reset.
  await page.locator('#workspace-reset').click();
  await expect(rows(page)).toHaveCount(5);
  page.removeAllListeners('dialog'); page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#workspace-reset').click();
  await expect(rows(page)).toHaveCount(0);
  await expect(page.locator('#workspace-undo')).toBeDisabled();
  await addFiles(page, fixture('simple-2pages.pdf'), 2);
});

test('無効・破損PDFの追加で既存編集を失わず、ツール切替時に古い完了表示を消す', async ({ page }) => {
  await openWorkspace(page);
  await addFiles(page, fixture('simple-2pages.pdf'), 2);
  await page.locator('#workspace-files').setInputFiles({ name: 'bad.txt', mimeType: 'text/plain', buffer: Buffer.from('not a pdf') });
  await expect(page.locator('#workspace-status')).toContainText('作業内容は変更していません');
  await expect(rows(page)).toHaveCount(2);
  await page.locator('#workspace-files').setInputFiles([
    { name: 'corrupt.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\n corrupt') },
  ]);
  await expect(page.locator('#workspace-status')).toContainText('追加できませんでした');
  await expect(rows(page)).toHaveCount(2);
  await page.locator('#feature-back button').click();
  const merge = await openFeature(page, 'merge');
  await page.locator('#merge-files').setInputFiles([fixture('simple-2pages.pdf'), fixture('simple-3pages.pdf')]);
  await clickAndReadPdfDownload(page, merge.getByRole('button', { name: '結合して保存' }));
  await expect(page.locator('#action-status')).not.toBeEmpty();
  await page.locator('#feature-back button').click();
  await expect(page.locator('#action-status')).toBeEmpty();
  await openFeature(page, 'workspace');
  await expect(rows(page)).toHaveCount(2);
  await expect(page.locator('#action-status')).toBeEmpty();
  const result = await save(page);
  expect(result.pdf.getPageCount()).toBe(2);
});

const geometries = [
  { label: 'Plain', size: [595, 842] },
  { label: 'Rotate90', size: [400, 600], rotation: 90 },
  { label: 'Rotate180Crop', size: [700, 900], crop: [50, 80, 500, 650], rotation: 180 },
  { label: 'Rotate270Crop', size: [700, 900], crop: [80, 100, 430, 580], rotation: 270 },
  { label: 'UserUnitRotateCrop', size: [400, 500], crop: [20, 30, 210, 297], rotation: 90, unit: 2.5 },
];

async function geometryFixture(spec) {
  const doc = await PDFDocument.create(); const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage(spec.size);
  if (spec.crop) page.setCropBox(...spec.crop);
  if (spec.rotation) page.setRotation(degrees(spec.rotation));
  if (spec.unit) page.node.set(PDFName.of('UserUnit'), PDFNumber.of(spec.unit));
  const [x, y, width, height] = spec.crop || [0, 0, ...spec.size];
  page.drawText(`SEARCHABLE ${spec.label}`, { x: x + 30, y: y + height / 2, size: 12, font, color: rgb(.3, .3, .3) });
  page.drawRectangle({ x: x + 10, y: y + 10, width: 15, height: 25, color: rgb(.7, .7, .7) });
  return { name: `${spec.label}.pdf`, mimeType: 'application/pdf', buffer: Buffer.from(await doc.save()) };
}

for (const spec of geometries) {
  test(`日本語メモ・確認印・チェック・番号の配置と元の検索文字を保存する: ${spec.label}`, async ({ page }) => {
    await openWorkspace(page);
    await addFiles(page, await geometryFixture(spec), 1);
    await addMark(page, 'text', '照合メモ 日本語123', { x: .15, y: .14 });
    await addMark(page, 'confirmed', null, { x: .53, y: .38 });
    await addMark(page, 'review', null, { x: .55, y: .67 });
    await addMark(page, 'check', null, { x: .18, y: .70 });
    const beforeNumbers = await canvasData(page);
    await page.locator('#workspace-page-numbers').check();
    await expect(page.locator('#workspace-canvas')).toHaveAttribute('data-ready', 'true');
    await expect.poll(() => canvasData(page)).not.toBe(beforeNumbers);
    const preview = await canvasData(page);
    const result = await save(page);
    const info = await readPdf(page, result.bytes, { render: true });
    expect(info[0].text).toContain(`SEARCHABLE ${spec.label}`);
    expect(result.pdf.getPage(0).getRotation().angle).toBe(spec.rotation || 0);
    if (spec.crop) expect(result.pdf.getPage(0).getCropBox()).toEqual({ x: spec.crop[0], y: spec.crop[1], width: spec.crop[2], height: spec.crop[3] });
    if (spec.unit) expect(result.pdf.getPage(0).node.get(PDFName.of('UserUnit')).asNumber()).toBe(spec.unit);
    const comparison = await compareImages(page, preview, info[0].dataUrl);
    expect(comparison.dimensionsMatch).toBe(true);
    expect(comparison.meanError).toBeLessThan(1.2);
    expect(comparison.changedRatio).toBeLessThan(.015);
    // Removing and undoing an annotation retains the original placement.
    await page.locator('#workspace-remove-note').click();
    await page.locator('#workspace-undo').click();
    await expect(page.locator('#workspace-canvas')).toHaveAttribute('data-ready', 'true');
    await expect.poll(() => canvasData(page)).toBe(preview);
  });
}

test('書き込みのEsc取消とキーボード配置、保存ダイアログ取消後の再保存', async ({ page }) => {
  await openWorkspace(page);
  await addFiles(page, await geometryFixture(geometries[0]), 1);
  const original = await canvasData(page);
  await page.locator('#workspace-note').fill('Keyboard memo');
  await page.locator('#workspace-add-note').click();
  await page.locator('#workspace-canvas').press('Escape');
  await expect(page.locator('#workspace-status')).toContainText('書き込みを取り消');
  await expect.poll(() => canvasData(page)).toBe(original);
  await page.locator('#workspace-add-note').click();
  await page.locator('#workspace-canvas').press('ArrowLeft');
  await expect(page.locator('#workspace-canvas')).toHaveAttribute('data-ready', 'true');
  await page.locator('#workspace-canvas').press('Enter');
  await expect(page.locator('#workspace-status')).toContainText('書き込みを追加');
  await page.locator('#workspace-preview-save').click();
  await expect(page.locator('#workspace-save-summary')).toContainText('書き込み1件');
  await page.locator('#workspace-save-dialog').press('Escape');
  await expect(page.locator('#workspace-save-dialog')).not.toBeVisible();
  await expect(page.locator('#workspace-preview-save')).toBeFocused();
  const result = await save(page, 'safe/name:123');
  expect(result.suggestedFilename).toBe('safe_name_123.pdf');
  expect(result.pdf.getPageCount()).toBe(1);
});

test('スマートフォン幅で横溢れなく編集・プレビュー・保存できる', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openWorkspace(page);
  await addFiles(page, fixture('simple-3pages.pdf'), 3);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.locator('#workspace-mark').selectOption('confirmed');
  await page.locator('#workspace-add-note').click();
  await expect(page.locator('#workspace-canvas')).toHaveAttribute('data-ready', 'true');
  await page.locator('#workspace-canvas').press('Enter');
  await expect(page.locator('#workspace-canvas')).toHaveAttribute('data-ready', 'true');
  await page.locator('#workspace-canvas').scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('workspace-mobile.png'), fullPage: true });
  await page.locator('#workspace-preview-save').click();
  const dialog = page.locator('#workspace-save-dialog');
  await expect(dialog).toBeVisible();
  const box = await dialog.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(391);
  await page.screenshot({ path: testInfo.outputPath('workspace-mobile-save.png'), fullPage: true });
  const result = await clickAndReadPdfDownload(page, page.locator('#workspace-save-confirm'));
  expect(result.pdf.getPageCount()).toBe(3);
});

test('保存準備中に一覧へ戻っても後からダイアログを表示せず編集内容を保持する', async ({ page }) => {
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await openWorkspace(page);
  await addFiles(page, fixture('simple-3pages.pdf'), 3);
  // Hold the output-loading step to reproduce navigation during an in-flight save.
  await page.evaluate(() => {
    const original = getPdfJsLib;
    const gate = new Promise((resolve) => { window.__releaseWorkspaceOutput = resolve; });
    getPdfJsLib = async () => { await gate; return original(); };
    window.__restorePdfJsLoader = () => { getPdfJsLib = original; };
  });
  await page.locator('#workspace-preview-save').click();
  await expect(page.locator('[data-feature="workspace"]')).toHaveAttribute('aria-busy', 'true');
  await page.locator('#feature-back button').click();
  await page.evaluate(() => window.__releaseWorkspaceOutput());
  await expect(page.locator('[data-feature="workspace"]')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#workspace-save-dialog')).not.toBeVisible();
  await expect(page.locator('#feature-home')).toHaveClass(/active/);
  await page.evaluate(() => window.__restorePdfJsLoader());
  await openFeature(page, 'workspace');
  await expect(rows(page)).toHaveCount(3);
  const result = await save(page);
  expect(result.pdf.getPageCount()).toBe(3);
  expect(errors).toEqual([]);
});

test('書き込み後の回転で書き込みもページと一緒に回転し保存結果と一致する', async ({ page }) => {
  await openWorkspace(page);
  await addFiles(page, await geometryFixture(geometries[0]), 1);
  await addMark(page, 'text', 'Rotate with page', { x: .15, y: .22 });
  for (let turns = 1; turns <= 3; turns++) {
    const before = await canvasData(page);
    await page.locator('#workspace-rotate-right').click();
    await expect(page.locator('#workspace-canvas')).toHaveAttribute('data-ready', 'true');
    await expect.poll(() => canvasData(page)).not.toBe(before);
    const preview = await canvasData(page);
    const result = await save(page, `rotate-${turns}`);
    expect(result.pdf.getPage(0).getRotation().angle).toBe(turns * 90);
    const info = await readPdf(page, result.bytes, { render: true });
    expect(info[0].text).toContain('SEARCHABLE Plain');
    const comparison = await compareImages(page, preview, info[0].dataUrl);
    expect(comparison.dimensionsMatch).toBe(true);
    expect(comparison.meanError).toBeLessThan(1.2);
  }
});
