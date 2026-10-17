/* Ma petite pièce — décorer des pièces isométriques avec des stickers à collectionner.
 * Écrans : pseudo → mes pièces → décoration, plus la boutique (enveloppes) et
 * l'atelier (réservé à l'administratrice, pour créer les enveloppes).
 * Chaque jour on gagne des points ; une enveloppe achetée donne UN sticker tiré
 * au sort parmi ceux qu'elle contient. Chaque exemplaire obtenu se pose une fois.
 * Tout est rangé dans Firebase, ou dans le navigateur si Firebase manque. */
(() => {
  'use strict';

  // ---------------------------------------------------------------------------
  // Constantes & état
  // ---------------------------------------------------------------------------
  const STAGE_W = 1000;
  const STAGE_H = 760;
  const STICKER_DEFAULT_SIZE = 160; // plus grand côté d'un sticker posé
  const IMPORT_MAX_SIZE = 500;      // les images sont réduites à l'import (taille max en px)
  const IMPORT_MAX_BYTES = 900000;  // un document Firestore est limité à 1 Mo
  const MIN_SIZE = 16;

  // Collection
  const ADMIN_PSEUDOS = ['prunalie'];  // pseudos (en minuscules) qui ont accès à l'atelier
  const DAILY_POINTS = 100;            // points gagnés une fois par jour
  const DEFAULT_PRICE = 50;            // prix d'une nouvelle enveloppe
  const RARITIES = {
    common: { label: 'Commun', weight: 10 },
    rare: { label: 'Rare', weight: 3 },
    epic: { label: 'Très rare', weight: 1 },
  };
  const ENVELOPE_COLORS = ['#e8a0ad', '#9cc5e0', '#b8d8a8', '#f2c879', '#c3a6e0'];

  const DEFAULT_COLORS = {
    wallLeft: '#f4d9c6',
    wallRight: '#ecc8b4',
    floor: '#d7b48f',
  };

  const state = {
    player: null,        // { key, name } : key = pseudo normalisé, sert d'identifiant
    rooms: [],           // pièces du joueur : { id, owner, name, stickers, colors, thumb, updated }
    roomId: null,        // pièce ouverte
    roomName: '',
    profile: null,       // { id, pseudo, points, lastDaily, inventory: { stickerId: nombre } }
    isAdmin: false,
    envelopes: [],       // { id, name, price, color, created }
    images: new Map(),   // catalogue : id -> { id, envelope, rarity, name, data, url, w, h }
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


  // ---------------------------------------------------------------------------
  // Petits dialogues intégrés à la page (alert/confirm sont bloqués dans certains cadres)
  // ---------------------------------------------------------------------------
  const confirmDialog = $('#confirmDialog');
  const exportDialog = $('#exportDialog');
  const exportImg = $('#exportImg');
  const exportLink = $('#exportLink');
  const toastEl = $('#toast');

  // Renvoie true/false, ou le texte saisi (null si annulé) quand `value` est fourni.
  function askDialog(message, okLabel, value) {
    return new Promise((resolve) => {
      const withInput = value !== undefined;
      const input = $('#confirmInput');
      $('#confirmText').textContent = message;
      const ok = $('#confirmOk'), cancel = $('#confirmCancel');
      ok.textContent = okLabel;
      input.hidden = !withInput;
      input.value = withInput ? value : '';
      confirmDialog.hidden = false;
      if (withInput) { input.focus(); input.select(); } else ok.focus();
      const done = (v) => {
        confirmDialog.hidden = true;
        ok.onclick = cancel.onclick = input.onkeydown = null;
        resolve(v);
      };
      ok.onclick = () => done(withInput ? input.value.trim() || null : true);
      cancel.onclick = () => done(withInput ? null : false);
      input.onkeydown = (e) => {
        if (e.key === 'Enter') ok.onclick();
        if (e.key === 'Escape') cancel.onclick();
      };
    });
  }
  const askConfirm = (message, okLabel) => askDialog(message, okLabel);
  const askText = (message, okLabel, value) => askDialog(message, okLabel, value);

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
  // Stockage
  // En ligne : Firebase (configuré dans firebase-config.js), pour retrouver ses
  // stickers sur tous ses appareils. Sinon : IndexedDB du navigateur.
  // ---------------------------------------------------------------------------
  const cloudDb = (() => {
    if (!window.FIREBASE_CONFIG || !window.firebase || !firebase.firestore) return null;
    try {
      if (!firebase.apps.length) firebase.initializeApp(window.FIREBASE_CONFIG);
      const fs = firebase.firestore();
      fs.enablePersistence().catch(() => {});
      const images = fs.collection('ma-petite-piece-stickers');
      const rooms = fs.collection('ma-petite-piece');
      const byOwner = async (col, owner) => {
        // Pas de orderBy ici : il demanderait un index composé dans Firestore.
        const snap = await col.where('owner', '==', owner).get();
        return snap.docs.map((d) => ({ ...d.data(), id: d.id }));
      };
      const clean = (v) => JSON.parse(JSON.stringify(v));
      const all = async (query) => (await query.get()).docs.map((d) => ({ ...d.data(), id: d.id }));
      // Les règles Firestore n'autorisent que deux collections : les pièces, joueurs et
      // enveloppes partagent « ma-petite-piece » (champ type), les stickers l'autre.
      return {
        listCatalog: () => all(images.where('catalog', '==', true)),
        putImage: ({ id, url, ...rec }) => images.doc(id).set(clean(rec)),
        deleteImage: (id) => images.doc(id).delete(),
        listRooms: (owner) => byOwner(rooms, owner),
        putRoom: ({ id, ...room }) => rooms.doc(id).set(clean(room)),
        deleteRoom: (id) => rooms.doc(id).delete(),
        getPlayer: async (id) => {
          const d = await rooms.doc(id).get();
          return d.exists ? { ...d.data(), id } : null;
        },
        putPlayer: ({ id, ...p }) => rooms.doc(id).set(clean({ ...p, type: 'player' })),
        listEnvelopes: () => all(rooms.where('type', '==', 'envelope')),
        putEnvelope: ({ id, ...env }) => rooms.doc(id).set(clean({ ...env, type: 'envelope' })),
        deleteEnvelope: (id) => rooms.doc(id).delete(),
      };
    } catch (e) {
      console.warn('Firebase indisponible', e);
      return null;
    }
  })();

  const localDb = (() => {
    let dbPromise = null;
    const open = () => {
      if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
          const req = indexedDB.open('ma-petite-piece', 3);
          req.onupgradeneeded = () => {
            const d = req.result;
            for (const name of ['images', 'rooms', 'players', 'envelopes']) {
              if (!d.objectStoreNames.contains(name)) d.createObjectStore(name, { keyPath: 'id' });
            }
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
    // Les pièces créées avant l'arrivée des pseudos (sans owner) restent visibles.
    const byOwner = async (store, owner) =>
      ((await run(store, 'readonly', (s) => s.getAll())) || []).filter((r) => !r.owner || r.owner === owner);
    const getAll = async (store) => (await run(store, 'readonly', (s) => s.getAll())) || [];
    return {
      listCatalog: async () => (await getAll('images')).filter((r) => r.catalog),
      putImage: ({ url, ...rec }) => run('images', 'readwrite', (s) => s.put(rec)),
      deleteImage: (id) => run('images', 'readwrite', (s) => s.delete(id)),
      listRooms: (owner) => byOwner('rooms', owner),
      putRoom: (room) => run('rooms', 'readwrite', (s) => s.put(room)),
      deleteRoom: (id) => run('rooms', 'readwrite', (s) => s.delete(id)),
      getPlayer: async (id) => (await run('players', 'readonly', (s) => s.get(id))) || null,
      putPlayer: (p) => run('players', 'readwrite', (s) => s.put(p)),
      listEnvelopes: () => getAll('envelopes'),
      putEnvelope: (env) => run('envelopes', 'readwrite', (s) => s.put(env)),
      deleteEnvelope: (id) => run('envelopes', 'readwrite', (s) => s.delete(id)),
    };
  })();

  let db = cloudDb || localDb;

  let saveTimer = null;
  let savePending = false;
  function scheduleSave() {
    if (!state.roomId) return;
    savePending = true;
    setSaveStatus('…');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveRoom, 700);
  }

  async function saveRoom() {
    clearTimeout(saveTimer);
    if (!savePending || !state.roomId) return;
    savePending = false;
    let thumb = '';
    try {
      const cv = await renderScene(0.3, null);
      thumb = cv.toDataURL('image/webp', 0.8);
      if (!thumb.startsWith('data:image/webp')) thumb = cv.toDataURL('image/png');
    } catch (e) {
      console.warn('Miniature impossible', e);
    }
    const room = {
      id: state.roomId,
      owner: state.player.key,
      name: state.roomName,
      stickers: state.stickers,
      colors: state.colors,
      thumb,
      updated: Date.now(),
    };
    const i = state.rooms.findIndex((r) => r.id === room.id);
    if (i >= 0) state.rooms[i] = { ...room, stickers: [...room.stickers], colors: { ...room.colors } };
    try {
      await db.putRoom(room);
      if (!savePending) setSaveStatus('Sauvegardé ✓');
    } catch (e) {
      console.warn('Sauvegarde impossible', e);
      setSaveStatus('Non sauvegardé');
      toast('La pièce n\'a pas pu être sauvegardée. Vérifie ta connexion.');
    }
  }

  function setSaveStatus(text) {
    $('#saveStatus').textContent = text;
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
    room.innerHTML = roomSvg(state.colors);
  }

  function roomSvg(colors) {
    const { wallLeft, wallRight, floor } = { ...DEFAULT_COLORS, ...colors };
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

    return parts.join('');
  }

  // ---------------------------------------------------------------------------
  // Mise à l'échelle de la scène
  // ---------------------------------------------------------------------------
  function fitStage() {
    if (!stageArea.clientWidth) return; // écran caché
    const small = stageArea.clientWidth < 600;
    const pad = small ? 4 : 24;
    const availW = stageArea.clientWidth - pad * 2;
    const availH = stageArea.clientHeight - pad * 2 - (small ? 70 : 50); // place pour la barre d'outils
    state.baseScale = Math.max(0.1, Math.min(availW / STAGE_W, availH / STAGE_H));
    stageScaler.style.width = STAGE_W * state.baseScale + 'px';
    stageScaler.style.height = STAGE_H * state.baseScale + 'px';
    applyView();
  }

  // Zoom dans la pièce : `zoom` multiplie l'échelle qui fait tenir la pièce à
  // l'écran, (x, y) décale la vue en pixels.
  const ZOOM_MAX = 5;
  const view = { zoom: 1, x: 0, y: 0 };

  function applyView() {
    if (!state.baseScale) return;
    view.zoom = clamp(view.zoom, 1, ZOOM_MAX);
    state.scale = state.baseScale * view.zoom;
    if (view.zoom <= 1.001) {
      view.zoom = 1; view.x = 0; view.y = 0;
    } else {
      // Le centre de la pièce reste toujours dans la zone visible.
      const a = stageArea.getBoundingClientRect();
      const sc = stageScaler.getBoundingClientRect();
      const offX = sc.left - a.left, offY = sc.top - a.top;
      const w = STAGE_W * state.scale, h = STAGE_H * state.scale;
      view.x = clamp(view.x, -offX - w / 2, a.width - offX - w / 2);
      view.y = clamp(view.y, -offY - h / 2, a.height - offY - h / 2);
    }
    stage.style.transform = `translate(${view.x}px, ${view.y}px) scale(${state.scale})`;
    // Les poignées gardent la même taille à l'écran, quel que soit le zoom.
    stage.style.setProperty('--inv', 1 / state.scale);
    stageArea.classList.toggle('zoomed', view.zoom > 1);
    $('#zoomReset').hidden = view.zoom === 1;
  }

  // Zoome en gardant fixe le point de l'écran (clientX, clientY).
  function zoomAt(clientX, clientY, zoom, anchor) {
    const p = anchor || toStage(clientX, clientY);
    view.zoom = clamp(zoom, 1, ZOOM_MAX);
    const s = state.baseScale * view.zoom;
    const sc = stageScaler.getBoundingClientRect();
    view.x = clientX - sc.left - p.x * s;
    view.y = clientY - sc.top - p.y * s;
    applyView();
  }

  function zoomCenter(factor) {
    const a = stageArea.getBoundingClientRect();
    zoomAt(a.left + a.width / 2, a.top + a.height / 2, view.zoom * factor);
  }

  function resetView() {
    view.zoom = 1; view.x = 0; view.y = 0;
    applyView();
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

  // Ajoute des images au catalogue, dans une enveloppe (atelier).
  async function importFiles(files, envelopeId) {
    const list = [...files].filter((f) => f.type.startsWith('image/'));
    for (const file of list) {
      try {
        const srcUrl = URL.createObjectURL(file);
        const img = await loadImageEl(srcUrl);
        URL.revokeObjectURL(srcUrl);
        const { data, w, h } = encodeImage(img);
        const rec = {
          id: uid(), catalog: true, envelope: envelopeId, rarity: 'common',
          name: file.name.replace(/\.[^.]+$/, ''), data, w, h, created: Date.now(),
        };
        await db.putImage(rec);
        addImageToLibrary(rec);
      } catch (e) {
        console.warn('Import impossible :', file.name, e);
        toast(`Impossible d'importer « ${file.name} ». Essaie un PNG ou un JPG.`);
      }
    }
  }

  // Réduit l'image et la transforme en texte (data URL) pour la stocker.
  function encodeImage(img) {
    const nw = img.naturalWidth || 200, nh = img.naturalHeight || 200;
    let max = Math.min(IMPORT_MAX_SIZE, Math.max(nw, nh));
    for (;;) {
      const k = max / Math.max(nw, nh);
      const w = Math.max(1, Math.round(nw * k)), h = Math.max(1, Math.round(nh * k));
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      cv.getContext('2d').drawImage(img, 0, 0, w, h);
      let data = cv.toDataURL('image/webp', 0.9);
      if (!data.startsWith('data:image/webp')) data = cv.toDataURL('image/png');
      if (data.length <= IMPORT_MAX_BYTES || max <= 100) return { data, w, h };
      max = Math.round(max * 0.75);
    }
  }

  function addImageToLibrary(rec) {
    const url = rec.data || (rec.blob ? URL.createObjectURL(rec.blob) : '');
    if (url) state.images.set(rec.id, { ...rec, url });
  }

  // Exemplaires : chaque sticker obtenu se pose une seule fois, toutes pièces confondues.
  const owned = (id) => (state.profile && state.profile.inventory[id]) || 0;
  function usedCount(id) {
    let n = 0;
    for (const r of state.rooms) {
      const list = r.id === state.roomId ? state.stickers : (r.stickers || []);
      for (const st of list) if (st.imageId === id) n++;
    }
    return n;
  }
  const available = (id) => owned(id) - usedCount(id);

  function renderLibrary() {
    libraryGrid.innerHTML = '';
    const mine = [...state.images.values()].filter((img) => owned(img.id) > 0);
    libraryEmpty.hidden = mine.length > 0;
    for (const img of mine) {
      const left = available(img.id);
      const el = document.createElement('div');
      el.className = 'thumb' + (left > 0 ? '' : ' used-up');
      el.dataset.rarity = img.rarity || 'common';
      el.title = `${img.name} : ${left} à poser sur ${owned(img.id)}`;
      el.innerHTML = `<img alt=""><span class="thumb-count"></span>`;
      el.querySelector('img').src = img.url;
      el.querySelector('.thumb-count').textContent = `${Math.max(0, left)}/${owned(img.id)}`;
      el.addEventListener('pointerdown', (e) => startSpawnDrag(e, img.id));
      libraryGrid.appendChild(el);
    }
  }

  // Glisser un sticker depuis la bibliothèque vers la pièce
  function startSpawnDrag(e, imageId) {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    if (available(imageId) <= 0) {
      toast('Tu as déjà posé tous tes exemplaires de ce sticker. Ouvre des enveloppes pour en gagner d\'autres !');
      return;
    }
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
        if (ev.type === 'pointercancel') return; // la bande de stickers a défilé
        // Simple clic : on pose le sticker au milieu de ce qu'on voit de la pièce
        const r = stageArea.getBoundingClientRect();
        const c = view.zoom > 1
          ? toStage(r.left + r.width / 2, r.top + r.height / 2)
          : { x: STAGE_W / 2, y: 430 };
        addSticker(imageId,
          clamp(c.x + (Math.random() - 0.5) * 80 / view.zoom, 0, STAGE_W),
          clamp(c.y + (Math.random() - 0.5) * 80 / view.zoom, 0, STAGE_H));
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
    if (!img || available(imageId) <= 0) return;
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
    renderLibrary();
  }

  function elFor(id) {
    return layer.querySelector(`.sticker[data-id="${id}"]`);
  }

  // Geste en cours sur le sticker sélectionné. Un doigt (ou la souris) déplace
  // le sticker ou agit via une poignée ; un deuxième doigt, posé n'importe où
  // dans la pièce, passe en mode « pincer » : agrandir et tourner à deux doigts.
  let gesture = null;

  function onStickerPointerDown(e, s, el) {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    if (joinPinch(e)) return;
    if (viewGesture) { viewPointerDown(e); return; }
    select(s.id);

    let mode = 'move';
    if (e.target.classList.contains('handle-scale')) mode = 'scale';
    else if (e.target.classList.contains('handle-rotate')) mode = 'rotate';

    gesture = { s, el, mode, pointers: new Map() };
    gesture.pointers.set(e.pointerId, toStage(e.clientX, e.clientY));
    resetGestureStart();
    el.classList.add('dragging');
    window.addEventListener('pointermove', onGestureMove);
    window.addEventListener('pointerup', onGestureEnd);
    window.addEventListener('pointercancel', onGestureEnd);
  }

  // Mémorise l'état de départ pour le mode courant.
  function resetGestureStart() {
    const { s, pointers } = gesture;
    gesture.start = { x: s.x, y: s.y, w: s.w, h: s.h, rot: s.rot };
    const pts = [...pointers.values()];
    if (gesture.mode === 'pinch') {
      const [a, b] = pts;
      gesture.startDist = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      gesture.startAngle = Math.atan2(b.y - a.y, b.x - a.x);
      gesture.startMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    } else {
      gesture.p0 = pts[0];
      gesture.startDist = Math.hypot(pts[0].x - s.x, pts[0].y - s.y) || 1;
    }
  }

  function joinPinch(e) {
    if (!gesture || gesture.pointers.size !== 1 || e.pointerType !== 'touch') return false;
    gesture.pointers.set(e.pointerId, toStage(e.clientX, e.clientY));
    gesture.mode = 'pinch';
    resetGestureStart();
    return true;
  }

  function onGestureMove(ev) {
    if (!gesture || !gesture.pointers.has(ev.pointerId)) return;
    gesture.pointers.set(ev.pointerId, toStage(ev.clientX, ev.clientY));
    const { s, el, mode, start } = gesture;
    const minK = MIN_SIZE / Math.min(start.w, start.h);
    if (mode === 'pinch') {
      const [a, b] = [...gesture.pointers.values()];
      const k = Math.max(Math.hypot(b.x - a.x, b.y - a.y) / gesture.startDist, minK);
      const da = (Math.atan2(b.y - a.y, b.x - a.x) - gesture.startAngle) * 180 / Math.PI;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      s.w = start.w * k;
      s.h = start.h * k;
      s.rot = (((start.rot + da) % 360) + 360) % 360;
      s.x = clamp(start.x + mid.x - gesture.startMid.x, 0, STAGE_W);
      s.y = clamp(start.y + mid.y - gesture.startMid.y, 0, STAGE_H);
    } else {
      const p = gesture.pointers.get(ev.pointerId);
      if (mode === 'move') {
        s.x = clamp(start.x + p.x - gesture.p0.x, 0, STAGE_W);
        s.y = clamp(start.y + p.y - gesture.p0.y, 0, STAGE_H);
      } else if (mode === 'scale') {
        const k = Math.max(Math.hypot(p.x - s.x, p.y - s.y) / gesture.startDist, minK);
        s.w = start.w * k;
        s.h = start.h * k;
      } else {
        let a = Math.atan2(p.y - s.y, p.x - s.x) * 180 / Math.PI + 90;
        if (ev.shiftKey) a = Math.round(a / 15) * 15;
        s.rot = ((a % 360) + 360) % 360;
      }
    }
    applyStickerStyle(el, s);
  }

  function onGestureEnd(ev) {
    if (!gesture || !gesture.pointers.has(ev.pointerId)) return;
    gesture.pointers.delete(ev.pointerId);
    if (gesture.pointers.size) {
      // Un doigt levé pendant le pincement : on continue en déplaçant avec l'autre.
      gesture.mode = 'move';
      resetGestureStart();
      return;
    }
    gesture.el.classList.remove('dragging');
    gesture = null;
    window.removeEventListener('pointermove', onGestureMove);
    window.removeEventListener('pointerup', onGestureEnd);
    window.removeEventListener('pointercancel', onGestureEnd);
    scheduleSave();
  }

  // Molette : sur le sticker sélectionné, agrandir / réduire ; ailleurs, zoomer.
  stageArea.addEventListener('wheel', (e) => {
    if (e.target.closest('.toolbar, .bar-tab, .zoom-ctrl')) return;
    e.preventDefault();
    const s = getSelected();
    const onSelected = s && e.target.closest('.sticker') === elFor(s.id);
    if (!onSelected) {
      zoomAt(e.clientX, e.clientY, view.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12));
      return;
    }
    const k = e.deltaY < 0 ? 1.06 : 1 / 1.06;
    if (Math.min(s.w, s.h) * k < MIN_SIZE) return;
    s.w *= k; s.h *= k;
    applyStickerStyle(elFor(s.id), s);
    scheduleSave();
  }, { passive: false });

  // Dans le vide de la pièce : un appui simple désélectionne, glisser déplace la
  // vue (quand on a zoomé), pincer à deux doigts zoome.
  let viewGesture = null;

  stageArea.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.sticker, .toolbar, .bar-tab, .zoom-ctrl')) return;
    if (e.button !== undefined && e.button !== 0) return;
    if (joinPinch(e)) return;
    viewPointerDown(e);
  });

  function viewPointerDown(e) {
    e.preventDefault();
    const pt = { x: e.clientX, y: e.clientY };
    if (viewGesture) {
      if (viewGesture.pointers.size >= 2) return;
      viewGesture.pointers.set(e.pointerId, pt);
      startViewPinch();
      return;
    }
    viewGesture = { pointers: new Map([[e.pointerId, pt]]), moved: false };
    startViewPan();
    window.addEventListener('pointermove', onViewMove);
    window.addEventListener('pointerup', onViewEnd);
    window.addEventListener('pointercancel', onViewEnd);
  }

  function startViewPan() {
    const [p] = [...viewGesture.pointers.values()];
    viewGesture.mode = 'pan';
    viewGesture.p0 = p;
    viewGesture.start = { x: view.x, y: view.y };
  }

  function startViewPinch() {
    const [a, b] = [...viewGesture.pointers.values()];
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    viewGesture.mode = 'pinch';
    viewGesture.moved = true;
    viewGesture.dist0 = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    viewGesture.zoom0 = view.zoom;
    viewGesture.anchor = toStage(mid.x, mid.y);
  }

  function onViewMove(ev) {
    if (!viewGesture || !viewGesture.pointers.has(ev.pointerId)) return;
    viewGesture.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (viewGesture.mode === 'pinch') {
      const [a, b] = [...viewGesture.pointers.values()];
      const k = Math.hypot(b.x - a.x, b.y - a.y) / viewGesture.dist0;
      zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, viewGesture.zoom0 * k, viewGesture.anchor);
      return;
    }
    const p = viewGesture.pointers.get(ev.pointerId);
    const dx = p.x - viewGesture.p0.x, dy = p.y - viewGesture.p0.y;
    if (!viewGesture.moved && Math.hypot(dx, dy) < 5) return;
    viewGesture.moved = true;
    view.x = viewGesture.start.x + dx;
    view.y = viewGesture.start.y + dy;
    applyView();
  }

  function onViewEnd(ev) {
    if (!viewGesture || !viewGesture.pointers.has(ev.pointerId)) return;
    viewGesture.pointers.delete(ev.pointerId);
    if (viewGesture.pointers.size) {
      startViewPan(); // un doigt levé : on continue à déplacer avec l'autre
      return;
    }
    if (!viewGesture.moved && ev.type === 'pointerup') select(null);
    viewGesture = null;
    window.removeEventListener('pointermove', onViewMove);
    window.removeEventListener('pointerup', onViewEnd);
    window.removeEventListener('pointercancel', onViewEnd);
  }

  $('#zoomIn').addEventListener('click', () => zoomCenter(1.4));
  $('#zoomOut').addEventListener('click', () => zoomCenter(1 / 1.4));
  $('#zoomReset').addEventListener('click', resetView);

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
        if (available(s.imageId) <= 0) {
          toast('Plus d\'exemplaire disponible de ce sticker. Ouvre des enveloppes pour en gagner d\'autres !');
          return;
        }
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

  // Un fichier lâché par erreur sur la page ne doit pas l'ouvrir à la place du jeu.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

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

  function setColor(key, hex) {
    state.colors[key] = hex;
    syncColorInputs();
    drawRoom();
    scheduleSave();
  }

  // Pipette : avec l'outil du navigateur quand il existe (Chrome, Edge sur
  // ordinateur : on peut viser n'importe où à l'écran) ; sinon on touche un
  // endroit de la pièce pour prendre sa couleur.
  let pipetteKey = null;
  const PIPETTE_NAMES = { wallLeft: 'le mur gauche', wallRight: 'le mur droit', floor: 'le sol' };

  document.querySelectorAll('.pipette-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const key = btn.dataset.color;
      if (window.EyeDropper) {
        try {
          const { sRGBHex } = await new window.EyeDropper().open();
          setColor(key, sRGBHex);
        } catch (e) { /* annulé avec Échap */ }
        return;
      }
      pipetteKey = key;
      stageArea.classList.add('pipette');
      toast(`Touche un endroit de la pièce pour prendre sa couleur pour ${PIPETTE_NAMES[key]}.`);
    });
  });

  function stopPipette() {
    pipetteKey = null;
    stageArea.classList.remove('pipette');
  }

  // En mode pipette, le prochain appui dans la pièce lit la couleur au lieu
  // d'agir sur les stickers (écoute en phase de capture, avant tout le reste).
  stageArea.addEventListener('pointerdown', async (e) => {
    if (!pipetteKey) return;
    e.preventDefault();
    e.stopPropagation();
    const key = pipetteKey;
    stopPipette();
    if (e.target.closest('.bar-tab, .zoom-ctrl, .toolbar')) return;
    const p = toStage(e.clientX, e.clientY);
    try {
      const cv = await renderScene(1, null);
      const [r, g, b, a] = cv.getContext('2d').getImageData(Math.round(p.x), Math.round(p.y), 1, 1).data;
      if (a < 20) {
        toast('Il n\'y a pas de couleur à cet endroit. Touche la pièce ou un sticker.');
        return;
      }
      setColor(key, '#' + [r, g, b].map((c) => c.toString(16).padStart(2, '0')).join(''));
    } catch (err) {
      console.warn('Pipette impossible', err);
      toast('Impossible de lire la couleur à cet endroit.');
    }
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && pipetteKey) stopPipette();
  });

  $('#btnClear').addEventListener('click', async () => {
    if (!state.stickers.length || !(await askConfirm('Retirer tous les stickers de la pièce ?', 'Vider'))) return;
    state.stickers = [];
    state.selectedId = null;
    renderStickers();
    scheduleSave();
  });

  // Dessine la pièce et ses stickers dans un canvas (export et miniatures).
  async function renderScene(K, background) {
    const cv = document.createElement('canvas');
    cv.width = Math.round(STAGE_W * K);
    cv.height = Math.round(STAGE_H * K);
    const ctx = cv.getContext('2d');
    ctx.scale(K, K);
    if (background) {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, STAGE_W, STAGE_H);
    }

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
    return cv;
  }

  $('#btnExport').addEventListener('click', async () => {
    // export en haute définition
    const cv = await renderScene(2, getComputedStyle(document.body).backgroundColor);
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
  // Écrans : pseudo → mes pièces → décoration
  // ---------------------------------------------------------------------------
  const screens = {
    start: $('#screenStart'),
    rooms: $('#screenRooms'),
    room: $('#screenRoom'),
    shop: $('#screenShop'),
    atelier: $('#screenAtelier'),
  };
  function showScreen(name) {
    for (const [key, el] of Object.entries(screens)) el.hidden = key !== name;
    if (name === 'room') fitStage();
    // On retient l'écran (et la pièce) pour y revenir après une actualisation.
    if (name !== 'start') store(PLACE_KEY, JSON.stringify({ screen: name, roomId: state.roomId }));
  }

  // Mémorisé dans le navigateur : le dernier pseudo (pré-rempli à l'accueil), la
  // session en cours (pour rester connectée en actualisant) et l'écran ouvert.
  const PSEUDO_KEY = 'ma-petite-piece:pseudo';
  const SESSION_KEY = 'ma-petite-piece:session';
  const PLACE_KEY = 'ma-petite-piece:ecran';
  const store = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* stockage indisponible */ } };
  const read = (k) => { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } };
  const remember = (v) => { store(PSEUDO_KEY, v); store(SESSION_KEY, v); };
  const recall = () => read(PSEUDO_KEY);
  const normalizePseudo = (name) => name.trim().replace(/\s+/g, ' ').toLowerCase();

  // Charge une liste en basculant sur le navigateur si Firebase ne répond pas.
  async function withFallback(fn) {
    try {
      return await fn(db);
    } catch (e) {
      if (db !== cloudDb) throw e;
      console.warn('Firebase indisponible, sauvegarde dans le navigateur', e);
      toast('Sauvegarde en ligne indisponible : tes pièces restent dans ce navigateur.');
      db = localDb;
      return fn(db);
    }
  }

  $('#startForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#pseudoInput').value.trim().replace(/\s+/g, ' ');
    if (name.length < 2) {
      $('#pseudoError').hidden = false;
      return;
    }
    $('#pseudoError').hidden = true;
    const btn = $('#startBtn');
    btn.disabled = true;
    try {
      await login(name);
    } finally {
      btn.disabled = false;
    }
  });

  const playerDocId = (key) => 'player-' + key.replace(/\//g, '_');
  const today = () => new Date().toLocaleDateString('fr-CA'); // AAAA-MM-JJ, heure locale

  async function login(name) {
    state.player = { key: normalizePseudo(name), name };
    state.isAdmin = ADMIN_PSEUDOS.includes(state.player.key);
    remember(name);
    $('#playerName').textContent = name;
    $('#btnAtelier').hidden = !state.isAdmin;
    state.images = new Map();
    let gained = 0;
    try {
      const [images, rooms, envelopes, profile] = await withFallback((d) => Promise.all([
        d.listCatalog(), d.listRooms(state.player.key), d.listEnvelopes(), d.getPlayer(playerDocId(state.player.key)),
      ]));
      images.sort((a, b) => (a.created || 0) - (b.created || 0)).forEach(addImageToLibrary);
      state.rooms = rooms;
      state.envelopes = envelopes.sort((a, b) => (a.created || 0) - (b.created || 0));
      state.profile = profile || {
        id: playerDocId(state.player.key), points: 0, lastDaily: '', inventory: {},
      };
      state.profile.pseudo = name;
      state.profile.inventory = state.profile.inventory || {};
      // Points du jour : une fois par jour, à la première connexion.
      if (state.profile.lastDaily !== today()) {
        state.profile.points = (state.profile.points || 0) + DAILY_POINTS;
        state.profile.lastDaily = today();
        gained = DAILY_POINTS;
        saveProfile();
      }
    } catch (e) {
      console.warn('Chargement impossible', e);
      toast('Impossible de charger tes pièces. Vérifie ta connexion puis recharge la page.');
      state.rooms = [];
      state.profile = state.profile || { id: playerDocId(state.player.key), points: 0, lastDaily: '', inventory: {} };
    }
    renderPoints();
    renderRoomList();
    showScreen('rooms');
    if (gained) toast(`+${gained} ⭐ : tes points du jour ! Va les dépenser dans la boutique.`);
  }

  function saveProfile() {
    return db.putPlayer(state.profile).catch((e) => {
      console.warn('Profil non sauvegardé', e);
      toast('Tes points n\'ont pas pu être enregistrés. Vérifie ta connexion.');
    });
  }

  function renderPoints() {
    const pts = (state.profile && state.profile.points) || 0;
    document.querySelectorAll('.points-pill').forEach((el) => {
      el.textContent = `${pts} ⭐`;
      el.title = `${pts} points`;
    });
  }

  $('#btnChangePseudo').addEventListener('click', () => {
    store(SESSION_KEY, null);
    store(PLACE_KEY, null);
    state.player = null;
    state.profile = null;
    state.isAdmin = false;
    state.rooms = [];
    showScreen('start');
    $('#pseudoInput').focus();
  });

  const dateFmt = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

  function renderRoomList() {
    const grid = $('#roomGrid');
    grid.innerHTML = '';
    const rooms = [...state.rooms].sort((a, b) => (b.updated || 0) - (a.updated || 0));
    $('#roomCount').textContent = rooms.length
      ? `${rooms.length} pièce${rooms.length > 1 ? 's' : ''}`
      : 'Aucune pièce pour l\'instant';

    const add = document.createElement('button');
    add.className = 'room-card room-new';
    add.innerHTML = '<span class="room-new-plus">＋</span><span>Nouvelle pièce</span>';
    add.addEventListener('click', createRoom);
    grid.appendChild(add);

    for (const r of rooms) {
      const card = document.createElement('article');
      card.className = 'room-card';
      const preview = r.thumb
        ? `<img class="room-thumb" alt="">`
        : `<svg class="room-thumb" viewBox="0 0 1000 760" xmlns="http://www.w3.org/2000/svg">${roomSvg(r.colors)}</svg>`;
      card.innerHTML = `
        <button class="room-open" title="Ouvrir">${preview}</button>
        <div class="room-meta">
          <h3 class="room-name"></h3>
          <p class="room-date"></p>
        </div>
        <div class="room-actions">
          <button data-room-act="rename" title="Renommer">✏️</button>
          <button data-room-act="duplicate" title="Dupliquer">⧉</button>
          <button data-room-act="delete" title="Supprimer" class="danger">🗑️</button>
        </div>`;
      if (r.thumb) card.querySelector('img').src = r.thumb;
      card.querySelector('.room-name').textContent = r.name || 'Sans nom';
      const n = (r.stickers || []).length;
      card.querySelector('.room-date').textContent =
        `${n} sticker${n > 1 ? 's' : ''} · ${r.updated ? dateFmt.format(r.updated) : ''}`;
      card.querySelector('.room-open').addEventListener('click', () => openRoom(r.id));
      card.querySelector('.room-actions').addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-room-act]');
        if (btn) roomAction(btn.dataset.roomAct, r);
      });
      grid.appendChild(card);
    }
  }

  function nextRoomName() {
    const names = new Set(state.rooms.map((r) => r.name));
    let i = state.rooms.length + 1;
    while (names.has(`Pièce ${i}`)) i++;
    return `Pièce ${i}`;
  }

  async function createRoom() {
    const name = await askText('Comment s\'appelle cette pièce ?', 'Créer', nextRoomName());
    if (!name) return;
    const r = {
      id: uid(),
      owner: state.player.key,
      name,
      stickers: [],
      colors: { ...DEFAULT_COLORS },
      thumb: '',
      updated: Date.now(),
    };
    state.rooms.push(r);
    try {
      await db.putRoom(r);
    } catch (e) {
      console.warn('Création impossible', e);
      toast('La pièce n\'a pas pu être enregistrée. Vérifie ta connexion.');
    }
    openRoom(r.id);
  }

  async function roomAction(action, r) {
    if (action === 'rename') {
      const name = await askText('Nouveau nom de la pièce :', 'Renommer', r.name);
      if (!name || name === r.name) return;
      r.name = name;
      r.updated = Date.now();
      db.putRoom(r).catch(() => toast('Le nouveau nom n\'a pas pu être enregistré.'));
    } else if (action === 'duplicate') {
      const copy = {
        ...JSON.parse(JSON.stringify(r)),
        id: uid(),
        name: `${r.name} (copie)`,
        stickers: [],
        updated: Date.now(),
      };
      state.rooms.push(copy);
      // Chaque exemplaire ne se pose qu'une fois : on ne recopie que ce qui reste.
      let missing = 0;
      for (const st of r.stickers || []) {
        if (available(st.imageId) > 0) copy.stickers.push({ ...st, id: uid() });
        else missing++;
      }
      if (missing) {
        copy.thumb = '';
        toast(`${missing} sticker${missing > 1 ? 's' : ''} n'${missing > 1 ? 'ont' : 'a'} pas été copié${missing > 1 ? 's' : ''} : tu n'en as plus d'exemplaire libre.`);
      }
      db.putRoom(copy).catch(() => toast('La copie n\'a pas pu être enregistrée.'));
    } else if (action === 'delete') {
      if (!(await askConfirm(`Supprimer « ${r.name} » ? Ses stickers restent dans ta bibliothèque.`, 'Supprimer'))) return;
      state.rooms = state.rooms.filter((x) => x.id !== r.id);
      db.deleteRoom(r.id).catch(() => toast('La pièce n\'a pas pu être supprimée.'));
    }
    renderRoomList();
  }

  function openRoom(id) {
    const r = state.rooms.find((x) => x.id === id);
    if (!r) return;
    state.roomId = r.id;
    state.roomName = r.name;
    view.zoom = 1; view.x = 0; view.y = 0;
    state.colors = { ...DEFAULT_COLORS, ...r.colors };
    state.stickers = (r.stickers || [])
      .filter((s) => state.images.has(s.imageId))
      .map((s) => ({ ...s }));
    state.selectedId = null;
    $('#roomName').value = r.name;
    setSaveStatus('Sauvegardé ✓');
    syncColorInputs();
    drawRoom();
    renderStickers();
    showScreen('room');
  }

  // Barres repliables : la barre du haut et la bibliothèque se cachent chacune
  // avec sa languette, pour laisser toute la place à la pièce.
  const BARS_KEY = 'ma-petite-piece:barres';
  const mqSmall = window.matchMedia('(max-width: 720px)');
  const tabTop = $('#tabTop');
  const tabLib = $('#tabLib');
  const bars = (() => {
    try {
      const saved = JSON.parse(localStorage.getItem(BARS_KEY));
      if (saved) return saved;
    } catch (e) { /* stockage indisponible */ }
    // Par défaut sur téléphone, la barre du haut est cachée.
    return { top: !mqSmall.matches, lib: true };
  })();

  function applyBars() {
    screens.room.classList.toggle('hide-top', !bars.top);
    screens.room.classList.toggle('hide-lib', !bars.lib);
    tabTop.textContent = bars.top ? '▴' : '▾ Menu';
    tabTop.title = bars.top ? 'Cacher la barre du haut' : 'Afficher la barre du haut';
    tabTop.setAttribute('aria-expanded', bars.top);
    if (mqSmall.matches) tabLib.textContent = bars.lib ? '▾' : '▴ Stickers';
    else tabLib.textContent = bars.lib ? '‹' : '› Stickers';
    tabLib.title = bars.lib ? 'Cacher les stickers' : 'Afficher les stickers';
    tabLib.setAttribute('aria-expanded', bars.lib);
    if (!bars.top) roomMenu.classList.remove('open');
  }
  function toggleBar(name) {
    bars[name] = !bars[name];
    try { localStorage.setItem(BARS_KEY, JSON.stringify(bars)); } catch (e) { /* stockage indisponible */ }
    applyBars();
  }
  tabTop.addEventListener('click', () => toggleBar('top'));
  tabLib.addEventListener('click', () => toggleBar('lib'));
  mqSmall.addEventListener('change', applyBars);

  const roomMenu = $('#roomMenu');
  const btnMenu = $('#btnMenu');
  btnMenu.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = !roomMenu.classList.contains('open');
    roomMenu.classList.toggle('open', open);
    btnMenu.setAttribute('aria-expanded', open);
  });
  document.addEventListener('pointerdown', (e) => {
    if (roomMenu.classList.contains('open') && !e.target.closest('#roomMenu, #btnMenu')) {
      roomMenu.classList.remove('open');
      btnMenu.setAttribute('aria-expanded', 'false');
    }
  });
  roomMenu.addEventListener('click', (e) => {
    if (e.target.closest('button')) roomMenu.classList.remove('open');
  });

  $('#roomName').addEventListener('input', (e) => {
    state.roomName = e.target.value.trim() || 'Sans nom';
    scheduleSave();
  });

  $('#btnBack').addEventListener('click', async () => {
    select(null);
    await saveRoom();
    state.roomId = null;
    renderRoomList();
    showScreen('rooms');
  });

  // Sauvegarde ce qui reste en attente si on ferme la page.
  window.addEventListener('pagehide', () => { saveRoom(); });

  // ---------------------------------------------------------------------------
  // Boutique : acheter et ouvrir des enveloppes
  // ---------------------------------------------------------------------------
  const stickersOf = (envId) => [...state.images.values()].filter((img) => img.envelope === envId);
  let shopReturnRoom = null; // pièce à rouvrir en quittant la boutique

  async function openShop(fromRoom) {
    if (fromRoom && state.roomId) {
      select(null);
      await saveRoom();
      shopReturnRoom = state.roomId;
      state.roomId = null;
    } else {
      shopReturnRoom = null;
    }
    renderShop();
    showScreen('shop');
  }

  $('#btnShop').addEventListener('click', () => openShop(false));
  $('#btnLibShop').addEventListener('click', () => openShop(true));
  $('#shopBack').addEventListener('click', () => {
    if (shopReturnRoom && state.rooms.some((r) => r.id === shopReturnRoom)) {
      openRoom(shopReturnRoom);
    } else {
      renderRoomList();
      showScreen('rooms');
    }
  });

  // Petit dessin d'enveloppe, aux couleurs choisies dans l'atelier.
  function envelopeArt(env, cls = '') {
    const el = document.createElement('div');
    el.className = 'env ' + cls;
    el.style.setProperty('--env', env.color || ENVELOPE_COLORS[0]);
    el.innerHTML = '<div class="env-back"></div><div class="env-pocket"></div><div class="env-flap"></div><div class="env-seal">★</div>';
    return el;
  }

  function renderShop() {
    renderPoints();
    const grid = $('#shopGrid');
    grid.innerHTML = '';
    const envs = state.envelopes.filter((env) => stickersOf(env.id).length);
    $('#shopEmpty').hidden = envs.length > 0;
    for (const env of envs) {
      const list = stickersOf(env.id);
      const got = list.filter((img) => owned(img.id) > 0).length;
      const price = env.price ?? DEFAULT_PRICE;
      const card = document.createElement('article');
      card.className = 'shop-card';
      card.innerHTML = `
        <button class="shop-art" title="Voir les stickers de cette enveloppe"></button>
        <h3 class="shop-name"></h3>
        <p class="shop-progress"><span class="bar"><span></span></span><span class="txt"></span></p>
        <button class="btn btn-primary shop-buy"></button>`;
      card.querySelector('.shop-art').appendChild(envelopeArt(env));
      card.querySelector('.shop-name').textContent = env.name || 'Enveloppe';
      card.querySelector('.bar span').style.width = `${(got / list.length) * 100}%`;
      card.querySelector('.txt').textContent = `${got}/${list.length} stickers`;
      const buy = card.querySelector('.shop-buy');
      buy.textContent = `Acheter · ${price} ⭐`;
      buy.disabled = state.profile.points < price;
      card.querySelector('.shop-art').addEventListener('click', () => showEnvelope(env));
      buy.addEventListener('click', () => buyEnvelope(env));
      grid.appendChild(card);
    }
  }

  // Contenu d'une enveloppe : les stickers obtenus, et la silhouette des autres.
  const envDialog = $('#envDialog');
  function showEnvelope(env) {
    const list = stickersOf(env.id);
    $('#envTitle').textContent = env.name || 'Enveloppe';
    const got = list.filter((img) => owned(img.id) > 0).length;
    $('#envSub').textContent = `${got}/${list.length} obtenus · un seul sticker par enveloppe, tiré au sort`;
    const grid = $('#envGrid');
    grid.innerHTML = '';
    const order = { epic: 0, rare: 1, common: 2 };
    for (const img of [...list].sort((a, b) => order[a.rarity || 'common'] - order[b.rarity || 'common'])) {
      const n = owned(img.id);
      const cell = document.createElement('div');
      cell.className = 'env-item' + (n ? '' : ' missing');
      cell.dataset.rarity = img.rarity || 'common';
      cell.innerHTML = '<div class="env-item-img"><img alt=""></div><span class="env-item-name"></span><span class="rarity-tag"></span>';
      cell.querySelector('img').src = img.url;
      cell.querySelector('.env-item-name').textContent = n ? `${img.name} ×${n}` : '???';
      cell.querySelector('.rarity-tag').textContent = RARITIES[img.rarity || 'common'].label;
      grid.appendChild(cell);
    }
    const price = env.price ?? DEFAULT_PRICE;
    const buy = $('#envBuy');
    buy.textContent = `Acheter · ${price} ⭐`;
    buy.disabled = state.profile.points < price;
    buy.onclick = () => { envDialog.hidden = true; buyEnvelope(env); };
    envDialog.hidden = false;
  }
  $('#envClose').addEventListener('click', () => { envDialog.hidden = true; });

  // Tirage pondéré par la rareté.
  function drawSticker(list) {
    const total = list.reduce((sum, img) => sum + RARITIES[img.rarity || 'common'].weight, 0);
    let r = Math.random() * total;
    for (const img of list) {
      r -= RARITIES[img.rarity || 'common'].weight;
      if (r < 0) return img;
    }
    return list[list.length - 1];
  }

  let buying = false;
  async function buyEnvelope(env) {
    if (buying) return;
    const list = stickersOf(env.id);
    const price = env.price ?? DEFAULT_PRICE;
    if (!list.length) return;
    if (state.profile.points < price) {
      toast(`Il te manque ${price - state.profile.points} ⭐ pour cette enveloppe.`);
      return;
    }
    buying = true;
    const pick = drawSticker(list);
    const before = owned(pick.id);
    state.profile.points -= price;
    state.profile.inventory[pick.id] = before + 1;
    renderPoints();
    saveProfile();
    await playOpening(env, pick, before + 1);
    buying = false;
    renderShop();
  }

  // Animation : l'enveloppe tremble, s'ouvre, et le sticker en sort.
  const openDialog = $('#openDialog');
  async function playOpening(env, img, count) {
    const stageEl = $('#openStage');
    stageEl.innerHTML = '';
    const art = envelopeArt(env, 'env-big');
    const sticker = document.createElement('img');
    sticker.className = 'open-sticker';
    sticker.src = img.url;
    sticker.alt = img.name;
    art.appendChild(sticker);
    stageEl.appendChild(art);
    const result = $('#openResult');
    result.hidden = true;
    openDialog.dataset.rarity = img.rarity || 'common';
    openDialog.hidden = false;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const wait = (ms) => new Promise((r) => setTimeout(r, reduced ? 0 : ms));
    art.classList.add('shaking');
    await wait(900);
    art.classList.remove('shaking');
    art.classList.add('opened');
    await wait(700);

    $('#openRarity').textContent = RARITIES[img.rarity || 'common'].label;
    $('#openName').textContent = img.name;
    $('#openText').textContent = count === 1
      ? 'Nouveau sticker pour ta collection !'
      : `Tu en as maintenant ${count} exemplaires.`;
    const price = env.price ?? DEFAULT_PRICE;
    const again = $('#openAgain');
    again.textContent = `Une autre · ${price} ⭐`;
    again.disabled = state.profile.points < price;
    again.onclick = () => { openDialog.hidden = true; buyEnvelope(env); };
    result.hidden = false;
  }
  $('#openClose').addEventListener('click', () => { openDialog.hidden = true; });

  // ---------------------------------------------------------------------------
  // Atelier : créer les enveloppes et leurs stickers (administratrice)
  // ---------------------------------------------------------------------------
  $('#btnAtelier').addEventListener('click', () => {
    if (!state.isAdmin) return;
    renderAtelier();
    showScreen('atelier');
  });
  $('#atelierBack').addEventListener('click', () => {
    renderRoomList();
    showScreen('rooms');
  });
  $('#btnGivePoints').addEventListener('click', () => {
    state.profile.points += 100;
    renderPoints();
    saveProfile();
    toast('+100 ⭐ ajoutés à ton compte.');
  });

  $('#btnNewEnvelope').addEventListener('click', async () => {
    const name = await askText('Nom de la nouvelle enveloppe :', 'Créer', `Enveloppe ${state.envelopes.length + 1}`);
    if (!name) return;
    const env = {
      id: uid(), name, price: DEFAULT_PRICE,
      color: ENVELOPE_COLORS[state.envelopes.length % ENVELOPE_COLORS.length],
      created: Date.now(),
    };
    state.envelopes.push(env);
    db.putEnvelope(env).catch(() => toast('L\'enveloppe n\'a pas pu être enregistrée.'));
    renderAtelier();
  });

  const envSaveTimers = {};
  function saveEnvelopeSoon(env) {
    clearTimeout(envSaveTimers[env.id]);
    envSaveTimers[env.id] = setTimeout(() => {
      db.putEnvelope(env).catch(() => toast('L\'enveloppe n\'a pas pu être enregistrée.'));
    }, 500);
  }

  function renderAtelier() {
    const listEl = $('#atelierList');
    listEl.innerHTML = '';
    $('#atelierEmpty').hidden = state.envelopes.length > 0;
    for (const env of state.envelopes) {
      const sec = document.createElement('section');
      sec.className = 'atelier-env';
      sec.innerHTML = `
        <div class="atelier-head">
          <div class="atelier-art"></div>
          <div class="atelier-fields">
            <label class="atelier-field"><span>Nom</span><input class="field" data-f="name" maxlength="40"></label>
            <label class="atelier-field small"><span>Prix ⭐</span><input class="field" data-f="price" type="number" min="0" step="10"></label>
            <label class="atelier-field small"><span>Couleur</span><input data-f="color" type="color"></label>
          </div>
          <button class="btn btn-ghost atelier-del" title="Supprimer l'enveloppe">🗑️</button>
        </div>
        <p class="atelier-count muted"></p>
        <div class="atelier-grid"></div>
        <label class="btn atelier-add">＋ Ajouter des stickers<input type="file" accept="image/*" multiple hidden></label>`;
      sec.querySelector('.atelier-art').appendChild(envelopeArt(env));
      const fName = sec.querySelector('[data-f="name"]');
      const fPrice = sec.querySelector('[data-f="price"]');
      const fColor = sec.querySelector('[data-f="color"]');
      fName.value = env.name;
      fPrice.value = env.price ?? DEFAULT_PRICE;
      fColor.value = env.color || ENVELOPE_COLORS[0];
      fName.addEventListener('input', () => { env.name = fName.value.trim() || 'Enveloppe'; saveEnvelopeSoon(env); });
      fPrice.addEventListener('input', () => {
        env.price = Math.max(0, Math.round(Number(fPrice.value) || 0));
        saveEnvelopeSoon(env);
      });
      fColor.addEventListener('input', () => {
        env.color = fColor.value;
        sec.querySelector('.env').style.setProperty('--env', env.color);
        saveEnvelopeSoon(env);
      });

      const list = stickersOf(env.id);
      sec.querySelector('.atelier-count').textContent = list.length
        ? `${list.length} sticker${list.length > 1 ? 's' : ''} (conseil : entre 5 et 10). Les « très rares » tombent environ 10 fois moins souvent que les « communs ».`
        : 'Aucun sticker : l\'enveloppe n\'apparaît pas dans la boutique tant qu\'elle est vide.';
      const grid = sec.querySelector('.atelier-grid');
      for (const img of list) {
        const cell = document.createElement('div');
        cell.className = 'atelier-item';
        cell.dataset.rarity = img.rarity || 'common';
        cell.innerHTML = `
          <div class="env-item-img"><img alt=""></div>
          <input class="atelier-name" maxlength="30" aria-label="Nom du sticker">
          <select aria-label="Rareté">${Object.entries(RARITIES).map(([k, r]) => `<option value="${k}">${r.label}</option>`).join('')}</select>
          <button class="atelier-item-del" title="Retirer ce sticker">✕</button>`;
        cell.querySelector('img').src = img.url;
        const nameIn = cell.querySelector('.atelier-name');
        nameIn.value = img.name;
        nameIn.addEventListener('change', () => {
          img.name = nameIn.value.trim() || 'Sticker';
          db.putImage(img).catch(() => toast('Le nom n\'a pas pu être enregistré.'));
        });
        const sel = cell.querySelector('select');
        sel.value = img.rarity || 'common';
        sel.addEventListener('change', () => {
          img.rarity = sel.value;
          cell.dataset.rarity = img.rarity;
          db.putImage(img).catch(() => toast('La rareté n\'a pas pu être enregistrée.'));
        });
        cell.querySelector('.atelier-item-del').addEventListener('click', async () => {
          if (!(await askConfirm(`Retirer « ${img.name} » de l'enveloppe ? Les joueurs qui l'ont déjà le perdront aussi.`, 'Retirer'))) return;
          state.images.delete(img.id);
          db.deleteImage(img.id).catch(() => toast('Le sticker n\'a pas pu être supprimé.'));
          renderAtelier();
        });
        grid.appendChild(cell);
      }

      const fileIn = sec.querySelector('input[type="file"]');
      fileIn.addEventListener('change', async () => {
        const addBtn = sec.querySelector('.atelier-add');
        addBtn.classList.add('busy');
        await importFiles(fileIn.files, env.id);
        fileIn.value = '';
        renderAtelier();
      });

      sec.querySelector('.atelier-del').addEventListener('click', async () => {
        const n = stickersOf(env.id).length;
        const msg = n
          ? `Supprimer « ${env.name} » et ses ${n} stickers ? Les joueurs qui les ont déjà les perdront aussi.`
          : `Supprimer « ${env.name} » ?`;
        if (!(await askConfirm(msg, 'Supprimer'))) return;
        for (const img of stickersOf(env.id)) {
          state.images.delete(img.id);
          db.deleteImage(img.id).catch(() => {});
        }
        state.envelopes = state.envelopes.filter((x) => x.id !== env.id);
        db.deleteEnvelope(env.id).catch(() => toast('L\'enveloppe n\'a pas pu être supprimée.'));
        renderAtelier();
      });
      listEl.appendChild(sec);
    }
  }

  // ---------------------------------------------------------------------------
  // Démarrage
  // ---------------------------------------------------------------------------
  async function init() {
    window.addEventListener('resize', fitStage);
    new ResizeObserver(fitStage).observe(stageArea);
    applyBars();
    $('#pseudoInput').value = recall();
    showScreen('start');

    // Session en cours : on se reconnecte tout seul et on rouvre le même écran.
    const session = read(SESSION_KEY);
    if (!session) {
      $('#pseudoInput').focus();
      return;
    }
    const btn = $('#startBtn');
    btn.disabled = true;
    btn.textContent = 'Connexion…';
    let place = {};
    try { place = JSON.parse(read(PLACE_KEY)) || {}; } catch (e) { /* écran inconnu */ }
    try {
      await login(session);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Jouer';
    }
    if (place.screen === 'room' && state.rooms.some((r) => r.id === place.roomId)) openRoom(place.roomId);
    else if (place.screen === 'shop') openShop(false);
    else if (place.screen === 'atelier' && state.isAdmin) $('#btnAtelier').click();
  }

  init();
})();
