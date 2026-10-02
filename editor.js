/* In-memory, non-destructive document workspace. No document network requests. */
(() => {
  'use strict';
  const byId = (id) => document.getElementById(`workspace-${id}`);
  const panel = document.querySelector('[data-feature="workspace"]');
  const sources = new Map();
  let pages = [], selected = new Set(), activeId = null, numbers = false;
  let undo = [], redo = [], busy = false, renderVersion = 0, sourceId = 0, pageId = 0;
  let savedState = JSON.stringify({ pages: [], numbers: false });
  let placement = null, output = null, outputPage = 1;
  let listVersion = 0, activeRenderVersion = 0, outputRenderVersion = 0, previewReady = false;
  const snapshot = () => JSON.parse(JSON.stringify({ pages, numbers }));
  const fingerprint = () => JSON.stringify({ pages, numbers });
  const activePage = () => pages.find((p) => p.id === activeId);
  const status = (message, error = false) => {
    byId('status').textContent = message;
    byId('status').classList.toggle('error', error);
  };
  const normalizeRotation = (angle) => ((angle % 360) + 360) % 360;

  function syncControls() {
    const hasPages = pages.length > 0;
    const hasSelected = selected.size > 0;
    panel.setAttribute('aria-busy', String(busy));
    for (const el of panel.querySelectorAll('button, input, select')) el.disabled = busy;
    byId('undo').disabled = busy || !undo.length;
    byId('redo').disabled = busy || !redo.length;
    for (const id of ['rotate-left', 'rotate-right', 'delete', 'deselect']) byId(id).disabled = busy || !hasSelected;
    for (const id of ['select-all', 'preview-save']) byId(id).disabled = busy || !hasPages;
    for (const id of ['add-note', 'remove-note']) byId(id).disabled = busy || !activePage();
    byId('add-note').disabled = busy || !activePage() || !previewReady;
    byId('remove-note').disabled = busy || !activePage()?.marks.length;
    byId('reset').disabled = busy || (!hasPages && !undo.length && !redo.length);
    byId('page-numbers').disabled = busy || !hasPages;
    byId('page-numbers').checked = numbers;
    byId('count').textContent = `${pages.length}ページ`;
    byId('note').disabled = busy || byId('mark').value !== 'text';
    byId('preview-save').textContent = busy ? '処理中…' : '保存前に確認';
    for (const el of byId('pages').querySelectorAll('.page-moves button')) {
      el.disabled = busy || el.dataset.boundary === 'true';
    }
  }

  function releaseUnusedSources() {
    const used = new Set([snapshot(), ...undo, ...redo].flatMap((s) => s.pages.map((p) => p.source)));
    for (const [id, source] of sources) {
      if (!used.has(id)) {
        source.preview.destroy().catch(() => {});
        sources.delete(id);
      }
    }
  }

  function mutate(action, message) {
    if (busy) return;
    undo.push(snapshot());
    if (undo.length > 50) undo.shift();
    redo = [];
    action();
    reconcile();
    status(message);
    releaseUnusedSources();
  }

  function reconcile() {
    placement = null;
    const ids = new Set(pages.map((p) => p.id));
    selected = new Set([...selected].filter((id) => ids.has(id)));
    if (!ids.has(activeId)) activeId = pages[0]?.id || null;
    byId('canvas').classList.remove('placing');
    renderWorkspace();
    syncControls();
  }

  function restore(state, message) {
    pages = state.pages;
    numbers = state.numbers;
    reconcile();
    status(message);
  }

  async function addFiles(fileList) {
    if (busy) return;
    const files = Array.from(fileList || []);
    byId('files').value = '';
    if (!files.length) return;
    if (files.some((file) => !isPdfFile(file))) {
      status('PDFだけを選んでください。作業内容は変更していません。', true);
      return;
    }
    busy = true; syncControls(); status('PDFを読み込んでいます…');
    const prepared = [];
    try {
      const pdfjs = await getPdfJsLib();
      for (const file of files) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        // Reject encrypted PDFs rather than bypassing their encryption flags.
        const doc = await PDFDocument.load(bytes.slice(), { updateMetadata: false });
        if (!doc.getPageCount()) throw new Error('ページのないPDFは追加できません。');
        const task = createPdfJsLoadingTask(pdfjs, bytes.slice());
        let preview;
        try { preview = await task.promise; }
        catch (error) { await task.destroy(); throw error; }
        prepared.push({ id: ++sourceId, name: file.name, doc, preview });
      }
      const inserted = prepared.flatMap((source) => source.doc.getPages().map((page, index) => ({
        id: ++pageId, source: source.id, index, rotation: normalizeRotation(page.getRotation().angle), marks: [],
      })));
      for (const source of prepared) sources.set(source.id, source);
      const position = byId('insert').value;
      const insertAt = position === 'start' ? 0 : position === 'after' && activeId
        ? pages.findIndex((p) => p.id === activeId) + 1 : pages.length;
      busy = false;
      mutate(() => {
        pages.splice(insertAt, 0, ...inserted);
        activeId = inserted[0].id;
        selected = new Set([activeId]);
      }, `${files.length}ファイル・${inserted.length}ページを追加しました。合計${pages.length + inserted.length}ページ。`);
      // Read the final total rather than a pre-mutation count.
      status(`${files.length}ファイル・${inserted.length}ページを追加しました。合計${pages.length}ページ。`);
      byId('filename').value = files[0].name.replace(/\.pdf$/i, '') + '_編集.pdf';
    } catch (error) {
      for (const source of prepared) if (!sources.has(source.id)) await source.preview.destroy();
      status(`追加できませんでした。パスワード保護・破損のないPDFか確認してください。作業内容は変更していません。${error.message || ''}`, true);
    } finally { busy = false; syncControls(); }
  }

  function makeButton(text, label, action) {
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = text;
    if (label) button.setAttribute('aria-label', label);
    button.addEventListener('click', action);
    return button;
  }

  async function renderWorkspace() {
    const version = ++renderVersion;
    const thumbnailVersion = ++listVersion;
    const list = byId('pages');
    list.replaceChildren();
    const thumbnails = [];
    pages.forEach((entry, index) => {
      const row = document.createElement('article'); row.className = 'workspace-page'; row.dataset.pageId = entry.id;
      row.classList.toggle('active', entry.id === activeId);
      row.classList.toggle('selected', selected.has(entry.id));
      const label = document.createElement('label');
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = selected.has(entry.id);
      checkbox.setAttribute('aria-label', `${index + 1}ページを選択`);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selected.add(entry.id); else selected.delete(entry.id);
        row.classList.toggle('selected', checkbox.checked);
        syncControls();
      });
      label.append(checkbox, document.createTextNode(`${index + 1}ページ`));
      const sourceText = document.createElement('p'); sourceText.className = 'page-source';
      sourceText.textContent = `${sources.get(entry.source).name} / 元${entry.index + 1}ページ`;
      const thumb = document.createElement('canvas'); thumb.setAttribute('aria-hidden', 'true');
      const view = makeButton('', `${index + 1}ページをプレビュー`, () => {
        activeId = entry.id; placement = null;
        list.querySelectorAll('.workspace-page').forEach((el) => el.classList.toggle('active', el.dataset.pageId === String(entry.id)));
        renderActive(++renderVersion).catch((error) => status(error.message, true));
        syncControls();
      });
      view.className = 'page-thumbnail'; view.append(thumb);
      const moves = document.createElement('div'); moves.className = 'page-moves';
      for (const [delta, text] of [[-1, '↑ 前へ'], [1, '↓ 後へ']]) {
        const button = makeButton(text, `${index + 1}ページを${delta < 0 ? '前' : '後'}へ移動`, () => {
          const currentIndex = pages.findIndex((p) => p.id === entry.id);
          const destination = currentIndex + delta;
          if (destination < 0 || destination >= pages.length) return;
          mutate(() => { const [moved] = pages.splice(currentIndex, 1); pages.splice(destination, 0, moved); }, 'ページ順を変更しました。');
        });
        button.dataset.boundary = String(index + delta < 0 || index + delta >= pages.length);
        moves.append(button);
      }
      row.append(label, sourceText, view, moves); list.append(row);
      thumbnails.push({ entry, canvas: thumb, index });
    });
    syncControls();
    renderActive(version).catch((error) => { if (version === renderVersion) status(error.message, true); });
    // Yield between pages; obsolete thumbnail passes stop immediately.
    for (const item of thumbnails) {
      if (thumbnailVersion !== listVersion) break;
      try { await renderPage(item.entry, item.canvas, 150, item.index); }
      catch (error) { if (version === renderVersion) status(`プレビューに失敗しました: ${error.message}`, true); }
    }
  }

  function createOverlay(entry, viewport, index, multiplier = 2) {
    const canvas = document.createElement('canvas');
    const scale = Math.min(multiplier, 2400 / Math.max(viewport.width, viewport.height));
    canvas.width = Math.max(1, Math.ceil(viewport.width * scale));
    canvas.height = Math.max(1, Math.ceil(viewport.height * scale));
    const ctx = canvas.getContext('2d');
    ctx.scale(canvas.width / viewport.width, canvas.height / viewport.height);
    const unit = viewport.width / 595.28;
    for (const mark of entry.marks) {
      ctx.save();
      const delta = normalizeRotation(entry.rotation - (mark.rotation ?? entry.rotation));
      const markWidth = delta % 180 ? viewport.height : viewport.width;
      const markHeight = delta % 180 ? viewport.width : viewport.height;
      if (delta === 90) { ctx.translate(viewport.width, 0); ctx.rotate(Math.PI / 2); }
      if (delta === 180) { ctx.translate(viewport.width, viewport.height); ctx.rotate(Math.PI); }
      if (delta === 270) { ctx.translate(0, viewport.height); ctx.rotate(-Math.PI / 2); }
      const markUnit = markWidth / 595.28;
      const fontSize = mark.size * markUnit;
      ctx.font = `${mark.kind === 'text' ? 500 : 700} ${fontSize}px "Noto Sans CJK JP", "Noto Sans JP", "Yu Gothic", "Meiryo", sans-serif`;
      ctx.textBaseline = 'top';
      const maxWidth = markWidth * .85;
      const lines = []; let line = '';
      for (const char of mark.text) {
        if (line && ctx.measureText(line + char).width > maxWidth) { lines.push(line); line = char; } else line += char;
      }
      if (line) lines.push(line);
      const pad = mark.kind === 'text' ? 2 * markUnit : 6 * markUnit;
      const width = Math.min(maxWidth, Math.max(...lines.map((s) => ctx.measureText(s).width), 1)) + pad * 2;
      const height = lines.length * fontSize * 1.4 + pad * 2;
      const x = Math.max(0, Math.min(mark.x * markWidth, markWidth - width));
      const y = Math.max(0, Math.min(mark.y * markHeight, markHeight - height));
      const color = mark.kind === 'review' ? '#95600b' : mark.kind === 'text' ? '#174c72' : '#b02537';
      if (mark.kind !== 'text') {
        ctx.strokeStyle = color; ctx.lineWidth = Math.max(markUnit, .6);
        ctx.strokeRect(x + markUnit, y + markUnit, width - 2 * markUnit, height - 2 * markUnit);
      }
      ctx.fillStyle = color;
      lines.forEach((text, lineIndex) => ctx.fillText(text, x + pad, y + pad + lineIndex * fontSize * 1.4));
      ctx.restore();
    }
    if (numbers) {
      ctx.font = `${11 * unit}px sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillStyle = '#374752';
      ctx.fillText(`${index + 1} / ${pages.length}`, viewport.width / 2, viewport.height - 10 * unit);
    }
    return canvas;
  }

  async function renderPage(entry, canvas, targetWidth, index) {
    const pdfPage = await sources.get(entry.source).preview.getPage(entry.index + 1);
    const base = pdfPage.getViewport({ scale: 1, rotation: entry.rotation });
    const viewport = pdfPage.getViewport({ scale: Math.min(targetWidth / base.width, 1800 / base.height), rotation: entry.rotation });
    canvas.width = Math.max(1, Math.ceil(viewport.width)); canvas.height = Math.max(1, Math.ceil(viewport.height));
    await pdfPage.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    const overlay = createOverlay(entry, base, index);
    canvas.getContext('2d').drawImage(overlay, 0, 0, canvas.width, canvas.height);
    canvas.dataset.ready = 'true';
  }

  async function renderActive(version) {
    const activeVersion = ++activeRenderVersion;
    const entry = activePage();
    const canvas = byId('canvas');
    previewReady = false; canvas.dataset.ready = 'false'; canvas.style.opacity = '.45'; syncControls();
    canvas.classList.toggle('placing', !!placement);
    byId('empty-preview').hidden = !!entry;
    canvas.style.display = entry ? 'block' : 'none';
    if (!entry) { byId('preview-title').textContent = 'ページを選ぶとここに表示します'; return; }
    const index = pages.indexOf(entry);
    byId('preview-title').textContent = `${index + 1} / ${pages.length}ページ · クリックで位置を指定`;
    // Render offscreen, then publish atomically to prevent races on the same canvas.
    const offscreen = document.createElement('canvas');
    await renderPage(entry, offscreen, 1200, index);
    if (version !== renderVersion || activeVersion !== activeRenderVersion || activeId !== entry.id) return;
    canvas.width = offscreen.width; canvas.height = offscreen.height;
    canvas.getContext('2d').drawImage(offscreen, 0, 0);
    canvas.dataset.ready = 'true'; canvas.style.opacity = '1'; previewReady = true; syncControls();
    if (placement) {
      const ctx = canvas.getContext('2d'); const x = placement.x * canvas.width, y = placement.y * canvas.height;
      ctx.strokeStyle = '#be7600'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x - 12, y); ctx.lineTo(x + 12, y); ctx.moveTo(x, y - 12); ctx.lineTo(x, y + 12); ctx.stroke();
    }
  }

  function placeMark(x, y) {
    if (!placement || busy || !previewReady || !activePage()) return;
    const mark = { ...placement, x, y, rotation: activePage().rotation };
    const entry = activePage();
    mutate(() => { entry.marks.push(mark); }, '書き込みを追加しました。元に戻すこともできます。');
  }

  async function buildWorkspacePdf() {
    const result = await PDFDocument.create();
    const copiedPages = new Map();
    // Copy a source's pages together so shared fonts/images stay shared.
    for (const sourceId of new Set(pages.map((entry) => entry.source))) {
      const entries = pages.filter((entry) => entry.source === sourceId);
      const copied = await result.copyPages(sources.get(sourceId).doc, entries.map((entry) => entry.index));
      entries.forEach((entry, index) => copiedPages.set(entry.id, copied[index]));
    }
    for (let index = 0; index < pages.length; index++) {
      const entry = pages[index], source = sources.get(entry.source);
      const page = copiedPages.get(entry.id);
      result.addPage(page); page.setRotation(degrees(entry.rotation));
      if (entry.marks.length || numbers) {
        const sourcePage = await source.preview.getPage(entry.index + 1);
        const viewport = sourcePage.getViewport({ scale: 1, rotation: entry.rotation });
        const overlay = createOverlay(entry, viewport, index);
        const image = await result.embedPng(overlay.toDataURL('image/png'));
        const bottomLeft = viewport.convertToPdfPoint(0, viewport.height);
        const bottomRight = viewport.convertToPdfPoint(viewport.width, viewport.height);
        const topLeft = viewport.convertToPdfPoint(0, 0);
        page.drawImage(image, {
          x: bottomLeft[0], y: bottomLeft[1],
          width: Math.hypot(bottomRight[0] - bottomLeft[0], bottomRight[1] - bottomLeft[1]),
          height: Math.hypot(topLeft[0] - bottomLeft[0], topLeft[1] - bottomLeft[1]),
          rotate: degrees(entry.rotation),
        });
      }
    }
    return result.save();
  }

  async function releaseOutput() {
    const previous = output; output = null;
    if (previous) await previous.preview.destroy().catch(() => {});
  }

  async function renderOutput() {
    if (!output) return;
    const current = output;
    const version = ++outputRenderVersion;
    const currentPage = outputPage;
    const page = await current.preview.getPage(currentPage);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(600 / base.width, 650 / base.height) });
    const offscreen = document.createElement('canvas'); offscreen.width = Math.ceil(viewport.width); offscreen.height = Math.ceil(viewport.height);
    await page.render({ canvasContext: offscreen.getContext('2d'), viewport }).promise;
    if (output !== current || version !== outputRenderVersion) return;
    const canvas = byId('output-canvas'); canvas.width = offscreen.width; canvas.height = offscreen.height;
    canvas.getContext('2d').drawImage(offscreen, 0, 0);
    byId('output-position').textContent = `${currentPage} / ${current.preview.numPages}ページ`;
    byId('output-prev').disabled = outputPage <= 1;
    byId('output-next').disabled = outputPage >= current.preview.numPages;
  }

  document.querySelector('[data-feature-target="workspace"]').addEventListener('drop', (event) => { event.preventDefault(); addFiles(event.dataTransfer?.files); });
  byId('files').addEventListener('change', (event) => addFiles(event.target.files));
  for (const name of ['dragenter', 'dragover']) byId('dropzone').addEventListener(name, (event) => { event.preventDefault(); if (!busy) byId('dropzone').classList.add('dragover'); });
  byId('dropzone').addEventListener('dragleave', () => byId('dropzone').classList.remove('dragover'));
  byId('dropzone').addEventListener('drop', (event) => { event.preventDefault(); byId('dropzone').classList.remove('dragover'); addFiles(event.dataTransfer.files); });
  byId('undo').addEventListener('click', () => { if (!busy && undo.length) { redo.push(snapshot()); restore(undo.pop(), '1つ前の操作に戻しました。'); } });
  byId('redo').addEventListener('click', () => { if (!busy && redo.length) { undo.push(snapshot()); restore(redo.pop(), '操作をやり直しました。'); } });
  for (const [id, angle] of [['rotate-left', -90], ['rotate-right', 90]]) byId(id).addEventListener('click', () => mutate(() => {
    pages.filter((p) => selected.has(p.id)).forEach((p) => { p.rotation = normalizeRotation(p.rotation + angle); });
  }, `${selected.size}ページを回転しました。`));
  byId('delete').addEventListener('click', () => mutate(() => { pages = pages.filter((p) => !selected.has(p.id)); }, '選択ページを作業から除きました。元に戻せます。'));
  byId('select-all').addEventListener('click', () => { selected = new Set(pages.map((p) => p.id)); reconcile(); status(`${pages.length}ページを選択しました。`); });
  byId('deselect').addEventListener('click', () => { selected.clear(); reconcile(); status('選択を解除しました。'); });
  byId('page-numbers').addEventListener('change', (event) => mutate(() => { numbers = event.target.checked; }, 'ページ番号の設定を変更しました。'));
  byId('mark').addEventListener('change', syncControls);
  byId('add-note').addEventListener('click', () => {
    const kind = byId('mark').value;
    const text = kind === 'text' ? byId('note').value.trim() : { confirmed: '確認済', review: '要確認', check: '✓' }[kind];
    if (!text) { status('メモの内容を入力してください。', true); byId('note').focus(); return; }
    placement = { kind, text, size: Number(byId('size').value), x: .7, y: .05 };
    renderActive(renderVersion).catch((error) => status(error.message, true));
    byId('canvas').focus(); status('位置をクリック、または矢印キーで調整してEnter。Escで取消できます。');
  });
  byId('remove-note').addEventListener('click', () => mutate(() => { activePage().marks.pop(); }, '最後の書き込みを削除しました。'));
  byId('canvas').addEventListener('click', (event) => {
    if (!placement) return;
    const rect = event.currentTarget.getBoundingClientRect();
    placeMark((event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height);
  });
  byId('canvas').addEventListener('keydown', (event) => {
    if (!placement) return;
    if (event.key === 'Escape') { event.preventDefault(); placement = null; renderActive(renderVersion).catch((error) => status(error.message, true)); status('書き込みを取り消しました。'); return; }
    if (event.key === 'Enter') { event.preventDefault(); placeMark(placement.x, placement.y); return; }
    const delta = { ArrowLeft: [-.02, 0], ArrowRight: [.02, 0], ArrowUp: [0, -.02], ArrowDown: [0, .02] }[event.key];
    if (delta) { event.preventDefault(); placement.x = Math.max(0, Math.min(.95, placement.x + delta[0])); placement.y = Math.max(0, Math.min(.95, placement.y + delta[1])); renderActive(renderVersion).catch((error) => status(error.message, true)); }
  });
  byId('reset').addEventListener('click', () => {
    if (busy || !window.confirm('このタブ内の編集内容と操作履歴をクリアしますか？元のPDFは変更されません。')) return;
    pages = []; selected.clear(); activeId = null; numbers = false; undo = []; redo = [];
    savedState = fingerprint(); reconcile(); releaseUnusedSources(); status('作業をクリアしました。');
  });
  byId('preview-save').addEventListener('click', async () => {
    if (busy || !pages.length) return;
    busy = true; placement = null; syncControls(); status('保存するPDFとプレビューを作成しています…');
    try {
      await releaseOutput();
      const bytes = await buildWorkspacePdf();
      const pdfjs = await getPdfJsLib();
      const task = createPdfJsLoadingTask(pdfjs, bytes.slice());
      let preview;
      try { preview = await task.promise; } catch (error) { await task.destroy(); throw error; }
      output = { bytes, preview, fingerprint: fingerprint() }; outputPage = 1;
      byId('save-summary').textContent = `${pages.length}ページ · 書き込み${pages.reduce((sum, p) => sum + p.marks.length, 0)}件 · ページ番号${numbers ? 'あり' : 'なし'} · ${formatFileSize(bytes.length)}`;
      await renderOutput();
      if (!panel.classList.contains('active')) { await releaseOutput(); status('保存確認はキャンセルされました。編集画面で再度「保存前に確認」を押してください。'); return; }
      byId('save-dialog').showModal(); status('出力PDFのプレビューを確認してください。');
    } catch (error) { await releaseOutput(); status(`PDFを作成できませんでした: ${error.message}`, true); }
    finally { busy = false; syncControls(); }
  });
  byId('output-prev').addEventListener('click', async () => { if (outputPage > 1) { outputPage--; await renderOutput().catch((error) => { if (output) status(`プレビューに失敗しました: ${error.message}`, true); }); } });
  byId('output-next').addEventListener('click', async () => { if (output && outputPage < output.preview.numPages) { outputPage++; await renderOutput().catch((error) => { if (output) status(`プレビューに失敗しました: ${error.message}`, true); }); } });
  byId('save-cancel').addEventListener('click', () => byId('save-dialog').close());
  byId('save-dialog').addEventListener('close', () => { releaseOutput(); byId('preview-save').focus(); });
  byId('save-confirm').addEventListener('click', () => {
    if (!output) return;
    const base = (byId('filename').value.trim() || 'edited.pdf').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_');
    const filename = /\.pdf$/i.test(base) ? base : `${base}.pdf`;
    const url = URL.createObjectURL(new Blob([output.bytes], { type: 'application/pdf' }));
    const link = document.createElement('a'); link.href = url; link.download = filename;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    savedState = output.fingerprint;
    byId('save-dialog').close(); status(`${filename} のダウンロードを開始しました。保存先を確認してください。編集はこのまま続けられます。`);
  });
  window.addEventListener('beforeunload', (event) => {
    if (busy || fingerprint() !== savedState) { event.preventDefault(); event.returnValue = ''; }
  });
  document.addEventListener('keydown', (event) => {
    if (!panel.classList.contains('active') || byId('save-dialog').open || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault(); byId(event.shiftKey ? 'redo' : 'undo').click();
    }
  });
  syncControls();
})();
