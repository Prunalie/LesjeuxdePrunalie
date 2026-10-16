/* Ma petite pièce — placer des stickers importés dans une pièce isométrique.
 * Tout est sauvegardé dans le navigateur (IndexedDB) : les images importées
 * et la disposition de la pièce. */
(() => {
  'use strict';

  // ---------------------------------------------------------------------------
  // Constantes & état
  // ---------------------------------------------------------------------------
  const STAGE_W = 1000;
  const STAGE_H = 760;
  const STICKER_DEFAULT_SIZE = 160; // plus grand côté d'un sticker posé
  const IMPORT_MAX_SIZE = 1024;     // les grosses images sont réduites à l'import
  const MIN_SIZE = 16;

  const DEFAULT_COLORS = {
    wallLeft: '#f4d9c6',
    wallRight: '#ecc8b4',
    floor: '#d7b48f',
  };

  const state = {
    images: new Map(),   // id -> { id, name, blob, url, w, h }
    stickers: [],        // ordre du tableau = ordre d'empilement (dernier = devant)
    colors: { ...DEFAULT_COLORS },
    selectedId: null,
    scale: 1,
  };

  const $ = (sel) => document.querySelector(sel);
  const stageArea = $('#stageArea');
  const stageScaler = $('#stageScaler');
  const stage = $('#stage');
  const room = $('#room');
  const layer = $('#stickerLayer');
  const toolbar = $('#toolbar');
  const libraryGrid = $('#libraryGrid');
  const libraryEmpty = $('#libraryEmpty');
  const fileInput = $('#fileInput');
  const dropOverlay = $('#dropOverlay');


  // ---------------------------------------------------------------------------
  // Petits dialogues intégrés à la page (alert/confirm sont bloqués dans certains cadres)
  // ---------------------------------------------------------------------------
  const confirmDialog = $('#confirmDialog');
  const exportDialog = $('#exportDialog');
  const exportImg = $('#exportImg');
  const exportLink = $('#exportLink');
  const toastEl = $('#toast');

  function askConfirm(message, okLabel) {
    return new Promise((resolve) => {
      $('#confirmText').textContent = message;
      const ok = $('#confirmOk'), cancel = $('#confirmCancel');
      ok.textContent = okLabel;
      confirmDialog.hidden = false;
      ok.focus();
      const done = (v) => {
        confirmDialog.hidden = true;
        ok.onclick = cancel.onclick = null;
        resolve(v);
      };
      ok.onclick = () => done(true);
      cancel.onclick = () => done(false);
    });
  }

  let toastTimer = null;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, 4000);
  }

  $('#exportClose').addEventListener('click', () => { exportDialog.hidden = true; });

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

  // ---------------------------------------------------------------------------
  // Stockage (IndexedDB)
  // ---------------------------------------------------------------------------
  const db = (() => {
    let dbPromise = null;
    const open = () => {
      if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
          const req = indexedDB.open('ma-petite-piece', 1);
          req.onupgradeneeded = () => {
            const d = req.result;
            d.createObjectStore('images', { keyPath: 'id' });
            d.createObjectStore('state');
          };
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
      }
      return dbPromise;
    };
    const run = async (store, mode, fn) => {
      const d = await open();
      return new Promise((resolve, reject) => {
        const tx = d.transaction(store, mode);
        const req = fn(tx.objectStore(store));
        tx.oncomplete = () => resolve(req && req.result);
        tx.onerror = () => reject(tx.error);
      });
    };
    return {
      allImages: () => run('images', 'readonly', (s) => s.getAll()),
      putImage: (img) => run('images', 'readwrite', (s) => s.put(img)),
      deleteImage: (id) => run('images', 'readwrite', (s) => s.delete(id)),
      getState: () => run('state', 'readonly', (s) => s.get('scene')),
      putState: (v) => run('state', 'readwrite', (s) => s.put(v, 'scene')),
    };
  })();

  let saveTimer = null;
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      db.putState({ stickers: state.stickers, colors: state.colors })
        .catch((e) => console.warn('Sauvegarde impossible', e));
    }, 300);
  }

  // ---------------------------------------------------------------------------
  // Dessin de la pièce isométrique
  // ---------------------------------------------------------------------------
  // Coin du fond au sol, et les deux axes du sol.
  const C = { x: 500, y: 330 };   // coin du fond
  const R = { x: 920, y: 540 };   // coin droit
  const L = { x: 80, y: 540 };    // coin gauche
  const WALL_H = 300;
  const TILES = 8;

  const floorPoint = (u, v) => ({
    x: C.x + u * (R.x - C.x) + v * (L.x - C.x),
    y: C.y + u * (R.y - C.y) + v * (L.y - C.y),
  });
  const up = (p, h = WALL_H) => ({ x: p.x, y: p.y - h });
  const pts = (...ps) => ps.map((p) => `${p.x},${p.y}`).join(' ');

  function shade(hex, amount) {
    const n = parseInt(hex.slice(1), 16);
    const ch = (c) => clamp(Math.round(c + amount * (amount > 0 ? 255 - c : c)), 0, 255);
    const r = ch((n >> 16) & 255), g = ch((n >> 8) & 255), b = ch(n & 255);
    return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
  }

  function drawRoom() {
    const { wallLeft, wallRight, floor } = state.colors;
    const B = floorPoint(1, 1);
    const parts = [];

    // Murs
    parts.push(`<polygon points="${pts(L, C, up(C), up(L))}" fill="${wallLeft}"/>`);
    parts.push(`<polygon points="${pts(C, R, up(R), up(C))}" fill="${wallRight}"/>`);

    // Plinthes
    const BASE = 14;
    parts.push(`<polygon points="${pts(L, C, up(C, BASE), up(L, BASE))}" fill="${shade(wallLeft, -0.18)}"/>`);
    parts.push(`<polygon points="${pts(C, R, up(R, BASE), up(C, BASE))}" fill="${shade(wallRight, -0.18)}"/>`);

    // Sol
    parts.push(`<polygon points="${pts(C, R, B, L)}" fill="${floor}"/>`);
    const lineColor = shade(floor, -0.12);
    for (let i = 1; i < TILES; i++) {
      const t = i / TILES;
      const a1 = floorPoint(t, 0), a2 = floorPoint(t, 1);
      const b1 = floorPoint(0, t), b2 = floorPoint(1, t);
      parts.push(`<line x1="${a1.x}" y1="${a1.y}" x2="${a2.x}" y2="${a2.y}" stroke="${lineColor}" stroke-width="1.5"/>`);
      parts.push(`<line x1="${b1.x}" y1="${b1.y}" x2="${b2.x}" y2="${b2.y}" stroke="${lineColor}" stroke-width="1.5"/>`);
    }

    // Épaisseur des murs (tranche du dessus) et du sol
    const T = 16;
    const edge = shade(wallLeft, -0.3);
    parts.push(`<polygon points="${pts(up(L), up(C), { x: up(C).x, y: up(C).y - T / 2 }, { x: up(L).x - T, y: up(L).y - T / 2 })}" fill="${shade(wallLeft, 0.35)}"/>`);
    parts.push(`<polygon points="${pts(up(C), up(R), { x: up(R).x + T, y: up(R).y - T / 2 }, { x: up(C).x, y: up(C).y - T / 2 })}" fill="${shade(wallRight, 0.35)}"/>`);
    parts.push(`<polygon points="${pts(L, { x: L.x - T, y: L.y - T / 2 }, { x: up(L).x - T, y: up(L).y - T / 2 }, up(L))}" fill="${shade(wallLeft, -0.25)}"/>`);
    parts.push(`<polygon points="${pts(R, { x: R.x + T, y: R.y - T / 2 }, { x: up(R).x + T, y: up(R).y - T / 2 }, up(R))}" fill="${shade(wallRight, -0.3)}"/>`);
    const SLAB = 18;
    parts.push(`<polygon points="${pts({ x: L.x - T, y: L.y - T / 2 }, B, { x: B.x, y: B.y + SLAB }, { x: L.x - T, y: L.y - T / 2 + SLAB })}" fill="${shade(floor, -0.25)}"/>`);
    parts.push(`<polygon points="${pts(B, { x: R.x + T, y: R.y - T / 2 }, { x: R.x + T, y: R.y - T / 2 + SLAB }, { x: B.x, y: B.y + SLAB })}" fill="${shade(floor, -0.38)}"/>`);
    parts.push(`<polygon points="${pts({ x: L.x - T, y: L.y - T / 2 }, L, B)}" fill="${floor}"/>`);
    parts.push(`<polygon points="${pts({ x: R.x + T, y: R.y - T / 2 }, R, B)}" fill="${floor}"/>`);

    // Arête du coin
    parts.push(`<line x1="${C.x}" y1="${C.y}" x2="${C.x}" y2="${up(C).y}" stroke="${edge}" stroke-opacity=".35" stroke-width="2"/>`);

    room.innerHTML = parts.join('');
  }

  // ---------------------------------------------------------------------------
  // Mise à l'échelle de la scène
  // ---------------------------------------------------------------------------
  function fitStage() {
    const pad = 24;
    const availW = stageArea.clientWidth - pad * 2;
    const availH = stageArea.clientHeight - pad * 2 - 50; // place pour la barre d'outils
    state.scale = Math.max(0.2, Math.min(availW / STAGE_W, availH / STAGE_H));
    stage.style.transform = `scale(${state.scale})`;
    stageScaler.style.width = STAGE_W * state.scale + 'px';
    stageScaler.style.height = STAGE_H * state.scale + 'px';
  }

  function toStage(clientX, clientY) {
    const r = stage.getBoundingClientRect();
    return { x: (clientX - r.left) / state.scale, y: (clientY - r.top) / state.scale };
  }

  // ---------------------------------------------------------------------------
  // Bibliothèque de stickers
  // ---------------------------------------------------------------------------
  function loadImageEl(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  async function importFiles(files) {
    const list = [...files].filter((f) => f.type.startsWith('image/'));
    for (const file of list) {
      try {
        const srcUrl = URL.createObjectURL(file);
        const img = await loadImageEl(srcUrl);
        let blob = file;
        let w = img.naturalWidth || 200, h = img.naturalHeight || 200;
        if (Math.max(w, h) > IMPORT_MAX_SIZE && file.type !== 'image/svg+xml') {
          const k = IMPORT_MAX_SIZE / Math.max(w, h);
          w = Math.round(w * k); h = Math.round(h * k);
          const cv = document.createElement('canvas');
          cv.width = w; cv.height = h;
          cv.getContext('2d').drawImage(img, 0, 0, w, h);
          blob = await new Promise((res) => cv.toBlob(res, 'image/png'));
        }
        URL.revokeObjectURL(srcUrl);
        const rec = { id: uid(), name: file.name, blob, w, h };
        await db.putImage(rec);
        addImageToLibrary(rec);
      } catch (e) {
        console.warn('Import impossible :', file.name, e);
        toast(`Impossible d'importer « ${file.name} ». Essaie un PNG ou un JPG.`);
      }
    }
    renderLibrary();
  }

  function addImageToLibrary(rec) {
    state.images.set(rec.id, { ...rec, url: URL.createObjectURL(rec.blob) });
  }

  function renderLibrary() {
    libraryGrid.innerHTML = '';
    libraryEmpty.hidden = state.images.size > 0;
    for (const img of state.images.values()) {
      const el = document.createElement('div');
      el.className = 'thumb';
      el.title = img.name;
      el.innerHTML = `<img alt="">`;
      el.querySelector('img').src = img.url;
      const del = document.createElement('button');
      del.className = 'thumb-del';
      del.textContent = '✕';
      del.title = 'Supprimer de la bibliothèque';
      del.addEventListener('pointerdown', (e) => e.stopPropagation());
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        removeImage(img.id);
      });
      el.appendChild(del);
      el.addEventListener('pointerdown', (e) => startSpawnDrag(e, img.id));
      libraryGrid.appendChild(el);
    }
  }

  async function removeImage(id) {
    const used = state.stickers.filter((s) => s.imageId === id).length;
    const msg = used
      ? `Supprimer ce sticker de la bibliothèque ? Il sera aussi retiré ${used} fois de la pièce.`
      : 'Supprimer ce sticker de la bibliothèque ?';
    if (!(await askConfirm(msg, 'Supprimer'))) return;
    const img = state.images.get(id);
    if (img) URL.revokeObjectURL(img.url);
    state.images.delete(id);
    state.stickers = state.stickers.filter((s) => s.imageId !== id);
    if (!state.stickers.some((s) => s.id === state.selectedId)) state.selectedId = null;
    await db.deleteImage(id);
    renderLibrary();
    renderStickers();
    scheduleSave();
  }

  // Glisser un sticker depuis la bibliothèque vers la pièce
  function startSpawnDrag(e, imageId) {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    const img = state.images.get(imageId);
    const startX = e.clientX, startY = e.clientY;
    let ghost = null;

    const move = (ev) => {
      if (!ghost && Math.hypot(ev.clientX - startX, ev.clientY - startY) > 5) {
        ghost = document.createElement('img');
        ghost.className = 'ghost';
        ghost.src = img.url;
        document.body.appendChild(ghost);
      }
      if (ghost) {
        ghost.style.left = ev.clientX + 'px';
        ghost.style.top = ev.clientY + 'px';
      }
    };
    const end = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      if (!ghost) {
        // Simple clic : on pose le sticker au milieu de la pièce
        addSticker(imageId, STAGE_W / 2 + (Math.random() - 0.5) * 80, 430 + (Math.random() - 0.5) * 80);
        return;
      }
      ghost.remove();
      if (ev.type === 'pointercancel') return;
      const r = stageArea.getBoundingClientRect();
      if (ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom) {
        const p = toStage(ev.clientX, ev.clientY);
        addSticker(imageId, clamp(p.x, 0, STAGE_W), clamp(p.y, 0, STAGE_H));
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }

  // ---------------------------------------------------------------------------
  // Stickers posés dans la pièce
  // ---------------------------------------------------------------------------
  function addSticker(imageId, x, y) {
    const img = state.images.get(imageId);
    if (!img) return;
    const k = STICKER_DEFAULT_SIZE / Math.max(img.w, img.h);
    const s = { id: uid(), imageId, x, y, w: img.w * k, h: img.h * k, rot: 0, flip: false };
    state.stickers.push(s); // nouveau sticker devant les autres
    state.selectedId = s.id;
    renderStickers();
    scheduleSave();
  }

  const getSelected = () => state.stickers.find((s) => s.id === state.selectedId) || null;

  function select(id) {
    state.selectedId = id;
    for (const el of layer.children) el.classList.toggle('selected', el.dataset.id === id);
    toolbar.hidden = !id;
  }

  function applyStickerStyle(el, s) {
    el.style.left = s.x - s.w / 2 + 'px';
    el.style.top = s.y - s.h / 2 + 'px';
    el.style.width = s.w + 'px';
    el.style.height = s.h + 'px';
    el.style.transform = `rotate(${s.rot}deg)`;
    el.firstChild.style.transform = s.flip ? 'scaleX(-1)' : '';
  }

  function renderStickers() {
    layer.innerHTML = '';
    state.stickers.forEach((s, i) => {
      const img = state.images.get(s.imageId);
      if (!img) return;
      const el = document.createElement('div');
      el.className = 'sticker';
      el.dataset.id = s.id;
      el.style.zIndex = i + 1;
      el.innerHTML = `<img alt="" draggable="false"><span class="handle handle-rotate" title="Tourner"></span><span class="handle handle-scale" title="Agrandir / réduire"></span>`;
      el.firstChild.src = img.url;
      applyStickerStyle(el, s);
      el.addEventListener('pointerdown', (e) => onStickerPointerDown(e, s, el));
      layer.appendChild(el);
    });
    select(state.selectedId);
  }

  function elFor(id) {
    return layer.querySelector(`.sticker[data-id="${id}"]`);
  }

  function onStickerPointerDown(e, s, el) {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    select(s.id);

    const p0 = toStage(e.clientX, e.clientY);
    const target = e.target;
    let mode = 'move';
    if (target.classList.contains('handle-scale')) mode = 'scale';
    else if (target.classList.contains('handle-rotate')) mode = 'rotate';

    const start = { x: s.x, y: s.y, w: s.w, h: s.h, rot: s.rot };
    const startDist = Math.hypot(p0.x - s.x, p0.y - s.y) || 1;
    el.classList.add('dragging');

    const move = (ev) => {
      const p = toStage(ev.clientX, ev.clientY);
      if (mode === 'move') {
        s.x = clamp(start.x + p.x - p0.x, 0, STAGE_W);
        s.y = clamp(start.y + p.y - p0.y, 0, STAGE_H);
      } else if (mode === 'scale') {
        const k = Math.hypot(p.x - s.x, p.y - s.y) / startDist;
        const kMin = MIN_SIZE / Math.min(start.w, start.h);
        const kk = Math.max(k, kMin);
        s.w = start.w * kk;
        s.h = start.h * kk;
      } else {
        let a = Math.atan2(p.y - s.y, p.x - s.x) * 180 / Math.PI + 90;
        if (ev.shiftKey) a = Math.round(a / 15) * 15;
        s.rot = ((a % 360) + 360) % 360;
      }
      applyStickerStyle(el, s);
    };
    const end = () => {
      el.classList.remove('dragging');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      scheduleSave();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }

  // Molette sur un sticker sélectionné : agrandir / réduire
  stage.addEventListener('wheel', (e) => {
    const s = getSelected();
    if (!s || !e.target.closest('.sticker')) return;
    e.preventDefault();
    const k = e.deltaY < 0 ? 1.06 : 1 / 1.06;
    if (Math.min(s.w, s.h) * k < MIN_SIZE) return;
    s.w *= k; s.h *= k;
    applyStickerStyle(elFor(s.id), s);
    scheduleSave();
  }, { passive: false });

  // Clic dans le vide : désélection
  stageArea.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('.sticker') && !e.target.closest('.toolbar')) select(null);
  });

  // ---------------------------------------------------------------------------
  // Actions (barre d'outils + clavier)
  // ---------------------------------------------------------------------------
  function act(action) {
    const s = getSelected();
    if (!s) return;
    const arr = state.stickers;
    const i = arr.indexOf(s);
    switch (action) {
      case 'front': arr.splice(i, 1); arr.push(s); break;
      case 'back': arr.splice(i, 1); arr.unshift(s); break;
      case 'forward': if (i < arr.length - 1) [arr[i], arr[i + 1]] = [arr[i + 1], arr[i]]; break;
      case 'backward': if (i > 0) [arr[i], arr[i - 1]] = [arr[i - 1], arr[i]]; break;
      case 'flip': s.flip = !s.flip; break;
      case 'duplicate': {
        const copy = { ...s, id: uid(), x: clamp(s.x + 24, 0, STAGE_W), y: clamp(s.y + 24, 0, STAGE_H) };
        arr.splice(i + 1, 0, copy);
        state.selectedId = copy.id;
        break;
      }
      case 'delete': arr.splice(i, 1); state.selectedId = null; break;
      default: return;
    }
    renderStickers();
    scheduleSave();
  }

  toolbar.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (btn) act(btn.dataset.act);
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea')) return;
    const s = getSelected();
    if (!s) return;
    const step = e.shiftKey ? 10 : 2;
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[e.key]) {
      e.preventDefault();
      s.x = clamp(s.x + moves[e.key][0], 0, STAGE_W);
      s.y = clamp(s.y + moves[e.key][1], 0, STAGE_H);
      applyStickerStyle(elFor(s.id), s);
      scheduleSave();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault(); act('delete');
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
      e.preventDefault(); act('duplicate');
    } else if (e.key === 'PageUp') {
      e.preventDefault(); act(e.shiftKey ? 'front' : 'forward');
    } else if (e.key === 'PageDown') {
      e.preventDefault(); act(e.shiftKey ? 'back' : 'backward');
    } else if (e.key.toLowerCase() === 'f') {
      act('flip');
    } else if (e.key === 'Escape') {
      select(null);
    }
  });

  // ---------------------------------------------------------------------------
  // Import par glisser-déposer de fichiers
  // ---------------------------------------------------------------------------
  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    dropOverlay.hidden = false;
  });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) dropOverlay.hidden = true;
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    dropOverlay.hidden = true;
    importFiles(e.dataTransfer.files);
  });

  fileInput.addEventListener('change', () => {
    importFiles(fileInput.files);
    fileInput.value = '';
  });

  // ---------------------------------------------------------------------------
  // Couleurs, vider, exporter
  // ---------------------------------------------------------------------------
  const colorInputs = {
    wallLeft: $('#colorWallLeft'),
    wallRight: $('#colorWallRight'),
    floor: $('#colorFloor'),
  };
  for (const [key, input] of Object.entries(colorInputs)) {
    input.addEventListener('input', () => {
      state.colors[key] = input.value;
      drawRoom();
      scheduleSave();
    });
  }
  function syncColorInputs() {
    for (const [key, input] of Object.entries(colorInputs)) input.value = state.colors[key];
  }

  $('#btnClear').addEventListener('click', async () => {
    if (!state.stickers.length || !(await askConfirm('Retirer tous les stickers de la pièce ?', 'Vider'))) return;
    state.stickers = [];
    state.selectedId = null;
    renderStickers();
    scheduleSave();
  });

  $('#btnExport').addEventListener('click', async () => {
    const K = 2; // export en haute définition
    const cv = document.createElement('canvas');
    cv.width = STAGE_W * K;
    cv.height = STAGE_H * K;
    const ctx = cv.getContext('2d');
    ctx.scale(K, K);
    ctx.fillStyle = getComputedStyle(document.body).backgroundColor;
    ctx.fillRect(0, 0, STAGE_W, STAGE_H);

    const svgText = new XMLSerializer().serializeToString(room);
    const svgUrl = URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml' }));
    try {
      ctx.drawImage(await loadImageEl(svgUrl), 0, 0, STAGE_W, STAGE_H);
    } finally {
      URL.revokeObjectURL(svgUrl);
    }

    for (const s of state.stickers) {
      const img = state.images.get(s.imageId);
      if (!img) continue;
      const el = await loadImageEl(img.url);
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate(s.rot * Math.PI / 180);
      if (s.flip) ctx.scale(-1, 1);
      ctx.shadowColor = 'rgba(0,0,0,.18)';
      ctx.shadowBlur = 3;
      ctx.shadowOffsetY = 4;
      ctx.drawImage(el, -s.w / 2, -s.h / 2, s.w, s.h);
      ctx.restore();
    }

    cv.toBlob((blob) => {
      // On affiche l'image (enregistrable par clic droit / appui long) avec un lien
      // de téléchargement, qui ne marche pas partout (pages intégrées).
      const url = URL.createObjectURL(blob);
      const prev = exportImg.src;
      exportImg.src = url;
      exportLink.href = url;
      exportDialog.hidden = false;
      if (prev.startsWith('blob:')) URL.revokeObjectURL(prev);
    }, 'image/png');
  });

  // ---------------------------------------------------------------------------
  // Démarrage
  // ---------------------------------------------------------------------------
  async function init() {
    fitStage();
    window.addEventListener('resize', fitStage);
    new ResizeObserver(fitStage).observe(stageArea);

    try {
      const [images, saved] = await Promise.all([db.allImages(), db.getState()]);
      (images || []).forEach(addImageToLibrary);
      if (saved) {
        state.colors = { ...DEFAULT_COLORS, ...saved.colors };
        state.stickers = (saved.stickers || []).filter((s) => state.images.has(s.imageId));
      }
    } catch (e) {
      console.warn('Chargement impossible (navigation privée ?)', e);
    }

    syncColorInputs();
    drawRoom();
    renderLibrary();
    renderStickers();
  }

  init();
})();
