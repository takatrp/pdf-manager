import { expect, test } from '@playwright/test';
import * as PDFLib from 'pdf-lib';
import { PDFDocument, PDFName, PDFNumber, StandardFonts, degrees, rgb } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { clickAndReadPdfDownload, fixture, openApp, openFeature } from './test-helpers.js';

const geometryCases = [
  { name: 'A4', size: [595.2756, 841.8898], expected: [595.2756, 841.8898] },
  { name: 'A3', size: [841.8898, 1190.5512], expected: [841.8898, 1190.5512] },
  { name: 'A4 rotated 90', size: [595.2756, 841.8898], rotation: 90, expected: [841.8898, 595.2756] },
  { name: 'A4 rotated 180', size: [595.2756, 841.8898], rotation: 180, expected: [595.2756, 841.8898] },
  { name: 'Offset CropBox', size: [800, 1000], crop: [100, 120, 450, 640], expected: [450, 640] },
  { name: 'CropBox rotated 270', size: [800, 1000], crop: [50, 70, 460, 650], rotation: 270, expected: [650, 460] },
  { name: 'UserUnit 2.5', size: [240, 320], userUnit: 2.5, expected: [600, 800] },
  { name: 'UserUnit and rotated CropBox', size: [400, 500], crop: [20, 30, 210, 297], rotation: 90, userUnit: 2, expected: [594, 420] },
  { name: 'CropBox intersected with MediaBox', size: [600, 800], crop: [-10, -20, 650, 900], expected: [600, 800] },
];

async function createGeometryFixture() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const spec of geometryCases) {
    const page = doc.addPage(spec.size);
    if (spec.crop) page.setCropBox(...spec.crop);
    if (spec.rotation) page.setRotation(degrees(spec.rotation));
    if (spec.userUnit) page.node.set(PDFName.of('UserUnit'), PDFNumber.of(spec.userUnit));
    // PDF.js displays the intersection of the CropBox and MediaBox. Keep the
    // registration marks inside that visible area, including oversized crops.
    const crop = page.getCropBox(), media = page.getMediaBox();
    const x = Math.max(crop.x, media.x), y = Math.max(crop.y, media.y);
    const width = Math.min(crop.x + crop.width, media.x + media.width) - x;
    const height = Math.min(crop.y + crop.height, media.y + media.height) - y;
    page.drawRectangle({ x, y, width, height, color: rgb(1, 1, 1) });
    // Asymmetric colored corners catch accidental rotation, mirroring or cropping.
    for (const [cx, cy, color] of [
      [x + 15, y + 15, rgb(1, 0, 0)],
      [x + width - 55, y + 15, rgb(0, 1, 0)],
      [x + 15, y + height - 55, rgb(0, 0, 1)],
      [x + width - 55, y + height - 55, rgb(0, 0, 0)],
    ]) page.drawRectangle({ x: cx, y: cy, width: 40, height: 40, color });
    page.drawText(spec.name, { x: x + 60, y: y + height / 2, size: 12, font });
  }
  return Array.from(await doc.save());
}

async function inspectInBrowser(page, bytes, { render = false } = {}) {
  return page.evaluate(async ({ bytes, render }) => {
    const lib = await getPdfJsLib();
    const pdf = await createPdfJsLoadingTask(lib, new Uint8Array(bytes)).promise;
    try {
      const results = [];
      for (let number = 1; number <= pdf.numPages; number++) {
        const page = await pdf.getPage(number);
        const viewport = page.getViewport({ scale: page.userUnit });
        const text = (await page.getTextContent()).items.map((item) => item.str).join(' ');
        let pixels;
        if (render) {
          const canvas = document.createElement('canvas');
          const smallViewport = page.getViewport({ scale: page.userUnit * 0.3 });
          canvas.width = Math.ceil(smallViewport.width);
          canvas.height = Math.ceil(smallViewport.height);
          const context = canvas.getContext('2d');
          await page.render({ canvasContext: context, viewport: smallViewport, background: 'rgb(255,255,255)' }).promise;
          pixels = Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data);
        }
        results.push({ width: viewport.width, height: viewport.height, text, pixels });
      }
      return results;
    } finally {
      await pdf.destroy();
    }
  }, { bytes, render });
}

