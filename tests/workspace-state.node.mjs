// Fast state/actual PDF-copy checks for the production editor. Rendering/DOM layout
// is intentionally stubbed; tests/workspace.spec.js covers the real browser path.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import { PDFDocument, degrees } from 'pdf-lib';

const code = await readFile(new URL('../editor.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const fixtures = new URL('./fixtures/', import.meta.url);

function element() {
  const handlers = new Map(), classes = new Set();
  return {
    handlers, value: '', disabled: false, textContent: '', checked: false,
    classList: { add: (s) => classes.add(s), remove: (s) => classes.delete(s), contains: (s) => classes.has(s), toggle: (s, yes) => yes ? classes.add(s) : classes.delete(s) },
    setAttribute() {}, querySelectorAll() { return []; }, addEventListener(type, callback) { handlers.set(type, callback); },
    focus() {}, style: {}, dataset: {},
  };
}

function harness() {
  const nodes = new Map();
  for (const match of html.matchAll(/\bid="([^"]+)"/g)) nodes.set(match[1], element());
  const panel = element(); panel.classList.add('active');
  const document = {
    getElementById(id) { assert.ok(nodes.has(id), `Unknown markup id ${id}`); return nodes.get(id); },
    querySelector() { return panel; }, addEventListener() {},
  };
  nodes.get('workspace-insert').value = 'end'; nodes.get('workspace-mark').value = 'text';
  const loading = { fail: false, destroyed: 0 };
  const context = vm.createContext({
    document, window: { addEventListener() {}, confirm: () => true }, console,
    PDFDocument: {
      load: PDFDocument.load,
      async create() {
        const pdf = await PDFDocument.create(), copyPages = pdf.copyPages.bind(pdf);
        // pdf-lib uses instanceof Array, so bridge arrays from the VM realm.
        pdf.copyPages = (source, indices) => copyPages(source, Array.from(indices));
        return pdf;
      },
    },
    degrees, Uint8Array, JSON, Map, Set,
    isPdfFile: (file) => file.type === 'application/pdf' || /\.pdf$/i.test(file.name),
    getPdfJsLib: async () => ({}),
    createPdfJsLoadingTask: () => ({
      promise: loading.fail ? Promise.reject(new Error('synthetic preview failure')) : Promise.resolve({ destroy: async () => { loading.destroyed++; } }),
      destroy: async () => { loading.destroyed++; },
    }),
  });
  const instrumented = code.replace(/\}\)\(\);\s*$/, `
    renderWorkspace = () => {};
    globalThis.state = {
      addFiles, buildWorkspacePdf, fingerprint,
      inspect: () => JSON.parse(JSON.stringify({ pages, numbers, selected: [...selected], activeId, undo: undo.length, redo: redo.length, busy, sourceCount: sources.size })),
      activate: (index) => { activeId = pages[index].id; },
      select: (indices) => { selected = new Set(indices.map((index) => pages[index].id)); syncControls(); },
    };
  })();`);
  vm.runInContext(instrumented, context, { filename: 'editor.js' });
  return {
    ...context.state, nodes, loading,
    async click(id) { const node = nodes.get(`workspace-${id}`); assert.equal(node.disabled, false, `${id} is disabled`); await node.handlers.get('click')({ target: node }); },
  };
}

async function file(name) {
  const buffer = await readFile(new URL(name, fixtures));
  return { name, type: 'application/pdf', arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) };
}

function summary(state) { return state.inspect().pages.map((page) => [page.source, page.index, page.rotation]); }

test('editor ids are unique and all literal production element references exist', () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  for (const [, ref] of code.matchAll(/byId\('([^']+)'\)/g)) assert.ok(ids.includes(`workspace-${ref}`), ref);
  new vm.Script(code);
});

