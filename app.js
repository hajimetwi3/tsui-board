'use strict';
(function () {
  // ===== 定数・ストレージキー =====
  const PAGE_COUNT = 5;
  const SK_SETTINGS = 'tsui-board.settings.v1';
  const SK_PAGE = (n) => `tsui-board.page.${n}.v1`;
  const MAX_STORAGE_BYTES_PER_PAGE = 4 * 1024 * 1024;
  const IMAGE_MAX_SIDE = 1024;

  // ===== 要素 =====
  const canvas = document.getElementById('canvas');
  const stage = document.getElementById('stage');
  const ctx = canvas.getContext('2d', { willReadFrequently: false });
  const sizeInput = document.getElementById('size');
  const sizeNum = document.getElementById('size-num');
  const colorPicker = document.getElementById('color-picker');
  const panel = document.getElementById('panel');
  const menuBtn = document.getElementById('menu-btn');
  const noticeEl = document.getElementById('notice');
  const pageBtn = document.getElementById('page-btn');
  const pageCurEl = document.getElementById('page-cur');

  // モバイル集約メニュー要素（存在しない場合はnull）
  const mSize = document.querySelector('.m-size');
  const mSizeNum = document.querySelector('.m-size-num');
  const mColorPicker = document.querySelector('.m-color-picker');
  const mPageCur = document.querySelector('.m-page-cur');

  // Aboutモーダル
  const aboutBtn = document.getElementById('about-btn');
  const modalBackdrop = document.getElementById('modal-backdrop');
  const modalEl = document.getElementById('modal');
  const modalClose = document.getElementById('modal-close');

  // ===== 状態 =====
  const state = {
    tool: 'pen',
    color: '#111111',
    size: 4,
    bg: 'plain',
    theme: 'dark',
    glow: 'on',
    page: 1,
    paper: 'white', // 'white' | 'board'
  };

  // 黒板モード時にペン色として自動選択されるテーマ色
  const THEME_PEN = {
    dark: '#7dd3c0',
    pink: '#ff26b3',
    cyber: '#39ff77',
    auto: '#7dd3c0',
  };

  const pages = {};
  for (let i = 1; i <= PAGE_COUNT; i++) pages[i] = [];

  let strokes = pages[state.page]; // 現ページへの参照
  let redoStack = [];
  let currentStroke = null;
  let dpr = 1;
  let cssW = 0, cssH = 0;

  // ===== 設定 =====
  function loadSettings() {
    try {
      const raw = localStorage.getItem(SK_SETTINGS);
      if (raw) {
        const obj = JSON.parse(raw);
        Object.assign(state, obj);
        if (!Number.isInteger(state.page) || state.page < 1 || state.page > PAGE_COUNT) state.page = 1;
      }
    } catch (e) { /* noop */ }
  }
  function saveSettings() {
    try { localStorage.setItem(SK_SETTINGS, JSON.stringify(state)); } catch (e) { /* noop */ }
  }
  function applySettings() {
    document.documentElement.dataset.theme = state.theme;
    document.documentElement.dataset.bg = state.bg;
    document.documentElement.dataset.glow = state.glow;
    document.documentElement.dataset.paper = state.paper;
    sizeInput.value = state.size;
    sizeNum.textContent = state.size;
    colorPicker.value = toHex(state.color);
    pageCurEl.textContent = String(state.page);
    // モバイル集約メニュー側も同期
    if (mSize) mSize.value = state.size;
    if (mSizeNum) mSizeNum.textContent = state.size;
    if (mColorPicker) mColorPicker.value = toHex(state.color);
    if (mPageCur) mPageCur.textContent = String(state.page);
    updateActiveUI();
  }

  function toHex(c) {
    if (typeof c !== 'string') return '#111111';
    if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c)) return c;
    return '#111111';
  }

  function updateActiveUI() {
    document.querySelectorAll('.tool-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.tool === state.tool);
    });
    document.querySelectorAll('.color-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.color.toLowerCase() === state.color.toLowerCase());
    });
    document.querySelectorAll('#panel button[data-k]').forEach(b => {
      const k = b.dataset.k;
      b.classList.toggle('active', state[k] === b.dataset.v);
    });
    canvas.style.cursor = state.tool === 'eraser' ? 'cell' : 'crosshair';
  }

  // ===== 永続化 =====
  function serializeStrokes(arr) {
    const slim = arr.map(s => {
      if (s.kind === 'image') {
        return { t: 'i', src: s.src, x: round2(s.x), y: round2(s.y), w: round2(s.w), h: round2(s.h) };
      }
      return {
        t: s.tool === 'eraser' ? 'e' : 'p',
        c: s.color,
        s: s.size,
        p: s.points.map(pt => [round2(pt[0]), round2(pt[1]), round2(pt[2] || 0)]),
      };
    });
    return JSON.stringify({ v: 2, strokes: slim });
  }

  function deserializeStrokes(json) {
    try {
      const data = JSON.parse(json);
      if (!data || !Array.isArray(data.strokes)) return [];
      return data.strokes.map(s => {
        if (s.t === 'i') {
          return makeImageStroke(s.src, s.x, s.y, s.w, s.h);
        }
        return {
          kind: 'stroke',
          tool: s.t === 'e' ? 'eraser' : 'pen',
          color: s.c || '#111111',
          size: s.s || 4,
          points: (s.p || []).map(pt => [pt[0], pt[1], pt[2] || 0]),
        };
      });
    } catch (e) { return []; }
  }

  function savePage(pageNum) {
    try {
      const arr = pages[pageNum];
      if (!arr || arr.length === 0) {
        localStorage.removeItem(SK_PAGE(pageNum));
        return;
      }
      const json = serializeStrokes(arr);
      if (json.length > MAX_STORAGE_BYTES_PER_PAGE) {
        toast(`ページ${pageNum}: 容量上限のため自動保存スキップ`);
        return;
      }
      localStorage.setItem(SK_PAGE(pageNum), json);
    } catch (e) {
      // QuotaExceeded 等は握りつぶす
    }
  }

  function loadAllPages() {
    for (let i = 1; i <= PAGE_COUNT; i++) {
      try {
        const raw = localStorage.getItem(SK_PAGE(i));
        pages[i] = raw ? deserializeStrokes(raw) : [];
      } catch (e) { pages[i] = []; }
    }
    strokes = pages[state.page];
  }

  function round2(n) { return Math.round(n * 100) / 100; }

  function rgbToHex(r, g, b) {
    const h = (n) => n.toString(16).padStart(2, '0');
    return `#${h(r)}${h(g)}${h(b)}`;
  }

  // スポイト: キャンバス上の1pxを取得。透明は null を返す
  function pickColor(cssX, cssY) {
    const px = Math.max(0, Math.min(canvas.width - 1, Math.round(cssX * dpr)));
    const py = Math.max(0, Math.min(canvas.height - 1, Math.round(cssY * dpr)));
    let rgba;
    try {
      rgba = ctx.getImageData(px, py, 1, 1).data;
    } catch (e) { return null; }
    const r = rgba[0], g = rgba[1], b = rgba[2], a = rgba[3];
    if (a === 0) return null;
    return rgbToHex(r, g, b);
  }

  // ===== 画像ストローク =====
  function makeImageStroke(src, x, y, w, h) {
    const s = { kind: 'image', src, x, y, w, h, _img: null, _ready: false };
    const img = new Image();
    img.onload = () => {
      s._img = img;
      s._ready = true;
      redrawAll();
    };
    img.onerror = () => { s._ready = false; };
    img.src = src;
    return s;
  }

  // ===== 描画 =====
  function applyStrokeStyle(s) {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (s.tool === 'eraser') {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.strokeStyle = '#000';
    } else {
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = s.color;
    }
  }

  function drawStroke(s) {
    const pts = s.points;
    if (!pts.length) return;
    applyStrokeStyle(s);
    if (pts.length === 1) {
      const p = pts[0];
      const w = s.size * pressureScale(p[2]);
      const prevOp = ctx.globalCompositeOperation;
      ctx.beginPath();
      ctx.arc(p[0], p[1], Math.max(0.5, w / 2), 0, Math.PI * 2);
      ctx.fillStyle = s.tool === 'eraser' ? '#000' : s.color;
      ctx.fill();
      ctx.globalCompositeOperation = prevOp;
      return;
    }
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const w = s.size * ((pressureScale(a[2]) + pressureScale(b[2])) / 2);
      ctx.lineWidth = Math.max(0.5, w);
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
    }
  }

  function drawLastSegment(s) {
    const pts = s.points;
    if (pts.length < 2) { drawStroke(s); return; }
    applyStrokeStyle(s);
    const a = pts[pts.length - 2], b = pts[pts.length - 1];
    const w = s.size * ((pressureScale(a[2]) + pressureScale(b[2])) / 2);
    ctx.lineWidth = Math.max(0.5, w);
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.stroke();
  }

  function drawImageStroke(s) {
    if (!s._ready || !s._img) return;
    const prev = ctx.globalCompositeOperation;
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(s._img, s.x, s.y, s.w, s.h);
    ctx.globalCompositeOperation = prev;
  }

  function pressureScale(p) {
    if (!p || p <= 0) return 1;
    return 0.5 + p * 0.7;
  }

  function drawOne(s) {
    if (s.kind === 'image') drawImageStroke(s);
    else drawStroke(s);
  }

  function redrawAll() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    for (const s of strokes) drawOne(s);
  }

  // ===== リサイズ =====
  function resizeCanvas() {
    const r = stage.getBoundingClientRect();
    cssW = Math.max(1, Math.floor(r.width));
    cssH = Math.max(1, Math.floor(r.height));
    dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    redrawAll();
  }

  // ===== Pointer 入力 =====
  let activePointerId = null;

  function getPos(e) {
    const r = canvas.getBoundingClientRect();
    return [
      (e.clientX - r.left),
      (e.clientY - r.top),
      (e.pressure != null ? e.pressure : 0)
    ];
  }

  function onPointerDown(e) {
    if (activePointerId !== null) return;
    if (e.button !== undefined && e.button !== 0 && e.pointerType === 'mouse') return;
    // Alt+クリックでスポイト（touchは除外。長押し等の誤爆を避ける）
    if (e.altKey && e.pointerType !== 'touch') {
      const p = getPos(e);
      const c = pickColor(p[0], p[1]);
      if (c) {
        state.color = c;
        state.tool = 'pen';
        colorPicker.value = toHex(c);
        saveSettings();
        updateActiveUI();
        toast('色を取得: ' + c);
      } else {
        toast('透明部分です（色なし）');
      }
      e.preventDefault();
      return;
    }
    activePointerId = e.pointerId;
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    const p = getPos(e);
    currentStroke = {
      kind: 'stroke',
      tool: state.tool,
      color: state.color,
      size: state.size,
      points: [p],
      _line: !!e.shiftKey, // 開始時にShift押下なら直線モード
    };
    strokes.push(currentStroke);
    redoStack.length = 0;
    drawStroke(currentStroke);
    e.preventDefault();
  }

  function onPointerMove(e) {
    if (activePointerId !== e.pointerId || !currentStroke) return;
    // 直線モード: 起点だけ残し、終点を現在位置に上書き → 毎フレーム全再描画
    if (currentStroke._line) {
      const p = getPos(e);
      currentStroke.points.length = 1;
      currentStroke.points.push(p);
      redrawAll();
      e.preventDefault();
      return;
    }
    const events = (typeof e.getCoalescedEvents === 'function') ? e.getCoalescedEvents() : null;
    if (events && events.length > 1) {
      const r = canvas.getBoundingClientRect();
      for (const ev of events) {
        const p = [ev.clientX - r.left, ev.clientY - r.top, ev.pressure != null ? ev.pressure : 0];
        const last = currentStroke.points[currentStroke.points.length - 1];
        if (last && Math.abs(p[0] - last[0]) < 0.75 && Math.abs(p[1] - last[1]) < 0.75) continue;
        currentStroke.points.push(p);
        drawLastSegment(currentStroke);
      }
    } else {
      const p = getPos(e);
      const last = currentStroke.points[currentStroke.points.length - 1];
      if (last && Math.abs(p[0] - last[0]) < 0.75 && Math.abs(p[1] - last[1]) < 0.75) return;
      currentStroke.points.push(p);
      drawLastSegment(currentStroke);
    }
    e.preventDefault();
  }

  function onPointerUp(e) {
    if (activePointerId !== e.pointerId) return;
    try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
    activePointerId = null;
    currentStroke = null;
    scheduleSave();
    e.preventDefault();
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('pointerleave', (e) => {
    if (activePointerId === e.pointerId) onPointerUp(e);
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // ===== Undo / Redo / Clear =====
  function undo() {
    if (!strokes.length) return;
    redoStack.push(strokes.pop());
    redrawAll();
    scheduleSave();
  }
  function redo() {
    if (!redoStack.length) return;
    strokes.push(redoStack.pop());
    redrawAll();
    scheduleSave();
  }
  function clearAll() {
    if (!strokes.length && !redoStack.length) return;
    if (!confirm(`ページ ${state.page} を全て消してよろしいですか？（元に戻せません）`)) return;
    strokes.length = 0; // 参照維持
    redoStack.length = 0;
    redrawAll();
    scheduleSave();
    toast(`ページ${state.page} をクリア`);
  }

  // ===== 出力用キャンバス合成 =====
  function composeOutputCanvas() {
    const out = document.createElement('canvas');
    out.width = canvas.width;
    out.height = canvas.height;
    const octx = out.getContext('2d');
    const isBoard = state.paper === 'board';
    octx.fillStyle = isBoard ? '#0a0a0a' : '#ffffff';
    octx.fillRect(0, 0, out.width, out.height);
    const gridColor = isBoard ? '#1e2230' : '#d8d8d8';
    const dotColor  = isBoard ? '#2a3040' : '#b8b8b8';
    if (state.bg === 'grid') {
      drawGridPattern(octx, out.width, out.height, 24 * dpr, gridColor, 1);
    } else if (state.bg === 'dot') {
      drawDotPattern(octx, out.width, out.height, 20 * dpr, 1.2 * dpr, dotColor);
    }
    octx.drawImage(canvas, 0, 0);
    return out;
  }

  function drawGridPattern(c, w, h, step, color, lineW) {
    c.save();
    c.strokeStyle = color; c.lineWidth = lineW;
    c.beginPath();
    for (let x = step; x < w; x += step) { c.moveTo(x + 0.5, 0); c.lineTo(x + 0.5, h); }
    for (let y = step; y < h; y += step) { c.moveTo(0, y + 0.5); c.lineTo(w, y + 0.5); }
    c.stroke();
    c.restore();
  }
  function drawDotPattern(c, w, h, step, r, color) {
    c.save();
    c.fillStyle = color;
    for (let y = step / 2; y < h; y += step) {
      for (let x = step / 2; x < w; x += step) {
        c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
      }
    }
    c.restore();
  }

  // ===== PNG保存 =====
  function savePNG() {
    const out = composeOutputCanvas();
    const filename = buildFilename();
    out.toBlob((blob) => {
      if (!blob) { toast('保存に失敗しました'); return; }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      toast('PNG を保存しました');
    }, 'image/png');
  }

  function buildFilename() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `tsui-board_p${state.page}_${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.png`;
  }

  // ===== クリップボード コピー =====
  async function copyPNG() {
    if (!navigator.clipboard || typeof navigator.clipboard.write !== 'function' || typeof window.ClipboardItem === 'undefined') {
      toast('このブラウザ/環境ではコピー非対応（http(s)経由で再試行）');
      return;
    }
    const out = composeOutputCanvas();
    await new Promise((resolve) => {
      out.toBlob(async (blob) => {
        if (!blob) { toast('コピーに失敗'); resolve(); return; }
        try {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
          toast('クリップボードにコピーしました');
        } catch (e) {
          toast('コピー失敗: ' + (e && e.message ? e.message : 'unknown'));
        }
        resolve();
      }, 'image/png');
    });
  }

  // ===== クリップボード ペースト =====
  async function pasteFromClipboardAPI() {
    if (!navigator.clipboard || typeof navigator.clipboard.read !== 'function') {
      toast('このブラウザ/環境では貼付API非対応。Ctrl/⌘+V をお試しください');
      return;
    }
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        for (const type of item.types) {
          if (type.startsWith('image/')) {
            const blob = await item.getType(type);
            await placePastedImage(blob);
            return;
          }
        }
      }
      toast('クリップボードに画像がありません');
    } catch (e) {
      toast('貼付失敗: ' + (e && e.message ? e.message : 'unknown'));
    }
  }

  async function placePastedImage(blob) {
    try {
      const dataURL = await blobToResizedDataURL(blob, IMAGE_MAX_SIDE);
      await new Promise((resolve, reject) => {
        const probe = new Image();
        probe.onload = () => {
          const sW = cssW, sH = cssH;
          const maxW = sW * 0.8, maxH = sH * 0.8;
          let w = probe.naturalWidth, h = probe.naturalHeight;
          const k = Math.min(maxW / w, maxH / h, 1);
          w *= k; h *= k;
          const x = (sW - w) / 2, y = (sH - h) / 2;
          const s = makeImageStroke(dataURL, x, y, w, h);
          strokes.push(s);
          redoStack.length = 0;
          redrawAll();
          scheduleSave();
          toast('画像を貼り付けました');
          resolve();
        };
        probe.onerror = reject;
        probe.src = dataURL;
      });
    } catch (e) {
      toast('画像の読み込みに失敗');
    }
  }

  async function blobToResizedDataURL(blob, maxSide) {
    const url = URL.createObjectURL(blob);
    try {
      const img = await loadImage(url);
      const w0 = img.naturalWidth, h0 = img.naturalHeight;
      const scale = Math.min(1, maxSide / Math.max(w0, h0));
      if (scale >= 1 && blob.type === 'image/png' && blob.size < 300 * 1024) {
        return await blobToDataURL(blob);
      }
      const w = Math.max(1, Math.round(w0 * scale));
      const h = Math.max(1, Math.round(h0 * scale));
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      return c.toDataURL('image/png');
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  }

  // pasteイベント: Ctrl/⌘+V でも貼り付けられるように
  document.addEventListener('paste', async (e) => {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    const cd = e.clipboardData;
    if (!cd || !cd.items) return;
    for (const item of cd.items) {
      if (item.type && item.type.startsWith('image/')) {
        const blob = item.getAsFile();
        if (blob) {
          e.preventDefault();
          await placePastedImage(blob);
          return;
        }
      }
    }
  });

  // ===== 自動保存（debounce） =====
  let saveTimer = null;
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => savePage(state.page), 400);
  }

  // ===== ページ切替 =====
  function switchPage(newPage) {
    if (newPage === state.page) return;
    if (newPage < 1) newPage = PAGE_COUNT;
    if (newPage > PAGE_COUNT) newPage = 1;
    clearTimeout(saveTimer);
    savePage(state.page);
    state.page = newPage;
    saveSettings();
    strokes = pages[newPage];
    redoStack = [];
    pageCurEl.textContent = String(newPage);
    if (mPageCur) mPageCur.textContent = String(newPage);
    redrawAll();
    toast(`ページ ${newPage} へ`);
  }

  // ===== トースト =====
  let noticeTimer = null;
  function toast(msg) {
    noticeEl.textContent = msg;
    noticeEl.classList.add('open');
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => noticeEl.classList.remove('open'), 1600);
  }

  // ===== UIイベント =====
  document.querySelectorAll('.tool-btn').forEach(b => {
    b.addEventListener('click', () => {
      state.tool = b.dataset.tool;
      saveSettings();
      updateActiveUI();
    });
  });
  document.querySelectorAll('.color-btn').forEach(b => {
    b.addEventListener('click', () => {
      state.color = b.dataset.color;
      state.tool = 'pen';
      colorPicker.value = toHex(state.color);
      saveSettings();
      updateActiveUI();
    });
  });
  colorPicker.addEventListener('input', () => {
    state.color = colorPicker.value;
    state.tool = 'pen';
    if (mColorPicker) mColorPicker.value = state.color;
    saveSettings();
    updateActiveUI();
  });
  sizeInput.addEventListener('input', () => {
    state.size = parseInt(sizeInput.value, 10);
    sizeNum.textContent = state.size;
    if (mSize) mSize.value = state.size;
    if (mSizeNum) mSizeNum.textContent = state.size;
    saveSettings();
  });
  document.getElementById('undo').addEventListener('click', undo);
  document.getElementById('redo').addEventListener('click', redo);
  document.getElementById('clear').addEventListener('click', clearAll);
  document.getElementById('save').addEventListener('click', savePNG);
  document.getElementById('copy').addEventListener('click', copyPNG);
  document.getElementById('paste').addEventListener('click', pasteFromClipboardAPI);

  // ページボタン: 通常=次 / Shift=前
  pageBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const dir = e.shiftKey ? -1 : 1;
    switchPage(state.page + dir);
  });

  // ===== モバイル集約メニュー =====
  if (mSize) {
    mSize.addEventListener('input', () => {
      state.size = parseInt(mSize.value, 10);
      sizeInput.value = state.size;
      sizeNum.textContent = state.size;
      if (mSizeNum) mSizeNum.textContent = state.size;
      saveSettings();
    });
  }
  if (mColorPicker) {
    mColorPicker.addEventListener('input', () => {
      state.color = mColorPicker.value;
      state.tool = 'pen';
      colorPicker.value = state.color;
      saveSettings();
      updateActiveUI();
    });
  }
  document.querySelectorAll('.m-page').forEach(b => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const dir = b.dataset.act === 'prev' ? -1 : 1;
      switchPage(state.page + dir);
    });
  });
  document.querySelectorAll('.m-op').forEach(b => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const op = b.dataset.op;
      if (op === 'copy') copyPNG();
      else if (op === 'paste') pasteFromClipboardAPI();
      else if (op === 'clear') clearAll();
    });
  });

  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    panel.classList.toggle('open');
  });
  document.addEventListener('click', (e) => {
    if (!panel.contains(e.target) && e.target !== menuBtn && !menuBtn.contains(e.target)) {
      panel.classList.remove('open');
    }
  });

  // ===== About モーダル =====
  function openModal() {
    if (!modalBackdrop) return;
    modalBackdrop.classList.add('open');
    panel.classList.remove('open'); // パネルは閉じる
    if (modalClose) modalClose.focus();
  }
  function closeModal() {
    if (!modalBackdrop) return;
    modalBackdrop.classList.remove('open');
  }
  if (aboutBtn) {
    aboutBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openModal();
    });
  }
  if (modalClose) {
    modalClose.addEventListener('click', (e) => { e.stopPropagation(); closeModal(); });
  }
  if (modalBackdrop) {
    modalBackdrop.addEventListener('click', () => closeModal());
  }
  if (modalEl) {
    modalEl.addEventListener('click', (e) => e.stopPropagation());
  }
  document.querySelectorAll('#panel button[data-k]').forEach(b => {
    b.addEventListener('click', () => {
      const k = b.dataset.k, v = b.dataset.v;
      const prev = state[k];
      state[k] = v;
      // 黒板モードON: ペン色をテーマ色に
      if (k === 'paper' && v === 'board' && prev !== 'board') {
        const c = THEME_PEN[state.theme] || '#7dd3c0';
        state.color = c;
      }
      // 黒板モード中のテーマ切替: ペン色追従
      if (k === 'theme' && state.paper === 'board') {
        const c = THEME_PEN[v] || '#7dd3c0';
        state.color = c;
      }
      saveSettings();
      applySettings();
    });
  });

  // ===== キーボード =====
  document.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    // ESC: モーダル優先で閉じる
    if (e.key === 'Escape') {
      if (modalBackdrop && modalBackdrop.classList.contains('open')) {
        closeModal();
        e.preventDefault();
        return;
      }
      if (panel.classList.contains('open')) {
        panel.classList.remove('open');
        e.preventDefault();
        return;
      }
    }
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    // モーダル表示中は他のショートカットを抑止
    if (modalBackdrop && modalBackdrop.classList.contains('open')) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
      return;
    }
    if (mod && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); redo(); return; }
    if (mod && (e.key === 's' || e.key === 'S')) { e.preventDefault(); savePNG(); return; }
    if (mod && (e.key === 'c' || e.key === 'C')) { e.preventDefault(); copyPNG(); return; }
    // Ctrl/⌘+V は paste イベントに任せる
    if (!mod) {
      if (e.key === 'p' || e.key === 'P') { state.tool = 'pen'; saveSettings(); updateActiveUI(); }
      else if (e.key === 'e' || e.key === 'E') { state.tool = 'eraser'; saveSettings(); updateActiveUI(); }
      else if (e.key === '[') {
        state.size = Math.max(1, state.size - 1); sizeInput.value = state.size; sizeNum.textContent = state.size; saveSettings();
      }
      else if (e.key === ']') {
        state.size = Math.min(40, state.size + 1); sizeInput.value = state.size; sizeNum.textContent = state.size; saveSettings();
      }
      else if (/^[1-5]$/.test(e.key)) {
        switchPage(parseInt(e.key, 10));
      }
    }
  });

  // ===== リサイズ =====
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resizeCanvas, 80);
  });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(resizeCanvas, 80);
    });
  }

  window.addEventListener('pagehide', () => savePage(state.page));
  window.addEventListener('beforeunload', () => savePage(state.page));

  // ===== PWA =====
  function registerPWA() {
    const proto = location.protocol;
    if (proto !== 'http:' && proto !== 'https:') return;
    try {
      const link = document.createElement('link');
      link.rel = 'manifest';
      link.href = 'manifest.webmanifest';
      document.head.appendChild(link);
    } catch (_) { /* noop */ }
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch(() => {});
      });
    }
  }

  // ===== 起動 =====
  loadSettings();
  loadAllPages();
  applySettings();
  resizeCanvas();
  registerPWA();
})();