for (const scale of [1, 2]) {
  test(`画像化の解像度 ${scale} 倍でもA4・A3・混在サイズ・回転・CropBox・UserUnitを保持する`, async ({ page }) => {
    await openApp(page);
    const original = await createGeometryFixture();
    const output = await page.evaluate(async ({ bytes, scale }) => {
      const lib = await getPdfJsLib();
      const pdf = await createPdfJsLoadingTask(lib, new Uint8Array(bytes)).promise;
      try {
        return Array.from(await buildCompressedPdf(pdf, { scale, quality: 0.9 }));
      } finally {
        await pdf.destroy();
      }
    }, { bytes: original, scale });
    const doc = await PDFDocument.load(new Uint8Array(output));
    expect(doc.getPageCount()).toBe(geometryCases.length);
    for (let i = 0; i < geometryCases.length; i++) {
      const outputPage = doc.getPage(i);
      expect(outputPage.getWidth(), geometryCases[i].name).toBeCloseTo(geometryCases[i].expected[0], 3);
      expect(outputPage.getHeight(), geometryCases[i].name).toBeCloseTo(geometryCases[i].expected[1], 3);
      expect(outputPage.getRotation().angle).toBe(0);
    }
    const before = await inspectInBrowser(page, original, { render: true });
    const after = await inspectInBrowser(page, output, { render: true });
    for (let i = 0; i < before.length; i++) {
      expect(after[i].text).toBe('');
      expect(after[i].width).toBeCloseTo(before[i].width, 3);
      expect(after[i].height).toBeCloseTo(before[i].height, 3);
      expect(after[i].pixels.length).toBe(before[i].pixels.length);
      let difference = 0;
      for (let pixel = 0; pixel < before[i].pixels.length; pixel++) {
        difference += Math.abs(before[i].pixels[pixel] - after[i].pixels[pixel]);
      }
      // Mean per-channel pixel error includes JPEG loss but rejects flipped/cropped output.
      expect(difference / before[i].pixels.length, geometryCases[i].name).toBeLessThan(2);
      const pixelWidth = Math.ceil(before[i].width * 0.3);
      // Compare colored corner positions too: sparse pages could otherwise hide a
      // wrong orientation in their mostly-white mean pixel error.
      for (let channel = 0; channel < 3; channel++) {
        const centroid = (pixels) => {
          let count = 0; let x = 0; let y = 0;
          for (let offset = 0; offset < pixels.length; offset += 4) {
            if (pixels[offset + channel] < 180 ||
                pixels[offset + (channel + 1) % 3] > 70 ||
                pixels[offset + (channel + 2) % 3] > 70) continue;
            count++;
            x += (offset / 4) % pixelWidth;
            y += Math.floor(offset / 4 / pixelWidth);
          }
          return { count, x: x / count, y: y / count };
        };
        const sourceCorner = centroid(before[i].pixels);
        const outputCorner = centroid(after[i].pixels);
        expect(sourceCorner.count, `${geometryCases[i].name}: source channel ${channel}`).toBeGreaterThan(10);
        expect(outputCorner.count, `${geometryCases[i].name}: output channel ${channel}`).toBeGreaterThan(10);
        expect(Math.abs(sourceCorner.x - outputCorner.x)).toBeLessThan(1);
        expect(Math.abs(sourceCorner.y - outputCorner.y)).toBeLessThan(1);
      }
    }
  });
}

