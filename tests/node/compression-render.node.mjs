// Real PDF.js -> canvas -> JPEG -> PDF export regression, without a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createCanvas, DOMMatrix, Path2D, ImageData } from '@napi-rs/canvas';
import * as PDFLib from 'pdf-lib';
const { PDFDocument, PDFName, PDFNumber, degrees, rgb } = PDFLib;
globalThis.DOMMatrix = DOMMatrix; globalThis.Path2D = Path2D; globalThis.ImageData = ImageData;
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
await mkdir('artifacts', { recursive: true });
const html = await readFile('index.html', 'utf8');
const code = html.slice(html.indexOf('  async function buildCompressedPdf('), html.indexOf('  async function convertHeicFileToJpegBlob('));
const document = { createElement() { const canvas = createCanvas(1, 1); canvas.toBlob = (callback, type, quality) => callback(new Blob([canvas.toBuffer('image/jpeg', quality * 100)], { type })); return canvas; } };
const build = new Function('document', 'PDFDocument', 'globalThis', `${code}\nreturn buildCompressedPdf;`)(document, PDFDocument, { PDFLib });
const factory = { create(w, h) { const canvas = createCanvas(w, h); return { canvas, context: canvas.getContext('2d') }; }, reset(t, w, h) { t.canvas.width = w; t.canvas.height = h; }, destroy(t) { t.canvas.width = 0; t.canvas = t.context = null; } };
const load = (data) => pdfjs.getDocument({ data: data.slice(), isEvalSupported: false, canvasFactory: factory, standardFontDataUrl: resolve('node_modules/pdfjs-dist/standard_fonts') + '/' }).promise;
const cases = [
  { size: [595.28, 841.89] }, { size: [841.89, 1190.55] },
  { size: [595.28, 841.89], rotate: 90 }, { size: [595.28, 841.89], rotate: 180 },
  { size: [800, 1000], rotate: 270, crop: [50, 70, 460, 650] },
  { size: [400, 500], rotate: 90, crop: [20, 30, 210, 297], unit: 2 },
];
for (const scale of [1, 2]) test(`raster compression preserves actual pixels/physical geometry at scale ${scale}`, async () => {
  const doc = await PDFDocument.create();
  for (const spec of cases) {
    const page = doc.addPage(spec.size); if (spec.rotate) page.setRotation(degrees(spec.rotate)); if (spec.crop) page.setCropBox(...spec.crop);
    if (spec.unit) page.node.set(PDFName.of('UserUnit'), PDFNumber.of(spec.unit));
    const [x, y, w, h] = spec.crop || [0, 0, ...spec.size];
    for (const [cx, cy, color] of [[x + 15, y + 15, rgb(1, 0, 0)], [x + w - 60, y + 15, rgb(0, .7, 0)], [x + 15, y + h - 60, rgb(0, 0, 1)]]) page.drawRectangle({ x: cx, y: cy, width: 40, height: 40, color });
  }
  const input = await load(await doc.save()), bytes = await build(input, { scale, quality: .9 }), output = await load(bytes);
  for (let i = 0; i < cases.length; i++) {
    const before = await input.getPage(i + 1), after = await output.getPage(i + 1);
    const a = before.getViewport({ scale: before.userUnit }), b = after.getViewport({ scale: after.userUnit });
    assert.ok(Math.abs(a.width - b.width) < .001); assert.ok(Math.abs(a.height - b.height) < .001);
    const canvases = [];
    for (const page of [before, after]) {
      const viewport = page.getViewport({ scale: page.userUnit * .4 });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      await page.render({ canvasContext: canvas.getContext('2d'), viewport, background: 'rgb(255,255,255)' }).promise;
      canvases.push(canvas);
    }
    const [original, compressed] = canvases.map((c) => c.getContext('2d').getImageData(0, 0, c.width, c.height).data);
    assert.equal(original.length, compressed.length); let sum = 0;
    for (let p = 0; p < original.length; p++) sum += Math.abs(original[p] - compressed[p]);
    assert.ok(sum / original.length < 1.2, `page ${i + 1}: ${sum / original.length}`);
    assert.equal((await after.getTextContent()).items.length, 0);
  }
  if (scale === 2) await writeFile('artifacts/compression-mixed-physical-sizes.pdf', bytes);
  await input.destroy(); await output.destroy();
});