test('real PDF append/insert, multi-rotate/delete, undo/redo, and copied output geometry', async () => {
  const h = harness();
  await h.addFiles([await file('simple-2pages.pdf'), await file('simple-3pages.pdf')]);
  assert.equal(h.inspect().pages.length, 5);
  h.select([0, 2]); await h.click('rotate-right');
  assert.deepEqual(summary(h).map((p) => p[2]), [90, 0, 90, 0, 0]);
  await h.click('delete'); assert.equal(h.inspect().pages.length, 3);
  await h.click('undo'); assert.equal(h.inspect().pages.length, 5);
  await h.click('redo'); assert.equal(h.inspect().pages.length, 3);
  await h.click('undo');
  h.activate(1); h.nodes.get('workspace-insert').value = 'after';
  await h.addFiles([await file('japanese-text.pdf')]);
  assert.deepEqual(summary(h).map((p) => p[0]), [1, 1, 3, 3, 2, 2, 2]);
  assert.equal(h.inspect().redo, 0);
  const output = await PDFDocument.load(await h.buildWorkspacePdf());
  assert.equal(output.getPageCount(), 7);
  assert.deepEqual(output.getPages().map((p) => p.getWidth()), [440, 460, 440, 460, 440, 460, 480]);
  assert.deepEqual(output.getPages().map((p) => p.getRotation().angle), [90, 0, 0, 0, 90, 0, 0]);
});

test('invalid and broken multi-file batches are atomic and leave existing history unchanged', async () => {
  const h = harness(); await h.addFiles([await file('simple-2pages.pdf')]);
  const original = h.fingerprint(), history = h.inspect().undo;
  await h.addFiles([{ name: 'no.txt', type: 'text/plain', arrayBuffer: async () => new ArrayBuffer(0) }]);
  assert.equal(h.fingerprint(), original); assert.equal(h.inspect().undo, history);
  await h.addFiles([await file('simple-3pages.pdf'), { name: 'corrupt.pdf', type: 'application/pdf', arrayBuffer: async () => new TextEncoder().encode('%PDF-1.7 corrupt').buffer }]);
  assert.equal(h.fingerprint(), original); assert.equal(h.inspect().undo, history);
  assert.equal(h.inspect().sourceCount, 1); assert.equal(h.loading.destroyed, 1);
  assert.equal(h.inspect().busy, false);
  h.loading.fail = true; await h.addFiles([await file('simple-3pages.pdf')]);
  assert.equal(h.fingerprint(), original); assert.equal(h.inspect().sourceCount, 1);
  assert.match(h.nodes.get('workspace-status').textContent, /作業内容は変更していません/);
});

test('all-delete is recoverable; reset releases all retained source documents and can restart', async () => {
  const h = harness(); await h.addFiles([await file('simple-3pages.pdf')]);
  await h.click('select-all'); await h.click('delete');
  assert.equal(h.inspect().pages.length, 0); assert.equal(h.inspect().sourceCount, 1);
  assert.equal(h.nodes.get('workspace-preview-save').disabled, true);
  await h.click('undo'); assert.equal(h.inspect().pages.length, 3);
  await h.click('reset');
  assert.equal(h.inspect().pages.length, 0); assert.equal(h.inspect().sourceCount, 0);
  assert.equal(h.inspect().undo, 0); assert.equal(h.inspect().redo, 0);
  assert.equal(h.loading.destroyed, 1);
  await h.addFiles([await file('simple-2pages.pdf')]); assert.equal(h.inspect().pages.length, 2);
});

test('history is bounded and a fresh action drops redo without leaking unused sources', async () => {
  const h = harness(); await h.addFiles([await file('simple-2pages.pdf')]);
  for (let i = 0; i < 60; i++) await h.click('rotate-right');
  assert.equal(h.inspect().undo, 50);
  await h.click('undo'); assert.equal(h.inspect().redo, 1);
  await h.click('rotate-left'); assert.equal(h.inspect().redo, 0);
  assert.equal(h.inspect().sourceCount, 1);
});

test('unchanged multipage PDFs keep shared image resources without multiplying output size', async () => {
  const h = harness(), input = await file('compression-source.pdf');
  const original = await input.arrayBuffer();
  await h.addFiles([input]);
  const output = await h.buildWorkspacePdf();
  assert.equal((await PDFDocument.load(output)).getPageCount(), 2);
  assert.ok(output.length < original.byteLength * 1.1, `Shared-image source ${original.byteLength} bytes expanded to ${output.length} bytes`);
});