test('構造最適化で検索文字・フォーム・リンク・ページ寸法を保持する', async ({ page }) => {
    await openApp(page);
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pdfPage = doc.addPage([595.2756, 841.8898]);
  pdfPage.drawText('Searchable invoice 12345', { x: 50, y: 650, font });
  const field = doc.getForm().createTextField('invoice.reference');
  field.setText('INV-12345');
  field.addToPage(pdfPage, { x: 50, y: 450, width: 200, height: 30 });
  const link = doc.context.register(doc.context.obj({
    Type: 'Annot', Subtype: 'Link', Rect: [50, 640, 250, 680],
    A: { Type: 'Action', S: 'URI', URI: PDFLib.PDFString.of('https://example.com/invoice') },
  }));
  pdfPage.node.addAnnot(link);
  const original = Array.from(await doc.save({ useObjectStreams: false }));
  const result = await page.evaluate(async (bytes) => {
    const result = await optimizePdfPreservingText(new Uint8Array(bytes));
    return { ...result, pdfBytes: Array.from(result.pdfBytes) };
  }, original);
  expect(result.optimized).toBe(true);
  expect(result.pdfBytes.length).toBeLessThan(original.length);
  const optimized = await PDFDocument.load(new Uint8Array(result.pdfBytes));
  expect(optimized.getForm().getTextField('invoice.reference').getText()).toBe('INV-12345');
  expect(optimized.getPage(0).node.Annots().size()).toBe(2);
  const info = await inspectInBrowser(page, result.pdfBytes);
  expect(info[0].text).toContain('Searchable invoice 12345');
  expect(info[0].width).toBeCloseTo(595.2756, 3);
  expect(info[0].height).toBeCloseTo(841.8898, 3);
});

test('文字保持が既定で、画像化の警告とレベルは明示選択後のみ表示する', async ({ page }) => {
    await openApp(page);
  const panel = await openFeature(page, 'compress');
  await expect(panel.locator('input[name="compress-mode"][value="preserve"]')).toBeChecked();
  await expect(page.locator('#compress-raster-options')).toBeHidden();
  await expect(page.locator('input[name="compress-level"][value="medium"]')).toBeDisabled();
  await panel.locator('input[name="compress-mode"][value="raster"]').check();
  await expect(page.locator('#compress-raster-warning')).toBeVisible();
  await expect(page.locator('#compress-raster-warning')).toContainText('文字検索・コピー');
  await expect(page.locator('input[name="compress-level"][value="medium"]')).toBeEnabled();
  await panel.getByRole('button', { name: 'クリア', exact: true }).click();
  await expect(panel.locator('input[name="compress-mode"][value="preserve"]')).toBeChecked();
  await expect(page.locator('#compress-raster-options')).toBeHidden();
});

test('署名辞書を含むPDFは文字保持モードでバイト単位で変更しない', async ({ page }) => {
    await openApp(page);
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]);
  // Direct signature dictionaries are valid too; avoid checking only indirect fields.
  doc.catalog.set(PDFName.of('AcroForm'), doc.context.obj({
    Fields: [{ FT: 'Sig', Type: 'Annot', Subtype: 'Widget', Rect: [0, 0, 10, 10] }],
  }));
  const original = Array.from(await doc.save({ useObjectStreams: false }));
  const result = await page.evaluate(async (bytes) => {
    const result = await optimizePdfPreservingText(new Uint8Array(bytes));
    return { ...result, pdfBytes: Array.from(result.pdfBytes) };
  }, original);
  expect(result.reason).toBe('signature');
  expect(result.optimized).toBe(false);
  expect(result.pdfBytes).toEqual(original);
});

test('画像化しても容量が減らない場合は元データに戻して保存する', async ({ page }) => {
    await openApp(page);
  const panel = await openFeature(page, 'compress');
  await page.locator('#compress-file').setInputFiles(fixture('simple-2pages.pdf'));
  await panel.locator('input[name="compress-mode"][value="raster"]').check();
  const result = await clickAndReadPdfDownload(page, panel.getByRole('button', { name: '圧縮して保存' }));
  await expect(page.locator('#compress-result')).toContainText('元のデータをそのまま保存');
  const { readFile } = await import('node:fs/promises');
  expect(result.bytes).toEqual(await readFile(fixture('simple-2pages.pdf')));
});

