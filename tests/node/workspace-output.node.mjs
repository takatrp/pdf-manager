import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createCanvas, DOMMatrix, Path2D, ImageData } from '@napi-rs/canvas';
import { PDFDocument, PDFName, PDFNumber, degrees, rgb, StandardFonts } from 'pdf-lib';
globalThis.DOMMatrix = DOMMatrix; globalThis.Path2D = Path2D; globalThis.ImageData = ImageData;
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
await mkdir('artifacts', { recursive: true });
const source = await readFile('editor.js', 'utf8');
const overlayCode = source.slice(source.indexOf('  function createOverlay('), source.indexOf('  async function renderPage('));
const exportCode = source.slice(source.indexOf('  async function buildWorkspacePdf('), source.indexOf('  async function releaseOutput('));
const factory = {
  create(width, height) { const canvas = createCanvas(width, height); return { canvas, context: canvas.getContext('2d') }; },
  reset(target, width, height) { target.canvas.width = width; target.canvas.height = height; },
  destroy(target) { target.canvas.width = 0; target.canvas.height = 0; target.canvas = null; target.context = null; },
};
const load = (bytes) => pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, canvasFactory: factory, standardFontDataUrl: resolve('node_modules/pdfjs-dist/standard_fonts') + '/' }).promise;
const normalize = (angle) => ((angle % 360) + 360) % 360;
function implementation(pages, sources, numbers = true) {
  return new Function('document', 'pages', 'sources', 'numbers', 'PDFDocument', 'degrees', 'normalizeRotation', `${overlayCode}\n${exportCode}\nreturn { createOverlay, buildWorkspacePdf };`)(
    { createElement(name) { assert.equal(name, 'canvas'); return createCanvas(1, 1); } }, pages, sources, numbers, PDFDocument, degrees, normalize,
  );
}
async function render(page, rotation, targetWidth = 900) {
  const base = page.getViewport({ scale: 1, rotation });
  const viewport = page.getViewport({ scale: targetWidth / base.width, rotation });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  return { canvas, base };
}
function difference(expected, actual) {
  assert.equal(actual.width, expected.width); assert.equal(actual.height, expected.height);
  const a = expected.getContext('2d').getImageData(0, 0, expected.width, expected.height).data;
  const b = actual.getContext('2d').getImageData(0, 0, actual.width, actual.height).data;
  let sum = 0, changed = 0;
  for (let i = 0; i < a.length; i += 4) { let pixel = 0; for (let channel = 0; channel < 3; channel++) pixel += Math.abs(a[i + channel] - b[i + channel]); sum += pixel; if (pixel > 30) changed++; }
  return { mean: sum / (a.length / 4 * 3), ratio: changed / (a.length / 4) };
}

for (const spec of [
  { label: 'portrait', size: [595.28, 841.89], rotation: 0 },
  { label: 'rotate90', size: [595.28, 841.89], rotation: 90 },
  { label: 'rotate180crop', size: [595.28, 841.89], rotation: 180, crop: [40, 60, 460, 690] },
  { label: 'rotate270crop', size: [841.89, 1190.55], rotation: 270, crop: [70, 90, 700, 950] },
  { label: 'userunit', size: [300, 420], rotation: 90, crop: [20, 30, 240, 350], unit: 2 },
  { label: 'rotate_after_mark', size: [595.28, 841.89], rotation: 0, finalRotation: 90 },
]) {
  test(`actual PDF output retains content and annotation pixels: ${spec.label}`, async () => {
    const doc = await PDFDocument.create(); const font = await doc.embedFont(StandardFonts.Helvetica);
    const original = doc.addPage(spec.size); original.setRotation(degrees(spec.rotation));
    if (spec.crop) original.setCropBox(...spec.crop);
    if (spec.unit) original.node.set(PDFName.of('UserUnit'), PDFNumber.of(spec.unit));
    original.drawText(`SEARCHABLE ${spec.label}`, { x: 70, y: 180, size: 17, font });
    original.drawRectangle({ x: 80, y: 100, width: 60, height: 40, color: rgb(.1, .6, .8) });
    const bytes = await doc.save(), input = await load(bytes);
    const pages = [{ id: 1, source: 1, index: 0, rotation: spec.finalRotation ?? spec.rotation, marks: [
      { kind: 'text', text: '照合メモ 日本語123', x: .1, y: .12, size: 20, rotation: spec.rotation },
      { kind: 'confirmed', text: '確認済', x: .56, y: .32, size: 20, rotation: spec.rotation },
      { kind: 'review', text: '要確認', x: .59, y: .62, size: 20, rotation: spec.rotation },
      { kind: 'check', text: '✓', x: .15, y: .72, size: 28, rotation: spec.rotation },
    ] }];
    const functions = implementation(pages, new Map([[1, { doc, preview: input }]]));
    const outputBytes = await functions.buildWorkspacePdf();
    const exported = await PDFDocument.load(outputBytes);
    assert.equal(exported.getPage(0).getRotation().angle, pages[0].rotation);
    assert.deepEqual(exported.getPage(0).getCropBox(), original.getCropBox());
    assert.equal(exported.getPage(0).node.get(PDFName.of('UserUnit'))?.asNumber() || 1, spec.unit || 1);
    const output = await load(outputBytes), outputPage = await output.getPage(1);
    assert.match((await outputPage.getTextContent()).items.map((item) => item.str).join(' '), /SEARCHABLE/);
    const { canvas: expected, base } = await render(await input.getPage(1), pages[0].rotation);
    expected.getContext('2d').drawImage(functions.createOverlay(pages[0], base, 0), 0, 0, expected.width, expected.height);
    const { canvas: actual } = await render(outputPage, pages[0].rotation);
    const diff = difference(expected, actual);
    assert.ok(diff.mean < 1.2, JSON.stringify(diff)); assert.ok(diff.ratio < .02, JSON.stringify(diff));
    if (spec.label === 'portrait' || spec.label === 'userunit' || spec.label === 'rotate_after_mark') {
      await writeFile(`artifacts/workspace-${spec.label}.png`, actual.toBuffer('image/png'));
      await writeFile(`artifacts/workspace-${spec.label}.pdf`, outputBytes);
    }
    await input.destroy(); await output.destroy();
  });
}

test('grouped copying retains resource sharing and output page order', async () => {
  const doc = await PDFDocument.create(); const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 20; i++) { const page = doc.addPage([400 + i, 500]); page.drawText('Shared font', { x: 20, y: 30, font }); }
  const pages = doc.getPages().map((_, index) => ({ id: index + 1, source: 1, index, rotation: 0, marks: [] })).reverse();
  const output = await implementation(pages, new Map([[1, { doc }]]), false).buildWorkspacePdf();
  const saved = await PDFDocument.load(output);
  assert.deepEqual(saved.getPages().map((page) => page.getWidth()), pages.map((entry) => 400 + entry.index));
  const refs = saved.getPages().map((page) => page.node.Resources().lookup(PDFName.of('Font')).values().map(String).sort().join(','));
  assert.equal(new Set(refs).size, 1);
  assert.ok(output.length < (await doc.save()).length * 1.2);
});