test('圧縮の重複実行を防ぎ、保存キャンセル後も再操作できる', async ({ page }) => {
    await openApp(page);
  const panel = await openFeature(page, 'compress');
  await page.locator('#compress-file').setInputFiles(fixture('simple-2pages.pdf'));
  page.removeAllListeners('dialog');
  let prompts = 0;
  page.on('dialog', async (dialog) => { prompts++; await dialog.dismiss(); });
  await page.evaluate(async () => Promise.all([handleCompress(), handleCompress()]));
  expect(prompts).toBe(1);
  await expect(page.locator('#action-status')).toContainText('保存をキャンセルしました');
  await expect(panel.getByRole('button', { name: '圧縮して保存' })).toBeEnabled();
  await expect(page.locator('#compress-file')).toBeEnabled();
  await panel.getByRole('button', { name: '圧縮して保存' }).click();
  await expect.poll(() => prompts).toBe(2);
});

// These checks use the same production functions and real PDF.js/pdf-lib objects.
// Only the canvas/JPEG raster is stubbed, so geometry and conservative output can
// also be verified on CI machines that cannot launch a browser.
async function loadCompressionFunctions(canvas) {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const start = html.indexOf('  async function optimizePdfPreservingText(');
  const end = html.indexOf('  async function convertHeicFileToJpegBlob(', start);
  const functions = new Function('PDFDocument', 'globalThis', 'document',
    `${html.slice(start, end)}; return { optimizePdfPreservingText, buildCompressedPdf };`);
  return functions(PDFDocument, { PDFLib }, { createElement: () => canvas });
}

test('Node: PDF.jsの実ページから全サイズ・回転・CropBox・UserUnitを解像度に依存せず出力する', async () => {
  const original = await createGeometryFixture();
  const source = await getDocument({ data: new Uint8Array(original), isEvalSupported: false }).promise;
  const jpeg = await readFile(fixture('sample.jpg'));
  const canvas = { width: 0, height: 0, getContext: () => ({}), toBlob: (callback) => callback(new Blob([jpeg])) };
  const { buildCompressedPdf } = await loadCompressionFunctions(canvas);
  const renderSizes = [];
  const wrappedSource = {
    numPages: source.numPages,
    getPage: async (number) => {
      const page = await source.getPage(number);
      return {
        userUnit: page.userUnit,
        getViewport: (options) => page.getViewport(options),
        cleanup: () => page.cleanup(),
        render: ({ viewport }) => {
          renderSizes.push([viewport.width, viewport.height]);
          return { promise: Promise.resolve() };
        },
      };
    },
  };
  try {
    for (const scale of [1, 2]) {
      renderSizes.length = 0;
      const output = await PDFDocument.load(await buildCompressedPdf(wrappedSource, { scale, quality: 0.9 }));
      expect(output.getPageCount()).toBe(geometryCases.length);
      geometryCases.forEach((spec, i) => {
        expect(output.getPage(i).getWidth(), spec.name).toBeCloseTo(spec.expected[0], 3);
        expect(output.getPage(i).getHeight(), spec.name).toBeCloseTo(spec.expected[1], 3);
        expect(renderSizes[i][0]).toBeCloseTo(spec.expected[0] * scale, 3);
        expect(renderSizes[i][1]).toBeCloseTo(spec.expected[1] * scale, 3);
      });
    }
  } finally {
    await source.destroy();
  }
});

test('Node: 文字・フォーム・リンク・CropBoxを保持して構造のみ最適化する', async () => {
  const source = await PDFDocument.create();
  const font = await source.embedFont(StandardFonts.Helvetica);
  const page = source.addPage([595, 842]);
  page.setCropBox(10, 20, 560, 800);
  page.setRotation(degrees(90));
  page.node.set(PDFName.of('UserUnit'), PDFNumber.of(2));
  page.drawText('Searchable invoice 12345', { x: 50, y: 650, font });
  const field = source.getForm().createTextField('reference');
  field.setText('INV-12345');
  field.addToPage(page, { x: 50, y: 450, width: 200, height: 30 });
  const link = source.context.register(source.context.obj({
    Type: 'Annot', Subtype: 'Link', Rect: [50, 640, 250, 680],
    A: { Type: 'Action', S: 'URI', URI: PDFLib.PDFString.of('https://example.com/invoice') },
  }));
  page.node.addAnnot(link);
  const original = await source.save({ useObjectStreams: false });
  const { optimizePdfPreservingText } = await loadCompressionFunctions();
  const result = await optimizePdfPreservingText(original);
  expect(result.optimized).toBe(true);
  expect(result.pdfBytes.length).toBeLessThan(original.length);
  const output = await PDFDocument.load(result.pdfBytes);
  expect(output.getForm().getTextField('reference').getText()).toBe('INV-12345');
  expect(output.getPage(0).getCropBox()).toEqual({ x: 10, y: 20, width: 560, height: 800 });
  expect(output.getPage(0).getRotation().angle).toBe(90);
  expect(output.getPage(0).node.get(PDFName.of('UserUnit')).asNumber()).toBe(2);
  const annotations = output.getPage(0).node.Annots();
  expect(annotations.size()).toBe(2);
  const action = annotations.lookup(1, PDFLib.PDFDict).lookup(PDFName.of('A'), PDFLib.PDFDict);
  expect(action.lookup(PDFName.of('URI'), PDFLib.PDFString).decodeText()).toBe('https://example.com/invoice');
  const pdf = await getDocument({ data: result.pdfBytes.slice(), isEvalSupported: false }).promise;
  try {
    const text = (await (await pdf.getPage(1)).getTextContent()).items.map((item) => item.str).join(' ');
    expect(text).toContain('Searchable invoice 12345');
  } finally {
    await pdf.destroy();
  }
});

test('Node: 小さくならないPDFと直接・間接署名辞書は元のバイト列を保持する', async () => {
  const { optimizePdfPreservingText } = await loadCompressionFunctions();
  const original = new Uint8Array(await readFile(fixture('simple-2pages.pdf')));
  const unchanged = await optimizePdfPreservingText(original);
  expect(unchanged.optimized).toBe(false);
  expect(unchanged.reason).toBe('not-smaller');
  expect(unchanged.pdfBytes).toEqual(original);
  for (const indirect of [false, true]) {
    const doc = await PDFDocument.create();
    doc.addPage([595, 842]);
    const signature = doc.context.obj({ FT: 'Sig', Type: 'Annot', Subtype: 'Widget', Rect: [0, 0, 10, 10] });
    doc.catalog.set(PDFName.of('AcroForm'), doc.context.obj({ Fields: [indirect ? doc.context.register(signature) : signature] }));
    const bytes = await doc.save({ useObjectStreams: false });
    const result = await optimizePdfPreservingText(bytes);
    expect(result.reason).toBe('signature');
    expect(result.pdfBytes).toEqual(bytes);
  }
});

test('Node: 巨大ページの描画メモリを制限しても物理サイズを保持する', async () => {
  const jpeg = await readFile(fixture('sample.jpg'));
  const sizes = [];
  const canvas = { width: 0, height: 0, getContext: () => ({}), toBlob: (callback) => callback(new Blob([jpeg])) };
  const { buildCompressedPdf } = await loadCompressionFunctions(canvas);
  const source = {
    numPages: 1,
    getPage: async () => ({
      userUnit: 20,
      getViewport: ({ scale }) => ({ width: 1000 * scale, height: 1000 * scale }),
      render: () => { sizes.push([canvas.width, canvas.height]); return { promise: Promise.resolve() }; },
    }),
  };
  const output = await PDFDocument.load(await buildCompressedPdf(source, { scale: 2, quality: 0.8 }));
  const unit = output.getPage(0).node.get(PDFName.of('UserUnit')).asNumber();
  expect(output.getPage(0).getWidth() * unit).toBe(20000);
  expect(output.getPage(0).getHeight() * unit).toBe(20000);
  expect(sizes[0][0] * sizes[0][1]).toBeLessThanOrEqual(16_000_000);
  expect(Math.max(...sizes[0])).toBeLessThanOrEqual(8192);
});
