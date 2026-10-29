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
  const ADMIN_PSEUDOS = ['administratrice'];
  const ADMIN_DISPLAY_NAME = 'Admin';     // nom affiché dans le jeu pour ce compte  // pseudos (en minuscules) qui ont accès à l'atelier
  const DAILY_POINTS = 100;            // points gagnés une fois par jour (par défaut ; réglable dans l'atelier)
  const DEFAULT_PRICE = 50;            // prix d'une nouvelle enveloppe
  const MULTI_BUY = 5;                 // nombre d'enveloppes du bouton « ×5 »
  const STAR_PRICE = 1000;              // valeurs par défaut : réglables dans « Paramétrage »
  const PROPOSAL_REWARD = 30;          // pièces proposées par défaut quand un sticker est accepté
  const MAX_PENDING = 30;              // propositions en attente par joueur (par défaut, réglable dans l'atelier)
  const STAMPS_PER_STAR = 10;          // tampons à réunir sur la carte pour gagner une étoile
  const RARITIES = {
    // sell : pièces 🪙 gagnées en revendant un exemplaire
    common: { label: 'Commun', weight: 10, sell: 10 },
    rare: { label: 'Rare', weight: 3, sell: 25 },
    epic: { label: 'Très rare', weight: 1, sell: 60 },
  };
  const ENVELOPE_COLORS = ['#e8a0ad', '#9cc5e0', '#b8d8a8', '#f2c879', '#c3a6e0'];

  const DEFAULT_COLORS = {
    wallLeft: '#f4d9c6',
    wallRight: '#ecc8b4',
    floor: '#d7b48f',
    // background : couleur du fond autour de la pièce (absente = fond de la page)
  };
  const DEFAULT_BACKGROUND = '#f6f0ea';

  const state = {
    player: null,        // { key, name } : key = pseudo normalisé, sert d'identifiant
    rooms: [],           // pièces du joueur : { id, owner, name, stickers, colors, thumb, updated }
    roomId: null,        // pièce ouverte
    roomName: '',
    profile: null,       // { id, pseudo, points, lastDaily, inventory: { stickerId: nombre }, stamps, stars }
    isAdmin: false,
    envelopes: [],       // { id, name, price, color, created }
    settings: { dailyPoints: DAILY_POINTS }, // réglages communs, modifiables par l'administratrice
    mails: [],           // boîte aux lettres : { id, to, title, text, reward, read, claimed, created }
    myProposals: [],     // stickers proposés par le joueur : { id, name, data, status, reward, ... }
    proposals: [],       // coffre (administratrice) : toutes les propositions
    decos: new Map(),    // papiers peints et sols : id -> { id, kind: 'wall' | 'floor', name, collection, price, size, data, url, w, h }
    images: new Map(),   // catalogue : id -> { id, envelope, rarity, name, data, url, w, h }
    stickers: [],        // ordre du tableau = ordre d'empilement (dernier = devant)
    ambient: 100,        // lumière de la pièce, de 5 (nuit) à 100 (jour)
    lights: [],          // points lumineux : { id, sid (sticker), dx, dy (position sur le sticker), color, intensity }
    colors: { ...DEFAULT_COLORS },
    shape: null,         // forme de la pièce ouverte (type, taille, étages)
    selectedId: null,
    scale: 1,
  };

  // ---------------------------------------------------------------------------
  // Paramètres réglables par l'administratrice (écran « Paramétrage »).
  // Chaque valeur est enregistrée dans le document « settings » ; sinon, valeur par défaut.
  // ---------------------------------------------------------------------------
  const SETTINGS = [
    { group: 'Pièces et étoiles', key: 'dailyPoints', label: 'Pièces gagnées chaque jour', unit: '🪙', def: () => DAILY_POINTS, max: 100000, step: 10 },
    { group: 'Pièces et étoiles', key: 'welcomeGift', label: 'Cadeau de bienvenue (nouveau joueur)', unit: '🪙', def: () => 1000, max: 1000000, step: 50 },
    { group: 'Pièces et étoiles', key: 'starPrice', label: 'Prix d\'une étoile', unit: '🪙', def: () => STAR_PRICE, min: 1, max: 1000000, step: 50 },
    { group: 'Pièces et étoiles', key: 'stampsPerStar', label: 'Tampons pour gagner une étoile', unit: 'tampons', def: () => STAMPS_PER_STAR, min: 1, max: 100, step: 1 },
    { group: 'Boutique', key: 'defaultEnvPrice', label: 'Prix d\'une nouvelle enveloppe', unit: '🪙', def: () => DEFAULT_PRICE, max: 100000, step: 10 },
    { group: 'Boutique', key: 'dailyEnvCount', label: 'Enveloppes du jour (prix normal, 0 = toutes)', unit: 'enveloppes', def: () => 5, max: 100, step: 1 },
    { group: 'Boutique', key: 'sundayAllNormal', type: 'bool', label: 'Le dimanche, toutes les enveloppes sont au prix normal', def: () => true },
    { group: 'Boutique', key: 'offPricePct', label: 'Hausse du prix des autres enveloppes', unit: '%', def: () => 100, max: 1000, step: 10 },
    { group: 'Boutique', key: 'packDiscountPct', label: 'Réduction sur le paquet « ×5 » (enveloppes du jour seulement)', unit: '% moins cher', def: () => 0, max: 90, step: 5 },
    { group: 'Boutique', key: 'multiBuy', label: 'Enveloppes du bouton « ×… »', unit: 'enveloppes', def: () => MULTI_BUY, min: 2, max: 50, step: 1 },
    { group: 'Revente des stickers', key: 'sell_common', label: 'Revente d\'un commun', unit: '🪙', def: () => RARITIES.common.sell, max: 100000, step: 5 },
    { group: 'Revente des stickers', key: 'sell_rare', label: 'Revente d\'un rare', unit: '🪙', def: () => RARITIES.rare.sell, max: 100000, step: 5 },
    { group: 'Revente des stickers', key: 'sell_epic', label: 'Revente d\'un très rare', unit: '🪙', def: () => RARITIES.epic.sell, max: 100000, step: 5 },
    { group: 'Propositions de stickers', key: 'proposalReward', label: 'Pièces proposées quand je valide', unit: '🪙', def: () => PROPOSAL_REWARD, max: 100000, step: 10 },
    { group: 'Propositions de stickers', key: 'proposalGiveSticker', type: 'bool', label: 'Offrir aussi le sticker (1 exemplaire) au joueur qui l\'a proposé', def: () => true },
    { group: 'Propositions de stickers', key: 'maxPending', label: 'Propositions en attente par joueur', unit: 'au plus', def: () => MAX_PENDING, min: 1, max: 1000, step: 1 },
    { group: 'Options d\'aménagement (en étoiles)', key: 'unlock_garden', label: '🌳 Jardin', unit: '🌟', def: () => 2, max: 100, step: 1 },
    { group: 'Options d\'aménagement (en étoiles)', key: 'unlock_size', label: '📐 Taille sur mesure', unit: '🌟', def: () => 1, max: 100, step: 1 },
    { group: 'Options d\'aménagement (en étoiles)', key: 'unlock_levels', label: '🏢 Étages', unit: '🌟', def: () => 2, max: 100, step: 1 },
    { group: 'Concours', key: 'contestReward', label: 'Récompense du gagnant', unit: '🪙', def: () => 200, max: 100000, step: 10 },
    { group: 'Concours', key: 'contestSoloReward', label: 'Gagnant d\'office (une seule pièce)', unit: '🪙', def: () => Math.round(setting('contestReward') / 2), max: 100000, step: 10 },
    { group: 'Concours', key: 'contestJoinReward', label: 'Pour avoir participé (une fois par jour, à la première publication)', unit: '🪙', def: () => 50, max: 100000, step: 5 },
    { group: 'Concours', key: 'voteReward', label: 'Pour avoir fini ses duels', unit: '🪙', def: () => 20, max: 100000, step: 5 },
    { group: 'Concours', key: 'duelsMax', label: 'Duels par joueur et par jour', unit: 'au plus', def: () => 10, min: 1, max: 100, step: 1 },
  ];
  const SETTING_BY_KEY = Object.fromEntries(SETTINGS.map((x) => [x.key, x]));
  function setting(key) {
    const def = SETTING_BY_KEY[key];
    const raw = state.settings[key];
    if (def.type === 'bool') return raw === undefined || raw === null ? def.def() : !!raw;
    const n = Math.round(Number(raw));
    if (raw === undefined || raw === null || raw === '' || !Number.isFinite(n)) return def.def();
    return Math.max(def.min ?? 0, n);
  }
  const starPrice = () => setting('starPrice');
  const stampsPerStar = () => setting('stampsPerStar');
  const multiBuy = () => setting('multiBuy');
  const proposalReward = () => setting('proposalReward');


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
  function askDialog(message, okLabel, value, danger = false) {
    return new Promise((resolve) => {
      $('#confirmOk').classList.toggle('btn-danger', danger);
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
        ok.classList.remove('btn-danger');
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
        // Papiers peints et sols (en test chez l'administratrice)
        listDecos: () => all(images.where('deco', '==', true)),
        putImage: ({ id, url, ...rec }) => images.doc(id).set(clean(rec)),
        deleteImage: (id) => images.doc(id).delete(),
        // Les participations au concours ont aussi un « owner » : ce ne sont pas des pièces.
        listRooms: async (owner) => (await byOwner(rooms, owner)).filter((r) => r.type !== 'contest'),
        putRoom: ({ id, ...room }) => rooms.doc(id).set(clean(room)),
        deleteRoom: (id) => rooms.doc(id).delete(),
        getPlayer: async (id) => {
          const d = await rooms.doc(id).get();
          return d.exists ? { ...d.data(), id } : null;
        },
        putPlayer: ({ id, ...p }) => rooms.doc(id).set(clean({ ...p, type: 'player' })),
        deletePlayer: (id) => rooms.doc(id).delete(),
        listEnvelopes: () => all(rooms.where('type', '==', 'envelope')),
        putEnvelope: ({ id, ...env }) => rooms.doc(id).set(clean({ ...env, type: 'envelope' })),
        deleteEnvelope: (id) => rooms.doc(id).delete(),
        // Propositions de stickers des joueurs (dans la collection des stickers, proposal: true)
        listMyProposals: async (owner) => (await all(images.where('owner', '==', owner))).filter((r) => r.proposal),
        listProposals: () => all(images.where('proposal', '==', true)),
        // Seulement celles en attente : bien plus léger que toutes les propositions (avec leurs images).
        listPendingProposals: () => all(images.where('proposal', '==', true).where('status', '==', 'pending')),
        // Change quelques champs sans renvoyer l'image.
        updateImage: (id, fields) => images.doc(id).set(clean(fields), { merge: true }),
        // Boîte aux lettres : messages (type « mail ») adressés à un pseudo
        listMail: (to) => all(rooms.where('to', '==', to)),
        listPlayers: () => all(rooms.where('type', '==', 'player')),
        getSettings: async () => {
          const d = await rooms.doc('settings').get();
          return d.exists ? d.data() : null;
        },
        putSettings: (st) => rooms.doc('settings').set(clean({ ...st, type: 'settings' })),
        putMail: ({ id, ...m }) => rooms.doc(id).set(clean({ ...m, type: 'mail' })),
        deleteMail: (id) => rooms.doc(id).delete(),
        // On ne touche qu'au champ « lu » (sinon une vieille copie pourrait effacer « récupéré »).
        markMailRead: (id) => rooms.doc(id).set({ read: true }, { merge: true }),
        // Récupérer un cadeau une seule fois, même avec le jeu ouvert sur deux appareils.
        // Crée le message seulement s'il n'existe pas déjà (pas de récompense en double).
        createMail: ({ id, ...m }) => fs.runTransaction(async (tx) => {
          const ref = rooms.doc(id);
          const d = await tx.get(ref);
          if (d.exists) return false;
          tx.set(ref, clean({ ...m, type: 'mail' }));
          return true;
        }),
        claimMail: (id) => fs.runTransaction(async (tx) => {
          const ref = rooms.doc(id);
          const d = await tx.get(ref);
          if (!d.exists || d.data().claimed) return false;
          tx.set(ref, { claimed: true, read: true }, { merge: true });
          return true;
        }),
        // Nouveautés écrites par l'administratrice (type « news »)
        listNews: () => all(rooms.where('type', '==', 'news')),
        putNews: ({ id, ...n }) => rooms.doc(id).set(clean({ ...n, type: 'news' })),
        deleteNews: (id) => rooms.doc(id).delete(),
        // Concours du jour : participations et votes d'un jour donné (champ contestDay)
        listContest: (day) => all(rooms.where('contestDay', '==', day)),
        putContest: ({ id, ...c }) => rooms.doc(id).set(clean({ ...c, type: 'contest' })),
        deleteContest: (id) => rooms.doc(id).delete(),
        // Toutes les participations d'un joueur, tous jours confondus
        listAllEntries: async () => (await all(rooms.where('type', '==', 'contest'))).filter((c) => c.kind === 'entry'),
        listMyContest: async (owner) => (await all(rooms.where('owner', '==', owner))).filter((c) => c.type === 'contest' && c.kind === 'entry'),
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
          const req = indexedDB.open('ma-petite-piece', 7);
          req.onupgradeneeded = () => {
            const d = req.result;
            for (const name of ['images', 'rooms', 'players', 'envelopes', 'mails', 'settings', 'news', 'contest']) {
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
      listDecos: async () => (await getAll('images')).filter((r) => r.deco),
      putImage: ({ url, ...rec }) => run('images', 'readwrite', (s) => s.put(rec)),
      deleteImage: (id) => run('images', 'readwrite', (s) => s.delete(id)),
      listRooms: (owner) => byOwner('rooms', owner),
      putRoom: (room) => run('rooms', 'readwrite', (s) => s.put(room)),
      deleteRoom: (id) => run('rooms', 'readwrite', (s) => s.delete(id)),
      getPlayer: async (id) => (await run('players', 'readonly', (s) => s.get(id))) || null,
      putPlayer: (p) => run('players', 'readwrite', (s) => s.put(p)),
      deletePlayer: (id) => run('players', 'readwrite', (s) => s.delete(id)),
      listEnvelopes: () => getAll('envelopes'),
      putEnvelope: (env) => run('envelopes', 'readwrite', (s) => s.put(env)),
      deleteEnvelope: (id) => run('envelopes', 'readwrite', (s) => s.delete(id)),
      listMyProposals: async (owner) => (await getAll('images')).filter((r) => r.proposal && r.owner === owner),
      listProposals: async () => (await getAll('images')).filter((r) => r.proposal),
      listPendingProposals: async () => (await getAll('images')).filter((r) => r.proposal && r.status === 'pending'),
      updateImage: async (id, fields) => {
        const all = await getAll('images');
        const cur = all.find((r) => r.id === id);
        if (cur) await run('images', 'readwrite', (s) => s.put({ ...cur, ...fields }));
      },
      listMail: async (to) => (await getAll('mails')).filter((m) => m.to === to),
      listPlayers: () => getAll('players'),
      getSettings: async () => (await run('settings', 'readonly', (s) => s.get('settings'))) || null,
      putSettings: (st) => run('settings', 'readwrite', (s) => s.put({ ...st, id: 'settings' })),
      putMail: (m) => run('mails', 'readwrite', (s) => s.put(m)),
      deleteMail: (id) => run('mails', 'readwrite', (s) => s.delete(id)),
      markMailRead: async (id) => {
        const m = await run('mails', 'readonly', (s) => s.get(id));
        if (m && !m.read) await run('mails', 'readwrite', (s) => s.put({ ...m, read: true }));
      },
      createMail: async (m) => {
        if (await run('mails', 'readonly', (s) => s.get(m.id))) return false;
        await run('mails', 'readwrite', (s) => s.put(m));
        return true;
      },
      claimMail: async (id) => {
        const m = await run('mails', 'readonly', (s) => s.get(id));
        if (!m || m.claimed) return false;
        await run('mails', 'readwrite', (s) => s.put({ ...m, claimed: true, read: true }));
        return true;
      },
      listNews: () => getAll('news'),
      putNews: (n) => run('news', 'readwrite', (s) => s.put(n)),
      deleteNews: (id) => run('news', 'readwrite', (s) => s.delete(id)),
      listContest: async (day) => (await getAll('contest')).filter((c) => c.contestDay === day),
      putContest: (c) => run('contest', 'readwrite', (s) => s.put(c)),
      deleteContest: (id) => run('contest', 'readwrite', (s) => s.delete(id)),
      listAllEntries: async () => (await getAll('contest')).filter((c) => c.kind === 'entry'),
      listMyContest: async (owner) => (await getAll('contest')).filter((c) => c.kind === 'entry' && c.owner === owner),
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
      const cv = await renderScene(0.3, state.colors.background || null);
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
      shape: state.shape,
      ...(currentRoom() && currentRoom().contestDay ? { contestDay: currentRoom().contestDay } : {}),
      ...(currentRoom() && currentRoom().publishedAt ? { publishedAt: currentRoom().publishedAt } : {}),
      ...(state.ambient < 100 ? { ambient: state.ambient } : {}),
      ...(state.lights.length ? { lights: state.lights.map((l) => ({ ...l })) } : {}),
      thumb,
      updated: Date.now(),
    };
    const i = state.rooms.findIndex((r) => r.id === room.id);
    if (i >= 0) state.rooms[i] = { ...room, stickers: [...room.stickers], colors: { ...room.colors }, shape: JSON.parse(JSON.stringify(room.shape)), ...(room.lights ? { lights: room.lights.map((l) => ({ ...l })) } : {}) };
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
  // Forme de la pièce : type (pièce ou jardin), taille en carreaux, hauteur des murs,
  // et étages (niveaux surélevés collés au coin du fond, chacun posé sur le précédent).
  const DEFAULT_SHAPE = { kind: 'room', w: 8, d: 8, h: 5, levels: [] };
  const SIZE_MIN = 3, SIZE_MAX = 16, WALL_MIN = 2, WALL_MAX = 10, LEVELS_MAX = 3;
  const GARDEN_COLORS = { wallLeft: '#86b86b', wallRight: '#74a85b', floor: '#9fd07f', background: '#d4ecf7' };

  function normShape(sh) {
    const s = { ...DEFAULT_SHAPE, ...(sh || {}) };
    s.kind = s.kind === 'garden' ? 'garden' : 'room';
    s.w = clamp(Math.round(s.w), SIZE_MIN, SIZE_MAX);
    s.d = clamp(Math.round(s.d), SIZE_MIN, SIZE_MAX);
    s.h = clamp(Math.round(s.h), WALL_MIN, WALL_MAX);
    let pw = s.w, pd = s.d;
    s.levels = (Array.isArray(s.levels) ? s.levels : []).slice(0, LEVELS_MAX).map((lv) => {
      const l = { w: clamp(Math.round(lv.w || 1), 1, pw), d: clamp(Math.round(lv.d || 1), 1, pd), h: clamp(Math.round(lv.h || 1), 1, 4) };
      pw = l.w; pd = l.d;
      return l;
    });
    return s;
  }

  // Géométrie : la pièce est mise à l'échelle et centrée dans la scène (1000 × 760).
  // Avec la forme par défaut, on retrouve exactement la pièce d'origine.
  const TILE_X = 52.5, TILE_Y = 26.25, TILE_Z = 60;
  function roomGeom(shape) {
    const sh = normShape(shape);
    const garden = sh.kind === 'garden';
    const levelsH = sh.levels.reduce((a, l) => a + l.h, 0);
    // Les murs dépassent toujours un peu du dernier étage.
    const wallTiles = garden ? Math.max(1.2, levelsH + 1.2) : Math.max(sh.h, levelsH + 2);
    const span = sh.w + sh.d;
    const k = Math.min(1, 840 / (span * TILE_X), 738 / (wallTiles * TILE_Z + span * TILE_Y + 18));
    const wallPx = wallTiles * TILE_Z * k;
    const C = {
      x: 500 + ((sh.d - sh.w) * TILE_X * k) / 2,
      y: 399 + (wallPx - span * TILE_Y * k - 18) / 2,
    };
    const P = (u, v, z = 0) => ({
      x: C.x + (u - v) * TILE_X * k,
      y: C.y + (u + v) * TILE_Y * k - z * TILE_Z * k,
    });
    return { sh, k, C, P, wallPx, wallTiles, garden };
  }

  const pts = (...ps) => ps.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

  function shade(hex, amount) {
    const n = parseInt(hex.slice(1), 16);
    const ch = (c) => clamp(Math.round(c + amount * (amount > 0 ? 255 - c : c)), 0, 255);
    const r = ch((n >> 16) & 255), g = ch((n >> 8) & 255), b = ch(n & 255);
    return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
  }

  function drawRoom() {
    room.innerHTML = roomSvg(state.colors, state.shape);
    // Couleurs des étages : seulement quand la pièce en a.
    const hasLevels = !!(state.shape && state.shape.levels.length);
    document.querySelectorAll('.level-color').forEach((el) => { el.hidden = !hasLevels; });
    if (hasLevels) syncColorInputs();
    stageArea.style.background = state.colors.background || '';
  }

  // Quadrillage (ou herbe pour un jardin) d'un sol rectangulaire à la hauteur z.
  function floorPattern(parts, P, w, d, z, floor, garden, k) {
    if (garden) {
      // Petites touffes d'herbe, placées toujours au même endroit.
      const tuft = shade(floor, -0.18);
      for (let u = 0; u < w; u++) {
        for (let v = 0; v < d; v++) {
          const seed = (u * 73 + v * 37 + z * 11) % 10;
          const p = P(u + 0.25 + seed / 20, v + 0.3 + ((seed * 7) % 10) / 20, z);
          const s = 5 * k;
          parts.push(`<path d="M${(p.x - s).toFixed(1)},${p.y.toFixed(1)} l${s.toFixed(1)},${(-2 * s).toFixed(1)} l${s.toFixed(1)},${(2 * s).toFixed(1)}" fill="none" stroke="${tuft}" stroke-width="${(1.6 * k).toFixed(2)}" stroke-linecap="round"/>`);
        }
      }
      return;
    }
    const lineColor = shade(floor, -0.12);
    const line = (a, b) => parts.push(`<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="${lineColor}" stroke-width="1.5"/>`);
    for (let i = 1; i < w; i++) line(P(i, 0, z), P(i, d, z));
    for (let j = 1; j < d; j++) line(P(0, j, z), P(w, j, z));
  }

  // Couleurs des étages : choisies par le joueur, sinon tirées du sol.
  function levelColors(colors, shape) {
    const garden = normShape(shape).kind === 'garden';
    const base = { ...(garden ? GARDEN_COLORS : DEFAULT_COLORS), ...colors };
    const side = garden ? '#a07a55' : base.floor;
    return {
      levelLeft: colors.levelLeft || shade(side, -0.25),
      levelRight: colors.levelRight || shade(side, -0.38),
      levelFloor: colors.levelFloor || shade(base.floor, 0.08),
    };
  }

  // Papier peint / sol : un motif plat (carré qui se répète) plaqué sur le plan du mur ou du sol.
  let decoSeq = 0;
  const DECO_VK = 1.0717; // 1 carreau de hauteur du motif = 1 carreau de large (la hauteur d'un carreau de pièce est un peu plus courte)
  function roomSvg(colors, shape) {
    const g = roomGeom(shape);
    const { sh, k, P, garden } = g;
    const base = garden ? { ...GARDEN_COLORS } : { ...DEFAULT_COLORS };
    const { wallLeft, wallRight, floor } = { ...base, ...colors };
    const defs = [];
    const decoFor = (key) => {
      const d = !garden && colors && colors[key] ? state.decos.get(colors[key]) : null;
      return d && d.w && d.h ? d : null;
    };
    // along : vecteur écran d'un carreau vers la droite du motif ; down : vers le bas du motif.
    const texture = (d, along, down, origin) => {
      const id = `deco${++decoSeq}`;
      const wu = Math.max(0.5, Math.min(12, Number(d.size) || 2)), hu = wu * d.h / d.w;
      const m = [along.x * wu / d.w, along.y * wu / d.w, down.x * hu / d.h, down.y * hu / d.h, origin.x, origin.y].map((n) => n.toFixed(5)).join(' ');
      defs.push(`<pattern id="${id}" patternUnits="userSpaceOnUse" x="0" y="0" width="${d.w}" height="${d.h}" patternTransform="matrix(${m})"><image href="${d.data}" width="${d.w}" height="${d.h}" preserveAspectRatio="none"/></pattern>`);
      return `url(#${id})`;
    };
    const decoWL = decoFor('wallLeftDeco'), decoWR = decoFor('wallRightDeco'), decoF = decoFor('floorDeco');
    const W = sh.w, D = sh.d, Z = g.wallTiles;
    const C = P(0, 0), R = P(W, 0), L = P(0, D), B = P(W, D);
    const up = (p) => ({ x: p.x, y: p.y - g.wallPx });
    const off = (p, dx, dy) => ({ x: p.x + dx, y: p.y + dy });
    const T = 16 * Math.max(k, 0.5);
    const parts = [];

    // Murs (ou haies pour un jardin)
    const wallDown = { x: 0, y: TILE_Z * k * DECO_VK };
    const fillWL = decoWL ? texture(decoWL, { x: -TILE_X * k, y: TILE_Y * k }, wallDown, up(C)) : wallLeft;
    const fillWR = decoWR ? texture(decoWR, { x: TILE_X * k, y: TILE_Y * k }, wallDown, up(C)) : wallRight;
    parts.push(`<polygon points="${pts(L, C, up(C), up(L))}" fill="${fillWL}"/>`);
    parts.push(`<polygon points="${pts(C, R, up(R), up(C))}" fill="${fillWR}"/>`);
    if (garden) {
      // Feuillage : quelques bosses sur le haut des haies.
      const bumps = (a, b, n, fill) => {
        for (let i = 0; i < n; i++) {
          const t = (i + 0.5) / n;
          const c = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t - g.wallPx };
          parts.push(`<ellipse cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" rx="${(30 * k).toFixed(1)}" ry="${(14 * k).toFixed(1)}" fill="${fill}"/>`);
        }
      };
      bumps(L, C, D, shade(wallLeft, 0.12));
      bumps(C, R, W, shade(wallRight, 0.12));
    } else {
      // Plinthes
      const BASE = 14 * Math.max(k, 0.5);
      parts.push(`<polygon points="${pts(L, C, off(C, 0, -BASE), off(L, 0, -BASE))}" fill="${shade(wallLeft, -0.18)}"/>`);
      parts.push(`<polygon points="${pts(C, R, off(R, 0, -BASE), off(C, 0, -BASE))}" fill="${shade(wallRight, -0.18)}"/>`);
    }

    // Arête du coin
    if (!garden) parts.push(`<line x1="${C.x.toFixed(1)}" y1="${C.y.toFixed(1)}" x2="${C.x.toFixed(1)}" y2="${up(C).y.toFixed(1)}" stroke="${shade(wallLeft, -0.3)}" stroke-opacity=".35" stroke-width="2"/>`);

    // Sol
    const fillF = decoF ? texture(decoF, { x: TILE_X * k, y: TILE_Y * k }, { x: -TILE_X * k, y: TILE_Y * k }, C) : floor;
    parts.push(`<polygon points="${pts(C, R, B, L)}" fill="${fillF}"/>`);
    if (!decoF) floorPattern(parts, P, W, D, 0, floor, garden, k);

    // Étages : chacun est un bloc collé au coin du fond, posé sur le précédent.
    let z = 0;
    sh.levels.forEach((lv) => {
      const z1 = z + lv.h;
      const lc = levelColors(colors || {}, shape);
      const top = lc.levelFloor;
      // Face avant gauche (côté v = d) et face avant droite (côté u = w).
      parts.push(`<polygon points="${pts(P(0, lv.d, z), P(lv.w, lv.d, z), P(lv.w, lv.d, z1), P(0, lv.d, z1))}" fill="${lc.levelLeft}"/>`);
      parts.push(`<polygon points="${pts(P(lv.w, 0, z), P(lv.w, lv.d, z), P(lv.w, lv.d, z1), P(lv.w, 0, z1))}" fill="${lc.levelRight}"/>`);
      parts.push(`<polygon points="${pts(P(0, 0, z1), P(lv.w, 0, z1), P(lv.w, lv.d, z1), P(0, lv.d, z1))}" fill="${top}"/>`);
      floorPattern(parts, P, lv.w, lv.d, z1, top, garden, k);
      // Petite bordure sur l'arête avant.
      parts.push(`<polyline points="${pts(P(0, lv.d, z1), P(lv.w, lv.d, z1), P(lv.w, 0, z1))}" fill="none" stroke="${shade(top, -0.45)}" stroke-opacity=".5" stroke-width="2"/>`);
      z = z1;
    });

    // Épaisseur des murs (tranche du dessus) et du sol
    if (!garden) {
      parts.push(`<polygon points="${pts(up(L), up(C), off(up(C), 0, -T / 2), off(up(L), -T, -T / 2))}" fill="${shade(wallLeft, 0.35)}"/>`);
      parts.push(`<polygon points="${pts(up(C), up(R), off(up(R), T, -T / 2), off(up(C), 0, -T / 2))}" fill="${shade(wallRight, 0.35)}"/>`);
    }
    parts.push(`<polygon points="${pts(L, off(L, -T, -T / 2), off(up(L), -T, -T / 2), up(L))}" fill="${shade(wallLeft, -0.25)}"/>`);
    parts.push(`<polygon points="${pts(R, off(R, T, -T / 2), off(up(R), T, -T / 2), up(R))}" fill="${shade(wallRight, -0.3)}"/>`);
    const SLAB = 18 * Math.max(k, 0.5);
    const slabColor = garden ? '#9b7653' : floor;
    const LT = off(L, -T, -T / 2), RT = off(R, T, -T / 2);
    parts.push(`<polygon points="${pts(LT, B, off(B, 0, SLAB), off(LT, 0, SLAB))}" fill="${shade(slabColor, -0.25)}"/>`);
    parts.push(`<polygon points="${pts(B, RT, off(RT, 0, SLAB), off(B, 0, SLAB))}" fill="${shade(slabColor, -0.38)}"/>`);
    parts.push(`<polygon points="${pts(LT, L, B)}" fill="${floor}"/>`);
    parts.push(`<polygon points="${pts(RT, R, B)}" fill="${floor}"/>`);


    return (defs.length ? `<defs>${defs.join('')}</defs>` : '') + parts.join('');
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
  const PAN_MARGIN = 40; // marge (en px de scène) au-delà des bords de la pièce
  const view = { zoom: 1, x: 0, y: 0 };

  function applyView() {
    if (!state.baseScale) return;
    view.zoom = clamp(view.zoom, 1, ZOOM_MAX);
    state.scale = state.baseScale * view.zoom;
    if (view.zoom <= 1.001) {
      view.zoom = 1; view.x = 0; view.y = 0;
    } else {
      // On peut amener n'importe quel point de la pièce (bords compris, avec un peu de marge)
      // au milieu de l'écran : on peut donc se déplacer partout, même zoomé à fond.
      const a = stageArea.getBoundingClientRect();
      const sc = stageScaler.getBoundingClientRect();
      const offX = sc.left - a.left, offY = sc.top - a.top;
      const s = state.scale, m = PAN_MARGIN;
      view.x = clamp(view.x, a.width / 2 - offX - (STAGE_W + m) * s, a.width / 2 - offX + m * s);
      view.y = clamp(view.y, a.height / 2 - offY - (STAGE_H + m) * s, a.height / 2 - offY + m * s);
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

  // Télécharge une image (en PNG, plus simple à retoucher) sous le nom donné.
  async function downloadImage(src, name) {
    try {
      const el = await loadImageEl(src);
      const cv = document.createElement('canvas');
      cv.width = el.naturalWidth; cv.height = el.naturalHeight;
      cv.getContext('2d').drawImage(el, 0, 0);
      const blob = await new Promise((resolve) => cv.toBlob(resolve, 'image/png'));
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = (name || 'sticker').replace(/[\\/:*?"<>|]+/g, '-').trim() + '.png';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (e) {
      console.warn('Téléchargement impossible', e);
      toast('L\'image n\'a pas pu être téléchargée.');
    }
  }

  function addDeco(rec) {
    if (rec.data) state.decos.set(rec.id, { ...rec, url: rec.data });
  }

  function addImageToLibrary(rec) {
    const url = rec.data || (rec.blob ? URL.createObjectURL(rec.blob) : '');
    if (url) state.images.set(rec.id, { ...rec, url });
  }

  // Exemplaires : chaque sticker obtenu se pose une seule fois, toutes pièces confondues.
  // La pièce du concours est à part : on y a tous ses exemplaires, sans toucher aux vraies pièces.
  const owned = (id) => (state.profile && state.profile.inventory[id]) || 0;
  const realRooms = () => state.rooms.filter((r) => !r.contestDay);
  const currentRoom = () => state.rooms.find((r) => r.id === state.roomId);
  const inContestRoom = () => !!(currentRoom() && currentRoom().contestDay);
  function usedCount(id) {
    let n = 0;
    if (inContestRoom()) {
      for (const st of state.stickers) if (st.imageId === id) n++;
      return n;
    }
    for (const r of realRooms()) {
      const list = r.id === state.roomId ? state.stickers : (r.stickers || []);
      for (const st of list) if (st.imageId === id) n++;
    }
    return n;
  }
  const available = (id) => owned(id) - usedCount(id);

  // Filtre de la liste des stickers : null = toutes les collections, sinon l'id d'une enveloppe (ou NO_COLLECTION).
  const NO_COLLECTION = '__none';
  let libFilter = null;
  const collectionOf = (img) => (state.envelopes.some((e) => e.id === img.envelope) ? img.envelope : NO_COLLECTION);

  // Collections où le joueur a au moins un sticker, dans l'ordre de la boutique.
  function libCollections() {
    const mine = [...state.images.values()].filter((img) => owned(img.id) > 0);
    const out = [];
    for (const env of state.envelopes) {
      const n = mine.filter((img) => collectionOf(img) === env.id).length;
      if (n) out.push({ id: env.id, name: env.name || 'Enveloppe', n });
    }
    const none = mine.filter((img) => collectionOf(img) === NO_COLLECTION).length;
    if (none) out.push({ id: NO_COLLECTION, name: 'Sans collection', n: none });
    return { list: out, total: mine.length };
  }

  function updateLibFilterButton() {
    const { list } = libCollections();
    if (libFilter && !list.some((c) => c.id === libFilter)) libFilter = null; // plus aucun sticker de cette collection
    const cur = list.find((c) => c.id === libFilter);
    const btn = $('#btnLibFilter');
    btn.classList.toggle('active', !!cur);
    btn.hidden = list.length < 2 && !cur;
    $('#libFilterLabel').textContent = cur ? `\u00a0${cur.name}` : '\u00a0Collections';
    btn.title = cur ? `Collection : ${cur.name} (toucher pour changer)` : 'Filtrer les stickers par collection';
  }

  function openLibFilter() {
    const { list, total } = libCollections();
    const box = $('#libFilterList');
    box.innerHTML = '';
    const item = (id, label, n) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'lib-filter-item' + ((libFilter || null) === id ? ' active' : '');
      b.innerHTML = '<span class="lf-name"></span><span class="lf-n"></span>';
      b.querySelector('.lf-name').textContent = ((libFilter || null) === id ? '✓ ' : '') + label;
      b.querySelector('.lf-n').textContent = plural(n, 'sticker');
      b.addEventListener('click', () => { libFilter = id; $('#libFilterDialog').hidden = true; renderLibrary(); });
      box.appendChild(b);
    };
    item(null, 'Toutes mes collections', total);
    list.forEach((c) => item(c.id, c.name, c.n));
    $('#libFilterDialog').hidden = false;
  }
  $('#btnLibFilter').addEventListener('click', openLibFilter);
  $('#libFilterClose').addEventListener('click', () => { $('#libFilterDialog').hidden = true; });
  $('#libFilterDialog').addEventListener('click', (e) => { if (e.target.id === 'libFilterDialog') $('#libFilterDialog').hidden = true; });

  function renderLibrary() {
    libraryGrid.innerHTML = '';
    const all = [...state.images.values()].filter((img) => owned(img.id) > 0);
    updateLibFilterButton();
    const mine = libFilter ? all.filter((img) => collectionOf(img) === libFilter) : all;
    libraryEmpty.hidden = all.length > 0;
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
    // Plus d'exemplaire à poser : le sticker est grisé, on ne fait rien.
    if (available(imageId) <= 0) return;
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
  // ---------------------------------------------------------------------------
  // Annuler / rétablir : on garde des instantanés de la pièce (stickers + couleurs)
  // ---------------------------------------------------------------------------
  const HISTORY_MAX = 60;
  const history = { undo: [], redo: [] };
  let lastCoalesce = { kind: null, time: 0 };

  const snapshot = () => JSON.stringify({ stickers: state.stickers, colors: state.colors, shape: state.shape, ambient: state.ambient, lights: state.lights });

  // Enregistre l'état « avant » si la pièce a vraiment changé depuis.
  function commit(before) {
    if (before === snapshot()) return;
    history.undo.push(before);
    if (history.undo.length > HISTORY_MAX) history.undo.shift();
    history.redo = [];
    lastCoalesce = { kind: null, time: 0 };
    updateUndoButtons();
  }

  // Pour les petits changements en rafale (molette, flèches, nuancier) : un seul
  // retour en arrière pour toute la rafale.
  function checkpoint(kind) {
    const now = Date.now();
    const same = lastCoalesce.kind === kind && now - lastCoalesce.time < 800;
    lastCoalesce = { kind, time: now };
    if (same) return;
    history.undo.push(snapshot());
    if (history.undo.length > HISTORY_MAX) history.undo.shift();
    history.redo = [];
    updateUndoButtons();
  }

  function resetHistory() {
    history.undo = [];
    history.redo = [];
    lastCoalesce = { kind: null, time: 0 };
    updateUndoButtons();
  }

  function restore(snap) {
    const data = JSON.parse(snap);
    state.stickers = data.stickers.filter((st) => state.images.has(st.imageId));
    state.colors = { ...DEFAULT_COLORS, ...data.colors };
    state.shape = normShape(data.shape);
    state.ambient = Number.isFinite(data.ambient) ? data.ambient : 100;
    state.lights = Array.isArray(data.lights) ? data.lights : [];
    if (!shapeDialog.hidden) renderShapeDialog();
    // Un exemplaire vendu entre-temps ne peut pas revenir dans la pièce.
    for (const id of new Set(state.stickers.map((st) => st.imageId))) {
      let extra = usedCount(id) - owned(id);
      for (let i = state.stickers.length - 1; i >= 0 && extra > 0; i--) {
        if (state.stickers[i].imageId === id) { state.stickers.splice(i, 1); extra--; }
      }
    }
    if (!state.stickers.some((st) => st.id === state.selectedId)) state.selectedId = null;
    lastCoalesce = { kind: null, time: 0 };
    syncColorInputs();
    drawRoom();
    if (cpKey && !cpTarget) renderPickerState(currentColor(cpKey), true);
    renderStickers();
    renderAmbientBar();
    if (lightBarOpen && !state.lights.some((l) => l.id === lightSel)) closeLightBar(); else renderLightBar();
    scheduleSave();
    updateUndoButtons();
  }

  function undo() {
    if (!history.undo.length || gesture) return;
    history.redo.push(snapshot());
    restore(history.undo.pop());
  }

  function redo() {
    if (!history.redo.length || gesture) return;
    history.undo.push(snapshot());
    restore(history.redo.pop());
  }

  function updateUndoButtons() {
    $('#btnUndo').disabled = !history.undo.length;
    $('#btnRedo').disabled = !history.redo.length;
  }

  $('#btnUndo').addEventListener('click', undo);
  $('#btnRedo').addEventListener('click', redo);

  function addSticker(imageId, x, y) {
    const img = state.images.get(imageId);
    if (!img || available(imageId) <= 0) return;
    const before = snapshot();
    const k = STICKER_DEFAULT_SIZE / Math.max(img.w, img.h);
    const s = { id: uid(), imageId, x, y, w: img.w * k, h: img.h * k, rot: 0, flip: false };
    state.stickers.push(s); // nouveau sticker devant les autres
    state.selectedId = s.id;
    renderStickers();
    scheduleSave();
    commit(before);
  }

  const getSelected = () => state.stickers.find((s) => s.id === state.selectedId) || null;

  // focus = sélection depuis la liste « Objets posés » : les autres stickers
  // s'estompent et laissent passer les clics, pour attraper celui qui est derrière.
  function select(id, focus = false) {
    state.selectedId = id;
    state.focusId = id && focus ? id : (id && id === state.focusId ? id : null);
    for (const el of layer.children) el.classList.toggle('selected', el.dataset.id === id);
    layer.classList.toggle('focus', !!state.focusId);
    toolbar.hidden = !id;
    // Le bandeau du concours laisse la place à la barre d'outils du sticker.
    document.getElementById('contestBanner').classList.toggle('away', !!id);
    renderLayers();
    // La barre de lumière suit l'objet sélectionné : elle se ferme si on en change.
    const cur = state.lights.find((x) => x.id === lightSel);
    if (lightBarOpen && (!id || !cur || cur.sid !== id)) closeLightBar();
    else { renderLightBar(); updateLightButton(); }
  }

  function applyStickerStyle(el, s) {
    el.style.left = s.x - s.w / 2 + 'px';
    el.style.top = s.y - s.h / 2 + 'px';
    el.style.width = s.w + 'px';
    el.style.height = s.h + 'px';
    el.style.transform = `rotate(${s.rot}deg)`;
    el.firstChild.style.transform = s.flip ? 'scaleX(-1)' : '';
    el.classList.toggle('locked', !!s.locked);
    scheduleLights();
  }

  function renderStickers() {
    layer.innerHTML = '';
    state.stickers.forEach((s, i) => {
      const img = state.images.get(s.imageId);
      if (!img) return;
      // Dessin remplacé par un autre de proportions différentes : même surface, nouvelles proportions.
      if (img.w && img.h && Math.abs(s.w / s.h - img.w / img.h) > 0.01) {
        const k = Math.sqrt((s.w * s.h) / (img.w * img.h));
        s.w = img.w * k;
        s.h = img.h * k;
      }
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
    scheduleLights();
  }


  // ---------------------------------------------------------------------------
  // Lumière (test pour l'administratrice) : lumière de la pièce + points lumineux sur des objets
  // ---------------------------------------------------------------------------
  const LIGHT_DEFAULT = { color: '#ffd27a', intensity: 70 };
  const AMBIENT_MIN = 5;
  const lightLayer = $('#lightLayer');
  const lightHandles = $('#lightHandles');
  const ambientBar = $('#ambientBar');   // lumière de la pièce (en haut)
  const lightBar = $('#lightBar');       // lumière de l'objet sélectionné (en bas)
  let lightBarOpen = false;
  let lightSel = null; // point lumineux sélectionné
  const hexRgb = (hex) => {
    const n = parseInt(String(hex || '#ffffff').slice(1), 16) || 0;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const lightRadius = (l) => 50 + l.intensity * 1.3;
  // Position d'un point lumineux dans la scène : posé sur son sticker (tourné, retourné, agrandi…).
  function lightPos(l, stickers = state.stickers) {
    const s = stickers.find((x) => x.id === l.sid);
    if (!s) return null;
    const a = (s.rot || 0) * Math.PI / 180;
    const lx = (s.flip ? -1 : 1) * l.dx * s.w, ly = l.dy * s.h;
    return { x: s.x + lx * Math.cos(a) - ly * Math.sin(a), y: s.y + lx * Math.sin(a) + ly * Math.cos(a) };
  }
  // Les lumières se voient moins en pleine journée qu'à la tombée de la nuit.
  function glowStops(l, ambient) {
    const [r, g, b] = hexRgb(l.color);
    const a = (0.25 + 0.6 * l.intensity / 100) * (0.55 + 0.45 * (1 - ambient / 100));
    return [[0, `rgba(${r},${g},${b},${a.toFixed(3)})`], [0.35, `rgba(${r},${g},${b},${(a * 0.5).toFixed(3)})`], [1, `rgba(${r},${g},${b},0)`]];
  }
  const glowCss = (l, ambient) => `radial-gradient(circle closest-side, ${glowStops(l, ambient).map(([p, c]) => `${c} ${p * 100}%`).join(', ')})`;

  // Un objet éclairé redevient plus clair : plus sa lumière est forte, moins il subit l'obscurité de la pièce
  // (à 100 %, il retrouve sa luminosité de jour).
  function stickerBrightness(sid, lights = state.lights, ambient = state.ambient) {
    const b = ambient / 100;
    let strength = 0;
    for (const l of lights) if (l.sid === sid) strength = Math.max(strength, l.intensity);
    return b + (1 - b) * strength / 100;
  }

  const glowEls = new Map();
  const handleEls = new Map();
  let lightRaf = 0;
  function scheduleLights() {
    if (lightRaf) return;
    lightRaf = requestAnimationFrame(() => { lightRaf = 0; renderLights(); });
  }

  function renderLights() {
    stage.classList.toggle('dim', state.ambient < 100);
    stage.style.setProperty('--amb', (state.ambient / 100).toFixed(3));
    // Un point lumineux disparaît avec son sticker.
    const n = state.lights.length;
    state.lights = state.lights.filter((l) => state.stickers.some((s) => s.id === l.sid));
    if (state.lights.length !== n) {
      if (lightSel && !state.lights.some((l) => l.id === lightSel)) { lightSel = null; closeLightBar(); }
      updateLightButton();
    }
    for (const st of state.stickers) {
      const el = elFor(st.id);
      if (!el) continue;
      if (state.lights.some((l) => l.sid === st.id)) el.style.setProperty('--sb', stickerBrightness(st.id).toFixed(3));
      else el.style.removeProperty('--sb');
    }
    const seen = new Set();
    for (const l of state.lights) {
      const p = lightPos(l);
      if (!p) continue;
      seen.add(l.id);
      const r = lightRadius(l);
      let g = glowEls.get(l.id);
      if (!g) { g = document.createElement('div'); g.className = 'glow'; lightLayer.appendChild(g); glowEls.set(l.id, g); }
      g.style.left = `${p.x - r}px`; g.style.top = `${p.y - r}px`;
      g.style.width = g.style.height = `${r * 2}px`;
      g.style.background = glowCss(l, state.ambient);
      let h = handleEls.get(l.id);
      // La poignée de déplacement n'apparaît que pour le point qu'on est en train de régler.
      if (state.isAdmin && lightBarOpen && l.id === lightSel) {
        if (!h) {
          h = document.createElement('div');
          h.className = 'light-handle';
          h.title = 'Glisse pour déplacer le point lumineux sur l\'objet';
          h.addEventListener('pointerdown', (e) => startLightDrag(e, l.id));
          lightHandles.appendChild(h);
          handleEls.set(l.id, h);
        }
        h.style.left = `${p.x}px`; h.style.top = `${p.y}px`;
        h.style.background = l.color;
        h.classList.toggle('sel', l.id === lightSel);
      } else if (h) { h.remove(); handleEls.delete(l.id); }
    }
    for (const [id, el] of glowEls) if (!seen.has(id)) { el.remove(); glowEls.delete(id); }
    for (const [id, el] of handleEls) if (!seen.has(id) || !(lightBarOpen && id === lightSel)) { el.remove(); handleEls.delete(id); }
  }

  function startLightDrag(e, id) {
    e.preventDefault();
    e.stopPropagation();
    const l = state.lights.find((x) => x.id === id);
    const s = l && state.stickers.find((x) => x.id === l.sid);
    if (!s) return;
    lightSel = id;
    scheduleLights();
    const before = snapshot();
    const move = (ev) => {
      const p = toStage(ev.clientX, ev.clientY);
      const a = (s.rot || 0) * Math.PI / 180;
      const vx = p.x - s.x, vy = p.y - s.y;
      const lx = vx * Math.cos(a) + vy * Math.sin(a), ly = -vx * Math.sin(a) + vy * Math.cos(a);
      l.dx = clamp((s.flip ? -1 : 1) * lx / s.w, -0.7, 0.7);
      l.dy = clamp(ly / s.h, -0.7, 0.7);
      scheduleLights();
    };
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      commit(before);
      scheduleSave();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }

  function addLightTo(s) {
    const already = state.lights.filter((l) => l.sid === s.id).length;
    const l = { id: uid(), sid: s.id, dx: Math.min(0.5, already * 0.15), dy: 0, ...LIGHT_DEFAULT };
    state.lights.push(l);
    lightSel = l.id;
    return l;
  }

  // --- Lumière de la pièce : barre en haut ---
  function renderAmbientBar() {
    $('#ambientRange').value = state.ambient;
    $('#ambientOut').textContent = `${state.ambient} %`;
  }
  function openAmbientBar() {
    if (!state.isAdmin) return;
    if (!colorsPanel.hidden) setColorsPanel(false);
    if (!layersPanel.hidden) closeLayers();
    ambientBar.hidden = false;
    $('#btnLight').setAttribute('aria-expanded', 'true');
    renderAmbientBar();
  }
  function closeAmbientBar() {
    ambientBar.hidden = true;
    $('#btnLight').setAttribute('aria-expanded', 'false');
  }
  $('#btnLight').addEventListener('click', () => (ambientBar.hidden ? openAmbientBar() : closeAmbientBar()));
  $('#ambientClose').addEventListener('click', closeAmbientBar);
  $('#ambientRange').addEventListener('input', (e) => {
    checkpoint('ambient');
    state.ambient = clamp(Number(e.target.value) || 100, AMBIENT_MIN, 100);
    $('#ambientOut').textContent = `${state.ambient} %`;
    scheduleLights();
    scheduleSave();
  });

  // --- Lumière d'un objet : barre en bas, juste au-dessus de la barre d'outils ---
  const lightOfSticker = (s) => (s ? state.lights.find((l) => l.sid === s.id) || null : null);
  function updateLightButton() {
    toolbar.querySelector('[data-act="light"]').classList.toggle('active', !!lightOfSticker(getSelected()));
  }
  function renderLightBar() {
    const l = state.lights.find((x) => x.id === lightSel);
    if (!lightBarOpen || !l) { lightBar.hidden = true; return; }
    lightBar.hidden = false;
    // Juste au-dessus de la barre d'outils de l'objet (pour voir la pièce pendant qu'on règle).
    if (!toolbar.hidden) {
      const a = stageArea.getBoundingClientRect(), t = toolbar.getBoundingClientRect();
      lightBar.style.bottom = `${Math.round(a.bottom - t.top + 8)}px`;
    }
    $('#lightColor').style.background = l.color;
    $('#lightRange').value = l.intensity;
    $('#lightOut').textContent = `${l.intensity} %`;
  }
  function openLightBar(l) {
    lightSel = l.id;
    lightBarOpen = true;
    renderLightBar();
    updateLightButton();
    scheduleLights();
  }
  function closeLightBar() {
    lightBarOpen = false;
    lightBar.hidden = true;
    updateLightButton();
    scheduleLights();
  }
  $('#lightBarClose').addEventListener('click', closeLightBar);
  window.addEventListener('resize', () => { if (lightBarOpen) renderLightBar(); });
  $('#lightRange').addEventListener('input', (e) => {
    const l = state.lights.find((x) => x.id === lightSel);
    if (!l) return;
    checkpoint('lightint:' + l.id);
    l.intensity = Number(e.target.value);
    $('#lightOut').textContent = `${l.intensity} %`;
    scheduleLights();
    scheduleSave();
  });
  $('#lightColor').addEventListener('click', () => {
    const l = state.lights.find((x) => x.id === lightSel);
    const s = l && state.stickers.find((x) => x.id === l.sid);
    const img = s && state.images.get(s.imageId);
    if (!img) return;
    openColorPickerFor({
      label: `Lumière · ${stickerLabel(s)}`,
      stickers: [img],
      get: () => l.color,
      set: (hex) => {
        checkpoint('lightcolor:' + l.id);
        l.color = hex;
        $('#lightColor').style.background = hex;
        scheduleLights();
        scheduleSave();
      },
    });
  });
  $('#lightDel').addEventListener('click', () => {
    const before = snapshot();
    state.lights = state.lights.filter((x) => x.id !== lightSel);
    lightSel = null;
    closeLightBar();
    commit(before);
    scheduleSave();
  });

  // Recopie des points lumineux avec de nouveaux sticker (copie ou duplication d'une pièce).
  const remapLights = (lights, idMap) => (lights || []).filter((l) => idMap.has(l.sid)).map((l) => ({ ...l, id: uid(), sid: idMap.get(l.sid) }));

  // ---------------------------------------------------------------------------
  // Objets posés : la liste des stickers de la pièce, du plus devant au plus
  // derrière, pour sélectionner celui qu'on veut et verrouiller ceux qui gênent.
  // ---------------------------------------------------------------------------
  const layersPanel = $('#layersPanel');
  const layersList = $('#layersList');

  function stickerLabel(s) {
    const img = state.images.get(s.imageId);
    const name = img ? img.name : 'Sticker';
    const same = state.stickers.filter((x) => x.imageId === s.imageId);
    return same.length > 1 ? `${name} (${same.indexOf(s) + 1})` : name;
  }

  function renderLayers() {
    $('#btnLayers').classList.toggle('active', !layersPanel.hidden);
    if (layersPanel.hidden) return;
    layersList.innerHTML = '';
    $('#layersEmpty').hidden = state.stickers.length > 0;
    const locked = state.stickers.filter((s) => s.locked).length;
    $('#layersCount').textContent = state.stickers.length
      ? `${state.stickers.length} objet${state.stickers.length > 1 ? 's' : ''}${locked ? ` · ${locked} verrouillé${locked > 1 ? 's' : ''}` : ''}`
      : '';
    for (const s of [...state.stickers].reverse()) {
      const img = state.images.get(s.imageId);
      if (!img) continue;
      const li = document.createElement('li');
      li.className = 'layer-row' + (s.id === state.selectedId ? ' selected' : '') + (s.locked ? ' locked' : '');
      li.innerHTML = `
        <button class="layer-pick" title="Sélectionner"><span class="layer-thumb"><img alt=""></span><span class="layer-name"></span></button>
        <button class="layer-lock" aria-pressed="${!!s.locked}"></button>`;
      li.querySelector('img').src = img.url;
      li.querySelector('.layer-name').textContent = stickerLabel(s);
      const lock = li.querySelector('.layer-lock');
      lock.textContent = s.locked ? '🔒' : '🔓';
      lock.title = s.locked ? 'Déverrouiller' : 'Verrouiller (ne plus pouvoir le toucher dans la pièce)';
      lock.addEventListener('click', () => toggleLock(s));
      const pick = li.querySelector('.layer-pick');
      pick.addEventListener('click', () => {
        if (s.locked) {
          toast('Ce sticker est verrouillé : touche 🔒 pour le déverrouiller.');
          return;
        }
        select(s.id, true);
        if (window.matchMedia('(max-width: 720px)').matches) closeLayers();
      });
      // Survol : on montre où il est dans la pièce.
      pick.addEventListener('pointerenter', () => { const el = elFor(s.id); if (el) el.classList.add('hint'); });
      pick.addEventListener('pointerleave', () => { const el = elFor(s.id); if (el) el.classList.remove('hint'); });
      layersList.appendChild(li);
    }
  }

  function toggleLock(s) {
    const before = snapshot();
    s.locked = !s.locked;
    if (s.locked && state.selectedId === s.id) state.selectedId = null;
    renderStickers();
    scheduleSave();
    commit(before);
  }

  function openLayers() {
    layersPanel.hidden = false;
    if (!colorsPanel.hidden) setColorsPanel(false);
    if (!ambientBar.hidden) closeAmbientBar();
    renderLayers();
  }
  function closeLayers() {
    layersPanel.hidden = true;
    renderLayers();
  }
  $('#btnLayers').addEventListener('click', () => (layersPanel.hidden ? openLayers() : closeLayers()));
  $('#layersClose').addEventListener('click', closeLayers);

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

    gesture = { s, el, mode, pointers: new Map(), before: snapshot() };
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
    const before = gesture.before;
    gesture = null;
    window.removeEventListener('pointermove', onGestureMove);
    window.removeEventListener('pointerup', onGestureEnd);
    window.removeEventListener('pointercancel', onGestureEnd);
    commit(before);
    scheduleSave();
  }

  // Molette : sur le sticker sélectionné, agrandir / réduire ; ailleurs, zoomer.
  stageArea.addEventListener('wheel', (e) => {
    if (e.target.closest('.toolbar, .bar-tab, .zoom-ctrl, .stage-tools, .layers-panel, .colors-panel, .pipette-hint, .light-bar')) return;
    e.preventDefault();
    const s = getSelected();
    const onSelected = s && e.target.closest('.sticker') === elFor(s.id);
    if (!onSelected) {
      zoomAt(e.clientX, e.clientY, view.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12));
      return;
    }
    const k = e.deltaY < 0 ? 1.06 : 1 / 1.06;
    if (Math.min(s.w, s.h) * k < MIN_SIZE) return;
    checkpoint('wheel:' + s.id);
    s.w *= k; s.h *= k;
    applyStickerStyle(elFor(s.id), s);
    scheduleSave();
  }, { passive: false });

  // Dans le vide de la pièce : un appui simple désélectionne, glisser déplace la
  // vue (quand on a zoomé), pincer à deux doigts zoome.
  let viewGesture = null;

  stageArea.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.sticker, .toolbar, .bar-tab, .zoom-ctrl, .stage-tools, .layers-panel, .colors-panel, .pipette-hint, .light-bar')) return;
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
    const before = snapshot();
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
      case 'light': {
        if (!state.isAdmin) return;
        // Un point lumineux par objet : l'ampoule le crée, puis ouvre (ou ferme) sa barre de réglage.
        const existing = lightOfSticker(s);
        if (existing && lightBarOpen && lightSel === existing.id) { closeLightBar(); return; }
        openLightBar(existing || addLightTo(s));
        break;
      }
      case 'lock':
        s.locked = true;
        state.selectedId = null;
        toast('Sticker verrouillé 🔒. Pour le déverrouiller : bouton « Objets posés ».');
        break;
      default: return;
    }
    renderStickers();
    scheduleSave();
    commit(before);
  }

  toolbar.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (btn) act(btn.dataset.act);
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea')) return;
    if (screens.room.hidden) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      redo();
      return;
    }
    const s = getSelected();
    if (!s) return;
    const step = e.shiftKey ? 10 : 2;
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[e.key]) {
      e.preventDefault();
      checkpoint('keys:' + s.id);
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
    background: $('#colorBackground'),
    levelLeft: $('#colorLevelLeft'),
    levelRight: $('#colorLevelRight'),
    levelFloor: $('#colorLevelFloor'),
  };
  // Chaque carré de couleur ouvre la palette maison.
  for (const [key, input] of Object.entries(colorInputs)) {
    input.addEventListener('click', (e) => { e.preventDefault(); openColorPicker(key); });
  }
  const currentColor = (key) => {
    const lc = levelColors(state.colors, state.shape);
    const base = normShape(state.shape).kind === 'garden' ? GARDEN_COLORS : DEFAULT_COLORS;
    return state.colors[key] || lc[key] || base[key] || (key === 'background' ? DEFAULT_BACKGROUND : '#cccccc');
  };
  function syncColorInputs() {
    for (const [key, input] of Object.entries(colorInputs)) {
      const c = currentColor(key);
      input.value = c;
      input.style.background = c;
      input.title = c;
    }
    $('#bgReset').hidden = !state.colors.background;
    syncDecoSwatches();
  }

  // ---------------------------------------------------------------------------
  // Palette de couleurs : 8 couleurs en mémoire, couleurs de base, et curseurs
  // (teinte, saturation, luminosité) placés sur la couleur actuelle.
  // ---------------------------------------------------------------------------
  const SAVED_MAX = 8;
  const BASE_COLORS = [
    '#ffffff', '#f4ede4', '#d9d2c5', '#9e9a93', '#5a5550', '#2e2b28',
    '#f6d6d0', '#eaa9a0', '#d9645a', '#f7e3b5', '#f0c46c', '#d8973c',
    '#dcebc8', '#a9cf8f', '#6a9f58', '#cfe6ee', '#8cc3d8', '#4a87a8',
    '#dcd3f0', '#ab9bd6', '#7a63b0', '#e8cfb4', '#c49a6c', '#8a5d3b',
  ];
  const colorPicker = $('#colorPicker');
  let cpKey = null;
  // Autre chose qu'une couleur de pièce (ex. une enveloppe) : { label, get(), set(hex) }.
  let cpTarget = null;
  const cpCurrent = () => (cpTarget ? cpTarget.get() : currentColor(cpKey));
  const CP_LABELS = {
    wallLeft: 'Mur gauche', wallRight: 'Mur droit', floor: 'Sol', background: 'Fond',
    levelLeft: 'Étage, côté gauche', levelRight: 'Étage, côté droit', levelFloor: 'Sol de l\'étage',
  };

  function hexToHsl(hex) {
    const n = parseInt(hex.slice(1), 16);
    const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0;
    const l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
  }
  function hslToHex(h, s, l) {
    s /= 100; l /= 100;
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    const to = (x) => Math.round(x * 255).toString(16).padStart(2, '0');
    return '#' + to(f(0)) + to(f(8)) + to(f(4));
  }
  const validHex = (v) => /^#[0-9a-f]{6}$/i.test(v);

  // Applique la couleur choisie à la pièce (un seul retour en arrière par rafale).
  function applyPickedColor(hex, fromSliders = false) {
    if (!cpKey || !validHex(hex)) return;
    hex = hex.toLowerCase();
    if (cpTarget) {
      cpTarget.set(hex);
      renderPickerState(hex, !fromSliders);
      return;
    }
    checkpoint('color:' + cpKey);
    state.colors[cpKey] = hex;
    drawRoom();
    syncColorInputs();
    scheduleSave();
    renderPickerState(hex, !fromSliders);
  }

  function renderPickerState(hex, moveSliders = true) {
    $('#cpPreview').style.background = hex;
    if (document.activeElement !== $('#cpHex')) $('#cpHex').value = hex;
    if (moveSliders) {
      const { h, s, l } = hexToHsl(hex);
      $('#cpH').value = h; $('#cpS').value = s; $('#cpL').value = l;
    }
    updateSliderTracks();
    document.querySelectorAll('#colorPicker .cp-swatch').forEach((b) => b.classList.toggle('active', b.dataset.color === hex));
  }
  function updateSliderTracks() {
    const h = +$('#cpH').value, s = +$('#cpS').value, l = +$('#cpL').value;
    $('#cpS').style.background = `linear-gradient(to right, ${hslToHex(h, 0, l)}, ${hslToHex(h, 100, l)})`;
    $('#cpL').style.background = `linear-gradient(to right, #000, ${hslToHex(h, s, 50)}, #fff)`;
  }

  function swatchButton(color, onPick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cp-swatch';
    b.dataset.color = color;
    b.style.background = color;
    b.title = color;
    b.addEventListener('click', () => onPick(color));
    return b;
  }
  const savedColors = () => (state.profile && state.profile.savedColors) || [];
  function renderSaved() {
    const box = $('#cpSaved');
    box.innerHTML = '';
    const list = savedColors();
    for (let i = 0; i < SAVED_MAX; i++) {
      if (list[i]) {
        const b = swatchButton(list[i], (c) => applyPickedColor(c));
        // Appui long (ou clic droit) : retirer la couleur de la mémoire.
        let timer = null;
        const remove = () => {
          state.profile.savedColors = savedColors().filter((c) => c !== list[i]);
          saveProfile();
          renderSaved();
          toast('Couleur retirée de ta mémoire.');
        };
        b.addEventListener('contextmenu', (e) => { e.preventDefault(); remove(); });
        b.addEventListener('pointerdown', () => { timer = setTimeout(() => { timer = 'done'; remove(); }, 650); });
        b.addEventListener('pointerup', () => { if (timer !== 'done') clearTimeout(timer); });
        b.addEventListener('pointerleave', () => { if (timer !== 'done') clearTimeout(timer); });
        box.appendChild(b);
      } else {
        const empty = document.createElement('span');
        empty.className = 'cp-swatch empty';
        empty.title = 'Emplacement libre';
        box.appendChild(empty);
      }
    }
    renderPickerState(cpCurrent(), false);
  }

  // Pipette : on choisit un sticker puis on touche l'endroit dont on veut la couleur.
  function setupPipette(stickers) {
    const box = $('#cpPipette');
    const list = stickers.filter((img) => img && img.url);
    box.hidden = !list.length;
    $('#cpPipZoom').hidden = true;
    const strip = $('#cpPipStrip');
    strip.innerHTML = '';
    for (const img of list) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cp-pip-thumb';
      b.title = img.name || 'Sticker';
      b.innerHTML = '<img alt="">';
      b.querySelector('img').src = img.url;
      b.addEventListener('click', () => {
        strip.querySelectorAll('.cp-pip-thumb').forEach((x) => x.classList.toggle('active', x === b));
        showPipSticker(img);
      });
      strip.appendChild(b);
    }
  }
  let pipCtx = null;
  async function showPipSticker(img) {
    const el = new Image();
    el.src = img.url;
    try { await el.decode(); } catch (e) { toast('Image impossible à lire.'); return; }
    const cv = $('#cpPipCanvas');
    const max = 260;
    const k = Math.min(1, max / Math.max(el.naturalWidth, el.naturalHeight));
    cv.width = Math.max(1, Math.round(el.naturalWidth * k));
    cv.height = Math.max(1, Math.round(el.naturalHeight * k));
    pipCtx = cv.getContext('2d', { willReadFrequently: true });
    pipCtx.clearRect(0, 0, cv.width, cv.height);
    pipCtx.drawImage(el, 0, 0, cv.width, cv.height);
    $('#cpPipZoom').hidden = false;
    // Couleurs principales du sticker, proposées en un geste.
    const box = $('#cpPipColors');
    box.innerHTML = '';
    let data;
    try { data = pipCtx.getImageData(0, 0, cv.width, cv.height).data; } catch (e) { return; }
    const counts = new Map();
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 200) continue;
      const q = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
      counts.set(q, (counts.get(q) || 0) + 1);
    }
    const picked = [];
    for (const [q] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
      const rgb = [(q >> 8) & 15, (q >> 4) & 15, q & 15].map((v) => v * 16 + 8);
      if (picked.some((c) => Math.abs(c[0] - rgb[0]) + Math.abs(c[1] - rgb[1]) + Math.abs(c[2] - rgb[2]) < 60)) continue;
      picked.push(rgb);
      if (picked.length >= 8) break;
    }
    picked.forEach((c) => box.appendChild(swatchButton(rgbHex(c[0], c[1], c[2]), (x) => applyPickedColor(x))));
  }
  const rgbHex = (r, g, b) => '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('');
  // Loupe : agrandit les pixels autour du doigt (au-dessus, pour ne pas être caché par lui).
  const LOUPE_PX = 15; // pixels visibles de chaque côté (la loupe fait 120 px)
  function showLoupe(e, x, y, hex) {
    const loupe = $('#cpLoupe');
    const lc = $('#cpLoupeCanvas').getContext('2d');
    lc.imageSmoothingEnabled = false;
    lc.clearRect(0, 0, 120, 120);
    const half = Math.floor(LOUPE_PX / 2);
    lc.drawImage($('#cpPipCanvas'), x - half, y - half, LOUPE_PX, LOUPE_PX, 0, 0, 120, 120);
    loupe.style.borderColor = hex || 'var(--line)';
    const touch = e.pointerType !== 'mouse';
    let top = e.clientY - (touch ? 150 : 140);
    if (top < 4) top = e.clientY + (touch ? 40 : 20); // trop haut : on la met en dessous
    loupe.style.left = `${Math.max(4, Math.min(window.innerWidth - 124, e.clientX - 60))}px`;
    loupe.style.top = `${top}px`;
    loupe.hidden = false;
  }
  const hideLoupe = () => { $('#cpLoupe').hidden = true; };
  function pipSample(e, apply = true) {
    const cv = $('#cpPipCanvas');
    if (!pipCtx) return;
    const r = cv.getBoundingClientRect();
    const x = Math.floor((e.clientX - r.left) * cv.width / r.width);
    const y = Math.floor((e.clientY - r.top) * cv.height / r.height);
    if (x < 0 || y < 0 || x >= cv.width || y >= cv.height) { hideLoupe(); return; }
    let d;
    try { d = pipCtx.getImageData(x, y, 1, 1).data; } catch (err) { return; }
    const hex = d[3] < 40 ? null : rgbHex(d[0], d[1], d[2]);
    showLoupe(e, x, y, hex);
    if (apply && hex) applyPickedColor(hex); // fond transparent : on ignore
  }
  {
    // Hors de la palette (qui est décalée) pour se placer exactement au-dessus du doigt.
    document.body.appendChild($('#cpLoupe'));
    const cv = $('#cpPipCanvas');
    let down = false;
    cv.addEventListener('pointerdown', (e) => { down = true; cv.setPointerCapture(e.pointerId); pipSample(e); e.preventDefault(); });
    // À la souris, la loupe suit le curseur même sans cliquer.
    cv.addEventListener('pointermove', (e) => { if (down) pipSample(e); else if (e.pointerType === 'mouse') pipSample(e, false); });
    cv.addEventListener('pointerup', (e) => { down = false; if (e.pointerType !== 'mouse') hideLoupe(); });
    cv.addEventListener('pointercancel', () => { down = false; hideLoupe(); });
    cv.addEventListener('pointerleave', () => { if (!down) hideLoupe(); });
  }

  // Palette pour une autre cible que la pièce (enveloppes de l'atelier…).
  function openColorPickerFor(target) {
    cpTarget = target;
    cpKey = 'custom';
    $('#cpEyedrop').hidden = true; // la pipette de la pièce ne sert que pour les couleurs de la pièce
    setupPipette(target.stickers || []);
    $('#cpTitle').textContent = target.label;
    const base = $('#cpBase');
    if (!base.children.length) BASE_COLORS.forEach((c) => base.appendChild(swatchButton(c, (x) => applyPickedColor(x))));
    renderSaved();
    renderPickerState(cpCurrent(), true);
    colorPicker.hidden = false;
  }

  function openColorPicker(key) {
    cpTarget = null;
    cpKey = key;
    $('#cpEyedrop').hidden = false;
    setupPipette([]);
    $('#cpTitle').textContent = CP_LABELS[key] || 'Couleur';
    const base = $('#cpBase');
    if (!base.children.length) BASE_COLORS.forEach((c) => base.appendChild(swatchButton(c, (x) => applyPickedColor(x))));
    renderSaved();
    renderPickerState(currentColor(key), true);
    colorPicker.hidden = false;
    // Le panneau Couleurs se cache pour laisser voir la pièce, puis revient avec « OK ».
    cpReopenPanel = !colorsPanel.hidden || cpReopenPanel;
    colorsPanel.hidden = true;
  }
  let cpReopenPanel = false;
  function closeColorPicker(reopen = true) {
    if (colorPicker.hidden && !cpKey) return;
    colorPicker.hidden = true;
    cpKey = null;
    if (cpTarget && cpTarget.close) cpTarget.close();
    cpTarget = null;
    if (cpReopenPanel && reopen && !screens.room.hidden) colorsPanel.hidden = false;
    cpReopenPanel = false;
  }
  $('#cpOk').addEventListener('click', () => closeColorPicker());
  $('#cpSave').addEventListener('click', () => {
    if (!cpKey) return;
    const c = cpCurrent().toLowerCase();
    const list = [c, ...savedColors().filter((x) => x !== c)].slice(0, SAVED_MAX);
    state.profile.savedColors = list;
    saveProfile();
    renderSaved();
    toast('Couleur gardée en mémoire 🎨');
  });
  $('#cpCustomBtn').addEventListener('click', () => {
    const panel = $('#cpCustom');
    panel.hidden = !panel.hidden;
    $('#cpCustomBtn').setAttribute('aria-expanded', !panel.hidden);
    // Les curseurs partent toujours de la couleur actuelle.
    if (!panel.hidden) renderPickerState(cpCurrent(), true);
  });
  for (const id of ['#cpH', '#cpS', '#cpL']) {
    $(id).addEventListener('input', () => {
      applyPickedColor(hslToHex(+$('#cpH').value, +$('#cpS').value, +$('#cpL').value), true);
    });
  }
  $('#cpHex').addEventListener('input', () => {
    let v = $('#cpHex').value.trim();
    if (!v.startsWith('#')) v = '#' + v;
    if (validHex(v)) applyPickedColor(v);
  });
  $('#cpHex').addEventListener('blur', () => { if (cpKey) $('#cpHex').value = cpCurrent(); });

  $('#bgReset').addEventListener('click', () => {
    const before = snapshot();
    delete state.colors.background;
    syncColorInputs();
    drawRoom();
    scheduleSave();
    commit(before);
  });

  function setColor(key, hex) {
    const before = snapshot();
    state.colors[key] = hex;
    commit(before);
    syncColorInputs();
    drawRoom();
    scheduleSave();
  }

  // Pipette : avec l'outil du navigateur quand il existe (Chrome, Edge sur
  // ordinateur : on peut viser n'importe où à l'écran) ; sinon on touche un
  // endroit de la pièce pour prendre sa couleur.
  let pipetteKey = null;
  const PIPETTE_NAMES = {
    wallLeft: 'le mur gauche', wallRight: 'le mur droit', floor: 'le sol', background: 'le fond',
    levelLeft: 'les murs de l\'étage (gauche)', levelRight: 'les murs de l\'étage (droite)', levelFloor: 'le sol de l\'étage',
  };

  // La pipette se lance depuis la palette (bouton « 💧 Pipette » à côté des couleurs gardées).
  let pipetteReturn = null; // palette à rouvrir une fois la couleur prise
  async function startPipette(key) {
    if (window.EyeDropper) {
      try {
        const { sRGBHex } = await new window.EyeDropper().open();
        applyPickedColor(sRGBHex);
      } catch (e) { /* annulé avec Échap */ }
      return;
    }
    pipetteReturn = { key, wasPanel: cpReopenPanel };
    pipetteKey = key;
    closeColorPicker(false);
    stageArea.classList.add('pipette');
    // Rappel qui reste affiché tant que la pipette est active (avec un bouton pour annuler).
    $('#pipetteHintText').textContent = `💧 Pipette pour ${PIPETTE_NAMES[key]} : appuie dans la pièce, glisse la loupe sur la couleur voulue, puis relâche.`;
    $('#pipetteHint').hidden = false;
  }
  $('#cpEyedrop').addEventListener('click', () => { if (cpKey && !cpTarget) startPipette(cpKey); });

  // La palette revient (avec la nouvelle couleur) quand la pipette a fini ou a été annulée.
  function returnToPicker() {
    const r = pipetteReturn;
    pipetteReturn = null;
    if (!r || screens.room.hidden) return;
    openColorPicker(r.key);
    cpReopenPanel = r.wasPanel;
  }
  // reopen=false : on est en pleine visée, la palette reviendra au relâchement.
  function stopPipette(reopen = true) {
    pipetteKey = null;
    stageArea.classList.remove('pipette');
    $('#pipetteHint').hidden = true;
    if (reopen) returnToPicker();
  }
  $('#pipetteCancel').addEventListener('click', () => stopPipette());

  // En mode pipette, appuyer dans la pièce affiche une loupe au-dessus du doigt :
  // on glisse pour viser la bonne couleur, et on relâche pour la choisir.
  // (Écoute en phase de capture, avant les stickers et le zoom.)
  const loupe = $('#loupe');
  const loupeCanvas = $('#loupeCanvas');
  const LOUPE_SIZE = 120;  // diamètre à l'écran, en px
  const LOUPE_MAG = 5;     // grossissement par rapport à ce qu'on voit
  const SCENE_K = 2;       // résolution du rendu lu par la pipette
  let pip = null;          // { key, ctx, pointerId, x, y }

  const toHex = (r, g, b) => '#' + [r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('');

  function sampleAt(clientX, clientY) {
    if (!pip || !pip.ctx) return null;
    const p = toStage(clientX, clientY);
    const x = Math.round(p.x * SCENE_K), y = Math.round(p.y * SCENE_K);
    // En dehors de la pièce dessinée : c'est le fond qu'on voit.
    const bg = state.colors.background || null;
    if (x < 0 || y < 0 || x >= STAGE_W * SCENE_K || y >= STAGE_H * SCENE_K) return bg;
    const [r, g, b, a] = pip.ctx.getImageData(x, y, 1, 1).data;
    return a < 20 ? bg : toHex(r, g, b);
  }

  function drawLoupe() {
    if (!pip) return;
    const { x, y } = pip;
    // Au-dessus du doigt ; en dessous s'il n'y a pas la place en haut.
    let top = y - LOUPE_SIZE - 48;
    if (top < 8) top = y + 48;
    loupe.style.left = clamp(x - LOUPE_SIZE / 2, 8, window.innerWidth - LOUPE_SIZE - 8) + 'px';
    loupe.style.top = top + 'px';
    loupe.hidden = false;
    if (!pip.ctx) return; // rendu en cours
    const dpr = window.devicePixelRatio || 1;
    const px = Math.round(LOUPE_SIZE * dpr);
    if (loupeCanvas.width !== px) { loupeCanvas.width = px; loupeCanvas.height = px; }
    const lctx = loupeCanvas.getContext('2d');
    lctx.imageSmoothingEnabled = false;
    lctx.fillStyle = getComputedStyle(document.body).backgroundColor;
    lctx.fillRect(0, 0, px, px);
    // Zone de la pièce couverte par la loupe, en unités de la pièce.
    const p = toStage(x, y);
    const span = LOUPE_SIZE / (state.scale * LOUPE_MAG);
    lctx.drawImage(pip.ctx.canvas,
      (p.x - span / 2) * SCENE_K, (p.y - span / 2) * SCENE_K, span * SCENE_K, span * SCENE_K,
      0, 0, px, px);
    const hex = sampleAt(x, y);
    loupe.style.setProperty('--picked', hex || 'transparent');
    $('#loupeHex').textContent = hex ? hex.toUpperCase() : '—';
  }

  function endPip() {
    pip = null;
    loupe.hidden = true;
    window.removeEventListener('pointermove', onPipMove, true);
    window.removeEventListener('pointerup', onPipUp, true);
    window.removeEventListener('pointercancel', onPipCancel, true);
  }

  function onPipMove(e) {
    if (!pip || e.pointerId !== pip.pointerId) return;
    e.preventDefault();
    e.stopPropagation();
    pip.x = e.clientX; pip.y = e.clientY;
    drawLoupe();
  }

  async function onPipUp(e) {
    if (!pip || e.pointerId !== pip.pointerId) return;
    e.preventDefault();
    e.stopPropagation();
    pip.x = e.clientX; pip.y = e.clientY;
    if (!pip.ctx) await pip.ready;
    const key = pip.key;
    const hex = sampleAt(pip.x, pip.y);
    endPip();
    if (hex) setColor(key, hex);
    else toast('Il n\'y a pas de couleur à cet endroit. Vise la pièce ou un sticker.');
    returnToPicker();
  }

  function onPipCancel(e) {
    if (pip && e.pointerId === pip.pointerId) { endPip(); returnToPicker(); }
  }

  stageArea.addEventListener('pointerdown', (e) => {
    if (!pipetteKey) return;
    if (e.target.closest('.pipette-hint')) return; // le bouton « Annuler » doit rester cliquable
    e.preventDefault();
    e.stopPropagation();
    if (pip) return; // un seul doigt pour la pipette
    if (e.target.closest('.bar-tab, .zoom-ctrl, .toolbar')) { stopPipette(); return; }
    pip = { key: pipetteKey, ctx: null, pointerId: e.pointerId, x: e.clientX, y: e.clientY };
    stopPipette(false);
    const current = pip;
    current.ready = renderScene(SCENE_K, state.colors.background || null).then((cv) => {
      current.ctx = cv.getContext('2d', { willReadFrequently: true });
      if (pip === current) drawLoupe();
    }).catch((err) => {
      console.warn('Pipette impossible', err);
      if (pip === current) { endPip(); toast('Impossible de lire les couleurs de la pièce.'); returnToPicker(); }
    });
    window.addEventListener('pointermove', onPipMove, true);
    window.addEventListener('pointerup', onPipUp, true);
    window.addEventListener('pointercancel', onPipCancel, true);
    drawLoupe();
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (pipetteKey) stopPipette();
    if (pip) endPip();
  });

  $('#btnClear').addEventListener('click', async () => {
    if (!state.stickers.length || !(await askConfirm('Retirer tous les stickers de la pièce ?', 'Vider'))) return;
    const before = snapshot();
    state.stickers = [];
    commit(before);
    state.selectedId = null;
    renderStickers();
    scheduleSave();
  });

  // Dessine la pièce et ses stickers dans un canvas (export et miniatures).
  // data (facultatif) : une autre pièce { colors, shape, stickers } à dessiner que celle ouverte.
  async function renderScene(K, background, data = null) {
    const cv = document.createElement('canvas');
    cv.width = Math.round(STAGE_W * K);
    cv.height = Math.round(STAGE_H * K);
    const ctx = cv.getContext('2d');
    ctx.scale(K, K);
    if (background) {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, STAGE_W, STAGE_H);
    }

    const stickers = data ? (data.stickers || []) : state.stickers;
    const lights = data ? (data.lights || []) : state.lights;
    const ambient = data ? (Number.isFinite(data.ambient) ? data.ambient : 100) : state.ambient;
    // Pièce sombre : la pièce est dessinée à part puis assombrie (le fond ne l'est pas),
    // et chaque sticker est assombri selon sa propre lumière.
    let content = ctx, layerCv = null;
    if (ambient < 100) {
      layerCv = document.createElement('canvas');
      layerCv.width = cv.width;
      layerCv.height = cv.height;
      content = layerCv.getContext('2d');
      content.scale(K, K);
    }

    const svgText = data
      ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${STAGE_W} ${STAGE_H}" width="${STAGE_W}" height="${STAGE_H}">${roomSvg({ ...DEFAULT_COLORS, ...(data.colors || {}) }, data.shape)}</svg>`
      : new XMLSerializer().serializeToString(room);
    const svgUrl = URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml' }));
    try {
      content.drawImage(await loadImageEl(svgUrl), 0, 0, STAGE_W, STAGE_H);
    } finally {
      URL.revokeObjectURL(svgUrl);
    }
    // Assombrit seulement ce qui est dessiné (équivalent de brightness() à l'écran).
    const darken = (c2, amount) => {
      c2.save();
      c2.setTransform(1, 0, 0, 1, 0, 0);
      c2.globalCompositeOperation = 'source-atop';
      c2.fillStyle = `rgba(0,0,0,${amount.toFixed(3)})`;
      c2.fillRect(0, 0, c2.canvas.width, c2.canvas.height);
      c2.restore();
    };
    if (layerCv) {
      darken(content, 1 - ambient / 100);
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(layerCv, 0, 0);
      ctx.restore();
    }

    for (const s of stickers) {
      const img = state.images.get(s.imageId);
      if (!img) continue;
      let el;
      try { el = await loadImageEl(img.url); } catch (e) { console.warn('Sticker illisible, ignoré', img.name); continue; }
      const f = ambient < 100 ? stickerBrightness(s.id, lights, ambient) : 1;
      // Le sticker est dessiné sur un petit calque à part s'il doit être assombri.
      const D = Math.ceil(Math.hypot(s.w, s.h) + 24);
      let target = ctx, tmp = null;
      if (f < 0.999) {
        tmp = document.createElement('canvas');
        tmp.width = tmp.height = Math.max(1, Math.ceil(D * K));
        target = tmp.getContext('2d');
        target.scale(K, K);
      }
      target.save();
      target.translate(tmp ? D / 2 : s.x, tmp ? D / 2 : s.y);
      target.rotate(s.rot * Math.PI / 180);
      if (s.flip) target.scale(-1, 1);
      target.shadowColor = 'rgba(0,0,0,.18)';
      target.shadowBlur = 3;
      target.shadowOffsetY = 4;
      target.drawImage(el, -s.w / 2, -s.h / 2, s.w, s.h);
      target.restore();
      if (tmp) {
        darken(target, 1 - f);
        ctx.drawImage(tmp, s.x - D / 2, s.y - D / 2, D, D);
      }
    }

    // Points lumineux : halos qui s'ajoutent à la lumière (comme « screen » à l'écran).
    for (const l of lights) {
      const p = lightPos(l, stickers);
      if (!p) continue;
      const r = lightRadius(l);
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
      for (const [pos, color] of glowStops(l, ambient)) g.addColorStop(pos, color);
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      ctx.fillStyle = g;
      ctx.fillRect(p.x - r, p.y - r, r * 2, r * 2);
      ctx.restore();
    }
    return cv;
  }

  let exportBlob = null;
  async function exportRoom() {
    try {
      select(null);
      // Export en haute définition ; si le téléphone n'a pas assez de mémoire, on réessaie en plus petit.
      let blob = null;
      for (const k of [2, 1.2]) {
        try {
          const cv = await renderScene(k, state.colors.background || getComputedStyle(document.body).backgroundColor);
          blob = await new Promise((resolve) => cv.toBlob(resolve, 'image/png'));
        } catch (e) { console.warn('Export à l\'échelle', k, e); }
        if (blob) break;
      }
      if (!blob) throw new Error('image vide');
      exportBlob = blob;
      // On affiche l'image (enregistrable par appui long) avec un lien de téléchargement,
      // qui ne marche pas partout (pages intégrées) : le bouton Partager prend le relais.
      const url = URL.createObjectURL(blob);
      const prev = exportImg.src;
      exportImg.src = url;
      exportLink.href = url;
      const file = new File([blob], 'ma-petite-piece.png', { type: 'image/png' });
      $('#exportShare').hidden = !(navigator.canShare && navigator.canShare({ files: [file] }));
      exportDialog.hidden = false;
      if (prev.startsWith('blob:')) URL.revokeObjectURL(prev);
    } catch (e) {
      console.warn('Export impossible', e);
      toast('La pièce n\'a pas pu être exportée. Réessaie, ou fais une capture d\'écran.');
    }
  }
  $('#btnExport').addEventListener('click', exportRoom);
  $('#btnExport2').addEventListener('click', exportRoom);
  $('#exportShare').addEventListener('click', async () => {
    if (!exportBlob) return;
    try {
      await navigator.share({ files: [new File([exportBlob], 'ma-petite-piece.png', { type: 'image/png' })], title: 'Ma petite pièce' });
    } catch (e) {
      if (e && e.name !== 'AbortError') toast('Le partage n\'a pas marché : appuie longuement sur l\'image pour l\'enregistrer.');
    }
  });

  // ---------------------------------------------------------------------------
  // Écrans : pseudo → mes pièces → décoration
  // ---------------------------------------------------------------------------
  const screens = {
    start: $('#screenStart'),
    home: $('#screenHome'),
    rooms: $('#screenRooms'),
    room: $('#screenRoom'),
    shop: $('#screenShop'),
    collection: $('#screenCollection'),
    players: $('#screenPlayers'),
    creations: $('#screenCreations'),
    mail: $('#screenMail'),
    coffre: $('#screenCoffre'),
    atelier: $('#screenAtelier'),
    decoAdmin: $('#screenDecoAdmin'),
    news: $('#screenNews'),
    contest: $('#screenContest'),
    ctHistory: $('#screenCtHistory'),
    settings: $('#screenSettings'),
    adminContest: $('#screenAdminContest'),
    maintenance: $('#screenMaintenance'),
  };
  function showScreen(name) {
    for (const [key, el] of Object.entries(screens)) el.hidden = key !== name;
    if (name !== 'room' && !colorPicker.hidden) closeColorPicker(false);
    if (name === 'room') fitStage();
    // On retient l'écran (et la pièce) pour y revenir après une actualisation.
    if (name !== 'start') store(PLACE_KEY, JSON.stringify({ screen: name, roomId: state.roomId }));
    // Pile des écrans : un écran déjà dans la pile (retour) la raccourcit, un nouvel écran s'y ajoute.
    const at = screenStack.lastIndexOf(name);
    if (name === 'home' || name === 'start') screenStack = [name];
    else if (at >= 0) screenStack.length = at + 1;
    else screenStack.push(name);
    scheduleHistorySync();
  }

  // ---------------------------------------------------------------------------
  // Bouton retour du téléphone : on revient à l'écran d'avant (ou on ferme la fenêtre ouverte)
  // au lieu de quitter le jeu. Dès qu'on est dans un sous-écran ou une fenêtre, l'historique du
  // navigateur a une entrée de plus ; le retour du téléphone la retire et lance le « retour » du jeu.
  // ---------------------------------------------------------------------------
  const OVERLAY_SEL = '.modal:not([hidden]), #duelView:not([hidden]), #colorPicker:not([hidden])';
  const currentScreenName = () => Object.keys(screens).find((k) => !screens[k].hidden);
  // Chaque écran ouvert (au-dessus de l'accueil) et chaque fenêtre ouverte ajoute une entrée à l'historique du
  // navigateur, au moment où on l'ouvre. Un retour du téléphone retire une entrée et ferme la fenêtre / revient
  // à l'écran d'avant : le jeu n'a jamais besoin de rajouter une entrée après coup.
  let screenStack = ['start'];
  const histDepth = () => { const st = window.history.state; return st && Number.isFinite(st.n) ? st.n : 0; };
  const targetDepth = () => Math.max(0, screenStack.length - 1) + document.querySelectorAll(OVERLAY_SEL).length;
  let popPending = false;   // un retour automatique est en cours : on attend qu'il soit terminé
  let popTimer = 0;
  let historyTimer = 0;
  let backBusy = false;     // un retour du téléphone vient d'être traité : pas d'entrée ajoutée le temps qu'il se termine
  let backBusyTimer = 0;

  // Chrome ignore (au retour) les entrées d'historique ajoutées sans geste de l'utilisateur :
  // tant qu'il n'y en a pas eu, on attend le premier appui avant d'ajouter une entrée.
  const noGestureYet = () => !!(navigator.userActivation && !navigator.userActivation.hasBeenActive);
  let waitingGesture = false;
  function syncAfterGesture() {
    if (waitingGesture) return;
    waitingGesture = true;
    const evs = ['pointerup', 'touchend', 'click', 'keydown'];
    const go = () => {
      waitingGesture = false;
      evs.forEach((ev) => window.removeEventListener(ev, go, true));
      scheduleHistorySync();
    };
    evs.forEach((ev) => window.addEventListener(ev, go, true));
  }

  // Met le nombre d'entrées de l'historique en accord avec ce qui est ouvert.
  function scheduleHistorySync() {
    clearTimeout(historyTimer);
    historyTimer = setTimeout(() => {
      if (popPending) return; // on refait le point dès que le retour en cours est fini
      const target = targetDepth();
      const n = histDepth();
      if (target > n) {
        if (backBusy) return; // sera refait à la fin du délai
        if (noGestureYet()) { syncAfterGesture(); return; }
        for (let i = n + 1; i <= target; i++) window.history.pushState({ nav: 'app', n: i }, '');
      } else if (target < n) {
        // Un seul retour automatique à la fois, même si l'écran change plusieurs fois pendant qu'il s'effectue.
        popPending = true;
        clearTimeout(popTimer);
        popTimer = setTimeout(() => { popPending = false; scheduleHistorySync(); }, 700);
        window.history.go(target - n);
      }
    }, 0);
  }

  // Ferme la fenêtre ouverte, en passant par son bouton Annuler / Fermer / OK.
  function closeTopOverlay() {
    const open = [...document.querySelectorAll(OVERLAY_SEL)];
    if (!open.length) return false;
    const top = open.find((e) => e.id === 'confirmDialog') || open[open.length - 1];
    const btn = top.querySelector('button[id$="Cancel"], button[id$="Close"], button[id$="Ok"]') || top.querySelector('.modal-actions button');
    if (btn) btn.click(); else top.hidden = true;
    return true;
  }

  // Un cran en arrière dans le jeu : fenêtre, puis liste des enveloppes (atelier), puis écran précédent.
  function navBack() {
    if (closeTopOverlay()) return;
    const cur = currentScreenName();
    if (!cur || cur === 'home' || cur === 'start') return;
    if (cur === 'atelier' && !$('#atelierDetailBar').hidden) { $('#atelierAll').click(); return; }
    const btn = screens[cur].querySelector('.topbar button[id$="Back"]');
    if (btn) btn.click(); else goHome();
  }

  window.addEventListener('popstate', () => {
    if (popPending) { popPending = false; clearTimeout(popTimer); scheduleHistorySync(); return; }
    if (histDepth() >= targetDepth()) return; // pas un retour en arrière par rapport à ce qui est ouvert
    // Retour du téléphone : on ferme la fenêtre ou on revient à l'écran d'avant (le jeu a alors une entrée de moins).
    backBusy = true;
    clearTimeout(backBusyTimer);
    backBusyTimer = setTimeout(() => { backBusy = false; scheduleHistorySync(); }, 600);
    navBack();
  });
  new MutationObserver(scheduleHistorySync).observe(document.body, { attributes: true, attributeFilter: ['hidden'], subtree: true });
  if (!window.history.state || !Number.isFinite(window.history.state.n)) window.history.replaceState({ nav: 'app', n: 0 }, '');
  // Au retour sur la page (téléphone qui se réveille, page restaurée), on vérifie que l'historique est bon.
  window.addEventListener('pageshow', scheduleHistorySync);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') scheduleHistorySync(); });

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
    const err = $('#pseudoError');
    if (name.length < 2) {
      err.textContent = 'Choisis un pseudo d\'au moins 2 lettres.';
      err.hidden = false;
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

  const dailyPoints = () => setting('dailyPoints');
  const playerDocId = (key) => 'player-' + key.replace(/\//g, '_');
  const today = () => new Date().toLocaleDateString('fr-CA'); // AAAA-MM-JJ, heure locale

  // L'ancien profil « Administrateur » devient « Administratrice » : on reprend ses pièces,
  // sa collection et ses pièces décorées la première fois qu'on se connecte avec le nouveau pseudo.
  const OLD_ADMIN = 'administrateur';
  async function migrateOldAdmin(d) {
    const key = state.player.key;
    if (await d.getPlayer(playerDocId(key))) return;
    const old = await d.getPlayer(playerDocId(OLD_ADMIN));
    if (!old) return;
    const { id, ...rest } = old;
    await d.putPlayer({ ...rest, id: playerDocId(key), key, pseudo: state.player.name });
    for (const room of await d.listRooms(OLD_ADMIN)) {
      if (room.owner === OLD_ADMIN) await d.putRoom({ ...room, owner: key });
    }
    for (const m of await d.listMail(OLD_ADMIN)) await d.putMail({ ...m, to: key });
    await d.deletePlayer(playerDocId(OLD_ADMIN));
  }

  async function login(name) {
    const key = normalizePseudo(name);
    state.isAdmin = ADMIN_PSEUDOS.includes(key);
    // Le compte d'administration s'affiche « Admin » partout dans le jeu : le pseudo de
    // connexion n'apparaît jamais à l'écran (ni pré-rempli à l'accueil).
    const display = state.isAdmin ? ADMIN_DISPLAY_NAME : name;
    state.player = { key, name: display };
    if (state.isAdmin) { store(PSEUDO_KEY, null); store(SESSION_KEY, name); } else remember(name);
    $('#pseudoInput').value = state.isAdmin ? '' : $('#pseudoInput').value;
    $('#playerName').textContent = display;
    $('#playerName2').textContent = display;
    $('#homeAtelier').hidden = !state.isAdmin;
    $('#homeAdmin').hidden = !state.isAdmin;
    state.images = new Map();
    state.decos = new Map();
    let gained = 0;
    let isNew = false;
    try {
      if (state.isAdmin) await withFallback(migrateOldAdmin);
      const [images, rooms, envelopes, profile, mails, mine, settings, news] = await withFallback((d) => Promise.all([
        d.listCatalog(), d.listRooms(state.player.key), d.listEnvelopes(), d.getPlayer(playerDocId(state.player.key)),
        d.listMail(state.player.key), d.listMyProposals(state.player.key), d.getSettings(),
        d.listNews().catch(() => []),
      ]));
      setNews(news);
      if (state.isAdmin) (await withFallback((d) => d.listDecos()).catch(() => [])).forEach(addDeco);
      state.settings = { dailyPoints: DAILY_POINTS, ...(settings || {}) };
      state.mails = mails;
      state.myProposals = mine;
      images.sort((a, b) => (a.created || 0) - (b.created || 0)).forEach(addImageToLibrary);
      state.rooms = rooms;
      // Les pièces de concours des jours passés ne servent plus.
      const oldest = shiftDay(today(), -1);
      for (const r of rooms.filter((x) => x.contestDay && x.contestDay < oldest)) db.deleteRoom(r.id).catch(() => {});
      state.rooms = rooms.filter((x) => !x.contestDay || x.contestDay >= oldest);
      state.envelopes = sortEnvelopes(envelopes);
      isNew = !profile && !state.isAdmin;
      state.profile = profile || {
        id: playerDocId(state.player.key), points: 0, lastDaily: '', inventory: {},
        // Un nouveau joueur n'a pas besoin de l'historique des mises à jour.
        newsSeen: Math.max(Date.now(), ...state.news.map((n) => n.date || 0)),
      };
      state.profile.pseudo = display;
      state.profile.key = state.player.key;
      state.profile.firstSeen = state.profile.firstSeen || Date.now();
      state.profile.lastSeen = Date.now();
      saveProfile();
      state.profile.inventory = state.profile.inventory || {};
      state.profile.stamps = state.profile.stamps || 0;
      state.profile.stars = state.profile.stars || 0;
      state.profile.unlocks = state.profile.unlocks || {};
      // Étages déjà débloqués avant l'escalier offert : on le leur donne une fois.
      if (state.profile.unlocks.levels && !state.isAdmin) {
        const st = await sendStairsGift();
        if (st) {
          saveProfile();
          setTimeout(() => toast(`Un escalier gratuit 🪜 t'attend dans ta boîte aux lettres 💌 : c'est le cadeau des étages !`), 4000);
        }
      }
      // Cartes déjà assez remplies (par ex. si le nombre de tampons requis a baissé).
      if (convertStamps()) {
        saveProfile();
        setTimeout(() => toast('Ta carte de tampons est complète : tu gagnes une étoile 🌟 !'), 2500);
      }
      // Points du jour : une fois par jour, à la première connexion.
      if (state.profile.lastDaily !== today()) {
        state.profile.points = (state.profile.points || 0) + dailyPoints();
        state.profile.lastDaily = today();
        gained = dailyPoints();
        saveProfile();
      }
    } catch (e) {
      console.warn('Chargement impossible', e);
      toast('Impossible de charger tes pièces. Vérifie ta connexion puis recharge la page.');
      state.rooms = [];
      state.profile = state.profile || { id: playerDocId(state.player.key), points: 0, lastDaily: '', inventory: {} };
    }
    renderPoints();
    goHome();
    if (isNew) {
      // Premier passage : un message de bienvenue (pas les nouveautés) et un cadeau dans la boîte aux lettres.
      await sendWelcome();
      showWelcome(gained);
      renderNewsBadge();
      return;
    }
    if (gained) toast(`+${gained} 🪙 : tes points du jour ! Va les dépenser dans la boutique.`);
    showNewsPopup();
  }

  async function sendWelcome() {
    const gift = setting('welcomeGift');
    const m = {
      id: `welcome-${state.player.key}`, to: state.player.key,
      title: 'Bienvenue dans Ma petite pièce 🏠',
      text: `Coucou ${state.player.name} !\n\nTrès contente de te voir ici. Voici ${gift ? `${gift} 🪙 pour bien démarrer : ` : ''}va ouvrir des enveloppes dans la boutique, colle tes stickers dans tes pièces et amuse-toi bien !\n\nÀ bientôt,\nAdmin`,
      reward: gift, read: false, claimed: false, created: Date.now(),
    };
    try {
      await db.putMail(m);
      if (!state.mails.some((x) => x.id === m.id)) state.mails.push(m);
    } catch (e) { console.warn('Message de bienvenue impossible', e); }
    renderMailBadge();
  }
  function showWelcome(gained) {
    const gift = setting('welcomeGift');
    $('#welcomeTitle').textContent = `Bienvenue, ${state.player.name} ! 🏠`;
    const list = $('#welcomeList');
    list.innerHTML = '';
    [
      gained ? `🪙 Tu as reçu ${gained} pièces : tu en gagnes chaque jour en revenant jouer.` : '🪙 Tu gagnes des pièces chaque jour en revenant jouer.',
      '🛍️ Dans la boutique, achète des enveloppes pour gagner des stickers.',
      '🏠 Dans « Mes pièces », colle tes stickers pour décorer tes pièces.',
      '🏆 Chaque jour, un thème pour le concours : décore, publie, puis vote le lendemain.',
      gift ? `💌 Un cadeau de ${gift} 🪙 t'attend dans ta boîte aux lettres !` : '💌 Un petit mot t\'attend dans ta boîte aux lettres.',
    ].forEach((t) => { const li = document.createElement('li'); li.textContent = t; list.appendChild(li); });
    $('#welcomeDialog').hidden = false;
  }
  $('#welcomeOk').addEventListener('click', () => { $('#welcomeDialog').hidden = true; });
  $('#welcomeMail').addEventListener('click', () => { $('#welcomeDialog').hidden = true; openMail(); });

  // Relit le profil enregistré (pièces, stickers, étoiles) : utile si le jeu est
  // ouvert sur plusieurs appareils, pour ne pas écraser ce qui a changé ailleurs.
  let profileRefreshedAt = 0;
  async function refreshProfile() {
    if (!state.profile || !state.player) return;
    try {
      const fresh = await db.getPlayer(playerDocId(state.player.key));
      if (!fresh) return;
      for (const k of ['points', 'inventory', 'stars', 'stamps', 'unlocks', 'savedColors', 'contestChecked', 'contestWins', 'newsSeen', 'lastDaily', 'voteRewardDay', 'joinRewardDay', 'stairsGift', 'decos']) {
        if (fresh[k] !== undefined) state.profile[k] = fresh[k];
      }
      state.profile.inventory = state.profile.inventory || {};
      profileRefreshedAt = Date.now();
      renderPoints();
    } catch (e) { /* hors ligne : on garde la version en mémoire */ }
  }
  // En revenant sur le jeu après un moment, on relit le profil.
  // Retour sur la page après une longue absence : on recharge le jeu (nouvelle version, thème du jour,
  // prix, messages…), sans rien perdre. Pour une absence plus courte, on rafraîchit seulement l'essentiel.
  const AWAY_RELOAD_MS = 15 * 60 * 1000;
  let hiddenAt = null;
  // Rien d'en cours qu'un rechargement ferait perdre (fenêtre ouverte, envoi de stickers en préparation).
  const busyForReload = () => !!document.querySelector('.modal:not([hidden]), .duel-view:not([hidden]), .color-sheet:not([hidden])')
    || !screens.creations.hidden;
  function updateContestBanner() {
    const r = currentRoom();
    if (r && r.contestDay) $('#contestBannerText').textContent = `Pièce du concours · thème « ${themeOf(r.contestDay)} » · tous tes stickers sont disponibles ici`;
  }
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
    const away = hiddenAt ? Date.now() - hiddenAt : 0;
    hiddenAt = null;
    if (!state.profile) return;
    if (away >= AWAY_RELOAD_MS && !state.isAdmin && !busyForReload()) {
      try { select(null); await saveRoom(); } catch (e) { /* on recharge quand même */ }
      toast('Mise à jour de ta page…');
      setTimeout(() => location.reload(), 400);
      return;
    }
    await refreshSettings();
    renderContestTile();
    updateContestBanner();
    if (Date.now() - profileRefreshedAt < 30000) return;
    await refreshProfile();
    if (!screens.home.hidden) goHome();
    else if (!screens.room.hidden) renderLibrary();
  });

  function saveProfile() {
    renderPoints();
    return db.putPlayer(state.profile).catch((e) => {
      console.warn('Profil non sauvegardé', e);
      toast('Tes points n\'ont pas pu être enregistrés. Vérifie ta connexion.');
    });
  }

  // Icônes dessinées (pièce, étoile) du nouveau design.
  const COIN_SVG = (n) => `<svg width="${n}" height="${n}" viewBox="0 0 26 26" role="img" aria-label="pièces"><circle cx="13" cy="13" r="11" fill="#FFC84A" stroke="#5A3E3A" stroke-width="2.5"/><circle cx="13" cy="13" r="6" fill="none" stroke="#E39A1B" stroke-width="2.5"/></svg>`;
  const STAR_SVG = (n) => `<svg width="${n}" height="${n}" viewBox="0 0 28 28" role="img" aria-label="étoiles"><path d="M14 3 L17.5 10.5 L25.5 11.5 L19.5 17 L21.2 25 L14 21 L6.8 25 L8.5 17 L2.5 11.5 L10.5 10.5 Z" fill="#FFD96B" stroke="#5A3E3A" stroke-width="2.5" stroke-linejoin="round"/></svg>`;

  function renderPoints() {
    const pts = (state.profile && state.profile.points) || 0;
    const stars = (state.profile && state.profile.stars) || 0;
    // Pièces et étoiles dans la même bulle.
    document.querySelectorAll('.points-pill:not(#collectionTotal)').forEach((el) => {
      el.innerHTML = `<span class="pill-part">${pts} ${COIN_SVG(22)}</span><span class="pill-sep" aria-hidden="true"></span><span class="pill-part">${stars} ${STAR_SVG(22)}</span>`;
      el.title = `${pts} pièces · ${stars} étoile${stars > 1 ? 's' : ''} (une étoile = le sticker de ton choix)`;
    });
  }

  // Thème clair / sombre : « auto » suit l'appareil ; le choix est gardé sur cet appareil.
  const THEME_KEY = 'ma-petite-piece:theme';
  function applyTheme(mode) {
    const root = document.documentElement;
    if (mode === 'light' || mode === 'dark') root.dataset.theme = mode; else delete root.dataset.theme;
  }
  const themeMode = () => { const t = read(THEME_KEY); return t === 'light' || t === 'dark' ? t : 'auto'; };
  applyTheme(themeMode());

  const prefsDialog = $('#prefsDialog');
  function renderPrefs() {
    const mode = themeMode();
    document.querySelectorAll('.theme-choice').forEach((b) => {
      const on = b.dataset.themeMode === mode;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on);
    });
    const device = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'sombre' : 'clair';
    $('#themeHint').textContent = mode === 'auto'
      ? `Automatique : le jeu suit ton appareil (en ce moment : ${device}).`
      : `Le jeu reste ${mode === 'dark' ? 'sombre' : 'clair'}, quel que soit ton appareil.`;
    $('#prefsName').textContent = state.player ? state.player.name : '';
  }
  document.querySelectorAll('.theme-choice').forEach((b) => b.addEventListener('click', () => {
    const mode = b.dataset.themeMode;
    store(THEME_KEY, mode === 'auto' ? null : mode);
    applyTheme(mode);
    renderPrefs();
  }));
  $('#btnPrefs').addEventListener('click', () => { renderPrefs(); prefsDialog.hidden = false; });
  $('#prefsClose').addEventListener('click', () => { prefsDialog.hidden = true; });
  prefsDialog.addEventListener('click', (e) => { if (e.target === prefsDialog) prefsDialog.hidden = true; });

  // Se déconnecter : le bouton d'avant, maintenant dans les paramètres.
  $('#btnLogout').addEventListener('click', () => {
    prefsDialog.hidden = true;
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
    const rooms = realRooms().sort((a, b) => (b.updated || 0) - (a.updated || 0));
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
        : `<svg class="room-thumb" viewBox="0 0 1000 760" xmlns="http://www.w3.org/2000/svg">${roomSvg(r.colors, r.shape)}</svg>`;
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
      if (r.colors && r.colors.background) card.querySelector('.room-open').style.background = r.colors.background;
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
    const names = new Set(realRooms().map((r) => r.name));
    let i = realRooms().length + 1;
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
      const idMap = new Map();
      for (const st of r.stickers || []) {
        if (available(st.imageId) > 0) { const c = { ...st, id: uid() }; idMap.set(st.id, c.id); copy.stickers.push(c); }
        else missing++;
      }
      if (copy.lights) copy.lights = remapLights(copy.lights, idMap);
      if (copy.lights && !copy.lights.length) delete copy.lights;
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
    if (maintBlocked(r.contestDay ? 'contest' : 'rooms')) return;
    state.roomId = r.id;
    state.roomName = r.name;
    view.zoom = 1; view.x = 0; view.y = 0;
    state.colors = { ...DEFAULT_COLORS, ...r.colors };
    state.shape = normShape(r.shape);
    state.stickers = (r.stickers || [])
      .filter((s) => state.images.has(s.imageId))
      .map((s) => ({ ...s }));
    state.selectedId = null;
    state.ambient = Number.isFinite(r.ambient) ? clamp(r.ambient, AMBIENT_MIN, 100) : 100;
    state.lights = (r.lights || []).map((l) => ({ ...l }));
    lightSel = null;
    closeLightBar();
    closeAmbientBar();
    resetHistory();
    layersPanel.hidden = true;
    // La lumière est en test : seulement pour l'administratrice.
    $('#btnLight').hidden = !state.isAdmin;
    toolbar.querySelector('[data-act="light"]').hidden = !state.isAdmin;
    $('#roomName').value = r.name;
    // Pièce du concours : bouton « Publier », et retour vers le concours.
    screens.room.classList.toggle('contest-mode', !!r.contestDay);
    $('#btnContestPublish').hidden = !r.contestDay;
    $('#btnContestPublish2').hidden = !r.contestDay;
    $('#btnContestDraft').hidden = !r.contestDay;
    $('#btnBack').title = r.contestDay ? 'Retour au concours' : 'Retour à mes pièces';
    $('#btnBack .label-long').innerHTML = r.contestDay ? '&nbsp;Concours' : '&nbsp;Mes pièces';
    $('#contestBanner').hidden = !r.contestDay;
    if (r.contestDay) $('#contestBannerText').textContent = `Pièce du concours · thème « ${themeOf(r.contestDay)} » · tous tes stickers sont disponibles ici`;
    setSaveStatus('Sauvegardé ✓');
    syncColorInputs();
    drawRoom();
    renderStickers();
    showScreen('room');
  }

  // ---------------------------------------------------------------------------
  // Aménager la pièce : jardin, taille sur mesure, étages (options à débloquer avec des étoiles)
  // ---------------------------------------------------------------------------
  const UNLOCKS = {
    garden: { label: 'Jardin', cost: 2, desc: 'Transforme une pièce en jardin : haies, pelouse et ciel.' },
    size: { label: 'Taille sur mesure', cost: 1, desc: 'Choisis la largeur, la profondeur et la hauteur des murs.' },
    levels: { label: 'Étages', cost: 2, desc: 'Ajoute jusqu\'à 3 niveaux surélevés au fond de la pièce. Un escalier gratuit 🪜 t\'est envoyé par message.' },
  };
  const UNLOCK_ICONS = { garden: '🌳', size: '📐', levels: '🏢' };
  const unlockCost = (key) => setting('unlock_' + key);
  const isUnlocked = (key) => state.isAdmin || !!(state.profile.unlocks && state.profile.unlocks[key]);
  const shapeDialog = $('#shapeDialog');

  // L'escalier offert avec les étages : l'objet « Escalier » de la collection Meuble(s).
  function stairsSticker() {
    const list = [...state.images.values()].filter((img) => img.catalog && normalizeText(img.name) === 'escalier');
    const env = (img) => state.envelopes.find((e) => e.id === img.envelope);
    return list.find((img) => env(img) && normalizeText(env(img).name).startsWith('meuble')) || list[0] || null;
  }
  // Un seul escalier offert par joueur : un message avec le cadeau à récupérer dans la boîte aux lettres.
  async function sendStairsGift() {
    const st = stairsSticker();
    if (!st || state.profile.stairsGift) return null;
    const m = {
      id: `stairs-gift-${state.player.key}`, to: state.player.key,
      title: 'Ton escalier gratuit 🪜',
      text: `Avec les étages, voici un escalier gratuit (de la collection Meuble) pour monter au premier niveau de tes pièces ! Récupère-le et pose-le où tu veux.`,
      reward: 0, stickers: [st.id], read: false, claimed: false, created: Date.now(),
    };
    try {
      if (await db.createMail(m)) state.mails.push(m);
    } catch (e) {
      console.warn('Message de l\'escalier impossible', e);
      return null; // on réessaiera à la prochaine connexion
    }
    state.profile.stairsGift = true;
    renderMailBadge();
    return st;
  }

  async function unlock(key) {
    const u = UNLOCKS[key], cost = unlockCost(key);
    const stars = state.profile.stars || 0;
    if (stars < cost) {
      toast(`Il te faut ${cost} 🌟 pour débloquer « ${u.label} ». Remplis ta carte de tampons ou achète une étoile dans la boutique.`);
      return;
    }
    if (!(await askConfirm(`Débloquer « ${u.label} » pour ${cost} 🌟 ? ${u.desc} Ce sera valable pour toutes tes pièces.`, 'Débloquer'))) return;
    state.profile.stars = stars - cost;
    state.profile.unlocks = { ...(state.profile.unlocks || {}), [key]: true };
    const stairs = key === 'levels' ? await sendStairsGift() : null;
    saveProfile();
    toast(`« ${u.label} » est débloqué 🎉${stairs ? ' Un escalier gratuit 🪜 t\'attend dans ta boîte aux lettres 💌' : ''}`);
    renderShapeDialog();
  }

  // Modifie la forme de la pièce (avec retour en arrière possible).
  function changeShape(kind, fn) {
    checkpoint('shape-' + kind);
    const sh = JSON.parse(JSON.stringify(state.shape));
    fn(sh);
    state.shape = normShape(sh);
    drawRoom();
    scheduleSave();
  }

  function renderShapeDialog() {
    const sh = state.shape;
    const body = $('#shapeBody');
    const scroll = body.scrollTop;
    body.innerHTML = '';
    const section = (key, title, build) => {
      const sec = document.createElement('section');
      sec.className = 'shape-sec';
      sec.innerHTML = '<div class="shape-sec-head"><h3></h3></div><div class="shape-sec-body"></div>';
      sec.querySelector('h3').textContent = title;
      const inner = sec.querySelector('.shape-sec-body');
      if (isUnlocked(key)) {
        build(inner);
      } else {
        sec.classList.add('locked');
        sec.querySelector('h3').textContent = UNLOCKS[key].label;
        const p = document.createElement('p');
        p.className = 'muted';
        p.textContent = UNLOCKS[key].desc;
        const b = document.createElement('button');
        b.className = 'btn btn-primary';
        b.textContent = `🔓 Débloquer · ${unlockCost(key)} 🌟`;
        b.addEventListener('click', () => unlock(key));
        inner.append(p, b);
      }
      body.appendChild(sec);
    };
    const slider = (parent, label, value, min, max, onInput) => {
      const row = document.createElement('label');
      row.className = 'shape-slider';
      row.innerHTML = '<span class="shape-slider-label"></span><input type="range"><output></output>';
      row.querySelector('.shape-slider-label').textContent = label;
      const input = row.querySelector('input');
      input.min = min; input.max = max; input.step = 1; input.value = value;
      row.querySelector('output').textContent = value;
      input.disabled = max <= min;
      input.addEventListener('input', () => {
        row.querySelector('output').textContent = input.value;
        onInput(Number(input.value));
      });
      input.addEventListener('change', () => renderShapeDialog());
      parent.appendChild(row);
    };

    section('garden', 'Type', (inner) => {
      const row = document.createElement('div');
      row.className = 'shape-kind';
      for (const [kind, label] of [['room', '🏠 Pièce'], ['garden', '🌳 Jardin']]) {
        const b = document.createElement('button');
        b.className = 'btn' + (sh.kind === kind ? ' btn-primary' : '');
        b.textContent = label;
        b.setAttribute('aria-pressed', sh.kind === kind);
        b.addEventListener('click', () => {
          if (sh.kind === kind) return;
          changeShape('kind', (x) => { x.kind = kind; });
          // Couleurs de départ adaptées (on garde la couleur du fond choisie à la main).
          const bg = state.colors.background;
          state.colors = kind === 'garden' ? { ...GARDEN_COLORS } : { ...DEFAULT_COLORS, ...(bg && bg !== GARDEN_COLORS.background ? { background: bg } : {}) };
          syncColorInputs();
          drawRoom();
          renderShapeDialog();
        });
        row.appendChild(b);
      }
      inner.appendChild(row);
    });

    section('size', 'Taille', (inner) => {
      slider(inner, 'Largeur', sh.w, SIZE_MIN, SIZE_MAX, (v) => changeShape('w', (x) => { x.w = v; }));
      slider(inner, 'Profondeur', sh.d, SIZE_MIN, SIZE_MAX, (v) => changeShape('d', (x) => { x.d = v; }));
      if (sh.kind !== 'garden') slider(inner, 'Hauteur des murs', sh.h, WALL_MIN, WALL_MAX, (v) => changeShape('h', (x) => { x.h = v; }));
    });

    section('levels', 'Étages', (inner) => {
      const hint = document.createElement('p');
      hint.className = 'muted shape-hint';
      hint.textContent = 'Les étages se placent au fond de la pièce, dans le coin. Chacun est posé sur le précédent et ne peut pas être plus grand que lui.';
      inner.appendChild(hint);
      sh.levels.forEach((lv, i) => {
        const box = document.createElement('div');
        box.className = 'shape-level';
        box.innerHTML = '<div class="shape-level-head"><strong></strong><button class="btn btn-ghost">Retirer</button></div>';
        box.querySelector('strong').textContent = `Étage ${i + 1}`;
        box.querySelector('button').addEventListener('click', () => {
          changeShape('remove', (x) => { x.levels.splice(i); });
          renderShapeDialog();
        });
        const maxW = i ? sh.levels[i - 1].w : sh.w, maxD = i ? sh.levels[i - 1].d : sh.d;
        slider(box, 'Largeur', lv.w, 1, maxW, (v) => changeShape('lw' + i, (x) => { x.levels[i].w = v; }));
        slider(box, 'Profondeur', lv.d, 1, maxD, (v) => changeShape('ld' + i, (x) => { x.levels[i].d = v; }));
        slider(box, 'Hauteur', lv.h, 1, 4, (v) => changeShape('lh' + i, (x) => { x.levels[i].h = v; }));
        inner.appendChild(box);
      });
      if (sh.levels.length < LEVELS_MAX) {
        const add = document.createElement('button');
        add.className = 'btn';
        add.textContent = '＋ Ajouter un étage';
        add.addEventListener('click', () => {
          changeShape('add', (x) => {
            const prev = x.levels[x.levels.length - 1] || { w: x.w, d: x.d };
            x.levels.push({ w: Math.max(1, Math.ceil(prev.w * 0.6)), d: Math.max(1, Math.ceil(prev.d * 0.5)), h: 2 });
          });
          renderShapeDialog();
        });
        inner.appendChild(add);
      }
    });
    $('#shapeStars').textContent = `Tu as ${state.profile.stars || 0} 🌟`;
    body.scrollTop = scroll;
  }

  $('#btnShape').addEventListener('click', () => {
    renderShapeDialog();
    shapeDialog.hidden = false;
  });
  $('#shapeClose').addEventListener('click', () => { shapeDialog.hidden = true; });

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

  const libMode = () => (!bars.lib ? 'hidden' : bars.big ? 'big' : 'small');
  function applyBars() {
    screens.room.classList.toggle('hide-top', !bars.top);
    screens.room.classList.toggle('hide-lib', !bars.lib);
    screens.room.classList.toggle('lib-big', !!bars.big);
    tabTop.textContent = bars.top ? '▴' : '▾ Menu';
    tabTop.title = bars.top ? 'Cacher la barre du haut' : 'Afficher la barre du haut';
    tabTop.setAttribute('aria-expanded', bars.top);
    // La languette de la liste des stickers a 3 crans : grande → petite → cachée.
    const mode = libMode();
    const small = mqSmall.matches;
    tabLib.textContent = { big: '⤡', small: small ? '▾' : '‹', hidden: small ? '▴ Stickers' : '› Stickers' }[mode];
    tabLib.title = { big: 'Réduire la liste des stickers', small: 'Cacher la liste des stickers', hidden: 'Afficher la liste des stickers (en grand)' }[mode];
    tabLib.setAttribute('aria-expanded', bars.lib);
  }
  function toggleBar(name) {
    bars[name] = !bars[name];
    try { localStorage.setItem(BARS_KEY, JSON.stringify(bars)); } catch (e) { /* stockage indisponible */ }
    applyBars();
  }
  tabTop.addEventListener('click', () => toggleBar('top'));
  // Un appui change de cran : grande → petite → cachée → grande.
  tabLib.addEventListener('click', () => {
    const m = libMode();
    if (m === 'big') bars.big = false;
    else if (m === 'small') { bars.lib = false; bars.big = false; }
    else { bars.lib = true; bars.big = true; }
    try { localStorage.setItem(BARS_KEY, JSON.stringify(bars)); } catch (e) { /* stockage indisponible */ }
    applyBars();
  });
  mqSmall.addEventListener('change', applyBars);

  // Panneau « Couleurs » (bouton 🎨 à côté des flèches).
  const colorsPanel = $('#colorsPanel');
  function setColorsPanel(open) {
    colorsPanel.hidden = !open;
    $('#btnColors').setAttribute('aria-expanded', open);
    if (open && !layersPanel.hidden) closeLayers();
    if (open && !ambientBar.hidden) closeAmbientBar();
  }
  $('#btnColors').addEventListener('click', () => setColorsPanel(colorsPanel.hidden));
  $('#colorsClose').addEventListener('click', () => { setColorsPanel(false); closeColorPicker(false); });

  $('#roomName').addEventListener('input', (e) => {
    state.roomName = e.target.value.trim() || 'Sans nom';
    scheduleSave();
  });

  $('#btnBack').addEventListener('click', async () => {
    select(null);
    const contest = inContestRoom();
    await saveRoom();
    state.roomId = null;
    if (contest) { openContest(); return; }
    renderRoomList();
    showScreen('rooms');
  });

  // Sauvegarde ce qui reste en attente si on ferme la page.
  window.addEventListener('pagehide', () => { saveRoom(); });

  // ---------------------------------------------------------------------------
  // Boutique : acheter et ouvrir des enveloppes
  // ---------------------------------------------------------------------------
  const stickersOf = (envId) => [...state.images.values()].filter((img) => img.envelope === envId);
  // Ordre des enveloppes (Atelier et boutique) : champ « order », sinon date de création.
  function sortEnvelopes(list) {
    const key = (e) => (Number.isFinite(e.order) ? e.order : Infinity);
    return list.sort((a, b) => key(a) - key(b) || (a.created || 0) - (b.created || 0));
  }
  const envelopeExists = (id) => !!id && state.envelopes.some((e) => e.id === id);
  // Stickers retirés de leur enveloppe : on peut les y remettre depuis l'atelier.
  const archivedStickers = () => [...state.images.values()].filter((img) => img.catalog && img.archived && !envelopeExists(img.envelope));
  let shopReturnRoom = null; // pièce à rouvrir en quittant la boutique

  let shopShowOthers = false; // « autres enveloppes » : cachées à chaque ouverture de la boutique
  async function openShop(fromRoom) {
    if (maintBlocked('shop')) return;
    shopShowOthers = false;
    if (fromRoom && state.roomId) {
      select(null);
      await saveRoom();
      shopReturnRoom = state.roomId;
      state.roomId = null;
    } else {
      shopReturnRoom = null;
    }
    shopView = state.isAdmin ? 'choice' : 'envelopes'; // le décor est en test chez l'administratrice
    renderShop();
    showScreen('shop');
  }

  $('#homeShop').addEventListener('click', () => openShop(false));
  $('#btnLibShop').addEventListener('click', () => openShop(true));
  $('#shopBack').addEventListener('click', () => {
    if (state.isAdmin && shopView !== 'choice') { shopView = 'choice'; applyShopView(); window.scrollTo(0, 0); return; }
    if (shopReturnRoom && state.rooms.some((r) => r.id === shopReturnRoom)) {
      openRoom(shopReturnRoom);
    } else {
      goHome();
    }
  });

  // Petit dessin d'enveloppe, aux couleurs choisies dans l'atelier.
  const DEFAULT_SEAL = '#f0658a';
  function envelopeArt(env, cls = '') {
    const el = document.createElement('div');
    el.className = 'env ' + cls;
    el.style.setProperty('--env', env.color || ENVELOPE_COLORS[0]);
    if (env.seal) el.style.setProperty('--seal', env.seal);
    el.innerHTML = '<div class="env-back"></div><div class="env-pocket"></div><div class="env-flap"></div><div class="env-seal">★</div>';
    return el;
  }

  // Enveloppes du jour : quelques-unes au prix normal (les mêmes pour tout le monde,
  // tirées au sort chaque jour), les autres sont plus chères.
  function seededRank(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
    return h >>> 0;
  }
  // Choix de l'administratrice pour un jour donné (sinon tirage au sort, le même pour tous).
  const dailyPicks = (day) => {
    const all = state.settings.dailyEnvPicks;
    return (all && Array.isArray(all[day]) ? all[day] : []);
  };
  // Le dimanche, toutes les enveloppes sont au prix normal (réglable dans Paramétrage).
  const allNormalDay = (day = today()) => setting('sundayAllNormal') && new Date(day + 'T12:00:00').getDay() === 0;
  function dailyEnvelopeIds(day = today(), ignoreSunday = false) {
    const shop = state.envelopes.filter((env) => stickersOf(env.id).length);
    const n = setting('dailyEnvCount');
    if (!n || shop.length <= n || (!ignoreSunday && allNormalDay(day))) return new Set(shop.map((e) => e.id));
    const chosen = dailyPicks(day).filter((id) => shop.some((e) => e.id === id)).slice(0, n);
    // S'il en manque (aucun choix, ou moins de n), on complète au hasard.
    const rest = shop.filter((e) => !chosen.includes(e.id))
      .sort((a, b) => seededRank(day + a.id) - seededRank(day + b.id))
      .slice(0, n - chosen.length).map((e) => e.id);
    return new Set([...chosen, ...rest]);
  }
  const isDailyEnvelope = (env) => dailyEnvelopeIds().has(env.id);
  const basePrice = (env) => env.price ?? DEFAULT_PRICE;
  function shopPrice(env) {
    const base = basePrice(env);
    if (isDailyEnvelope(env)) return base;
    return Math.round(base * (1 + setting('offPricePct') / 100) / 5) * 5;
  }

  // La réduction du paquet ne vaut que pour les enveloppes du jour (si la sélection du jour est active).
  const packDiscount = (env) => {
    const daily = setting('dailyEnvCount');
    return !daily || isDailyEnvelope(env) ? setting('packDiscountPct') : 0;
  };
  // Prix d'un paquet de n enveloppes : n fois le prix, moins la réduction du paquet.
  function packPrice(env, n) {
    const full = shopPrice(env) * n;
    return Math.round(full * (1 - packDiscount(env) / 100));
  }

  // Boutique : un écran de choix (enveloppes ou décor), puis la page choisie.
  let shopView = 'envelopes';
  function applyShopView() {
    $('#shopChoice').hidden = shopView !== 'choice';
    $('#shopEnvView').hidden = shopView !== 'envelopes';
    $('#shopDecoView').hidden = shopView !== 'deco';
    $('#shopStamps').hidden = shopView !== 'envelopes';
    $('#shopTitle').textContent = shopView === 'envelopes' && state.isAdmin ? 'Enveloppes' : (shopView === 'deco' ? 'Décor' : 'Boutique');
    $('#shopBack').title = shopView === 'choice' || !state.isAdmin ? 'Retour' : 'Retour à la boutique';
  }

  // Infos sur les deux grandes cartes du choix.
  function renderShopChoice() {
    const shop = state.envelopes.filter((env) => stickersOf(env.id).length);
    const stars = state.profile ? state.profile.stars || 0 : 0;
    const stamps = state.profile ? state.profile.stamps || 0 : 0;
    $('#shopChoiceEnvSub').textContent = shop.length
      ? `${plural(shop.length, 'enveloppe')} en vente · tampons ${stamps}/${stampsPerStar()}${stars ? ` · ${plural(stars, 'étoile')} à utiliser` : ''}`
      : 'Bientôt des enveloppes';
    const daily = setting('dailyEnvCount');
    const nDaily = dailyEnvelopeIds().size;
    $('#shopChoiceEnvChip').textContent = !shop.length ? 'Reviens bientôt' : (allNormalDay() ? '☀️ Dimanche : toutes au prix normal !' : !daily || shop.length <= daily
      ? '⭐ Toutes au prix normal aujourd\'hui' : `⭐ ${plural(nDaily, 'enveloppe')} du jour au prix normal`);
    const walls = [...state.decos.values()].filter((d) => d.kind === 'wall').length;
    const floors = [...state.decos.values()].filter((d) => d.kind === 'floor').length;
    $('#shopChoiceDecoSub').textContent = walls + floors
      ? `${plural(walls, 'papier peint')} · ${plural(floors, 'sol')} en vente`
      : 'Papiers peints et sols pour tes pièces';
  }

  function renderShop() {
    applyShopView();
    renderShopChoice();
    renderPoints();
    $('#shopDaily').textContent = `${dailyPoints()} 🪙`;
    renderStampCard();
    const grid = $('#shopGrid');
    grid.innerHTML = '';
    const all = state.envelopes.filter((env) => stickersOf(env.id).length);
    $('#shopEmpty').hidden = all.length > 0;
    const daily = dailyEnvelopeIds();
    const featured = all.filter((env) => daily.has(env.id));
    const others = all.filter((env) => !daily.has(env.id));
    const heading = (title, sub) => {
      const h = document.createElement('div');
      h.className = 'shop-heading';
      h.innerHTML = '<h2></h2><p class="muted"></p>';
      h.querySelector('h2').textContent = title;
      h.querySelector('p').textContent = sub;
      grid.appendChild(h);
    };
    const envs = [];
    if (others.length) {
      heading('⭐ Les enveloppes du jour', 'Au prix normal aujourd\'hui · elles changent à minuit');
      envs.push(...featured, 'toggle');
      if (shopShowOthers) envs.push(null, ...others);
    } else {
      if (allNormalDay() && featured.length && setting('dailyEnvCount')) heading('☀️ Dimanche : toutes les enveloppes au prix normal !', 'Profites-en pour compléter ta collection · retour des enveloppes du jour demain');
      envs.push(...featured);
    }
    for (const env of envs) {
      if (env === 'toggle') {
        // Les autres enveloppes restent cachées tant qu'on n'appuie pas sur ce bouton.
        const row = document.createElement('div');
        row.className = 'shop-more';
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn';
        b.textContent = shopShowOthers ? '▲ Masquer les autres enveloppes' : `▼ Voir les autres enveloppes (${others.length})`;
        b.addEventListener('click', () => { shopShowOthers = !shopShowOthers; renderShop(); });
        row.appendChild(b);
        grid.appendChild(row);
        continue;
      }
      if (!env) { heading('Les autres enveloppes', `Prix +${setting('offPricePct')} % aujourd'hui : guette-les dans les enveloppes du jour !`); continue; }
      const list = stickersOf(env.id);
      const got = list.filter((img) => owned(img.id) > 0).length;
      const price = shopPrice(env);
      const card = document.createElement('article');
      card.className = 'shop-card';
      card.innerHTML = `
        <button class="shop-art" title="Voir les stickers de cette enveloppe"></button>
        <h3 class="shop-name"></h3>
        <p class="shop-progress"><span class="bar"><span></span></span><span class="txt"></span></p>
        <div class="shop-buttons">
          <button class="btn btn-primary shop-buy"></button>
          <button class="btn shop-buy5"></button>
        </div>`;
      card.querySelector('.shop-art').appendChild(envelopeArt(env));
      card.querySelector('.shop-name').textContent = env.name || 'Enveloppe';
      if (others.length && daily.has(env.id)) card.classList.add('shop-daily');
      else if (others.length) card.classList.add('shop-other');
      card.querySelector('.bar span').style.width = `${(got / list.length) * 100}%`;
      card.querySelector('.txt').textContent = `${got}/${list.length} stickers`;
      const buy = card.querySelector('.shop-buy');
      buy.textContent = `Acheter · ${price} 🪙`;
      buy.disabled = state.profile.points < price;
      card.querySelector('.shop-art').addEventListener('click', () => showEnvelope(env));
      buy.addEventListener('click', () => buyEnvelope(env));
      const buy5 = card.querySelector('.shop-buy5');
      buy5.textContent = `×${multiBuy()} · ${packPrice(env, multiBuy())} 🪙${packDiscount(env) ? ` · −${packDiscount(env)} %` : ''}`;
      buy5.title = `Acheter ${multiBuy()} enveloppes « ${env.name} » d'un coup`;
      buy5.disabled = state.profile.points < packPrice(env, multiBuy());
      buy5.addEventListener('click', () => buyEnvelopes(env, multiBuy()));
      grid.appendChild(card);
    }
  }

  // Contenu d'une enveloppe : les stickers obtenus, et la silhouette des autres.
  const envDialog = $('#envDialog');
  function showEnvelope(env) {
    const list = stickersOf(env.id);
    $('#envTitle').textContent = env.name || 'Enveloppe';
    const got = list.filter((img) => owned(img.id) > 0).length;
    $('#envSub').textContent = `${list.length} stickers possibles · ${got} déjà obtenu${got > 1 ? 's' : ''} · un seul par enveloppe, tiré au sort`;
    const grid = $('#envGrid');
    grid.innerHTML = '';
    grid.classList.add('env-grid-small');
    // Tous les stickers sont montrés en vrai (en petit), avec leur chance de sortir.
    const totalWeight = list.reduce((sum, img) => sum + RARITIES[img.rarity || 'common'].weight, 0);
    const order = { epic: 0, rare: 1, common: 2 };
    for (const img of [...list].sort((a, b) => order[a.rarity || 'common'] - order[b.rarity || 'common'])) {
      const n = owned(img.id);
      const chance = Math.round((RARITIES[img.rarity || 'common'].weight / totalWeight) * 100);
      const cell = document.createElement('div');
      cell.className = 'env-item' + (n ? ' owned' : '');
      cell.dataset.rarity = img.rarity || 'common';
      cell.title = `${img.name} · ${RARITIES[img.rarity || 'common'].label} · ${chance || '<1'} % de chance`;
      cell.innerHTML = `<div class="env-item-img"><img alt="">${n ? `<span class="env-owned">✓${n > 1 ? ` ×${n}` : ''}</span>` : ''}</div>
        <span class="env-item-name"></span>
        <span class="env-chance"><span class="rarity-dot"></span>${chance || '<1'} %</span>`;
      cell.querySelector('img').src = img.url;
      cell.querySelector('.env-item-name').textContent = img.name;
      grid.appendChild(cell);
    }
    const price = shopPrice(env);
    const buy = $('#envBuy');
    buy.textContent = `Acheter · ${price} 🪙`;
    buy.disabled = state.profile.points < price;
    buy.onclick = () => { envDialog.hidden = true; buyEnvelope(env); };
    const buy5 = $('#envBuy5');
    buy5.textContent = `×${multiBuy()} · ${packPrice(env, multiBuy())} 🪙${packDiscount(env) ? ` · −${packDiscount(env)} %` : ''}`;
    buy5.disabled = state.profile.points < packPrice(env, multiBuy());
    buy5.onclick = () => { envDialog.hidden = true; buyEnvelopes(env, multiBuy()); };
    const starBtn = $('#envStar');
    starBtn.hidden = (state.profile.stars || 0) < 1;
    starBtn.onclick = () => { envDialog.hidden = true; openStarPicker(env, () => renderShop()); };
    envDialog.hidden = false;
  }
  $('#envClose').addEventListener('click', () => { envDialog.hidden = true; });
  envDialog.addEventListener('click', (e) => { if (e.target === envDialog) envDialog.hidden = true; });

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
    const price = shopPrice(env);
    if (!list.length) return;
    if (state.profile.points < price) {
      toast(`Il te manque ${price - state.profile.points} 🪙 pour cette enveloppe.`);
      return;
    }
    buying = true;
    const pick = drawSticker(list);
    const before = owned(pick.id);
    state.profile.points -= price;
    state.profile.inventory[pick.id] = before + 1;
    // Carte de tampons : un tampon par enveloppe achetée.
    state.profile.stamps = (state.profile.stamps || 0) + 1;
    let starWon = false;
    if (convertStamps()) starWon = true;
    renderPoints();
    saveProfile();
    await playOpening(env, pick, before + 1, { starWon });
    buying = false;
    renderShop();
  }

  // Acheter plusieurs enveloppes identiques d'un coup : autant de tirages et de
  // tampons, puis tous les stickers obtenus sont montrés ensemble.
  const multiDialog = $('#multiDialog');
  async function buyEnvelopes(env, n) {
    if (buying) return;
    const list = stickersOf(env.id);
    const price = shopPrice(env);
    if (!list.length) return;
    const total = packPrice(env, n);
    if (state.profile.points < total) {
      toast(`Il te manque ${total - state.profile.points} 🪙 pour ${n} enveloppes.`);
      return;
    }
    buying = true;
    const results = [];
    for (let i = 0; i < n; i++) {
      const pick = drawSticker(list);
      const isNew = owned(pick.id) === 0;
      state.profile.inventory[pick.id] = owned(pick.id) + 1;
      results.push({ img: pick, isNew });
    }
    state.profile.points -= total;
    state.profile.stamps = (state.profile.stamps || 0) + n;
    const starsWon = convertStamps();
    renderPoints();
    saveProfile();
    await playMultiOpening(env, results, starsWon);
    buying = false;
    renderShop();
  }

  async function playMultiOpening(env, results, starsWon) {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const wait = (ms) => new Promise((r) => setTimeout(r, reduced ? 0 : ms));
    $('#multiTitle').textContent = `${results.length} enveloppes « ${env.name || 'Enveloppe'} »`;
    const stageEl = $('#multiStage');
    stageEl.innerHTML = '';
    const art = envelopeArt(env, 'env-big');
    stageEl.appendChild(art);
    stageEl.hidden = false;
    const grid = $('#multiGrid');
    grid.innerHTML = '';
    grid.hidden = true;
    $('#multiFoot').hidden = true;
    multiDialog.hidden = false;
    art.classList.add('shaking');
    await wait(900);
    stageEl.hidden = true;

    // Les stickers apparaissent l'un après l'autre.
    results.forEach(({ img, isNew }, i) => {
      const cell = document.createElement('div');
      cell.className = 'multi-item';
      cell.dataset.rarity = img.rarity || 'common';
      cell.style.animationDelay = `${i * 0.15}s`;
      cell.innerHTML = `<div class="env-item-img"><img alt=""></div><span class="env-item-name"></span><span class="rarity-tag"></span>${isNew ? '<span class="multi-new">Nouveau !</span>' : ''}`;
      cell.querySelector('img').src = img.url;
      cell.querySelector('.env-item-name').textContent = img.name;
      cell.querySelector('.rarity-tag').textContent = RARITIES[img.rarity || 'common'].label;
      grid.appendChild(cell);
    });
    grid.hidden = false;
    const fresh = results.filter((r) => r.isNew).length;
    $('#multiText').textContent = fresh
      ? `${fresh} nouveau${fresh > 1 ? 'x' : ''} sticker${fresh > 1 ? 's' : ''} pour ta collection !`
      : 'Que des doubles cette fois… tu peux les vendre dans ta collection.';
    const stamp = $('#multiStamp');
    stamp.classList.toggle('won', starsWon > 0);
    stamp.textContent = starsWon
      ? `+${results.length} tampons · carte complète ! Tu gagnes ${starsWon > 1 ? `${starsWon} étoiles` : 'une étoile'} 🌟`
      : `+${results.length} tampons · ${state.profile.stamps}/${stampsPerStar()}`;
    const price = packPrice(env, results.length);
    const again = $('#multiAgain');
    again.textContent = `Encore ×${results.length} · ${price} 🪙`;
    again.disabled = state.profile.points < price;
    again.onclick = () => { multiDialog.hidden = true; buyEnvelopes(env, results.length); };
    await wait(results.length * 150);
    $('#multiFoot').hidden = false;
  }
  $('#multiClose').addEventListener('click', () => { multiDialog.hidden = true; });

  // ---------------------------------------------------------------------------
  // Carte de tampons et étoiles
  // ---------------------------------------------------------------------------
  // Chaque carte complète devient une étoile ; les tampons en trop restent sur la carte suivante.
  function convertStamps() {
    let won = 0;
    while ((state.profile.stamps || 0) >= stampsPerStar()) {
      state.profile.stamps -= stampsPerStar();
      state.profile.stars = (state.profile.stars || 0) + 1;
      won++;
    }
    return won;
  }

  function renderStampCard() {
    const n = state.profile.stamps || 0;
    const stars = state.profile.stars || 0;
    const grid = $('#stampGrid');
    grid.innerHTML = '';
    for (let i = 0; i < stampsPerStar(); i++) {
      const cell = document.createElement('span');
      const last = i === stampsPerStar() - 1;
      cell.className = 'stamp' + (i < n ? ' on' : '') + (last ? ' reward' : '');
      // Chaque tampon est un peu de travers, comme un vrai coup de tampon.
      cell.style.setProperty('--tilt', `${((i * 47) % 30) - 15}deg`);
      cell.textContent = i < n ? '★' : (last ? '🌟' : i + 1);
      grid.appendChild(cell);
    }
    $('#stampText').textContent = `${n}/${stampsPerStar()} tampons · encore ${stampsPerStar() - n} enveloppe${stampsPerStar() - n > 1 ? 's' : ''} pour gagner une étoile`;
    $('#starCount').textContent = `🌟 ×${stars}`;
    // Bouton de la barre du haut : tampons en cours (et étoiles disponibles).
    $('#shopStampsText').textContent = ` ${n}/${stampsPerStar()}`;
    const use = $('#btnUseStar');
    use.disabled = stars < 1 || !collectible().length;
    use.textContent = stars ? 'Utiliser une étoile' : 'Pas encore d\'étoile';
    const buy = $('#btnBuyStar');
    buy.textContent = `Acheter une étoile · ${starPrice()} 🪙`;
    buy.disabled = state.profile.points < starPrice();
    buy.title = buy.disabled ? `Il te manque ${starPrice() - state.profile.points} 🪙` : '';
  }

  // Une étoile peut aussi s'acheter avec des pièces.
  $('#btnBuyStar').addEventListener('click', async () => {
    if (state.profile.points < starPrice()) return;
    if (!(await askConfirm(`Acheter une étoile 🌟 pour ${starPrice()} 🪙 ?`, 'Acheter'))) return;
    if (state.profile.points < starPrice()) return;
    state.profile.points -= starPrice();
    state.profile.stars = (state.profile.stars || 0) + 1;
    saveProfile();
    renderPoints();
    renderStampCard();
    renderShop();
    toast('Étoile achetée 🌟 ! Utilise-la pour choisir le sticker que tu veux.');
  });

  // Avec une étoile : choisir n'importe quel sticker, dans n'importe quelle enveloppe.
  const starDialog = $('#starDialog');
  let starAfter = () => renderShop();
  // onlyEnv : ne proposer que les stickers d'une enveloppe (depuis le classeur ou l'aperçu d'une enveloppe).
  function openStarPicker(onlyEnv = null, after = () => renderShop()) {
    if ((state.profile.stars || 0) < 1) return;
    starAfter = after;
    $('#starTitle').textContent = onlyEnv ? `Choisis ton sticker « ${onlyEnv.name || 'Enveloppe'} » 🌟` : 'Choisis ton sticker 🌟';
    $('.star-sub').textContent = onlyEnv
      ? `Ton étoile te permet de prendre le sticker que tu veux dans « ${onlyEnv.name || 'Enveloppe'} ».`
      : 'Ton étoile te permet de prendre le sticker que tu veux, dans n\'importe quelle enveloppe.';
    const body = $('#starList');
    body.innerHTML = '';
    const envs = onlyEnv ? [onlyEnv] : state.envelopes;
    for (const env of envs.filter((e) => stickersOf(e.id).length)) {
      const h = document.createElement('h3');
      h.className = 'star-env';
      h.textContent = env.name || 'Enveloppe';
      body.appendChild(h);
      const grid = document.createElement('div');
      grid.className = 'env-grid';
      for (const img of stickersOf(env.id)) {
        const n = owned(img.id);
        const cell = document.createElement('button');
        cell.className = 'env-item star-pick';
        cell.dataset.rarity = img.rarity || 'common';
        cell.innerHTML = '<div class="env-item-img"><img alt=""></div><span class="env-item-name"></span><span class="rarity-tag"></span>';
        cell.querySelector('img').src = img.url;
        cell.querySelector('.env-item-name').textContent = n ? `${img.name} ×${n}` : `${img.name} · nouveau !`;
        cell.querySelector('.rarity-tag').textContent = RARITIES[img.rarity || 'common'].label;
        cell.addEventListener('click', () => useStar(env, img));
        grid.appendChild(cell);
      }
      body.appendChild(grid);
    }
    starDialog.hidden = false;
  }
  $('#btnUseStar').addEventListener('click', () => { $('#stampDialog').hidden = true; openStarPicker(); });
  $('#shopStamps').addEventListener('click', () => { renderStampCard(); $('#stampDialog').hidden = false; });
  $('#stampClose').addEventListener('click', () => { $('#stampDialog').hidden = true; });
  $('#stampDialog').addEventListener('click', (e) => { if (e.target.id === 'stampDialog') $('#stampDialog').hidden = true; });
  $('#starClose').addEventListener('click', () => { starDialog.hidden = true; });

  async function useStar(env, img) {
    if (!(await askConfirm(`Utiliser une étoile 🌟 pour obtenir « ${img.name} » ?`, 'Oui !'))) return;
    if ((state.profile.stars || 0) < 1) return;
    starDialog.hidden = true;
    state.profile.stars -= 1;
    const count = owned(img.id) + 1;
    state.profile.inventory[img.id] = count;
    saveProfile();
    await playOpening(env, img, count, { withStar: true });
    starAfter();
  }

  // Animation : l'enveloppe tremble, s'ouvre, et le sticker en sort.
  const openDialog = $('#openDialog');
  async function playOpening(env, img, count, opts = {}) {
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
    $('#openText').textContent = (opts.withStar ? 'Obtenu avec une étoile ! ' : '') + (count === 1
      ? 'Nouveau sticker pour ta collection !'
      : `Tu en as maintenant ${count} exemplaires.`);
    // Tampon gagné (pas pour un sticker choisi avec une étoile).
    const stampEl = $('#openStamp');
    stampEl.hidden = !!opts.withStar;
    stampEl.classList.toggle('won', !!opts.starWon);
    stampEl.textContent = opts.starWon
      ? `Carte complète ! Tu gagnes une étoile 🌟`
      : `+1 tampon · ${state.profile.stamps}/${stampsPerStar()}`;
    const price = shopPrice(env);
    const again = $('#openAgain');
    again.hidden = !!opts.withStar;
    again.textContent = `Une autre · ${price} 🪙`;
    again.disabled = state.profile.points < price;
    again.onclick = () => { openDialog.hidden = true; buyEnvelope(env); };
    result.hidden = false;
  }
  $('#openClose').addEventListener('click', () => { openDialog.hidden = true; });

  // ---------------------------------------------------------------------------
  // Atelier : créer les enveloppes et leurs stickers (administratrice)
  // ---------------------------------------------------------------------------
  // Atelier : d'abord la liste des enveloppes, puis une seule enveloppe ouverte à la fois.
  let atelierOpen = null; // id d'enveloppe, 'archives' ou null (liste)

  function openAtelier() {
    if (!state.isAdmin) return;
    atelierOpen = null;
    atelierDaily = false;
    atelierReorder = false;
    $('#atelierSearch').value = '';
    renderAtelier();
    refreshCoffreCount();
    showScreen('atelier');
  }
  $('#homeAtelier').addEventListener('click', openAtelier);
  $('#atelierBack').addEventListener('click', goHome);
  $('#btnGivePoints').addEventListener('click', () => {
    state.profile.points += 100;
    renderPoints();
    saveProfile();
    toast('+100 🪙 ajoutés à ton compte.');
  });

  $('#btnNewEnvelope').addEventListener('click', async () => {
    const name = await askText('Nom de la nouvelle enveloppe :', 'Créer', `Enveloppe ${state.envelopes.length + 1}`);
    if (!name) return;
    const env = {
      id: uid(), name, price: setting('defaultEnvPrice'),
      color: ENVELOPE_COLORS[state.envelopes.length % ENVELOPE_COLORS.length],
      created: Date.now(),
    };
    // Rangée à la fin (après celles déjà ordonnées).
    if (state.envelopes.some((e) => Number.isFinite(e.order))) env.order = state.envelopes.length;
    state.envelopes.push(env);
    db.putEnvelope(env).catch(() => toast('L\'enveloppe n\'a pas pu être enregistrée.'));
    atelierOpen = env.id;
    renderAtelier();
  });

  const envSaveTimers = {};
  function saveEnvelopeSoon(env) {
    clearTimeout(envSaveTimers[env.id]);
    envSaveTimers[env.id] = setTimeout(() => {
      db.putEnvelope(env).catch(() => toast('L\'enveloppe n\'a pas pu être enregistrée.'));
    }, 500);
  }

  const maxPending = () => setting('maxPending');

  function renderAtelier() {
    if (atelierOpen === 'archives' ? !archivedStickers().length : atelierOpen && !state.envelopes.some((e) => e.id === atelierOpen)) atelierOpen = null;
    const detail = !!atelierOpen;
    $('#atelierHome').hidden = detail;
    $('#atelierDetailBar').hidden = !detail;
    const listEl = $('#atelierList');
    listEl.innerHTML = '';
    if (!detail) {
      $('#atelierEmpty').hidden = state.envelopes.length > 0;
      $('#atelierSearch').hidden = atelierReorder || atelierDaily;
      $('#atelierOrder').textContent = atelierReorder ? '✓ Terminé' : '↕️ Ordre de la boutique';
      $('#atelierOrder').classList.toggle('btn-primary', atelierReorder);
      $('#atelierOrder').hidden = state.envelopes.length < 2 || atelierDaily;
      $('#atelierDaily').textContent = atelierDaily ? '✓ Terminé' : '⭐ Enveloppes du jour';
      $('#atelierDaily').classList.toggle('btn-primary', atelierDaily);
      $('#atelierDaily').hidden = atelierReorder;
      if (atelierReorder) renderAtelierOrder(listEl);
      else if (atelierDaily) renderAtelierDaily(listEl);
      else renderAtelierTiles(listEl);
      return;
    }
    $('#atelierEmpty').hidden = true;
    window.scrollTo(0, 0);
    if (atelierOpen === 'archives') {
      $('#atelierDetailTitle').textContent = '📦 Archives';
      renderArchives(listEl);
      return;
    }
    for (const env of state.envelopes.filter((e) => e.id === atelierOpen)) {
      $('#atelierDetailTitle').textContent = env.name || 'Enveloppe';
      const sec = document.createElement('section');
      sec.className = 'atelier-env';
      sec.innerHTML = `
        <div class="atelier-head">
          <div class="atelier-art"></div>
          <div class="atelier-fields">
            <label class="atelier-field"><span>Nom</span><input class="field" data-f="name" maxlength="40"></label>
            <label class="atelier-field small"><span>Prix 🪙</span><input class="field" data-f="price" type="number" min="0" step="10"></label>
            <div class="atelier-field small"><span>Couleur</span><button type="button" class="swatch-btn env-swatch" data-f="color" title="Couleur de l'enveloppe"></button></div>
            <div class="atelier-field small"><span>Rond</span><button type="button" class="swatch-btn env-swatch" data-f="seal" title="Couleur du petit rond (cachet)"></button></div>
          </div>
          <button class="btn btn-ghost atelier-del" title="Supprimer l'enveloppe">🗑️</button>
        </div>
        <p class="atelier-count muted"></p>
        <div class="atelier-grid"></div>
        <div class="atelier-add-row">
          <label class="btn atelier-add">＋ Ajouter des stickers<input type="file" accept="image/*" multiple hidden></label>
          <button type="button" class="btn atelier-unfiled">📥 Stickers à ranger <span class="atelier-unfiled-n"></span></button>
        </div>`;
      sec.querySelector('.atelier-art').appendChild(envelopeArt(env));
      const fName = sec.querySelector('[data-f="name"]');
      const fPrice = sec.querySelector('[data-f="price"]');
      const fColor = sec.querySelector('[data-f="color"]');
      fName.value = env.name;
      fPrice.value = env.price ?? DEFAULT_PRICE;
      const fSeal = sec.querySelector('[data-f="seal"]');
      const paintSwatches = () => {
        fColor.style.background = env.color || ENVELOPE_COLORS[0];
        fSeal.style.background = env.seal || DEFAULT_SEAL;
      };
      paintSwatches();
      fName.addEventListener('input', () => {
        env.name = fName.value.trim() || 'Enveloppe';
        $('#atelierDetailTitle').textContent = env.name;
        saveEnvelopeSoon(env);
      });
      fPrice.addEventListener('input', () => {
        env.price = Math.max(0, Math.round(Number(fPrice.value) || 0));
        saveEnvelopeSoon(env);
      });
      // Même palette que pour les pièces : couleurs en mémoire, couleurs de base, curseurs.
      const pickFor = (field, label) => () => openColorPickerFor({
        label: `${label} · ${env.name || 'Enveloppe'}`,
        stickers: stickersOf(env.id),
        get: () => (field === 'seal' ? env.seal || DEFAULT_SEAL : env.color || ENVELOPE_COLORS[0]),
        set: (hex) => {
          env[field] = hex;
          const art = sec.querySelector('.env');
          art.style.setProperty(field === 'seal' ? '--seal' : '--env', hex);
          paintSwatches();
          saveEnvelopeSoon(env);
        },
      });
      fColor.addEventListener('click', pickFor('color', 'Enveloppe'));
      fSeal.addEventListener('click', pickFor('seal', 'Petit rond'));

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
          <select class="atelier-rarity" aria-label="Rareté">${Object.entries(RARITIES).map(([k, r]) => `<option value="${k}">${r.label}</option>`).join('')}</select>
          <select class="atelier-move" aria-label="Enveloppe" title="Changer d'enveloppe"></select>
          <button class="atelier-item-del" title="Retirer et archiver">✕</button>
          <label class="atelier-item-img" title="Changer le dessin">🖼️<input type="file" accept="image/*" hidden></label>
          <button class="atelier-item-dl" title="Télécharger le dessin">⬇️</button>
          <button class="atelier-item-tag" type="button"></button>`;
        cell.querySelector('img').src = img.url;
        const tagBtn = cell.querySelector('.atelier-item-tag');
        const paintTag = () => {
          cell.classList.toggle('to-fix', !!img.toFix);
          tagBtn.textContent = '🏷️';
          tagBtn.title = img.toFix ? 'À modifier (touche pour retirer le tag)' : 'Marquer « à modifier » : il apparaîtra dans le Coffre';
          tagBtn.setAttribute('aria-pressed', img.toFix ? 'true' : 'false');
        };
        paintTag();
        tagBtn.addEventListener('click', async () => { await setToFix(img, !img.toFix); paintTag(); });
        const nameIn = cell.querySelector('.atelier-name');
        nameIn.value = img.name;
        nameIn.addEventListener('change', () => {
          img.name = nameIn.value.trim() || 'Sticker';
          db.updateImage(img.id, { name: img.name }).catch(() => toast('Le nom n\'a pas pu être enregistré.'));
        });
        const sel = cell.querySelector('.atelier-rarity');
        sel.value = img.rarity || 'common';
        sel.addEventListener('change', () => {
          img.rarity = sel.value;
          cell.dataset.rarity = img.rarity;
          db.updateImage(img.id, { rarity: img.rarity }).catch(() => toast('La rareté n\'a pas pu être enregistrée.'));
        });
        cell.querySelector('.atelier-item-dl').addEventListener('click', () => downloadImage(img.url, img.name));
        const imgIn = cell.querySelector('.atelier-item-img input');
        imgIn.addEventListener('change', async () => {
          const file = imgIn.files[0];
          imgIn.value = '';
          if (file) await replaceStickerImage(img, file);
        });
        const moveSel = cell.querySelector('.atelier-move');
        for (const e of state.envelopes) moveSel.add(new Option('✉️ ' + (e.name || 'Enveloppe'), e.id));
        moveSel.value = env.id;
        moveSel.addEventListener('change', () => moveToEnvelope(img, moveSel.value));
        cell.querySelector('.atelier-item-del').addEventListener('click', async () => {
          if (!(await askConfirm(`Retirer « ${img.name} » de l'enveloppe ? Il sera archivé en bas de l'atelier : tu pourras le remettre dans une enveloppe quand tu veux. Les joueurs qui l'ont le gardent.`, 'Archiver'))) return;
          await archiveSticker(img);
          renderAtelier();
        });
        grid.appendChild(cell);
      }

      const fileIn = sec.querySelector('.atelier-add input[type="file"]');
      fileIn.addEventListener('change', async () => {
        const addBtn = sec.querySelector('.atelier-add');
        addBtn.classList.add('busy');
        await importFiles(fileIn.files, env.id);
        fileIn.value = '';
        renderAtelier();
      });

      // Stickers acceptés (proposés par les joueurs) pas encore rangés : les ajouter ici.
      const unfiledBtn = sec.querySelector('.atelier-unfiled');
      const nUnfiled = unfiledProposals().length;
      unfiledBtn.querySelector('.atelier-unfiled-n').textContent = nUnfiled ? `(${nUnfiled})` : '';
      unfiledBtn.disabled = !nUnfiled;
      unfiledBtn.title = nUnfiled ? 'Choisir des stickers acceptés à ranger dans cette enveloppe' : 'Aucun sticker à ranger pour l\'instant';
      unfiledBtn.addEventListener('click', () => openUnfiledPicker(env));

      sec.querySelector('.atelier-del').addEventListener('click', async () => {
        const n = stickersOf(env.id).length;
        const msg = n
          ? `Supprimer « ${env.name} » ? Ses ${n} stickers seront archivés en bas de l'atelier : tu pourras les remettre dans une autre enveloppe.`
          : `Supprimer « ${env.name} » ?`;
        if (!(await askConfirm(msg, 'Supprimer'))) return;
        // Ses stickers partent aux archives (les joueurs les gardent).
        for (const img of stickersOf(env.id)) archiveSticker(img);
        state.envelopes = state.envelopes.filter((x) => x.id !== env.id);
        db.deleteEnvelope(env.id).catch(() => toast('L\'enveloppe n\'a pas pu être supprimée.'));
        renderAtelier();
      });
      listEl.appendChild(sec);
    }
  }


  // ---------------------------------------------------------------------------
  // Décor : papiers peints et sols (en test chez l'administratrice)
  // Vendus un par un. Dans une pièce : un papier peint pour les deux murs, ou pour un seul.
  // ---------------------------------------------------------------------------
  let decoAsPlayer = false; // admin : ne voir que ses achats, comme un joueur
  const decoOwned = (id) => (state.isAdmin && !decoAsPlayer) || !!(state.profile && state.profile.decos && state.profile.decos[id]);
  const decoByName = (a, b) => (a.collection || '').localeCompare(b.collection || '', 'fr') || (a.name || '').localeCompare(b.name || '', 'fr');
  const decoList = (kind) => [...state.decos.values()].filter((d) => d.kind === kind).sort(decoByName);
  function decoThumb(d) {
    const el = document.createElement('span');
    el.className = 'deco-thumb';
    el.style.backgroundImage = `url("${d.url}")`;
    return el;
  }
  // Titres de collection au-dessus des décors (un décor se vend toujours seul).
  function decoGroups(list, container, makeItem) {
    let last = null;
    for (const d of list) {
      const c = d.collection || 'Sans collection';
      if (c !== last) {
        const h = document.createElement('h4');
        h.className = 'deco-group';
        h.textContent = c;
        container.appendChild(h);
        last = c;
      }
      container.appendChild(makeItem(d));
    }
  }

  // Choix dans une pièce : un carré à côté de Mur G, Mur D et Sol, avec l'aperçu du décor posé.
  const decoPicker = $('#decoPicker');
  const DECO_SLOTS = {
    wallLeftDeco: { kind: 'wall', title: 'Papier peint · mur gauche', other: 'wallRightDeco', otherName: 'mur droit' },
    wallRightDeco: { kind: 'wall', title: 'Papier peint · mur droit', other: 'wallLeftDeco', otherName: 'mur gauche' },
    floorDeco: { kind: 'floor', title: 'Sol à motif', other: null },
  };
  let decoSlot = 'wallLeftDeco';
  const decoSwatches = [...document.querySelectorAll('.deco-swatch')];
  function syncDecoSwatches() {
    const show = state.isAdmin && normShape(state.shape).kind !== 'garden';
    for (const b of decoSwatches) {
      b.hidden = !show;
      const d = state.decos.get(state.colors[b.dataset.deco] || '');
      b.classList.toggle('empty', !d);
      b.style.backgroundImage = d ? `url("${d.url}")` : '';
      b.textContent = d ? '' : '🖼️';
      b.title = d ? `${d.name} (touche pour changer)` : (b.dataset.deco === 'floorDeco' ? 'Choisir un sol à motif' : 'Choisir un papier peint');
    }
  }
  for (const b of decoSwatches) b.addEventListener('click', () => openDecoPicker(b.dataset.deco));
  function openDecoPicker(slot) {
    decoSlot = slot;
    renderDecoPicker();
    decoPicker.hidden = false;
  }
  function renderDecoPicker() {
    const slot = DECO_SLOTS[decoSlot];
    $('#decoPickTitle').textContent = slot.title;
    const list = $('#decoPickList');
    list.innerHTML = '';
    const cur = state.colors[decoSlot] || '';
    const action = (label, cls, fn) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn deco-action ' + cls;
      b.textContent = label;
      b.addEventListener('click', fn);
      list.appendChild(b);
    };
    // Même papier peint que l'autre mur, s'il en a un (et pas déjà ici).
    const otherId = slot.other ? state.colors[slot.other] || '' : '';
    const otherDeco = otherId && state.decos.get(otherId);
    if (otherDeco && otherId !== cur) action(`Même que le ${slot.otherName} : ${otherDeco.name}`, 'btn-primary', () => applyDeco(otherId));
    if (cur) action('✕ Retirer', 'btn-ghost', () => applyDeco(''));
    const owned = decoList(slot.kind).filter((d) => decoOwned(d.id));
    decoGroups(owned, list, (d) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'deco-item' + (cur === d.id ? ' active' : '');
      b.appendChild(decoThumb(d));
      const n = document.createElement('span');
      n.className = 'deco-name';
      n.textContent = d.name;
      b.appendChild(n);
      b.addEventListener('click', () => applyDeco(d.id));
      return b;
    });
    if (!owned.length) {
      const p = document.createElement('p');
      p.className = 'muted deco-empty';
      p.textContent = slot.kind === 'floor' ? 'Aucun sol pour l\'instant : il y en a à la boutique (🎨 Décor).' : 'Aucun papier peint pour l\'instant : il y en a à la boutique (🎨 Décor).';
      list.appendChild(p);
    }
  }
  function applyDeco(id) {
    const before = snapshot();
    if (id) state.colors[decoSlot] = id; else delete state.colors[decoSlot];
    commit(before);
    drawRoom();
    syncDecoSwatches();
    scheduleSave();
    decoPicker.hidden = true;
  }
  $('#decoPickClose').addEventListener('click', () => { decoPicker.hidden = true; });
  decoPicker.addEventListener('click', (e) => { if (e.target === decoPicker) decoPicker.hidden = true; });

  // Boutique : achat un par un
  function renderDecoShop() {
    $('#decoAsPlayerRow').hidden = !state.isAdmin;
    const list = $('#decoShopList');
    list.innerHTML = '';
    let any = false;
    for (const kind of ['wall', 'floor']) {
      const items = decoList(kind);
      if (!items.length) continue;
      any = true;
      const h = document.createElement('h3');
      h.className = 'deco-kind';
      h.textContent = kind === 'wall' ? 'Papiers peints' : 'Sols';
      list.appendChild(h);
      decoGroups(items, list, (d) => {
        const own = decoOwned(d.id);
        const card = document.createElement('div');
        card.className = 'deco-item deco-shop-item';
        card.appendChild(decoThumb(d));
        const n = document.createElement('span');
        n.className = 'deco-name';
        n.textContent = d.name;
        card.appendChild(n);
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn' + (own ? '' : ' btn-primary');
        b.disabled = own;
        b.textContent = own ? '✓ À toi' : `${d.price} 🪙`;
        b.addEventListener('click', () => buyDeco(d));
        card.appendChild(b);
        return card;
      });
    }
    if (!any) list.innerHTML = '<p class="muted deco-empty">Rien en vente pour l\'instant.</p>';
  }
  async function buyDeco(d) {
    if (decoOwned(d.id)) return;
    if ((state.profile.points || 0) < d.price) { toast(`Il te manque ${d.price - (state.profile.points || 0)} 🪙.`); return; }
    if (!(await askConfirm(`Acheter « ${d.name} » pour ${d.price} 🪙 ?`, 'Acheter'))) return;
    if ((state.profile.points || 0) < d.price) return;
    state.profile.points -= d.price;
    state.profile.decos = { ...(state.profile.decos || {}), [d.id]: true };
    renderPoints();
    saveProfile();
    toast(`« ${d.name} » est à toi ! Tu le trouves dans 🎨 Couleurs, quand tu décores une pièce.`);
    renderDecoShop();
  }
  $('#shopChoiceEnv').addEventListener('click', () => { shopView = 'envelopes'; renderShop(); window.scrollTo(0, 0); });
  $('#shopChoiceDeco').addEventListener('click', () => { shopView = 'deco'; renderDecoShop(); applyShopView(); window.scrollTo(0, 0); });
  $('#decoAsPlayer').addEventListener('change', (e) => { decoAsPlayer = e.target.checked; renderDecoShop(); });

  // Atelier : importer et régler les décors
  function renderDecoAdmin() {
    const list = $('#decoAdminList');
    list.innerHTML = '';
    const items = [...state.decos.values()].sort((a, b) => a.kind.localeCompare(b.kind) || decoByName(a, b));
    $('#decoAdminEmpty').hidden = items.length > 0;
    const collections = [...new Set(items.map((d) => d.collection).filter(Boolean))];
    for (const d of items) {
      const card = document.createElement('article');
      card.className = 'deco-admin-card';
      card.innerHTML = `
        <div class="deco-preview"></div>
        <div class="deco-admin-fields">
          <label><span>Nom</span><input class="field" data-f="name" maxlength="40"></label>
          <label><span>Type</span><select class="field" data-f="kind"><option value="wall">Papier peint</option><option value="floor">Sol</option></select></label>
          <label><span>Collection</span><input class="field" data-f="collection" maxlength="40" list="decoCollections"></label>
          <label><span>Prix 🪙</span><input class="field" data-f="price" type="number" min="0" step="10"></label>
          <label><span>Taille (carreaux)</span><input class="field" data-f="size" type="number" min="0.5" max="12" step="0.5"></label>
        </div>
        <button class="btn btn-ghost deco-admin-del" type="button" title="Supprimer ce décor">🗑️</button>`;
      card.querySelector('.deco-preview').style.backgroundImage = `url("${d.url}")`;
      const save = (field, value) => {
        d[field] = value;
        db.updateImage(d.id, { [field]: value }).catch(() => toast('Le réglage n\'a pas pu être enregistré. Vérifie ta connexion.'));
      };
      const f = (name) => card.querySelector(`[data-f="${name}"]`);
      f('name').value = d.name || '';
      f('kind').value = d.kind;
      f('collection').value = d.collection || '';
      f('price').value = d.price ?? 100;
      f('size').value = d.size || 2;
      f('name').addEventListener('change', () => save('name', f('name').value.trim() || 'Décor'));
      f('kind').addEventListener('change', () => save('kind', f('kind').value));
      f('collection').addEventListener('change', () => save('collection', f('collection').value.trim()));
      f('price').addEventListener('change', () => save('price', Math.max(0, Math.round(Number(f('price').value) || 0))));
      f('size').addEventListener('change', () => save('size', Math.max(0.5, Math.min(12, Number(f('size').value) || 2))));
      card.querySelector('.deco-admin-del').addEventListener('click', async () => {
        if (!(await askConfirm(`Supprimer « ${d.name} » ? Les pièces qui l'utilisent reprennent leur couleur unie.`, 'Supprimer'))) return;
        state.decos.delete(d.id);
        db.deleteImage(d.id).catch(() => toast('Le décor n\'a pas pu être supprimé.'));
        renderDecoAdmin();
      });
      list.appendChild(card);
    }
    let dl = $('#decoCollections');
    if (!dl) { dl = document.createElement('datalist'); dl.id = 'decoCollections'; document.body.appendChild(dl); }
    dl.innerHTML = collections.map((c) => `<option value="${c.replace(/"/g, '&quot;')}">`).join('');
  }
  $('#decoImportFile').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    const kind = $('#decoImportKind').value;
    let n = 0;
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue;
      try {
        const src = URL.createObjectURL(file);
        const el = await loadImageEl(src);
        URL.revokeObjectURL(src);
        const { data, w, h } = encodeImage(el);
        const rec = { id: uid(), deco: true, kind, name: file.name.replace(/\.[^.]+$/, '').slice(0, 40) || 'Décor', collection: '', price: kind === 'floor' ? 150 : 100, size: 2, data, w, h, created: Date.now() };
        await db.putImage(rec);
        addDeco(rec);
        n++;
      } catch (err) {
        console.warn('Import du décor impossible', err);
        toast(`« ${file.name} » n'a pas pu être importé.`);
      }
    }
    if (n) toast(`${plural(n, 'décor')} ajouté${n > 1 ? 's' : ''}. Règle leur nom, leur collection et leur prix.`);
    renderDecoAdmin();
  });
  $('#atelierDeco').addEventListener('click', () => { if (!state.isAdmin) return; renderDecoAdmin(); showScreen('decoAdmin'); });
  $('#decoAdminBack').addEventListener('click', openAtelier);

  // Ranger les enveloppes : l'ordre ici est celui de la boutique (et du classeur).
  let atelierReorder = false;
  function renderAtelierOrder(listEl) {
    const help = document.createElement('p');
    help.className = 'muted';
    help.textContent = 'Monte ou descends les enveloppes : c\'est l\'ordre dans lequel les joueurs les voient dans la boutique. Les enveloppes vides n\'y apparaissent pas.';
    listEl.appendChild(help);
    const ol = document.createElement('ol');
    ol.className = 'atelier-order';
    const n = state.envelopes.length;
    state.envelopes.forEach((env, i) => {
      const li = document.createElement('li');
      li.className = 'atelier-order-row' + (stickersOf(env.id).length ? '' : ' empty');
      li.innerHTML = `<span class="atelier-order-n">${i + 1}</span><div class="atelier-tile-art"></div>
        <div class="atelier-tile-text"><strong></strong><span class="muted"></span></div>
        <div class="atelier-order-btns">
          <button type="button" class="btn" data-to="0" title="Tout en haut" ${i ? '' : 'disabled'}>⤒</button>
          <button type="button" class="btn" data-to="${i - 1}" title="Monter" ${i ? '' : 'disabled'}>▲</button>
          <button type="button" class="btn" data-to="${i + 1}" title="Descendre" ${i < n - 1 ? '' : 'disabled'}>▼</button>
        </div>`;
      li.querySelector('.atelier-tile-art').appendChild(envelopeArt(env));
      li.querySelector('strong').textContent = env.name || 'Enveloppe';
      const count = stickersOf(env.id).length;
      li.querySelector('.muted').textContent = count ? plural(count, 'sticker') : 'Vide : pas dans la boutique';
      li.querySelectorAll('[data-to]').forEach((b) => b.addEventListener('click', () => moveEnvelope(i, Number(b.dataset.to))));
      ol.appendChild(li);
    });
    listEl.appendChild(ol);
  }
  function moveEnvelope(from, to) {
    const list = state.envelopes;
    if (to < 0 || to >= list.length || to === from) return;
    const [env] = list.splice(from, 1);
    list.splice(to, 0, env);
    // On renumérote et on n'enregistre que celles qui ont changé de place.
    list.forEach((e, i) => {
      if (e.order === i) return;
      e.order = i;
      db.putEnvelope(e).catch(() => toast('L\'ordre n\'a pas pu être enregistré. Vérifie ta connexion.'));
    });
    renderAtelier();
  }
  $('#atelierOrder').addEventListener('click', () => { atelierReorder = !atelierReorder; renderAtelier(); });

  // Choisir les enveloppes du jour (aujourd'hui ou demain) ; sinon, tirage au sort.
  let atelierDaily = false;
  let dailyDayOffset = 0;
  const shopCount = () => state.envelopes.filter((env) => stickersOf(env.id).length).length;
  function renderAtelierDaily(listEl) {
    const n = setting('dailyEnvCount');
    const day = shiftDay(today(), dailyDayOffset);
    const shop = state.envelopes.filter((env) => stickersOf(env.id).length);
    const head = document.createElement('div');
    head.className = 'atelier-daily-head';
    // Nombre d'enveloppes du jour mises à disposition (0 = toutes au prix normal).
    const count = document.createElement('div');
    count.className = 'atelier-daily-count';
    count.innerHTML = `<span>Enveloppes du jour à mettre à disposition</span>
      <div class="atelier-daily-stepper"><button type="button" class="btn" data-d="-1" ${n <= 0 ? 'disabled' : ''} aria-label="Une de moins">−</button>
      <strong></strong><button type="button" class="btn" data-d="1" ${n >= shopCount() ? 'disabled' : ''} aria-label="Une de plus">＋</button></div>`;
    count.querySelector('strong').textContent = n ? String(n) : 'Toutes';
    count.querySelectorAll('[data-d]').forEach((b) => b.addEventListener('click', async () => {
      const next = Math.max(0, Math.min(shopCount(), n + Number(b.dataset.d)));
      state.settings.dailyEnvCount = next;
      renderAtelier();
      await saveSettings();
    }));
    listEl.appendChild(count);
    if (!n) {
      head.innerHTML = '<p class="muted">Toutes les enveloppes sont au prix normal. Ajoute-en avec « ＋ » pour n\'en mettre que quelques-unes à disposition chaque jour.</p>';
      listEl.appendChild(head);
      return;
    }
    const picks = dailyPicks(day).filter((id) => shop.some((e) => e.id === id));
    const current = dailyEnvelopeIds(day, true);
    head.innerHTML = `<div class="atelier-daily-tabs">
        <button type="button" class="btn ${dailyDayOffset === 0 ? 'btn-primary' : ''}" data-off="0">Aujourd'hui</button>
        <button type="button" class="btn ${dailyDayOffset === 1 ? 'btn-primary' : ''}" data-off="1">Demain</button>
      </div>
      <p class="atelier-daily-info"></p>
      <button type="button" class="btn btn-ghost atelier-daily-random">🎲 Revenir au tirage au sort</button>`;
    head.querySelector('.atelier-daily-info').textContent = picks.length
      ? `Ton choix : ${picks.length}/${n}${picks.length < n ? ` (les ${n - picks.length} autres sont tirées au sort)` : ''}. Touche une enveloppe pour l'ajouter ou la retirer.`
      : `Tirage au sort en ce moment. Touche une enveloppe pour choisir toi-même (jusqu'à ${n}).`;
    if (allNormalDay(day)) head.querySelector('.atelier-daily-info').textContent = `☀️ Ce jour-là est un dimanche : toutes les enveloppes sont au prix normal, ce choix ne sert pas. ${head.querySelector('.atelier-daily-info').textContent}`;
    head.querySelector('.atelier-daily-random').hidden = !picks.length;
    head.querySelectorAll('[data-off]').forEach((b) => b.addEventListener('click', () => { dailyDayOffset = Number(b.dataset.off); renderAtelier(); }));
    head.querySelector('.atelier-daily-random').addEventListener('click', () => setDailyPicks(day, []));
    listEl.appendChild(head);
    const grid = document.createElement('div');
    grid.className = 'atelier-tiles';
    for (const env of shop) {
      const mine = picks.includes(env.id);
      const on = current.has(env.id);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'atelier-tile daily-pick' + (on ? ' on' : '') + (mine ? ' mine' : '');
      b.innerHTML = '<div class="atelier-tile-art"></div><div class="atelier-tile-text"><strong></strong><span class="muted"></span><div class="daily-strip"></div></div><span class="daily-mark"></span>';
      b.querySelector('.atelier-tile-art').appendChild(envelopeArt(env));
      b.querySelector('strong').textContent = env.name || 'Enveloppe';
      const content = stickersOf(env.id);
      b.querySelector('.muted').textContent = `${env.price ?? DEFAULT_PRICE} 🪙 · ${plural(content.length, 'sticker')}` + (mine ? ' · choisie par toi' : on ? ' · tirée au sort' : '');
      // Contenu de la collection : tous les stickers, les plus rares d'abord.
      const rank = { epic: 0, rare: 1, common: 2 };
      const strip = b.querySelector('.daily-strip');
      for (const img of [...content].sort((x, y) => rank[x.rarity || 'common'] - rank[y.rarity || 'common'])) {
        const t = document.createElement('span');
        t.className = 'daily-thumb';
        t.dataset.rarity = img.rarity || 'common';
        t.title = `${img.name} · ${RARITIES[img.rarity || 'common'].label || img.rarity || 'commun'}`;
        const im = document.createElement('img');
        im.alt = img.name || '';
        im.loading = 'lazy';
        im.src = img.url;
        t.appendChild(im);
        strip.appendChild(t);
      }
      b.querySelector('.daily-mark').textContent = on ? '⭐' : '☆';
      b.addEventListener('click', () => {
        if (mine) { setDailyPicks(day, picks.filter((id) => id !== env.id)); return; }
        if (picks.length >= n) { toast(`Tu as déjà choisi ${n} enveloppes : retires-en une d'abord.`); return; }
        setDailyPicks(day, [...picks, env.id]);
      });
      grid.appendChild(b);
    }
    listEl.appendChild(grid);
    if (!shop.length) listEl.insertAdjacentHTML('beforeend', '<p class="muted">Aucune enveloppe avec des stickers pour l\'instant.</p>');
  }
  async function setDailyPicks(day, ids) {
    const all = { ...(state.settings.dailyEnvPicks || {}) };
    // On ne garde que les jours à venir (aujourd'hui et après).
    for (const d of Object.keys(all)) if (d < today()) delete all[d];
    if (ids.length) all[day] = ids; else delete all[day];
    state.settings.dailyEnvPicks = all;
    renderAtelier();
    await saveSettings();
  }
  $('#atelierDaily').addEventListener('click', () => { atelierDaily = !atelierDaily; dailyDayOffset = 0; renderAtelier(); });

  // Liste des enveloppes en tuiles (avec recherche par nom d'enveloppe ou de sticker).
  function renderAtelierTiles(listEl) {
    const q = normalizeText($('#atelierSearch').value);
    const grid = document.createElement('div');
    grid.className = 'atelier-tiles';
    const tile = (artEl, title, sub, onClick, extra = '') => {
      const b = document.createElement('button');
      b.className = 'atelier-tile ' + extra;
      b.innerHTML = '<div class="atelier-tile-art"></div><div class="atelier-tile-text"><strong></strong><span class="muted"></span></div><span class="atelier-tile-go">›</span>';
      b.querySelector('.atelier-tile-art').appendChild(artEl);
      b.querySelector('strong').textContent = title;
      b.querySelector('.muted').textContent = sub;
      b.addEventListener('click', onClick);
      grid.appendChild(b);
    };
    let shown = 0;
    for (const env of state.envelopes) {
      const list = stickersOf(env.id);
      const hits = q ? list.filter((img) => normalizeText(img.name).includes(q)) : [];
      if (q && !normalizeText(env.name).includes(q) && !hits.length) continue;
      shown++;
      const sub = (list.length ? plural(list.length, 'sticker') : 'Vide : pas dans la boutique')
        + ` · ${env.price ?? DEFAULT_PRICE} 🪙` + (list.length && isDailyEnvelope(env) && setting('dailyEnvCount') ? ' · ⭐ du jour' : '')
        + (hits.length ? ` · contient « ${hits.slice(0, 2).map((h) => h.name).join(' », « ')} »${hits.length > 2 ? '…' : ''}` : '');
      tile(envelopeArt(env), env.name || 'Enveloppe', sub, async () => { atelierOpen = env.id; renderAtelier(); await refreshCoffreCount(); if (atelierOpen === env.id) renderAtelier(); }, list.length ? '' : 'empty');
    }
    const arch = archivedStickers();
    const archHits = q ? arch.filter((img) => normalizeText(img.name).includes(q)) : arch;
    if (archHits.length) {
      shown++;
      const art = document.createElement('div');
      art.className = 'atelier-tile-icon';
      art.textContent = '📦';
      tile(art, 'Archives', `${plural(arch.length, 'sticker')} retiré${arch.length > 1 ? 's' : ''} des enveloppes`, () => { atelierOpen = 'archives'; renderAtelier(); }, 'archives');
    }
    listEl.appendChild(grid);
    if (q && !shown) listEl.insertAdjacentHTML('beforeend', '<p class="muted">Aucune enveloppe ni sticker ne correspond.</p>');
  }
  const normalizeText = (t) => (t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  $('#atelierSearch').addEventListener('input', () => renderAtelier());
  $('#atelierAll').addEventListener('click', () => { atelierOpen = null; renderAtelier(); });

  // Nouveau dessin pour un sticker existant : il garde son nom, sa rareté, son enveloppe,
  // et les joueurs qui l'ont voient le nouveau dessin partout (même dans leurs pièces).
  // Tag « à modifier » : le sticker reste dans son enveloppe, on le retrouve dans l'onglet « À modifier » du Coffre.
  async function setToFix(img, on) {
    img.toFix = on;
    try {
      await db.updateImage(img.id, { toFix: on });
    } catch (e) {
      console.warn('Tag impossible', e);
      img.toFix = !on;
      toast('Le tag n\'a pas pu être enregistré. Vérifie ta connexion.');
    }
  }

  async function replaceStickerImage(img, file) {
    if (!file.type.startsWith('image/')) return;
    if (!(await askConfirm(`Remplacer le dessin de « ${img.name} » par « ${file.name} » ? Les joueurs qui l'ont garderont leur sticker, avec le nouveau dessin.`, 'Remplacer'))) return;
    // Garde le lien avec la proposition d'origine (retrouvée jusqu'ici par l'image).
    const prop = !img.fromProposal && (state.proposals || []).find((p) => p.data && p.data === img.data);
    if (prop) img.fromProposal = prop.id;
    const old = { data: img.data, w: img.w, h: img.h, url: img.url };
    try {
      const srcUrl = URL.createObjectURL(file);
      const el = await loadImageEl(srcUrl);
      URL.revokeObjectURL(srcUrl);
      const { data, w, h } = encodeImage(el);
      Object.assign(img, { data, w, h, url: data, updated: Date.now() });
      await db.putImage(img);
      toast(`Nouveau dessin enregistré pour « ${img.name} ».`);
    } catch (e) {
      console.warn('Remplacement impossible', e);
      Object.assign(img, old);
      toast('Le dessin n\'a pas pu être remplacé. Essaie un PNG ou un JPG, et vérifie ta connexion.');
    }
    renderAtelier();
  }

  async function moveToEnvelope(img, envId) {
    const env = state.envelopes.find((e) => e.id === envId);
    if (!env) return;
    img.envelope = env.id;
    img.archived = false;
    try {
      await db.updateImage(img.id, { envelope: env.id, archived: false });
      toast(`« ${img.name} » est maintenant dans l'enveloppe « ${env.name} ».`);
    } catch (e) {
      console.warn('Déplacement impossible', e);
      toast('Le sticker n\'a pas pu être déplacé. Vérifie ta connexion.');
    }
    renderAtelier();
  }

  function renderArchives(listEl) {
    const list = archivedStickers();
    if (!list.length) return;
    const sec = document.createElement('section');
    sec.className = 'atelier-env atelier-archives';
    sec.innerHTML = `
      <p class="atelier-count muted">Stickers retirés de leur enveloppe. On ne peut plus les gagner, mais les joueurs qui les ont les gardent.</p>
      <div class="atelier-grid"></div>`;
    const grid = sec.querySelector('.atelier-grid');
    for (const img of list) {
      const cell = document.createElement('div');
      cell.className = 'atelier-item';
      cell.dataset.rarity = img.rarity || 'common';
      cell.innerHTML = `
        <div class="env-item-img"><img alt=""></div>
        <p class="atelier-arch-name"></p>
        <select aria-label="Enveloppe"></select>
        <button class="btn btn-primary atelier-restore">Remettre</button>
        <button class="atelier-item-del" title="Supprimer définitivement">🗑️</button>`;
      cell.querySelector('img').src = img.url;
      cell.querySelector('.atelier-arch-name').textContent = img.name + (img.author ? ` · par ${img.author}` : '');
      const sel = cell.querySelector('select');
      for (const e of state.envelopes) sel.add(new Option('✉️ ' + (e.name || 'Enveloppe'), e.id));
      const restore = cell.querySelector('.atelier-restore');
      if (!state.envelopes.length) { sel.hidden = true; restore.disabled = true; restore.textContent = 'Crée une enveloppe'; }
      restore.addEventListener('click', () => moveToEnvelope(img, sel.value));
      cell.querySelector('.atelier-item-del').addEventListener('click', async () => {
        if (!(await askConfirm(`Supprimer définitivement « ${img.name} » ? Les joueurs qui l'ont le perdront.`, 'Supprimer'))) return;
        state.images.delete(img.id);
        db.deleteImage(img.id).catch(() => toast('Le sticker n\'a pas pu être supprimé.'));
        renderAtelier();
      });
      grid.appendChild(cell);
    }
    listEl.appendChild(sec);
  }

  // ---------------------------------------------------------------------------
  // Menu principal
  // ---------------------------------------------------------------------------
  const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`;
  // Stickers du catalogue rangés dans une enveloppe qui existe encore.
  const collectible = () => [...state.images.values()].filter((img) => state.envelopes.some((e) => e.id === img.envelope));

  // Duels restant à voter pour le concours d'hier (mis en valeur sur la tuile du menu).
  let homeVote = { day: null, at: 0, left: 0 };
  function renderContestTile() {
    $('#homeContestTheme').textContent = themeOf(today());
    const tile = $('#homeContest');
    const yesterday = shiftDay(today(), -1);
    const left = !voteMaintenance() && !votingOver() && homeVote.day === yesterday ? homeVote.left : 0;
    tile.classList.toggle('vote-todo', left > 0);
    $('#homeContestTodo').hidden = !left;
    $('#homeContestTodo').textContent = left ? `⚔️ ${plural(left, 'duel')} à voter` : '';
    $('#homeContestChip').textContent = voteMaintenance() ? 'vote en maintenance'
      : (votingOver() ? 'Gagnant dévoilé !'
        : (left ? `+${voteReward()} 🪙 · jusqu'à 20 h` : 'votes jusqu\'à 20 h'));
  }
  function setHomeVote(v) {
    const plan = duelPlan(v, state.player.key);
    homeVote = { day: v.day, at: Date.now(), left: plan.total ? Math.max(0, plan.total - plan.done) : 0 };
    if (!screens.home.hidden) renderContestTile();
  }
  // Recharge le concours d'hier pour savoir s'il reste des duels à voter (au plus toutes les 5 minutes).
  async function refreshHomeVote() {
    if (!state.profile || !state.player || voteMaintenance() || votingOver()) return;
    const day = shiftDay(today(), -1);
    if (homeVote.day === day && Date.now() - homeVote.at < 300000) return;
    try {
      setHomeVote(await loadContestDay(day));
    } catch (e) { /* hors ligne : on ne dit rien */ }
  }

  function goHome() {
    renderPoints();
    renderContestTile();
    refreshHomeVote();
    if (state.profile) claimContestRewards();
    const all = collectible();
    const got = all.filter((img) => owned(img.id) > 0).length;
    const envs = state.envelopes.filter((env) => stickersOf(env.id).length).length;
    const nRooms = realRooms().length;
    $('#homeRoomsSub').textContent = nRooms ? plural(nRooms, 'pièce') : 'Crée ta première pièce';
    const stars = state.profile.stars || 0;
    if (stars) $('#homeShopSub').innerHTML = `${STAR_SVG(15)} ${plural(stars, 'étoile')} à utiliser !`;
    else $('#homeShopSub').textContent = envs ? `${plural(envs, 'enveloppe')} en vente` : 'Bientôt des enveloppes';
    $('#homeCollectionSub').textContent = all.length ? `${got}/${all.length} stickers obtenus` : 'Classeur vide';
    $('#homeCollectionBar').style.width = all.length ? `${Math.round((got / all.length) * 100)}%` : '0%';
    $('#homeAdmin').hidden = !state.isAdmin;
    const pending = state.myProposals.filter((x) => x.status === 'pending').length;
    $('#homeCreationsSub').textContent = pending ? `${plural(pending, 'proposition')} en attente` : 'Envoie tes dessins !';
    renderMailBadge();
    $('#homeCoffre').hidden = !state.isAdmin;
    $('#homePlayers').hidden = !state.isAdmin;
    if (state.isAdmin) refreshCoffreCount();
    renderMaintTiles();
    showScreen('home');
    if (maintBlocked('all', true)) return;
  }

  function openRooms() {
    if (maintBlocked('rooms')) return;
    renderRoomList();
    showScreen('rooms');
  }

  $('#homeRooms').addEventListener('click', openRooms);
  $('#roomsBack').addEventListener('click', goHome);
  $('#homeCollection').addEventListener('click', () => openCollection());
  $('#collectionBack').addEventListener('click', goHome);

  // ---------------------------------------------------------------------------
  // Collection : un classeur avec une page par enveloppe
  // ---------------------------------------------------------------------------
  let binderPage = 0;
  const binderPages = () => state.envelopes.filter((env) => stickersOf(env.id).length);

  function openCollection(page) {
    if (maintBlocked('collection')) return;
    if (page !== undefined) binderPage = page;
    renderCollection();
    showScreen('collection');
  }

  function renderCollection() {
    $('#collectionHint').textContent = `Touche un sticker obtenu pour voir sa fiche ou le vendre. Revente : commun ${setting('sell_common')} 🪙, rare ${setting('sell_rare')} 🪙, très rare ${setting('sell_epic')} 🪙.`;
    const pages = binderPages();
    const all = collectible();
    const got = all.filter((img) => owned(img.id) > 0).length;
    $('#collectionTotal').textContent = `${got}/${all.length}`;
    $('#collectionTotal').title = `${got} stickers obtenus sur ${all.length}`;
    $('#collectionEmpty').hidden = pages.length > 0;
    document.querySelector('.binder').hidden = !pages.length;
    if (!pages.length) return;
    binderPage = clamp(binderPage, 0, pages.length - 1);
    const env = pages[binderPage];

    // Onglets : un par enveloppe, à sa couleur.
    const tabs = $('#binderTabs');
    tabs.innerHTML = '';
    pages.forEach((p, i) => {
      const list = stickersOf(p.id);
      const done = list.every((img) => owned(img.id) > 0);
      const tab = document.createElement('button');
      tab.className = 'binder-tab' + (i === binderPage ? ' active' : '');
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', i === binderPage);
      tab.style.setProperty('--tab', p.color || ENVELOPE_COLORS[0]);
      tab.textContent = (done ? '★ ' : '') + (p.name || 'Enveloppe');
      tab.title = done ? 'Page complète !' : `${list.filter((img) => owned(img.id) > 0).length}/${list.length}`;
      tab.addEventListener('click', () => { binderPage = i; renderCollection(); });
      tabs.appendChild(tab);
    });
    const activeTab = tabs.children[binderPage];
    if (activeTab) activeTab.scrollIntoView({ block: 'nearest', inline: 'nearest' });

    // Page : une pochette par sticker, dans l'ordre où ils ont été créés.
    const list = stickersOf(env.id);
    const pageGot = list.filter((img) => owned(img.id) > 0).length;
    document.querySelector('.binder-page').style.setProperty('--tab', env.color || ENVELOPE_COLORS[0]);
    $('#binderTitle').textContent = env.name || 'Enveloppe';
    $('#binderCount').textContent = pageGot === list.length ? `Complète ! ${pageGot}/${list.length}` : `${pageGot}/${list.length}`;
    $('#binderBar').style.width = `${(pageGot / list.length) * 100}%`;
    const stars = state.profile.stars || 0;
    const starBtn = $('#binderStar');
    starBtn.hidden = stars < 1;
    starBtn.textContent = `🌟 Utiliser une étoile${stars > 1 ? ` (${stars})` : ''}`;
    starBtn.onclick = () => openStarPicker(env, () => renderCollection());
    const grid = $('#binderGrid');
    grid.innerHTML = '';
    list.forEach((img, i) => {
      const n = owned(img.id);
      const slot = document.createElement('button');
      slot.className = 'binder-slot' + (n ? '' : ' missing');
      slot.dataset.rarity = img.rarity || 'common';
      slot.innerHTML = `
        <span class="slot-sleeve"><img alt=""></span>
        <span class="slot-num">n°${String(i + 1).padStart(2, '0')}</span>
        <span class="slot-name"></span>
        ${n > 1 ? `<span class="slot-count">×${n}</span>` : ''}`;
      slot.querySelector('img').src = img.url;
      slot.querySelector('.slot-name').textContent = n ? img.name : '???';
      slot.title = n ? `${img.name} (${RARITIES[img.rarity || 'common'].label})` : 'Pas encore obtenu';
      slot.addEventListener('click', () => {
        if (n) showCard(img);
        else toast(`Pas encore obtenu : il se trouve dans l'enveloppe « ${env.name} ».`);
      });
      grid.appendChild(slot);
    });

    $('#binderPageNum').textContent = `Page ${binderPage + 1} / ${pages.length}`;
    $('#binderPrev').disabled = binderPage === 0;
    $('#binderNext').disabled = binderPage === pages.length - 1;
  }

  $('#binderPrev').addEventListener('click', () => { binderPage--; renderCollection(); });
  $('#binderNext').addEventListener('click', () => { binderPage++; renderCollection(); });

  // Fiche d'un sticker obtenu.
  const cardDialog = $('#cardDialog');
  function showCard(img) {
    const n = owned(img.id), used = usedCount(img.id);
    const price = sellPrice(img);
    cardDialog.dataset.rarity = img.rarity || 'common';
    $('#cardImg img').src = img.url;
    $('#cardRarity').textContent = RARITIES[img.rarity || 'common'].label;
    $('#cardName').textContent = img.name + (img.author ? ` · par ${img.author}` : '');
    $('#cardInfo').textContent = `${plural(n, 'exemplaire')} · ${used ? `${used} posé${used > 1 ? 's' : ''} dans tes pièces` : 'aucun posé pour l\'instant'}`;
    const sell = $('#cardSell');
    const free = available(img.id);
    sell.disabled = free < 1;
    sell.textContent = `Vendre… · ${price} 🪙 l'unité`;
    $('#cardSellHint').textContent = free < 1
      ? 'Tous tes exemplaires sont posés : retire-en un d\'une pièce pour pouvoir le vendre.'
      : `Tu peux en vendre ${free} (ceux qui ne sont pas posés dans tes pièces).`;
    sell.onclick = () => sellSticker(img);
    cardDialog.hidden = false;
  }
  $('#cardClose').addEventListener('click', () => { cardDialog.hidden = true; });

  // ---------------------------------------------------------------------------
  // Vente : un exemplaire non posé rapporte des pièces selon sa rareté
  // ---------------------------------------------------------------------------
  const sellPrice = (img) => setting('sell_' + (img.rarity || 'common'));

  function removeCopies(img, k) {
    const left = owned(img.id) - k;
    if (left > 0) state.profile.inventory[img.id] = left;
    else delete state.profile.inventory[img.id];
  }

  // Fenêtre de vente : on choisit combien d'exemplaires vendre (parmi ceux qui
  // ne sont pas posés) et on voit tout de suite ce que ça rapporte.
  const sellDialog = $('#sellDialog');
  const sellQty = $('#sellQty');
  let selling = null; // { img, max }

  function sellSticker(img) {
    const max = available(img.id);
    if (max < 1) return;
    selling = { img, max };
    sellDialog.dataset.rarity = img.rarity || 'common';
    $('#sellImg img').src = img.url;
    $('#sellName').textContent = img.name;
    sellQty.max = max;
    sellQty.value = 1;
    updateSell();
    cardDialog.hidden = true;
    sellDialog.hidden = false;
    sellQty.focus();
    sellQty.select();
  }

  function sellAmount() {
    const n = Math.round(Number(sellQty.value));
    return Number.isFinite(n) ? clamp(n, 1, selling.max) : 1;
  }

  function updateSell() {
    if (!selling) return;
    const { img, max } = selling;
    const n = sellAmount();
    $('#sellMax').textContent = `/ ${max}`;
    $('#sellMinus').disabled = n <= 1;
    $('#sellPlus').disabled = n >= max;
    $('#sellAll').disabled = n === max;
    $('#sellGain').textContent = `+${n * sellPrice(img)} 🪙`;
    const left = owned(img.id) - n;
    $('#sellNote').textContent = left > 0
      ? `Il t'en restera ${left}${usedCount(img.id) ? ` (dont ${usedCount(img.id)} posé${usedCount(img.id) > 1 ? 's' : ''} dans tes pièces)` : ''}.`
      : (n === 1
        ? 'C\'est ton dernier exemplaire : ce sticker quittera ta collection.'
        : 'Tu vends tous tes exemplaires : ce sticker quittera ta collection.');
    $('#sellNote').classList.toggle('warn', left <= 0);
    $('#sellConfirm').textContent = `Vendre ${n}`;
  }

  sellQty.addEventListener('input', updateSell);
  sellQty.addEventListener('change', () => { sellQty.value = sellAmount(); updateSell(); });
  sellQty.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#sellConfirm').click(); });
  $('#sellMinus').addEventListener('click', () => { sellQty.value = sellAmount() - 1; updateSell(); });
  $('#sellPlus').addEventListener('click', () => { sellQty.value = sellAmount() + 1; updateSell(); });
  $('#sellAll').addEventListener('click', () => { sellQty.value = selling.max; updateSell(); });
  $('#sellCancel').addEventListener('click', () => {
    sellDialog.hidden = true;
    if (selling) showCard(selling.img);
    selling = null;
  });

  $('#sellConfirm').addEventListener('click', () => {
    if (!selling) return;
    const { img } = selling;
    const n = Math.min(sellAmount(), available(img.id));
    if (n < 1) return;
    const gain = n * sellPrice(img);
    removeCopies(img, n);
    state.profile.points += gain;
    saveProfile();
    renderPoints();
    sellDialog.hidden = true;
    selling = null;
    toast(`+${gain} 🪙 : ${n} « ${img.name} » vendu${n > 1 ? 's' : ''}.`);
    if (owned(img.id) > 0) showCard(img);
    if (!screens.collection.hidden) renderCollection();
  });

  // ---------------------------------------------------------------------------
  // Proposer un sticker (joueurs)
  // ---------------------------------------------------------------------------
  const STATUS_LABELS = { pending: 'En attente', accepted: 'Accepté', refused: 'Refusé' };
  let draft = null; // image choisie, pas encore envoyée : { data, w, h }

  function openCreations() {
    if (maintBlocked('creations')) return;
    renderCreations();
    showScreen('creations');
  }
  $('#homeCreations').addEventListener('click', openCreations);
  $('#creationsBack').addEventListener('click', goHome);

  $('#propFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file || !file.type.startsWith('image/')) return;
    try {
      const url = URL.createObjectURL(file);
      const img = await loadImageEl(url);
      URL.revokeObjectURL(url);
      draft = encodeImage(img);
      if (!$('#propName').value.trim()) $('#propName').value = file.name.replace(/\.[^.]+$/, '').slice(0, 30);
      renderDraft();
    } catch (err) {
      toast('Impossible de lire cette image. Essaie un PNG ou un JPG.');
    }
  });

  function renderDraft() {
    $('#propPreview').hidden = !draft;
    $('#propPick').hidden = !!draft;
    if (draft) $('#propPreview img').src = draft.data;
    $('#propSend').disabled = !draft;
  }
  $('#propClear').addEventListener('click', () => { draft = null; renderDraft(); });

  $('#propForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!draft) return;
    const name = $('#propName').value.trim() || 'Mon sticker';
    if (state.myProposals.filter((x) => x.status === 'pending').length >= maxPending()) {
      toast(`Tu as déjà ${maxPending()} propositions en attente. Attends qu'elles soient regardées !`);
      return;
    }
    const rec = {
      id: uid(), proposal: true, owner: state.player.key, ownerName: state.player.name,
      name, ...draft, status: 'pending', created: Date.now(),
    };
    $('#propSend').disabled = true;
    try {
      await db.putImage(rec);
      state.myProposals.push(rec);
      draft = null;
      $('#propName').value = '';
      toast('Envoyé ! L\'administratrice va regarder ta proposition. Réponse dans ta boîte aux lettres 📬');
    } catch (err) {
      console.warn('Envoi impossible', err);
      toast('Ta proposition n\'a pas pu être envoyée. Vérifie ta connexion.');
    }
    renderCreations();
  });

  function renderCreations() {
    renderPoints();
    renderDraft();
    const list = $('#propList');
    list.innerHTML = '';
    const mine = [...state.myProposals].sort((a, b) => (b.created || 0) - (a.created || 0));
    $('#propEmpty').hidden = mine.length > 0;
    for (const p of mine) {
      const card = document.createElement('div');
      card.className = 'prop-card';
      card.dataset.status = p.status;
      card.innerHTML = `
        <div class="env-item-img"><img alt=""></div>
        <span class="prop-name"></span>
        <span class="prop-status"></span>
        ${p.status === 'pending' ? '<button class="btn btn-ghost prop-del">Retirer</button>' : ''}`;
      card.querySelector('img').src = p.data;
      card.querySelector('.prop-name').textContent = p.name;
      card.querySelector('.prop-status').textContent = STATUS_LABELS[p.status] + (p.status === 'accepted' && p.reward ? ` · +${p.reward} 🪙` : '');
      const del = card.querySelector('.prop-del');
      if (del) del.addEventListener('click', async () => {
        if (!(await askConfirm(`Retirer ta proposition « ${p.name} » ?`, 'Retirer'))) return;
        state.myProposals = state.myProposals.filter((x) => x.id !== p.id);
        db.deleteImage(p.id).catch(() => toast('La proposition n\'a pas pu être retirée.'));
        renderCreations();
      });
      list.appendChild(card);
    }
  }

  // ---------------------------------------------------------------------------
  // Nouveautés : la liste des mises à jour du jeu, et une fenêtre à la connexion
  // pour prévenir les joueurs de ce qui a changé depuis leur dernière visite.
  // ---------------------------------------------------------------------------
  // Mises à jour écrites dans le code (date = jour de la mise en ligne).
  const BUILTIN_NEWS = [
    {
      id: 'n-2026-10-29a', date: Date.UTC(2026, 9, 29, 8, 0), title: 'Le dimanche, tout est au prix normal ☀️',
      items: [
        'Chaque dimanche, toutes les enveloppes de la boutique sont au prix normal, pas seulement celles du jour.',
        'Profites-en pour compléter ta collection : le paquet ×5 est aussi moins cher sur toutes les enveloppes ce jour-là.',
        'Dès le lundi, les enveloppes du jour reviennent.',
      ],
    },
    {
      id: 'n-2026-10-28a', date: Date.UTC(2026, 9, 28, 8, 0), title: 'Des pièces pour participer au concours 🏆',
      items: [
        'Tu gagnes maintenant des pièces 🪙 dès que tu publies ta pièce du concours, une fois par jour.',
        'Tu peux toujours la modifier et la republier jusqu\'à minuit, sans gagner de pièces en plus.',
        'Le montant est indiqué sur l\'écran du concours, à côté du thème du jour.',
      ],
    },
    {
      id: 'n-2026-10-24a', date: Date.UTC(2026, 9, 24, 9, 0), title: 'Menu Paramètres ⚙️',
      items: [
        'Le bouton en haut à droite du menu ouvre maintenant les Paramètres.',
        'Tu peux choisir ton thème : ☀️ clair, 🌙 sombre, ou 🌓 automatique (comme ton téléphone).',
        'Tu y retrouves aussi « Se déconnecter ».',
      ],
    },
    {
      id: 'n-2026-10-23a', date: Date.UTC(2026, 9, 23, 9, 30), title: 'Un escalier offert 🪜',
      items: [
        'Quand tu débloques les étages, un message avec un escalier gratuit (de la collection Meuble) arrive dans ta boîte aux lettres, pour monter au premier niveau.',
        'Si tu avais déjà débloqué les étages, ton escalier t\'attend dans ta boîte aux lettres !',
      ],
    },
    {
      id: 'n-2026-10-22b', date: Date.UTC(2026, 9, 22, 9, 0), title: 'Boîte aux lettres 💌',
      items: [
        'Tu gagnes le concours ? Un message de victoire arrive dans ta boîte aux lettres, avec ta récompense à récupérer.',
        'Nouveau bouton « 📬 Tout lire et tout récupérer » pour ouvrir tous tes cadeaux d\'un coup.',
      ],
    },
    {
      id: 'n-2026-10-22a', date: Date.UTC(2026, 9, 22, 8, 0), title: 'Les enveloppes du jour ⭐',
      items: [
        'Chaque jour, quelques enveloppes de la boutique sont au prix normal : ce sont les enveloppes du jour, les mêmes pour tout le monde.',
        'Les autres restent en vente, mais plus chères. Reviens demain : la sélection change à minuit !',
      ],
    },
    {
      id: 'n-2026-10-21c', date: Date.UTC(2026, 9, 21, 11, 0), title: 'Concours : brouillon 📝',
      items: [
        'Dans ta pièce du concours, le bouton « 💾 Brouillon » enregistre ta pièce : reviens la finir plus tard, jusqu\'à minuit.',
        'Sur l\'écran du concours, ton brouillon s\'affiche avec « ✏️ Reprendre » ou « 🗑️ Recommencer ».',
      ],
    },
    {
      id: 'n-2026-10-21b', date: Date.UTC(2026, 9, 21, 9, 0), title: 'Concours : pars d\'une de tes pièces 📋',
      items: [
        'En créant ta pièce du concours, tu peux partir de zéro ou d\'une copie d\'une de tes pièces. Ta pièce d\'origine ne change pas.',
      ],
    },
    {
      id: 'n-2026-10-21a', date: Date.UTC(2026, 9, 21, 6, 30), title: 'Vote en duels ⚔️',
      items: [
        'Pour le concours, le vote se fait maintenant en duels : deux pièces s\'affichent, touche ta préférée. Jamais la tienne !',
        'Termine tes duels du jour (10 au plus) et gagne des pièces 🪙 pour avoir voté.',
        'À 20 h, la pièce qui a gagné le plus de duels (en %) remporte le concours.',
      ],
    },
    {
      id: 'n-2026-10-20e', date: Date.UTC(2026, 9, 20, 11, 30), title: 'Nouveau look ✨',
      items: [
        'Le menu principal fait peau neuve : nouvelles couleurs, nouvelles icônes et une jolie police.',
        'La boîte aux lettres 📬 et les Nouveautés ✨ sont maintenant en haut, à côté de tes pièces et de tes étoiles.',
      ],
    },
    {
      id: 'n-2026-10-20d', date: Date.UTC(2026, 9, 20, 9, 45), title: 'Concours du jour 🏆',
      items: [
        'Chaque jour, un nouveau thème ! Dans 🏆 Concours du jour, crée ta pièce du concours : tu y as tous tes stickers, même ceux déjà posés ailleurs, sans rien enlever à tes pièces. Puis appuie sur 🏆 Publier.',
        'Le lendemain, tout le monde vote pour sa pièce préférée ❤️ jusqu\'à 20 h (une voix par joueur, pas pour soi).',
        'À 20 h, on dévoile le gagnant : il reçoit des pièces 🪙 automatiquement.',
      ],
    },
    {
      id: 'n-2026-10-20c', date: Date.UTC(2026, 9, 20, 9, 30), title: 'Nouvelle palette de couleurs 🎨',
      items: [
        'Touche une couleur dans 🎨 Couleurs : une palette s\'ouvre en bas de l\'écran, et la pièce change en direct.',
        'Garde jusqu\'à 8 couleurs en mémoire avec « ＋ Garder cette couleur » (appui long sur une couleur pour la retirer).',
        '« 🎚️ Personnaliser » : les curseurs partent de la couleur actuelle, pour l\'ajuster facilement.',
      ],
    },
    {
      id: 'n-2026-10-20b', date: Date.UTC(2026, 9, 20, 9), title: 'Des couleurs pour tes étages 🎨',
      items: [
        'Dans 🎨 Couleurs, tu peux maintenant choisir la couleur des murs de tes étages (côté gauche et côté droit) et celle de leur sol.',
      ],
    },
    {
      id: 'n-2026-10-20', date: Date.UTC(2026, 9, 19, 22), title: 'Aménage tes pièces 🏗️',
      items: [
        'Nouveau bouton 🏗️ Aménager dans tes pièces : transforme une pièce en jardin 🌳, choisis sa taille 📐 et ajoute des étages au fond 🏢. Chaque option se débloque avec des étoiles 🌟.',
        'Tes étoiles 🌟 s\'affichent maintenant à côté de tes pièces 🪙.',
        'Dans la Collection, le bouton « 🌟 Utiliser une étoile » te laisse choisir un sticker de la page ouverte.',
        'Dans une pièce : les boutons 🎨 Couleurs et 🏗️ Aménager sont sous les flèches, 📷 Exporter et 🧹 Tout vider en haut.',
        'Le bouton ⤢ agrandit la fenêtre de tes stickers.',
      ],
    },
    {
      id: 'n-2026-10-19', date: Date.UTC(2026, 9, 18, 22), title: 'Propose tes dessins ✏️',
      items: [
        'Quand ton sticker proposé est accepté, tu reçois des pièces et ton sticker en 1 exemplaire dans ta boîte aux lettres 📬.',
        'Tu peux avoir jusqu\'à 30 propositions en attente.',
        'Des cadeaux peuvent arriver dans ta boîte aux lettres : pièces et stickers 🎁.',
      ],
    },
  ];
  state.news = [...BUILTIN_NEWS];
  function setNews(fromDb) {
    state.news = [...BUILTIN_NEWS, ...(fromDb || [])].sort((a, b) => (b.date || 0) - (a.date || 0));
  }
  const unseenNews = () => {
    const seen = (state.profile && state.profile.newsSeen) || 0;
    return state.news.filter((n) => (n.date || 0) > seen);
  };
  function markNewsSeen() {
    const latest = Math.max(0, ...state.news.map((n) => n.date || 0));
    if (state.profile && latest > (state.profile.newsSeen || 0)) {
      state.profile.newsSeen = latest;
      saveProfile();
    }
    renderNewsBadge();
  }
  function renderNewsBadge() {
    const n = unseenNews().length;
    $('#newsBadge').hidden = !n;
    $('#newsBadge').textContent = n;
    $('#homeNewsSub').textContent = n ? `${plural(n, 'nouveauté')} à découvrir !` : 'Les dernières mises à jour';
    $('#homeNews').setAttribute('aria-label', `Nouveautés, ${$('#homeNewsSub').textContent.toLowerCase()}`);
  }

  // Une nouveauté (titre, date, liste ou texte) dans un élément.
  function newsCard(n, withDelete) {
    const el = document.createElement('article');
    el.className = 'news-item';
    el.innerHTML = '<div class="mail-head"><h3></h3><time></time></div><ul class="news-points"></ul><p class="mail-text"></p>';
    el.querySelector('h3').textContent = n.title;
    el.querySelector('time').textContent = n.date ? new Date(n.date).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
    const ul = el.querySelector('ul');
    for (const it of n.items || []) {
      const li = document.createElement('li');
      li.textContent = it;
      ul.appendChild(li);
    }
    ul.hidden = !(n.items || []).length;
    el.querySelector('.mail-text').textContent = n.text || '';
    el.querySelector('.mail-text').hidden = !n.text;
    if (withDelete && !n.id.startsWith('n-')) {
      const del = document.createElement('button');
      del.className = 'btn btn-ghost news-del';
      del.textContent = 'Supprimer';
      del.addEventListener('click', async () => {
        if (!(await askConfirm(`Supprimer la nouveauté « ${n.title} » ?`, 'Supprimer'))) return;
        state.news = state.news.filter((x) => x.id !== n.id);
        db.deleteNews(n.id).catch(() => toast('La nouveauté n\'a pas pu être supprimée.'));
        renderNews();
      });
      el.appendChild(del);
    }
    return el;
  }

  // Fenêtre à la connexion : ce qui est nouveau depuis la dernière visite.
  const newsDialog = $('#newsDialog');
  function showNewsPopup() {
    const list = unseenNews();
    renderNewsBadge();
    if (!list.length) return;
    const body = $('#newsDialogList');
    body.innerHTML = '';
    list.slice(0, 3).forEach((n) => body.appendChild(newsCard(n, false)));
    $('#newsDialogMore').hidden = list.length <= 3;
    newsDialog.hidden = false;
  }
  $('#newsDialogOk').addEventListener('click', () => { newsDialog.hidden = true; markNewsSeen(); });
  $('#newsDialogAll').addEventListener('click', () => { newsDialog.hidden = true; openNews(); });

  function openNews() {
    if (maintBlocked('news')) return;
    renderNews();
    showScreen('news');
    markNewsSeen();
  }
  function renderNews() {
    renderPoints();
    $('#newsForm').hidden = !state.isAdmin;
    const list = $('#newsList');
    list.innerHTML = '';
    $('#newsEmpty').hidden = state.news.length > 0;
    for (const n of state.news) list.appendChild(newsCard(n, state.isAdmin));
  }
  $('#homeNews').addEventListener('click', openNews);
  $('#newsBack').addEventListener('click', goHome);

  // L'administratrice écrit une nouveauté : les joueurs la verront à leur prochaine connexion.
  $('#newsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = $('#newsTitle').value.trim();
    const lines = $('#newsText').value.split('\n').map((l) => l.replace(/^[-•*]\s*/, '').trim()).filter(Boolean);
    if (!title || !lines.length) { toast('Écris un titre et au moins une ligne.'); return; }
    const n = { id: uid(), date: Date.now(), title, items: lines };
    try {
      await db.putNews(n);
      state.news.unshift(n);
      $('#newsTitle').value = '';
      $('#newsText').value = '';
      // L'administratrice l'a déjà vue.
      state.profile.newsSeen = n.date;
      saveProfile();
      toast('Nouveauté publiée : les joueurs la verront à leur prochaine connexion ✨');
      renderNews();
    } catch (err) {
      console.warn('Nouveauté impossible', err);
      toast('La nouveauté n\'a pas pu être publiée. Vérifie ta connexion.');
    }
  });

  // ---------------------------------------------------------------------------
  // Concours du jour : un thème par jour. Jour J : chacun publie une de ses pièces.
  // Jour J+1 : tout le monde vote jusqu'à 20 h ; à 20 h, on dévoile le gagnant, qui reçoit des pièces.
  // ---------------------------------------------------------------------------
  const CONTEST_REWARD = 200;
  const VOTE_END_HOUR = 20;
  const votingOver = () => new Date().getHours() >= VOTE_END_HOUR;
  // Vote en maintenance (réglable dans l'atelier ; activé tant que l'administratrice ne l'a pas rouvert).
  const voteMaintenanceOn = () => state.settings.voteMaintenance !== false || maintOn('contest');
  // L'administratrice peut toujours voter, pour tester pendant la maintenance.
  const voteMaintenance = () => voteMaintenanceOn() && !state.isAdmin;
  // Heure de fin des votes du concours d'un jour : le lendemain à 20 h.
  const voteEnd = (day) => { const { y, m, dd } = parseDay(day); return new Date(y, m - 1, dd + 1, VOTE_END_HOUR).getTime(); };
  // Dernier concours dont le gagnant est dévoilé.
  const lastRevealedDay = () => shiftDay(today(), votingOver() ? -1 : -2);
  const DEFAULT_THEMES = [
    'Chambre cosy', 'Cuisine gourmande', 'Jardin fleuri', 'Salle de bain zen', 'Bibliothèque', 'Pâtisserie',
    'Chambre d\'enfant', 'Café', 'Atelier d\'artiste', 'Plage', 'Forêt enchantée', 'Halloween',
    'Noël', 'Printemps', 'Fête d\'anniversaire', 'Salon douillet', 'Magasin de jouets', 'Serre tropicale',
    'Pique-nique', 'Château', 'Sous la mer', 'Espace', 'Fleuriste', 'Boulangerie',
    'Tout en rose', 'Tout en vert', 'Petit déjeuner', 'Soirée cinéma', 'Animaux', 'Rêve',
  ];
  const contestReward = () => setting('contestReward');
  const contestThemes = () => {
    const list = Array.isArray(state.settings.contestThemes) ? state.settings.contestThemes.filter(Boolean) : [];
    return list.length ? list : DEFAULT_THEMES;
  };
  const parseDay = (d) => { const [y, m, dd] = d.split('-').map(Number); return { y, m, dd }; };
  function shiftDay(day, n) {
    const { y, m, dd } = parseDay(day);
    return new Date(y, m - 1, dd + n).toLocaleDateString('fr-CA');
  }
  // Thème choisi à la main par l'administratrice pour ce jour (sinon la rotation de la liste).
  function themeOf(day) {
    const o = state.settings.contestThemeOverrides && state.settings.contestThemeOverrides[day];
    return typeof o === 'string' && o.trim() ? o : autoThemeOf(day);
  }
  function autoThemeOf(day) {
    const { y, m, dd } = parseDay(day);
    const idx = Math.round((Date.UTC(y, m - 1, dd) - Date.UTC(2026, 0, 1)) / 86400000);
    const list = contestThemes();
    return list[((idx % list.length) + list.length) % list.length];
  }
  const dayLabel = (day) => { const { y, m, dd } = parseDay(day); return new Date(y, m - 1, dd).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }); };

  // Participations et votes d'un jour, avec le classement.
  // Votes en duels : on montre 2 pièces, on touche sa préférée. Classement au % de duels gagnés.
  const DUELS_MAX = 10;                // duels par joueur et par jour
  const VOTE_REWARD = 20;              // pièces pour avoir fini ses duels du jour
  const voteReward = () => setting('voteReward');
  // Gagnant d'office (une seule participation) : moitié de la récompense par défaut.
  const soloReward = () => setting('contestSoloReward');

  async function loadContestDay(day) {
    const docs = await db.listContest(day);
    const entries = docs.filter((d) => d.kind === 'entry');
    const owners = new Set(entries.map((e) => e.owner));
    const inTime = (d) => !d.created || d.created <= voteEnd(day);
    // Les duels arrivés après 20 h ne comptent pas, ni ceux sur sa propre pièce.
    const duels = docs.filter((d) => d.kind === 'duel' && inTime(d) && owners.has(d.a) && owners.has(d.b)
      && d.a !== d.voter && d.b !== d.voter && (d.winner === d.a || d.winner === d.b));
    // Anciens votes (avant les duels) : un vote = une victoire.
    const votes = docs.filter((d) => d.kind === 'vote' && inTime(d) && d.entry !== d.voter && owners.has(d.entry));
    return scoreContest(day, entries, duels, votes);
  }

  // Classement : % de duels gagnés (et les règles pour 1 ou 2 participations).
  function scoreContest(day, entries, duels, votes) {
    const wins = {}, seen = {};
    for (const d of duels) {
      seen[d.a] = (seen[d.a] || 0) + 1;
      seen[d.b] = (seen[d.b] || 0) + 1;
      wins[d.winner] = (wins[d.winner] || 0) + 1;
    }
    for (const v of votes) { wins[v.entry] = (wins[v.entry] || 0) + 1; seen[v.entry] = (seen[v.entry] || 0) + 1; }
    const rate = (o) => (seen[o] ? (wins[o] || 0) / seen[o] : 0);
    let winners = [];
    let solo = false;
    if (entries.length === 1) {
      // Une seule participation : gagnante d'office.
      winners = [entries[0].owner];
      solo = true;
    } else if (entries.length === 2 && !duels.length && !votes.length) {
      // Deux pièces et personne n'a voté : égalité.
      winners = entries.map((e) => e.owner);
    } else {
      const best = Math.max(0, ...entries.map((e) => rate(e.owner)));
      if (best > 0) winners = entries.filter((e) => rate(e.owner) === best).map((e) => e.owner);
    }
    return { day, entries, duels, votes, wins, seen, rate, winners, solo };
  }
  const rewardOf = (res) => (res.solo ? soloReward() : contestReward());

  // À la connexion : récompense des concours terminés (résultats le surlendemain).
  // Un seul calcul à la fois (sinon la récompense pourrait être donnée deux fois).
  let claiming = null;
  function claimContestRewards() {
    if (!claiming) claiming = doClaimContestRewards().finally(() => { claiming = null; });
    return claiming;
  }
  async function doClaimContestRewards() {
    if (!state.profile) return;
    const last = lastRevealedDay();
    let from = state.profile.contestChecked ? shiftDay(state.profile.contestChecked, 1) : shiftDay(today(), -8);
    if (from < shiftDay(today(), -8)) from = shiftDay(today(), -8);
    if (from > last) return;
    const wins = [];
    try {
      for (let d = from; d <= last; d = shiftDay(d, 1)) {
        const res = await loadContestDay(d);
        if (res.winners.includes(state.player.key)) wins.push({ day: d, res });
      }
    } catch (e) {
      console.warn('Résultats du concours indisponibles', e);
      return;
    }
    // Chaque victoire arrive dans la boîte aux lettres, avec la récompense à récupérer.
    const me = state.player.key;
    try {
      for (const { day, res } of wins) {
        const id = `contest-win-${day}-${me}`;
        if (state.mails.some((m) => m.id === id)) continue;
        const reward = rewardOf(res);
        const entry = res.entries.find((e) => e.owner === me);
        const room = entry && entry.roomName ? ` « ${entry.roomName} »` : '';
        const when = dateFmt.format(new Date(`${day}T12:00:00`)).replace(/ à .*/, '');
        let how;
        if (res.solo) how = 'Tu étais la seule participation : tu gagnes d\'office !';
        else if (res.winners.length > 1) how = `Égalité : tu partages la victoire avec ${res.winners.length - 1 > 1 ? `${res.winners.length - 1} autres joueurs` : 'un autre joueur'}.`;
        else how = res.seen[me] ? `Ta pièce a gagné ${res.wins[me] || 0} duel${(res.wins[me] || 0) > 1 ? 's' : ''} sur ${res.seen[me]} (${Math.round(res.rate(me) * 100)} %).` : '';
        const m = {
          id, to: me, title: `🏆 Tu as gagné le concours « ${themeOf(day)} » !`,
          text: `Bravo ! Ta pièce${room} a remporté le concours du ${when}, sur le thème « ${themeOf(day)} ». ${how}\n\nVoici ta récompense : ${reward} 🪙.`,
          reward, read: false, claimed: false, created: Date.now(),
        };
        if (await db.createMail(m)) state.mails.push(m);
      }
    } catch (e) {
      console.warn('Message de victoire impossible', e);
      return; // on réessaiera à la prochaine connexion
    }
    state.profile.contestChecked = last;
    if (wins.length) {
      state.profile.contestWins = (state.profile.contestWins || 0) + wins.length;
      const themes = wins.map((w) => themeOf(w.day));
      renderMailBadge();
      setTimeout(() => toast(`🏆 Tu as gagné le concours « ${themes.join(' », « ')} » ! Ta récompense t'attend dans ta boîte aux lettres 💌`), 1500);
    }
    saveProfile();
  }

  let contestData = { today: null, vote: null, results: null };
  async function openContest() {
    if (maintBlocked('contest')) return;
    showScreen('contest');
    renderPoints();
    $('#ctBody').innerHTML = '<p class="muted">Chargement…</p>';
    try {
      const [t, v, r] = await Promise.all([
        loadContestDay(today()), loadContestDay(shiftDay(today(), -1)), loadContestDay(lastRevealedDay()),
      ]);
      contestData = { today: t, vote: v, results: r };
      claimContestRewards();
    } catch (e) {
      console.warn('Concours indisponible', e);
      $('#ctBody').innerHTML = '<p class="muted">Impossible de charger le concours. Vérifie ta connexion.</p>';
      return;
    }
    renderContest();
  }
  $('#ctBack').addEventListener('click', goHome);

  function entryCard(e, opts = {}) {
    const card = document.createElement('article');
    card.className = 'ct-entry' + (opts.mine ? ' mine' : '') + (opts.voted ? ' voted' : '') + (opts.winner ? ' winner' : '');
    card.innerHTML = '<button class="ct-img" title="Agrandir"><img alt=""></button><div class="ct-meta"><strong></strong><span class="muted"></span></div><div class="ct-actions"></div>';
    card.querySelector('img').src = e.image;
    card.querySelector('strong').textContent = (opts.winner ? '🏆 ' : '') + (e.ownerName || e.owner);
    card.querySelector('.muted').textContent = e.roomName || '';
    card.querySelector('.ct-img').addEventListener('click', () => {
      $('#ctViewImg').src = e.image;
      $('#ctViewTitle').textContent = `${e.ownerName || e.owner}${e.roomName ? ' · ' + e.roomName : ''}`;
      $('#ctView').hidden = false;
    });
    if (opts.score) {
      const c = document.createElement('span');
      c.className = 'ct-count';
      c.textContent = opts.score;
      card.querySelector('.ct-meta').appendChild(c);
    }
    if (state.isAdmin && opts.canModerate) {
      const del = document.createElement('button');
      del.className = 'btn btn-ghost ct-small';
      del.textContent = 'Retirer';
      del.addEventListener('click', async () => {
        if (!(await askConfirm(`Retirer la participation de ${e.ownerName || e.owner} ?`, 'Retirer'))) return;
        await db.deleteContest(e.id).catch(() => toast('La participation n\'a pas pu être retirée.'));
        if (!screens.adminContest.hidden) refreshAdminContest(); else openContest();
      });
      card.querySelector('.ct-actions').appendChild(del);
    }
    return card;
  }

  function renderContest() {
    const body = $('#ctBody');
    body.innerHTML = '';
    const me = state.player.key;
    const section = (cls, title, sub) => {
      const sec = document.createElement('section');
      sec.className = 'ct-section ' + cls;
      sec.innerHTML = '<div class="ct-head"><h2></h2><p class="muted"></p></div><div class="ct-content"></div>';
      sec.querySelector('h2').textContent = title;
      sec.querySelector('p').textContent = sub;
      body.appendChild(sec);
      return sec.querySelector('.ct-content');
    };

    // 1. Thème du jour : publier une pièce
    const t = contestData.today;
    const c1 = section('ct-today', `Thème du jour : ${themeOf(t.day)}`,
      `Décore une pièce sur ce thème et publie-la avant minuit${setting('contestJoinReward') > 0 ? ` (+${setting('contestJoinReward')} 🪙 pour ta participation)` : ''}. Demain, tout le monde vote jusqu'à 20 h, puis on dévoile le gagnant : il reçoit ${contestReward()} 🪙.`);
    const mine = t.entries.find((e) => e.owner === me);
    if (mine) {
      const box = document.createElement('div');
      box.className = 'ct-mine';
      box.appendChild(entryCard(mine, { mine: true }));
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = 'Ta participation est publiée ✓ Tu peux encore modifier ta pièce et la republier jusqu\'à minuit.';
      box.appendChild(p);
      c1.appendChild(box);
    }
    const myRoom = state.rooms.find((r) => r.contestDay === t.day);
    if (myRoom && !(blankContestRoom(myRoom) && !mine)) {
      // Brouillon : la pièce du concours en cours, enregistrée, à reprendre plus tard.
      const card = document.createElement('div');
      card.className = 'ct-draft';
      const pending = !mine || !myRoom.publishedAt || (myRoom.updated || 0) - myRoom.publishedAt > 3000;
      const hour = (ts) => new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
      card.innerHTML = `<button type="button" class="ct-draft-open">${myRoom.thumb ? '<img class="room-thumb" alt="">'
        : `<svg class="room-thumb" viewBox="0 0 1000 760" xmlns="http://www.w3.org/2000/svg">${roomSvg(myRoom.colors, myRoom.shape)}</svg>`}</button>
        <div class="ct-draft-info"><p class="ct-draft-title"></p><p class="muted ct-small-text ct-draft-sub"></p>
        <div class="ct-draft-actions"><button type="button" class="btn btn-primary ct-draft-go">✏️ Reprendre</button>
        <button type="button" class="btn btn-ghost ct-draft-reset">🗑️ Recommencer</button></div></div>`;
      if (myRoom.thumb) card.querySelector('img').src = myRoom.thumb;
      card.querySelector('.ct-draft-title').textContent = mine ? (pending ? '📝 Modifications pas encore publiées' : '✅ Pièce publiée, à jour') : '📝 Mon brouillon';
      card.querySelector('.ct-draft-sub').textContent = `Enregistré à ${hour(myRoom.updated || Date.now())} · ${plural((myRoom.stickers || []).length, 'sticker')}`
        + (pending ? ' · appuie sur « 🏆 Publier » dans la pièce quand elle est prête.' : '');
      card.querySelector('.ct-draft-open').addEventListener('click', openContestRoom);
      card.querySelector('.ct-draft-go').addEventListener('click', openContestRoom);
      card.querySelector('.ct-draft-reset').addEventListener('click', async () => {
        const msg = mine
          ? 'Effacer ton brouillon et repartir d\'une autre pièce ? Ta participation déjà publiée reste en place tant que tu n\'en publies pas une nouvelle.'
          : 'Effacer ton brouillon et repartir de zéro ou d\'une autre pièce ?';
        if (!(await askConfirm(msg, 'Recommencer'))) return;
        state.rooms = state.rooms.filter((x) => x.id !== myRoom.id);
        db.deleteRoom(myRoom.id).catch(() => {});
        openContestRoom();
      });
      c1.appendChild(card);
    } else {
      const pub = document.createElement('button');
      pub.className = 'btn btn-primary';
      pub.textContent = '🎨 Créer ma pièce du concours';
      pub.addEventListener('click', openContestRoom);
      c1.appendChild(pub);
    }
    const help = document.createElement('p');
    help.className = 'muted ct-small-text';
    help.textContent = 'Une pièce rien que pour ce thème, vide ou copiée d\'une de tes pièces : tu y as tous tes stickers, même ceux déjà posés dans tes pièces, sans rien leur enlever. Elle s\'enregistre toute seule (bouton « 💾 Brouillon » pour revenir plus tard) ; quand elle te plaît, appuie sur « 🏆 Publier ».';
    c1.appendChild(help);
    const nb = document.createElement('p');
    nb.className = 'muted ct-small-text';
    nb.textContent = t.entries.length ? `${plural(t.entries.length, 'participation')} aujourd'hui.` : 'Personne n\'a encore participé aujourd\'hui : sois la première ou le premier !';
    c1.appendChild(nb);
    if (state.isAdmin && t.entries.length) {
      const grid = document.createElement('div');
      grid.className = 'ct-grid';
      t.entries.forEach((e) => grid.appendChild(entryCard(e, { canModerate: true })));
      c1.appendChild(grid);
    }

    // 2. Vote en duels pour le thème d'hier
    const v = contestData.vote;
    if (voteMaintenance()) {
      section('ct-vote ct-maintenance', '🛠️ Vote en maintenance', 'Le vote est momentanément fermé pour maintenance. Tu peux toujours créer et publier ta pièce du concours : le vote reviendra bientôt !');
    } else if (!votingOver()) {
      const title = `Vote : ${themeOf(v.day)}${voteMaintenanceOn() ? ' · 🛠️ test admin (en maintenance pour les joueurs)' : ''}`;
      const plan = duelPlan(v, me);
      let sub;
      if (!v.entries.length) sub = 'Personne n\'a participé hier : rien à voter aujourd\'hui.';
      else if (v.entries.length === 1) sub = `Une seule participation hier : pas de vote aujourd'hui. ${v.entries[0].owner === me ? 'Tu gagnes' : `${v.entries[0].ownerName || v.entries[0].owner} gagne`} d'office à 20 h !`;
      else if (!plan.total) sub = 'Tu as participé hier et il n\'y a qu\'une autre pièce : tu ne peux pas voter aujourd\'hui. Les autres joueurs départagent !';
      else sub = `Touche ta pièce préférée dans chaque duel (jamais la tienne). ${plan.total > 1 ? `Termine tes ${plan.total} duels` : 'Fais ton duel'} pour gagner ${voteReward()} 🪙. Gagnant dévoilé à 20 h !`;
      const c2 = section('ct-vote', title, sub);
      if (plan.total) {
        const finished = plan.done >= plan.total;
        const b = document.createElement('button');
        b.className = 'btn ' + (finished ? '' : 'btn-primary') + ' vote-open';
        b.textContent = finished ? `✓ Duels terminés (${plan.total}/${plan.total})` : `⚔️ Voter${plan.done ? ` · ${plan.done}/${plan.total}` : ''}`;
        b.addEventListener('click', () => openDuelView(v));
        c2.appendChild(b);
        // Admin : effacer ses duels du jour pour retester le vote.
        if (state.isAdmin && plan.done) {
          const r = document.createElement('button');
          r.className = 'btn btn-ghost vote-open';
          r.textContent = '🔁 Recommencer mes votes (test admin)';
          r.addEventListener('click', () => resetMyDuels(v));
          c2.appendChild(r);
        }
      }
    }

    // 3. Résultats du dernier concours dévoilé (à 20 h le lendemain)
    const r = contestData.results;
    const c3 = section('ct-results', `${r.day === shiftDay(today(), -1) ? 'Résultats de ce soir' : 'Derniers résultats'} : ${themeOf(r.day)}`,
      !r.entries.length ? 'Pas de participation ce jour-là.'
        : r.solo ? `Une seule participation : gagnante d'office, avec ${soloReward()} 🪙.`
          : r.winners.length ? `Bravo ! ${r.winners.length > 1 ? 'Les gagnants reçoivent' : 'Le gagnant reçoit'} ${contestReward()} 🪙.` : 'Aucun vote : pas de gagnant cette fois.');
    if (r.entries.length) {
      const grid = document.createElement('div');
      grid.className = 'ct-grid';
      [...r.entries].sort((a, b) => r.rate(b.owner) - r.rate(a.owner) || (r.wins[b.owner] || 0) - (r.wins[a.owner] || 0))
        .forEach((e) => grid.appendChild(entryCard(e, {
          winner: r.winners.includes(e.owner), mine: e.owner === me,
          score: r.seen[e.owner] ? `⚔️ ${r.wins[e.owner] || 0}/${r.seen[e.owner]} · ${Math.round(r.rate(e.owner) * 100)} %` : null,
        })));
      c3.appendChild(grid);
    }
    const hist = document.createElement('button');
    hist.className = 'btn ct-history-btn';
    hist.textContent = '📜 Mon historique des concours';
    hist.addEventListener('click', openContestHistory);
    body.appendChild(hist);
  }

  // Historique : toutes les pièces publiées par le joueur, avec le résultat de chaque concours terminé.
  async function openContestHistory() {
    showScreen('ctHistory');
    renderPoints();
    const body = $('#ctHistBody');
    body.innerHTML = '<p class="muted">Chargement…</p>';
    try {
      const mine = (await db.listMyContest(state.player.key)).filter((e) => e.contestDay && e.image)
        .sort((a, b) => b.contestDay.localeCompare(a.contestDay));
      if (!mine.length) { body.innerHTML = '<p class="muted">Tu n\'as pas encore participé à un concours. Tes pièces publiées apparaîtront ici !</p>'; return; }
      const done = lastRevealedDay();
      const results = {};
      await Promise.all(mine.filter((e) => e.contestDay <= done).map(async (e) => {
        try { results[e.contestDay] = await loadContestDay(e.contestDay); } catch (err) { /* résultat indisponible */ }
      }));
      body.innerHTML = '';
      const wonCount = mine.filter((e) => results[e.contestDay] && results[e.contestDay].winners.includes(e.owner)).length;
      const intro = document.createElement('p');
      intro.className = 'muted';
      intro.textContent = `${plural(mine.length, 'participation')}${wonCount ? ` · 🏆 ${plural(wonCount, 'victoire')}` : ''}. Touche une pièce pour l'agrandir.`;
      body.appendChild(intro);
      const grid = document.createElement('div');
      grid.className = 'ct-grid';
      for (const e of mine) {
        const r = results[e.contestDay];
        const won = !!r && r.winners.includes(e.owner);
        let score = null;
        if (e.contestDay > done) score = e.contestDay === today() ? '⏳ Vote demain' : '⏳ Résultat à 20 h';
        else if (r && r.solo) score = 'Seule participante : gagnée d\'office';
        else if (r && r.seen[e.owner]) score = `⚔️ ${r.wins[e.owner] || 0}/${r.seen[e.owner]} · ${Math.round(r.rate(e.owner) * 100)} %`;
        const card = entryCard({ ...e, ownerName: `${themeOf(e.contestDay)}`, roomName: dayLabel(e.contestDay) }, { mine: true, winner: won, score });
        grid.appendChild(card);
      }
      body.appendChild(grid);
    } catch (err) {
      console.warn('Historique indisponible', err);
      body.innerHTML = '<p class="muted">Impossible de charger ton historique. Vérifie ta connexion.</p>';
    }
  }
  $('#ctHistBack').addEventListener('click', openContest);

  // Les duels d'un joueur : toutes les paires de pièces (sans la sienne), 10 au plus.
  function duelPlan(v, me) {
    const others = v.entries.filter((e) => e.owner !== me).map((e) => e.owner);
    const pairs = [];
    for (let i = 0; i < others.length; i++) for (let j = i + 1; j < others.length; j++) pairs.push([others[i], others[j]].sort());
    const mine = v.duels.filter((d) => d.voter === me);
    const done = new Set(mine.map((d) => [d.a, d.b].sort().join('|')));
    const total = Math.min(setting('duelsMax'), pairs.length);
    const left = pairs.filter((p) => !done.has(p.join('|')));
    return { pairs, left, done: Math.min(mine.length, total), total };
  }
  // Prochain duel : les pièces les moins vues d'abord, pour que chacune passe autant de fois.
  function nextDuel(v, plan) {
    if (plan.done >= plan.total || !plan.left.length) return null;
    const seen = {};
    for (const d of v.duels) { seen[d.a] = (seen[d.a] || 0) + 1; seen[d.b] = (seen[d.b] || 0) + 1; }
    const score = (p) => (seen[p[0]] || 0) + (seen[p[1]] || 0) + Math.random() * 0.5;
    const best = [...plan.left].sort((x, y) => score(x) - score(y))[0];
    return Math.random() < 0.5 ? best : [best[1], best[0]];
  }

  function provisionalRanking(v) {
    const res = scoreContest(v.day, v.entries, v.duels, v.votes);
    const box = document.createElement('div');
    box.className = 'ct-provisional';
    const h = document.createElement('p');
    h.className = 'ct-prov-title';
    h.textContent = `🔮 Classement provisoire (visible seulement par toi) · ${plural(v.duels.length, 'duel')} joué${v.duels.length > 1 ? 's' : ''}`;
    box.appendChild(h);
    const ol = document.createElement('ol');
    [...v.entries].sort((a, b) => res.rate(b.owner) - res.rate(a.owner) || (res.wins[b.owner] || 0) - (res.wins[a.owner] || 0)).forEach((e) => {
      const li = document.createElement('li');
      const win = res.winners.includes(e.owner);
      li.textContent = `${win ? '🏆 ' : ''}${e.ownerName || e.owner} — ${res.seen[e.owner] ? `${res.wins[e.owner] || 0}/${res.seen[e.owner]} duels gagnés · ${Math.round(res.rate(e.owner) * 100)} %` : 'pas encore vue en duel'}`;
      if (win) li.className = 'win';
      ol.appendChild(li);
    });
    box.appendChild(ol);
    const p = document.createElement('p');
    p.className = 'muted ct-small-text';
    p.textContent = res.winners.length
      ? `Si le vote s'arrêtait maintenant : ${res.winners.map((o) => (v.entries.find((e) => e.owner === o) || {}).ownerName || o).join(', ')} gagnerai${res.winners.length > 1 ? 'ent' : 't'}${res.solo ? ' (gagnant d\'office)' : ''}.`
      : 'Pas encore de gagnant : aucune pièce n\'a gagné de duel.';
    box.appendChild(p);
    return box;
  }

  async function resetMyDuels(v) {
    if (!(await askConfirm('Effacer tes duels du jour pour refaire le vote ? (test admin)', 'Recommencer'))) return;
    const me = state.player.key;
    const mine = v.duels.filter((d) => d.voter === me);
    try {
      await Promise.all(mine.map((d) => db.deleteContest(d.id)));
    } catch (e) {
      console.warn('Effacement impossible', e);
      toast('Les votes n\'ont pas pu être effacés. Vérifie ta connexion.');
      return;
    }
    v.duels = v.duels.filter((d) => d.voter !== me);
    if (state.profile.voteRewardDay === v.day) { state.profile.voteRewardDay = ''; saveProfile(); }
    duelCurrent = null;
    toast('Tes votes du jour sont effacés : tu peux recommencer 🔁');
    renderContest();
  }

  // Page de vote en grand : un duel à la fois.
  const duelView = $('#duelView');
  let duelDay = null;
  function openDuelView(v) {
    duelDay = v;
    renderDuelView();
    duelView.hidden = false;
  }
  function closeDuelView() {
    duelView.hidden = true;
    duelDay = null;
    renderContest();
  }
  $('#duelClose').addEventListener('click', closeDuelView);
  function renderDuelView() {
    const v = duelDay;
    if (!v) return;
    const plan = duelPlan(v, state.player.key);
    $('#duelTitle').textContent = `Vote : ${themeOf(v.day)}`;
    $('#duelSub').textContent = `Touche la pièce que tu préfères (jamais la tienne). ${plan.total > 1 ? `Termine tes ${plan.total} duels` : 'Fais ton duel'} pour gagner ${voteReward()} 🪙. Gagnant dévoilé à 20 h !`;
    const box = $('#duelBody');
    box.innerHTML = '';
    renderDuel(box, v, plan);
  }

  let duelCurrent = null;
  function renderDuel(box, v, plan) {
    const me = state.player.key;
    const prog = document.createElement('p');
    prog.className = 'duel-progress';
    box.appendChild(prog);
    if (plan.done >= plan.total) {
      prog.textContent = plan.total > 1 ? `✓ Merci ! Tu as fait tes ${plan.total} duels du jour.` : '✓ Merci ! Tu as fait ton duel du jour.';
      if ((state.profile.voteRewardDay || '') === v.day) prog.textContent += ` (+${voteReward()} 🪙 reçues)`;
      prog.classList.add('done');
      const end = document.createElement('p');
      end.className = 'muted duel-end';
      end.textContent = 'Reviens à 20 h pour découvrir la pièce gagnante 🏆';
      box.appendChild(end);
      $('#duelClose').textContent = 'Retour au concours';
      return;
    }
    prog.textContent = `Duel ${plan.done + 1} / ${plan.total}`;
    $('#duelClose').textContent = 'Plus tard';
    if (!duelCurrent || duelCurrent.day !== v.day || !plan.left.some((p) => p.join('|') === [...duelCurrent.pair].sort().join('|'))) {
      duelCurrent = { day: v.day, pair: nextDuel(v, plan) };
    }
    const [a, b] = duelCurrent.pair;
    const arena = document.createElement('div');
    arena.className = 'duel-arena';
    for (const owner of [a, b]) {
      const e = v.entries.find((x) => x.owner === owner);
      const btn = document.createElement('button');
      btn.className = 'duel-pick';
      // Pas de nom pendant le duel : on vote pour la pièce, pas pour la personne.
      btn.innerHTML = '<img alt="Pièce du concours"><span class="duel-choose">❤️ Je préfère</span>';
      btn.querySelector('img').src = e.image;
      btn.addEventListener('click', () => castDuel(v, a, b, owner, btn));
      arena.appendChild(btn);
    }
    const vs = document.createElement('span');
    vs.className = 'duel-vs';
    vs.textContent = 'VS';
    arena.insertBefore(vs, arena.children[1]);
    box.appendChild(arena);
  }

  async function castDuel(v, a, b, winner, btn) {
    if (voteMaintenance()) { toast('🛠️ Le vote est en maintenance pour le moment.'); duelView.hidden = true; openContest(); return; }
    if (votingOver()) { toast('Les votes sont clos depuis 20 h : le gagnant est dévoilé !'); duelView.hidden = true; openContest(); return; }
    const me = state.player.key;
    const [x, y] = [a, b].sort();
    const duel = { id: `cd-${v.day}-${me}-${x}-${y}`, kind: 'duel', contestDay: v.day, voter: me, a: x, b: y, winner, created: Date.now() };
    document.querySelectorAll('.duel-pick').forEach((el) => { el.disabled = true; });
    btn.classList.add('chosen');
    try {
      await db.putContest(duel);
    } catch (e) {
      console.warn('Duel impossible', e);
      toast('Le vote n\'a pas pu être enregistré. Vérifie ta connexion.');
      renderDuelView();
      return;
    }
    v.duels = [...v.duels.filter((d) => d.id !== duel.id), duel];
    duelCurrent = null;
    setHomeVote(v);
    const plan = duelPlan(v, me);
    // Récompense une fois les duels du jour terminés.
    if (plan.done >= plan.total && state.profile.voteRewardDay !== v.day) {
      await refreshProfile();
      if (state.profile.voteRewardDay !== v.day) {
        state.profile.voteRewardDay = v.day;
        state.profile.points = (state.profile.points || 0) + voteReward();
        saveProfile();
        toast(`Merci d'avoir voté ! +${voteReward()} 🪙`);
      }
    }
    setTimeout(renderDuelView, 250);
  }

  // Pièce du concours : une pièce à part, créée pour le thème du jour.
  // Pièce du concours jamais commencée : vide, jamais publiée, couleurs et forme d'origine.
  function blankContestRoom(r) {
    if (!r || (r.stickers || []).length || r.publishedAt) return false;
    const c = { ...DEFAULT_COLORS, ...(r.colors || {}) };
    const sameColors = Object.keys(c).every((k) => c[k] === DEFAULT_COLORS[k]);
    return sameColors && JSON.stringify(normShape(r.shape)) === JSON.stringify(normShape(null));
  }

  async function openContestRoom() {
    const day = today();
    const existing = state.rooms.find((x) => x.contestDay === day);
    if (existing && !blankContestRoom(existing)) { openRoom(existing.id); return; }
    if (existing) {
      // Pièce restée vide : on repart du choix (de zéro ou d'une de mes pièces).
      state.rooms = state.rooms.filter((x) => x.id !== existing.id);
      db.deleteRoom(existing.id).catch(() => {});
    }
    const from = await pickContestStart();
    if (from === null) return;
    const r = {
      id: uid(), owner: state.player.key, name: `Concours · ${themeOf(day)}`, contestDay: day,
      stickers: [], colors: { ...DEFAULT_COLORS }, thumb: '', updated: Date.now(),
    };
    // Copie d'une pièce existante : mêmes stickers, couleurs et aménagement (l'originale ne bouge pas).
    if (from) {
      const idMap = new Map();
      r.stickers = (from.stickers || []).map((st) => { const c = { ...JSON.parse(JSON.stringify(st)), id: uid() }; idMap.set(st.id, c.id); return c; });
      if (from.ambient < 100) r.ambient = from.ambient;
      if (from.lights && from.lights.length) r.lights = remapLights(from.lights, idMap);
      r.colors = { ...DEFAULT_COLORS, ...(from.colors || {}) };
      if (from.shape) r.shape = JSON.parse(JSON.stringify(from.shape));
      r.thumb = from.thumb || '';
    }
    state.rooms.push(r);
    try {
      await db.putRoom(r);
    } catch (e) {
      console.warn('Création impossible', e);
      toast('La pièce du concours n\'a pas pu être créée. Vérifie ta connexion.');
    }
    openRoom(r.id);
  }

  // Choix de départ : '' = de zéro, une pièce = copie, null = annulé.
  function pickContestStart() {
    const rooms = realRooms().slice().sort((a, b) => (b.updated || 0) - (a.updated || 0));
    if (!rooms.length) return Promise.resolve('');
    return new Promise((resolve) => {
      const dlg = $('#ctStartDialog');
      const list = $('#ctStartRooms');
      list.innerHTML = '';
      const done = (v) => { dlg.hidden = true; resolve(v); };
      for (const r of rooms) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'ct-start-room';
        b.innerHTML = (r.thumb ? '<img class="room-thumb" alt="">'
          : `<svg class="room-thumb" viewBox="0 0 1000 760" xmlns="http://www.w3.org/2000/svg">${roomSvg(r.colors, r.shape)}</svg>`)
          + '<span class="ct-start-name"></span>';
        if (r.thumb) b.querySelector('img').src = r.thumb;
        b.querySelector('.ct-start-name').textContent = r.name;
        b.addEventListener('click', () => done(r));
        list.appendChild(b);
      }
      $('#ctStartEmpty').onclick = () => done('');
      $('#ctStartCancel').onclick = () => done(null);
      dlg.hidden = false;
    });
  }

  // Publier la pièce du concours ouverte (image de la pièce telle qu'elle est).
  async function publishContestRoom() {
    const r = currentRoom();
    if (!r || !r.contestDay) return;
    if (r.contestDay !== today()) {
      toast('Ce concours est terminé : publie plutôt une pièce pour le thème du jour.');
      return;
    }
    if (!state.stickers.length && !(await askConfirm('Ta pièce est vide. La publier quand même ?', 'Publier'))) return;
    if (!(await askConfirm(`Publier ta pièce pour le thème « ${themeOf(r.contestDay)} » ? Tu pourras la modifier et la republier jusqu'à minuit.`, 'Publier'))) return;
    select(null);
    try {
      const cv = await renderScene(0.7, state.colors.background || (state.shape.kind === 'garden' ? GARDEN_COLORS.background : DEFAULT_BACKGROUND));
      let image = cv.toDataURL('image/webp', 0.85);
      if (!image.startsWith('data:image/webp')) image = cv.toDataURL('image/jpeg', 0.85);
      await db.putContest({
        id: `ct-${r.contestDay}-${state.player.key}`, kind: 'entry', contestDay: r.contestDay,
        owner: state.player.key, ownerName: state.player.name, roomName: state.roomName, image, created: Date.now(),
      });
      const cur = currentRoom();
      if (cur) cur.publishedAt = Date.now();
      savePending = true;
      await saveRoom();
      // Pièces de participation : une fois par jour, dès la première publication.
      let joinMsg = '';
      const join = setting('contestJoinReward');
      if (join > 0 && state.profile.joinRewardDay !== r.contestDay) {
        await refreshProfile();
        if (state.profile.joinRewardDay !== r.contestDay) {
          state.profile.joinRewardDay = r.contestDay;
          state.profile.points = (state.profile.points || 0) + join;
          renderPoints();
          saveProfile();
          joinMsg = ` +${join} 🪙 pour ta participation !`;
        }
      }
      toast(`Ta pièce est publiée 🏆${joinMsg} Demain, tout le monde votera jusqu'à 20 h !`);
      // La pièce se ferme : retour à l'écran du concours, où l'on voit sa participation.
      state.roomId = null;
      openContest();
    } catch (e) {
      console.warn('Publication impossible', e);
      toast('La pièce n\'a pas pu être publiée. Vérifie ta connexion.');
    }
  }
  $('#btnContestPublish').addEventListener('click', publishContestRoom);
  // Brouillon : on enregistre tout de suite et on revient au concours.
  $('#btnContestDraft').addEventListener('click', async () => {
    if (!inContestRoom()) return;
    select(null);
    savePending = true;
    await saveRoom();
    state.roomId = null;
    toast('Brouillon enregistré 📝 Reviens le finir quand tu veux, jusqu\'à minuit.');
    openContest();
  });
  $('#btnContestPublish2').addEventListener('click', publishContestRoom);
  $('#ctViewClose').addEventListener('click', () => { $('#ctView').hidden = true; });
  $('#ctView').addEventListener('click', (e) => { if (e.target.id === 'ctView') $('#ctView').hidden = true; });
  $('#homeContest').addEventListener('click', openContest);

  // ---------------------------------------------------------------------------
  // Maintenance : l'administratrice ferme des menus pendant une mise à jour.
  // ---------------------------------------------------------------------------
  const MAINT_MENUS = [
    { key: 'all', label: 'Tout le jeu', desc: 'Les joueurs voient un écran « Le jeu est en maintenance » et ne peuvent rien faire.' },
    { key: 'rooms', label: '🏠 Mes pièces', desc: 'Les pièces et leur décoration.' },
    { key: 'shop', label: '🛍️ Boutique', desc: 'Acheter des enveloppes et des étoiles.' },
    { key: 'collection', label: '📒 Collection', desc: 'Le classeur et la vente des stickers.' },
    { key: 'creations', label: '✏️ Proposer un sticker', desc: 'Envoyer des dessins.' },
    { key: 'mail', label: '📬 Boîte aux lettres', desc: 'Lire les messages et récupérer les cadeaux.' },
    { key: 'contest', label: '🏆 Concours (tout)', desc: 'Pièce du concours, publication et vote.' },
    { key: 'vote', label: '⚔️ Vote du concours seulement', desc: 'On peut publier sa pièce, mais pas voter.' },
    { key: 'news', label: '✨ Nouveautés', desc: 'La liste des mises à jour.' },
  ];
  const MAINT_LABEL = Object.fromEntries(MAINT_MENUS.map((m) => [m.key, m.label]));
  function maintOn(key) {
    const m = state.settings.maintenance || {};
    if (key === 'vote') return state.settings.voteMaintenance !== false || !!m.contest || !!m.all;
    return !!m[key] || (key !== 'all' && !!m.all);
  }
  // Bloque l'entrée d'un menu en maintenance (sauf pour l'administratrice).
  function maintBlocked(key, silent = false) {
    if (state.isAdmin || !maintOn(key)) return false;
    if (key === 'all' || maintOn('all')) {
      $('#maintScreen').hidden = false;
      return true;
    }
    if (!silent) toast(`🛠️ « ${MAINT_LABEL[key].replace(/^\S+\s/, '')} » est en maintenance : reviens un peu plus tard !`);
    return true;
  }
  $('#maintRetry').addEventListener('click', async () => {
    await refreshSettings();
    if (!maintOn('all')) { $('#maintScreen').hidden = true; goHome(); } else toast('Toujours en maintenance… encore un peu de patience !');
  });
  const TILE_MAINT = { homeRooms: 'rooms', homeShop: 'shop', homeCollection: 'collection', homeCreations: 'creations', homeMail: 'mail', homeContest: 'contest', homeNews: 'news' };
  function renderMaintTiles() {
    for (const [id, key] of Object.entries(TILE_MAINT)) {
      const el = document.getElementById(id);
      if (el) el.classList.toggle('is-maint', maintOn(key));
    }
    const closed = MAINT_MENUS.filter((m) => m.key !== 'vote' && maintOn(m.key) && (m.key === 'all' || !maintOn('all'))).length;
    const sub = $('#homeMaintenanceSub');
    if (sub) sub.textContent = maintOn('all') ? '⚠️ Tout le jeu est fermé' : (closed ? `${plural(closed, 'menu')} fermé${closed > 1 ? 's' : ''}` : (maintOn('vote') ? 'Vote fermé' : 'Tout est ouvert'));
  }

  // Relit les réglages (maintenance, prix…) régulièrement : un joueur dans un menu
  // qui passe en maintenance est ramené au menu principal.
  async function refreshSettings() {
    try {
      const fresh = await db.getSettings();
      if (fresh) state.settings = { ...state.settings, ...fresh };
    } catch (e) { /* hors ligne */ }
  }
  const SCREEN_MAINT = { rooms: 'rooms', shop: 'shop', collection: 'collection', creations: 'creations', mail: 'mail', contest: 'contest', news: 'news' };
  setInterval(async () => {
    if (!state.profile || document.visibilityState !== 'visible') return;
    await refreshSettings();
    if (!screens.home.hidden) { renderMaintTiles(); renderContestTile(); }
    updateContestBanner();
    if (state.isAdmin) return;
    if (maintOn('all')) { $('#maintScreen').hidden = false; return; }
    $('#maintScreen').hidden = true;
    const current = Object.keys(screens).find((k) => !screens[k].hidden);
    let key = SCREEN_MAINT[current];
    if (current === 'room') key = inContestRoom() ? 'contest' : 'rooms';
    if (key && maintOn(key)) {
      if (current === 'room') await saveRoom();
      goHome();
      toast(`🛠️ « ${MAINT_LABEL[key].replace(/^\S+\s/, '')} » vient de passer en maintenance : reviens un peu plus tard !`);
    }
  }, 60000);

  async function saveSettings(msg) {
    try {
      await db.putSettings(state.settings);
      if (msg) toast(msg);
      return true;
    } catch (e) {
      console.warn('Réglage impossible', e);
      toast('Le réglage n\'a pas pu être enregistré. Vérifie ta connexion.');
      return false;
    }
  }

  function openMaintenance() {
    if (!state.isAdmin) return;
    renderMaintenance();
    showScreen('maintenance');
  }
  function renderMaintenance() {
    const list = $('#maintList');
    list.innerHTML = '';
    for (const m of MAINT_MENUS) {
      const on = m.key === 'vote' ? state.settings.voteMaintenance !== false : !!(state.settings.maintenance || {})[m.key];
      const row = document.createElement('label');
      row.className = 'maint-row' + (m.key === 'all' ? ' all' : '') + (on ? ' on' : '');
      row.innerHTML = '<span class="maint-text"><strong></strong><span class="muted"></span></span><span class="switch"><input type="checkbox"><span class="slider"></span></span>';
      row.querySelector('strong').textContent = m.label;
      row.querySelector('.muted').textContent = on ? `🛠️ En maintenance · ${m.desc}` : m.desc;
      const input = row.querySelector('input');
      input.checked = on;
      input.addEventListener('change', async () => {
        if (m.key === 'vote') state.settings.voteMaintenance = input.checked;
        else state.settings.maintenance = { ...(state.settings.maintenance || {}), [m.key]: input.checked };
        await saveSettings(input.checked ? `🛠️ « ${m.label} » est en maintenance.` : `✅ « ${m.label} » est rouvert.`);
        renderMaintenance();
      });
      list.appendChild(row);
    }
  }
  $('#homeMaintenance').addEventListener('click', openMaintenance);
  $('#maintBack').addEventListener('click', goHome);

  // ---------------------------------------------------------------------------
  // Paramétrage : tous les chiffres du jeu
  // ---------------------------------------------------------------------------
  function openSettings() {
    if (!state.isAdmin) return;
    renderSettings();
    showScreen('settings');
  }
  function renderSettings() {
    const form = $('#settingsForm');
    form.innerHTML = '';
    let groupEl = null, groupName = null;
    for (const def of SETTINGS) {
      if (def.group !== groupName) {
        groupName = def.group;
        groupEl = document.createElement('fieldset');
        groupEl.className = 'settings-group';
        groupEl.innerHTML = '<legend></legend>';
        groupEl.querySelector('legend').textContent = def.group;
        form.appendChild(groupEl);
      }
      const row = document.createElement('label');
      row.className = 'settings-row';
      if (def.type === 'bool') {
        row.classList.add('settings-check');
        row.innerHTML = '<span class="settings-label"></span><span class="settings-input"><input type="checkbox"></span>';
        row.querySelector('.settings-label').textContent = def.label;
        const cb = row.querySelector('input');
        cb.dataset.key = def.key;
        cb.checked = setting(def.key);
        groupEl.appendChild(row);
        continue;
      }
      row.innerHTML = '<span class="settings-label"></span><span class="settings-input"><input class="field" type="number" inputmode="numeric"><span class="settings-unit"></span></span>';
      row.querySelector('.settings-label').textContent = def.label;
      row.querySelector('.settings-unit').textContent = def.unit || '';
      const input = row.querySelector('input');
      input.dataset.key = def.key;
      input.min = def.min ?? 0;
      input.max = def.max ?? 100000;
      input.step = def.step ?? 1;
      const raw = state.settings[def.key];
      input.value = raw === undefined || raw === null || raw === '' ? '' : setting(def.key);
      input.placeholder = String(def.def());
      groupEl.appendChild(row);
    }
  }
  $('#settingsSave').addEventListener('click', async () => {
    const before = JSON.parse(JSON.stringify(state.settings));
    for (const input of document.querySelectorAll('#settingsForm input[data-key]')) {
      const def = SETTING_BY_KEY[input.dataset.key];
      if (def.type === 'bool') { state.settings[def.key] = input.checked; continue; }
      const v = input.value.trim();
      if (v === '') { delete state.settings[def.key]; continue; }
      const n = Math.round(Number(v));
      if (!Number.isFinite(n) || n < (def.min ?? 0) || n > (def.max ?? 100000)) {
        toast(`« ${def.label} » : indique un nombre entre ${def.min ?? 0} et ${def.max ?? 100000}.`);
        state.settings = before;
        input.focus();
        return;
      }
      state.settings[def.key] = n;
    }
    if (!(await saveSettings('C\'est enregistré ✓ Les nouveaux chiffres s\'appliquent tout de suite.'))) state.settings = before;
    renderSettings();
  });
  $('#settingsForm').addEventListener('submit', (e) => e.preventDefault());
  $('#homeSettings').addEventListener('click', openSettings);
  $('#settingsBack').addEventListener('click', goHome);

  // ---------------------------------------------------------------------------
  // Concours (administratrice) : thèmes et résultats en direct
  // ---------------------------------------------------------------------------
  // Choisir le thème des prochains jours parmi la liste (ou laisser la rotation automatique).
  function renderThemePick() {
    const box = $('#acThemePick');
    box.innerHTML = '';
    const overrides = state.settings.contestThemeOverrides || {};
    const labels = ['Hier', 'Aujourd\'hui', 'Demain', 'Après-demain'];
    labels.forEach((label, i) => {
      const day = shiftDay(today(), i - 1);
      const auto = autoThemeOf(day);
      const row = document.createElement('label');
      row.className = 'ac-theme-row';
      row.innerHTML = '<span class="ac-theme-day"></span><select class="field ac-theme-select"></select>';
      row.querySelector('.ac-theme-day').textContent = label;
      const sel = row.querySelector('select');
      sel.add(new Option(`🎲 Automatique : « ${auto} »`, ''));
      const list = contestThemes().slice();
      if (overrides[day] && !list.includes(overrides[day])) list.unshift(overrides[day]);
      for (const t of list) sel.add(new Option(t, t));
      sel.value = overrides[day] || '';
      sel.addEventListener('change', () => setThemeOverride(day, sel.value, label));
      box.appendChild(row);
    });
  }
  async function setThemeOverride(day, theme, label) {
    if (day === today() && theme !== (state.settings.contestThemeOverrides || {})[day]) {
      try {
        const t = await loadContestDay(day);
        if (t.entries.length && !(await askConfirm(`${t.entries.length === 1 ? '1 joueur a déjà publié sa pièce' : `${t.entries.length} joueurs ont déjà publié leur pièce`} pour le thème du jour. Changer le thème maintenant peut les surprendre. Continuer ?`, 'Changer'))) {
          renderThemePick();
          return;
        }
      } catch (e) { /* hors ligne : on laisse faire */ }
    }
    const all = { ...(state.settings.contestThemeOverrides || {}) };
    // On garde les derniers jours (les résultats d'un concours passé affichent encore son thème).
    const oldest = shiftDay(today(), -10);
    for (const d of Object.keys(all)) if (d < oldest) delete all[d];
    if (theme) all[day] = theme; else delete all[day];
    state.settings.contestThemeOverrides = all;
    renderThemePick();
    renderContestTile();
    await saveSettings(theme ? `${label} : thème « ${theme} » ✓` : `${label} : thème automatique ✓`);
  }

  let acTimer = null;
  async function openAdminContest() {
    if (!state.isAdmin) return;
    showScreen('adminContest');
    $('#acThemes').value = (Array.isArray(state.settings.contestThemes) && state.settings.contestThemes.length ? state.settings.contestThemes : DEFAULT_THEMES).join('\n');
    renderThemePick();
    await refreshAdminContest();
    clearInterval(acTimer);
    // Mise à jour automatique pendant que l'écran est ouvert.
    acTimer = setInterval(() => {
      if (screens.adminContest.hidden) { clearInterval(acTimer); return; }
      refreshAdminContest();
    }, 15000);
  }
  // Qui a voté : chaque votant, ses duels faits et le détail de ses choix.
  let acPlayers = null;
  function acName(key, v) {
    if (ADMIN_PSEUDOS.includes(key)) return ADMIN_DISPLAY_NAME;
    const e = v.entries.find((x) => x.owner === key);
    if (e && e.ownerName) return e.ownerName;
    const p = (acPlayers || []).find((x) => playerKey(x) === key);
    return (p && p.pseudo) || key;
  }
  function votersBox(v) {
    const box = document.createElement('div');
    box.className = 'ct-provisional ac-voters';
    const byVoter = new Map();
    for (const d of [...v.duels, ...v.votes]) {
      if (!byVoter.has(d.voter)) byVoter.set(d.voter, []);
      byVoter.get(d.voter).push(d);
    }
    const h = document.createElement('p');
    h.className = 'ct-prov-title';
    h.textContent = `🗳️ Qui a voté (${byVoter.size})`;
    box.appendChild(h);
    if (!byVoter.size) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = 'Personne n\'a encore voté.';
      box.appendChild(p);
    }
    const timeFmt = (t) => new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    const rows = [...byVoter.entries()].sort((a, b) => Math.max(...b[1].map((d) => d.created || 0)) - Math.max(...a[1].map((d) => d.created || 0)));
    for (const [voter, list] of rows) {
      const plan = duelPlan(v, voter);
      const duels = list.filter((d) => d.kind === 'duel').sort((a, b) => (a.created || 0) - (b.created || 0));
      const last = Math.max(...list.map((d) => d.created || 0));
      const det = document.createElement('details');
      det.className = 'ac-voter';
      const sum = document.createElement('summary');
      const finished = plan.total && plan.done >= plan.total;
      sum.textContent = `${finished ? '✅' : '⏳'} ${acName(voter, v)} — ${duels.length ? `${plan.done}/${plan.total} duels` : plural(list.length, 'vote')}${last ? ` · dernier vote à ${timeFmt(last)}` : ''}`;
      det.appendChild(sum);
      const ul = document.createElement('ul');
      for (const d of list) {
        const li = document.createElement('li');
        li.textContent = d.kind === 'duel'
          ? `${acName(d.a, v)} contre ${acName(d.b, v)} → ${acName(d.winner, v)}`
          : `Vote pour ${acName(d.entry, v)}`;
        ul.appendChild(li);
      }
      det.appendChild(ul);
      box.appendChild(det);
    }
    const missing = v.entries.filter((e) => !byVoter.has(e.owner));
    if (missing.length && v.entries.length > 2) {
      const p = document.createElement('p');
      p.className = 'muted ac-missing';
      p.textContent = `Participants qui n'ont pas encore voté : ${missing.map((e) => acName(e.owner, v)).join(', ')}.`;
      box.appendChild(p);
    }
    return box;
  }
  async function refreshAdminContest() {
    if (!acPlayers) db.listPlayers().then((l) => { acPlayers = l; }).catch(() => {});
    let v, t;
    try {
      [v, t] = await Promise.all([loadContestDay(shiftDay(today(), -1)), loadContestDay(today())]);
    } catch (e) {
      $('#acLive').innerHTML = '<p class="muted">Impossible de charger le concours. Vérifie ta connexion.</p>';
      return;
    }
    const voters = new Set(v.duels.map((d) => d.voter)).size;
    const state20 = votingOver() ? 'Vote terminé : résultat définitif.' : `Vote ouvert jusqu'à 20 h${voteMaintenanceOn() ? ' (🛠️ en maintenance pour les joueurs)' : ''}.`;
    $('#acLiveInfo').textContent = `Thème d'hier : « ${themeOf(v.day)} » · ${plural(v.entries.length, 'participation')} · ${plural(voters, 'votant')} · ${plural(v.duels.length, 'duel')}. ${state20}`;
    const live = $('#acLive');
    live.innerHTML = '';
    if (v.entries.length) {
      const box = provisionalRanking(v);
      box.querySelector('.ct-prov-title').textContent = '🏆 Classement actuel';
      live.appendChild(box);
      live.appendChild(votersBox(v));
      const grid = document.createElement('div');
      grid.className = 'ct-grid ac-grid';
      v.entries.forEach((e) => grid.appendChild(entryCard(e, { canModerate: true, winner: v.winners.includes(e.owner) })));
      live.appendChild(grid);
    } else {
      live.innerHTML = '<p class="muted">Personne n\'a participé hier.</p>';
    }
    const td = $('#acToday');
    td.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = `Thème du jour : « ${themeOf(t.day)} » · ${plural(t.entries.length, 'participation')} pour l'instant.`;
    td.appendChild(p);
    if (t.entries.length) {
      const grid = document.createElement('div');
      grid.className = 'ct-grid ac-grid';
      t.entries.forEach((e) => grid.appendChild(entryCard(e, { canModerate: true })));
      td.appendChild(grid);
    }
    $('#acRefreshed').textContent = `Mis à jour à ${new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })} · actualisation automatique toutes les 15 s.`;
  }
  $('#acThemesSave').addEventListener('click', async () => {
    const themes = $('#acThemes').value.split('\n').map((x) => x.trim()).filter(Boolean);
    // Modifier la liste décale la rotation : on fige d'abord les jours déjà joués et aujourd'hui,
    // pour que seuls les jours à venir suivent la nouvelle liste.
    const frozen = { ...(state.settings.contestThemeOverrides || {}) };
    for (let i = -10; i <= 0; i++) {
      const day = shiftDay(today(), i);
      if (!frozen[day]) frozen[day] = themeOf(day);
    }
    state.settings.contestThemeOverrides = frozen;
    state.settings.contestThemes = themes;
    await saveSettings(`Thèmes enregistrés ✓ ${themes.length ? plural(themes.length, 'thème') : 'Thèmes par défaut'} · aujourd'hui : « ${themeOf(today())} ».`);
    renderThemePick();
  });
  $('#homeAdminContest').addEventListener('click', openAdminContest);
  $('#adminContestBack').addEventListener('click', () => { clearInterval(acTimer); goHome(); });

  // ---------------------------------------------------------------------------
  // Boîte aux lettres
  // ---------------------------------------------------------------------------
  // Stickers offerts dans un message (un id par exemplaire).
  const giftIds = (m) => m.stickers || (m.sticker ? [m.sticker] : []);
  const hasGift = (m) => !!(m.reward || giftIds(m).length);
  const unreadMail = () => state.mails.filter((m) => !m.read || (hasGift(m) && !m.claimed)).length;

  function renderMailBadge() {
    const n = unreadMail();
    const badge = $('#mailBadge');
    badge.hidden = !n;
    badge.textContent = n;
    $('#homeMailSub').textContent = n > 1 ? `${n} nouveaux messages` : (n ? '1 nouveau message' : 'Aucun nouveau message');
    $('#homeMail').setAttribute('aria-label', `Boîte aux lettres, ${$('#homeMailSub').textContent.toLowerCase()}`);
  }

  async function openMail() {
    if (maintBlocked('mail')) return;
    renderMail();
    showScreen('mail');
    // On recharge les messages : ils ont pu changer sur un autre appareil.
    try {
      state.mails = await db.listMail(state.player.key);
      renderMail();
    } catch (e) { /* on garde ceux déjà chargés */ }
    // Ouvrir la boîte marque les messages comme lus (les cadeaux restent à récupérer).
    for (const m of state.mails) {
      if (!m.read) {
        m.read = true;
        db.markMailRead(m.id).catch(() => {});
      }
    }
    renderMailBadge();
  }
  $('#homeMail').addEventListener('click', openMail);
  $('#mailBack').addEventListener('click', goHome);

  function renderMail() {
    renderPoints();
    const gifts = state.mails.filter((m) => hasGift(m) && !m.claimed).length;
    const unread = state.mails.filter((m) => !m.read).length;
    const all = $('#mailAll');
    all.hidden = !gifts && !unread;
    all.textContent = gifts ? `📬 Tout lire et tout récupérer (${gifts} cadeau${gifts > 1 ? 'x' : ''})` : '📬 Tout marquer comme lu';
    const list = $('#mailList');
    list.innerHTML = '';
    const mails = [...state.mails].sort((a, b) => (b.created || 0) - (a.created || 0));
    $('#mailEmpty').hidden = mails.length > 0;
    for (const m of mails) {
      const el = document.createElement('article');
      el.className = 'mail-item' + (m.read ? '' : ' unread');
      el.innerHTML = `
        <div class="mail-head"><h3></h3><time></time></div>
        <p class="mail-text"></p>
        <div class="mail-gift" hidden></div>
        ${hasGift(m) ? `<button class="btn ${m.claimed ? 'btn-ghost' : 'btn-primary'} mail-claim" ${m.claimed ? 'disabled' : ''}></button>` : ''}`;
      el.querySelector('h3').textContent = m.title;
      el.querySelector('time').textContent = m.created ? dateFmt.format(m.created) : '';
      el.querySelector('.mail-text').textContent = m.text;
      if ((m.text || '').length > 400 || (m.text || '').split('\n').length > 8) {
        const txt = el.querySelector('.mail-text');
        txt.classList.add('mail-long');
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'btn btn-ghost mail-more';
        more.textContent = 'Lire la suite';
        more.addEventListener('click', () => {
          const open = txt.classList.toggle('mail-open');
          more.textContent = open ? 'Réduire' : 'Lire la suite';
        });
        txt.after(more);
      }
      // Cadeau : des pièces et/ou des stickers.
      const ids = giftIds(m);
      const counts = {};
      for (const id of ids) counts[id] = (counts[id] || 0) + 1;
      const known = Object.keys(counts).filter((id) => state.images.has(id));
      if (known.length) {
        const gift = el.querySelector('.mail-gift');
        gift.hidden = false;
        gift.innerHTML = '';
        for (const id of known) {
          const img = state.images.get(id);
          const item = document.createElement('div');
          item.className = 'mail-gift-item';
          item.innerHTML = '<div class="env-item-img"><img alt=""></div><span></span>';
          item.querySelector('img').src = img.url;
          item.querySelector('span').textContent = img.name + (counts[id] > 1 ? ` ×${counts[id]}` : '');
          gift.appendChild(item);
        }
      }
      const parts = [];
      if (m.reward) parts.push(`+${m.reward} 🪙`);
      if (ids.length === 1) parts.push(`« ${state.images.get(ids[0])?.name || 'ton sticker'} »`);
      else if (ids.length) parts.push(`${ids.length} stickers`);
      const claim = el.querySelector('.mail-claim');
      if (claim) claim.textContent = m.claimed ? `${parts.join(' et ')} récupéré${ids.length ? (parts.length > 1 || ids.length > 1 ? 's' : '') : 'es'}` : `Récupérer ${parts.join(' et ')}`;
      if (claim && !m.claimed) claim.addEventListener('click', async () => {
        if (m.claimed || claim.disabled) return;
        claim.disabled = true;
        let ok;
        try {
          ok = await db.claimMail(m.id);
        } catch (e) {
          console.warn('Récupération impossible', e);
          toast('Le cadeau n\'a pas pu être récupéré. Vérifie ta connexion.');
          claim.disabled = false;
          return;
        }
        m.claimed = true;
        m.read = true;
        if (!ok) {
          toast('Ce cadeau a déjà été récupéré (peut-être sur un autre appareil).');
          renderMail();
          return;
        }
        await refreshProfile();
        if (m.reward) state.profile.points += m.reward;
        for (const id of ids) state.profile.inventory[id] = (state.profile.inventory[id] || 0) + 1;
        saveProfile();
        toast(ids.length ? `${parts.join(' et ')} reçu${parts.length > 1 || ids.length > 1 ? 's' : ''} !` : `+${m.reward} 🪙 ajoutées à ton compte !`);
        renderMail();
      });
      list.appendChild(el);
    }
  }

  // Tout lire et récupérer tous les cadeaux en une fois.
  let claimingAll = false;
  $('#mailAll').addEventListener('click', async () => {
    if (claimingAll) return;
    claimingAll = true;
    const btn = $('#mailAll');
    btn.disabled = true;
    for (const m of state.mails) {
      if (!m.read) { m.read = true; db.markMailRead(m.id).catch(() => {}); }
    }
    let coins = 0, stickers = 0, done = 0, failed = 0;
    try {
      await refreshProfile();
      for (const m of state.mails.filter((x) => hasGift(x) && !x.claimed)) {
        let ok;
        try { ok = await db.claimMail(m.id); } catch (e) { failed++; continue; }
        m.claimed = true;
        if (!ok) continue; // déjà récupéré ailleurs
        done++;
        if (m.reward) { state.profile.points += m.reward; coins += m.reward; }
        for (const id of giftIds(m)) { state.profile.inventory[id] = (state.profile.inventory[id] || 0) + 1; stickers++; }
      }
      if (done) saveProfile();
    } finally {
      claimingAll = false;
      btn.disabled = false;
    }
    const parts = [];
    if (coins) parts.push(`+${coins} 🪙`);
    if (stickers) parts.push(plural(stickers, 'sticker'));
    if (failed) toast('Certains cadeaux n\'ont pas pu être récupérés. Vérifie ta connexion et réessaie.');
    else toast(parts.length ? `Tout est récupéré : ${parts.join(' et ')} !` : 'Tous tes messages sont lus ✓');
    renderMail();
    renderMailBadge();
  });

  // stickers : un id, ou une liste d'ids (un par exemplaire offert).
  function sendMail(to, title, text, reward = 0, stickers = null) {
    const m = { id: uid(), to, title, text, reward, read: false, claimed: false, created: Date.now() };
    if (stickers) m.stickers = [].concat(stickers);
    return db.putMail(m);
  }

  // ---------------------------------------------------------------------------
  // Coffre (administratrice) : valider les propositions et les ranger en enveloppe
  // ---------------------------------------------------------------------------
  // Toutes les propositions (avec leurs images) ne sont chargées qu'une fois par session :
  // ensuite, on ne recharge que celles en attente (les acceptées ne changent que par ici).
  let proposalsLoaded = false;
  async function refreshCoffreCount() {
    try {
      if (!proposalsLoaded) {
        state.proposals = await db.listProposals();
        proposalsLoaded = true;
      } else {
        const fresh = await db.listPendingProposals();
        const keep = state.proposals.filter((p) => p.status !== 'pending');
        const known = new Set(keep.map((p) => p.id));
        state.proposals = keep.concat(fresh.filter((p) => !known.has(p.id)));
      }
    } catch (e) {
      return;
    }
    const n = state.proposals.filter((p) => p.status === 'pending').length;
    $('#homeCoffreSub').textContent = n ? `${plural(n, 'proposition')} à regarder` : 'Rien à valider';
  }

  // Lien entre une proposition et le sticker du catalogue qu'on en a tiré.
  function catalogOf(p) {
    const list = [...state.images.values()];
    return list.find((img) => img.fromProposal === p.id)
      || list.find((img) => !img.fromProposal && img.data && img.data === p.data);
  }
  // Onglet d'une proposition : une acceptée dont le sticker n'est plus dans une enveloppe est archivée.
  function coffreStatus(p) {
    if (p.status !== 'accepted') return p.status;
    const rec = catalogOf(p);
    if (rec && envelopeExists(rec.envelope)) return 'accepted';
    return rec && rec.archived ? 'archived' : 'unfiled';
  }

  async function archiveSticker(img) {
    img.envelope = null;
    img.archived = true;
    try {
      await db.updateImage(img.id, { envelope: null, archived: true });
    } catch (e) {
      console.warn('Archivage impossible', e);
      toast('Le sticker n\'a pas pu être archivé. Vérifie ta connexion.');
    }
  }

  async function openCoffre() {
    if (!state.isAdmin) return;
    showScreen('coffre');
    $('#coffreList').innerHTML = '<p class="muted">Chargement…</p>';
    await refreshCoffreCount();
    renderCoffre();
  }
  $('#homeCoffre').addEventListener('click', openCoffre);
  $('#coffreAcceptAll').addEventListener('click', acceptAllProposals);
  $('#coffreBack').addEventListener('click', goHome);
  $('#atelierCoffre').addEventListener('click', openCoffre);

  let coffreFilter = 'pending';
  document.querySelectorAll('.coffre-tab').forEach((tab) => tab.addEventListener('click', () => {
    coffreFilter = tab.dataset.filter;
    renderCoffre();
  }));

  const toFixList = () => [...state.images.values()].filter((i) => i.catalog && i.toFix);

  function renderToFix() {
    const list = $('#coffreList');
    const items = toFixList().sort((a, b) => (a.name || '').localeCompare(b.name || '', 'fr'));
    $('#coffreEmpty').hidden = items.length > 0;
    $('#coffreEmpty').textContent = 'Aucun sticker à modifier. Dans l\'atelier, touche 🏷️ sur un sticker pour le retrouver ici.';
    for (const img of items) {
      const env = state.envelopes.find((e) => e.id === img.envelope);
      const card = document.createElement('article');
      card.className = 'coffre-card';
      card.innerHTML = `
        <div class="env-item-img"><img alt=""></div>
        <div class="coffre-info">
          <h3></h3>
          <p class="muted coffre-meta"></p>
          <div class="coffre-actions"></div>
        </div>`;
      card.querySelector('img').src = img.url;
      card.querySelector('h3').textContent = img.name;
      card.querySelector('.coffre-meta').textContent = (env ? `Dans l'enveloppe « ${env.name} »` : (img.archived ? '📦 Archivé' : 'Pas dans une enveloppe'))
        + (img.author ? ` · par ${img.author}` : '');
      const actions = card.querySelector('.coffre-actions');
      const dl = document.createElement('button');
      dl.className = 'btn';
      dl.textContent = '⬇️ Télécharger';
      dl.addEventListener('click', () => downloadImage(img.url, img.name));
      const rep = document.createElement('label');
      rep.className = 'btn btn-primary';
      rep.innerHTML = '🖼️ Remplacer le dessin<input type="file" accept="image/*" hidden>';
      rep.querySelector('input').addEventListener('change', async (e) => {
        const file = e.target.files[0];
        e.target.value = '';
        if (!file) return;
        const before = img.updated;
        await replaceStickerImage(img, file);
        if (img.updated !== before) { await setToFix(img, false); renderCoffre(); }
      });
      const done = document.createElement('button');
      done.className = 'btn btn-ghost';
      done.textContent = '✓ Retirer le tag';
      done.addEventListener('click', async () => { await setToFix(img, false); renderCoffre(); });
      actions.append(dl, rep, done);
      list.appendChild(card);
    }
  }

  function renderCoffre() {
    document.querySelectorAll('.coffre-tab').forEach((tab) => {
      const n = tab.dataset.filter === 'tofix' ? toFixList().length : state.proposals.filter((p) => coffreStatus(p) === tab.dataset.filter).length;
      tab.classList.toggle('active', tab.dataset.filter === coffreFilter);
      tab.querySelector('span').textContent = n;
    });
    const list = $('#coffreList');
    list.innerHTML = '';
    $('#coffreEmpty').textContent = 'Rien ici pour l\'instant.';
    if (coffreFilter === 'tofix') { $('#coffreAcceptAll').hidden = true; renderToFix(); return; }
    const items = state.proposals
      .filter((p) => coffreStatus(p) === coffreFilter)
      .sort((a, b) => (b.created || 0) - (a.created || 0));
    $('#coffreEmpty').hidden = items.length > 0;
    const all = $('#coffreAcceptAll');
    all.hidden = coffreFilter !== 'pending' || !items.length;
    all.disabled = false;
    all.textContent = `✓ Tout valider (${items.length})`;
    for (const p of items) {
      const card = document.createElement('article');
      card.className = 'coffre-card';
      card.innerHTML = `
        <div class="env-item-img"><img alt=""></div>
        <div class="coffre-info">
          <h3></h3>
          <p class="muted coffre-meta"></p>
          <div class="coffre-actions"></div>
        </div>`;
      card.querySelector('img').src = p.data;
      card.querySelector('h3').textContent = p.name;
      card.querySelector('.coffre-meta').textContent = `par ${p.ownerName || p.owner} · ${p.created ? dateFmt.format(p.created) : ''}`
        + (p.status === 'accepted' && p.reward ? ` · ${p.reward} 🪙 offertes` : '');
      const actions = card.querySelector('.coffre-actions');
      const button = (label, cls, fn) => {
        const b = document.createElement('button');
        b.className = 'btn ' + cls;
        b.textContent = label;
        b.addEventListener('click', fn);
        actions.appendChild(b);
        return b;
      };
      if (p.status === 'pending') {
        button('✓ Valider', 'btn-primary', () => acceptProposal(p));
        button('⬇️ Télécharger', '', () => downloadImage(p.data, `${p.name} - ${p.ownerName || p.owner}`));
        button('✕ Refuser', '', () => refuseProposal(p));
      } else if (p.status === 'accepted') {
        const rec = catalogOf(p);
        button('⬇️', 'btn-ghost', () => downloadImage(p.data, `${p.name} - ${p.ownerName || p.owner}`)).title = 'Télécharger l\'image envoyée par le joueur';
        const envSelect = (exclude) => {
          const sel = document.createElement('select');
          sel.className = 'coffre-select';
          sel.setAttribute('aria-label', 'Enveloppe');
          const list = state.envelopes.filter((env) => env.id !== exclude);
          for (const env of list) sel.add(new Option(env.name || 'Enveloppe', env.id));
          // Par défaut : la dernière enveloppe créée.
          const newest = list.reduce((best, env) => (!best || (env.created || 0) >= (best.created || 0) ? env : best), null);
          if (newest) sel.value = newest.id;
          actions.appendChild(sel);
          return sel;
        };
        const note = (text, cls) => {
          const tag = document.createElement('span');
          tag.className = cls;
          tag.textContent = text;
          actions.appendChild(tag);
        };
        if (rec && envelopeExists(rec.envelope)) {
          const env = state.envelopes.find((e) => e.id === rec.envelope);
          note(`Dans l'enveloppe « ${env.name} »`, 'coffre-used');
          if (state.envelopes.length > 1) {
            const sel = envSelect(env.id);
            button('Déplacer', '', () => moveSticker(p, rec, sel.value));
          }
          button('📦 Archiver', '', async () => {
            if (!(await askConfirm(`Retirer « ${rec.name} » de l'enveloppe « ${env.name} » et l'archiver ? Les joueurs qui l'ont le gardent.`, 'Archiver'))) return;
            await archiveSticker(rec);
            renderCoffre();
          });
        } else if (state.envelopes.length) {
          if (rec) note(rec.archived ? '📦 Archivé' : 'Pas encore dans une enveloppe', rec.archived ? 'coffre-archived' : 'muted');
          const sel = envSelect(null);
          button(rec && rec.archived ? 'Remettre dans l\'enveloppe' : 'Ajouter à l\'enveloppe', 'btn-primary',
            () => (rec ? moveSticker(p, rec, sel.value) : addProposalToEnvelope(p, sel.value)));
        } else {
          if (rec && rec.archived) note('📦 Archivé', 'coffre-archived');
          note('Crée une enveloppe dans l\'atelier pour l\'y ranger.', 'muted');
        }
        button('Supprimer', 'btn-ghost', () => deleteProposal(p));
      } else {
        button('⬇️ Télécharger', '', () => downloadImage(p.data, `${p.name} - ${p.ownerName || p.owner}`));
        button('Supprimer', 'btn-ghost', () => deleteProposal(p));
      }
      list.appendChild(card);
    }
  }

  // Valide une proposition : sticker au catalogue, pièces (et sticker si le réglage est coché) par message.
  async function doAccept(p, reward) {
    const give = setting('proposalGiveSticker');
    const before = { status: p.status, reward: p.reward };
    p.status = 'accepted';
    p.reward = reward;
    const rec = catalogOf(p) || {
      id: uid(), catalog: true, envelope: null, archived: false, rarity: 'common',
      name: p.name, data: p.data, w: p.w, h: p.h, created: Date.now(),
      author: p.ownerName || p.owner, fromProposal: p.id,
    };
    try {
      await db.putImage(rec);
      addImageToLibrary(rec);
      await db.updateImage(p.id, { status: 'accepted', reward });
      const thanks = give
        ? `Voici ${reward ? `${reward} 🪙 et ` : ''}ton sticker en 1 exemplaire pour te remercier.`
        : (reward ? `Voici ${reward} 🪙 pour te remercier.` : 'Merci beaucoup !');
      await sendMail(p.owner, 'Sticker accepté 🎉',
        `Ton sticker « ${p.name} » a été accepté ! ${thanks} Il pourra bientôt apparaître dans une enveloppe.`,
        reward, give ? rec.id : null);
      return true;
    } catch (e) {
      console.warn('Validation impossible', e);
      Object.assign(p, before);
      return false;
    }
  }

  async function acceptProposal(p) {
    const give = setting('proposalGiveSticker');
    const answer = await askText(`Valider « ${p.name} » de ${p.ownerName || p.owner}. Combien de pièces lui offrir ?${give ? ' (Il recevra aussi le sticker en 1 exemplaire.)' : ''}`, 'Valider', String(proposalReward()));
    if (answer === null) return;
    const reward = Math.max(0, Math.round(Number(answer) || 0));
    if (await doAccept(p, reward)) toast(`« ${p.name} » validé. ${p.ownerName || p.owner} a reçu un message.`);
    else toast('La validation n\'a pas pu être enregistrée. Vérifie ta connexion.');
    renderCoffre();
  }

  // Tout valider d'un coup : même récompense pour tous, un message par joueur.
  let acceptingAll = false;
  async function acceptAllProposals() {
    if (acceptingAll) return;
    const list = state.proposals.filter((p) => p.status === 'pending');
    if (!list.length) return;
    const give = setting('proposalGiveSticker');
    const answer = await askText(`Valider les ${list.length} propositions en attente. Combien de pièces offrir à chaque joueur ?${give ? ' (Chacun recevra aussi son sticker en 1 exemplaire.)' : ''}`, `Tout valider (${list.length})`, String(proposalReward()));
    if (answer === null) return;
    const reward = Math.max(0, Math.round(Number(answer) || 0));
    acceptingAll = true;
    const btn = $('#coffreAcceptAll');
    let ok = 0;
    for (const p of list) {
      if (btn) { btn.disabled = true; btn.textContent = `Validation… ${ok}/${list.length}`; }
      if (await doAccept(p, reward)) ok++;
      else break; // problème de connexion : on s'arrête, le reste reste à valider
    }
    acceptingAll = false;
    toast(ok === list.length
      ? `${plural(ok, 'proposition')} validée${ok > 1 ? 's' : ''} ✓ Chaque joueur a reçu son message.`
      : `${plural(ok, 'proposition')} validée${ok > 1 ? 's' : ''} sur ${list.length} : la connexion a coupé, réessaie pour les autres.`);
    renderCoffre();
  }

  async function refuseProposal(p) {
    const answer = await askText(`Refuser « ${p.name} » de ${p.ownerName || p.owner}. Message pour le joueur :`, 'Refuser',
      'Merci pour ta proposition ! Elle n\'a pas été retenue cette fois, n\'hésite pas à en envoyer d\'autres.');
    if (answer === null) return;
    p.status = 'refused';
    try {
      await db.updateImage(p.id, { status: 'refused' });
      await sendMail(p.owner, 'Proposition non retenue', `« ${p.name} » : ${answer}`);
      toast(`« ${p.name} » refusé. ${p.ownerName || p.owner} a reçu un message.`);
    } catch (e) {
      console.warn('Refus impossible', e);
      toast('Le refus n\'a pas pu être enregistré. Vérifie ta connexion.');
    }
    renderCoffre();
  }

  async function addProposalToEnvelope(p, envId) {
    const env = state.envelopes.find((e) => e.id === envId);
    if (!env) return;
    const rec = {
      id: uid(), catalog: true, envelope: env.id, rarity: 'common',
      name: p.name, data: p.data, w: p.w, h: p.h, created: Date.now(),
      author: p.ownerName || p.owner, fromProposal: p.id,
    };
    try {
      await db.putImage(rec);
      addImageToLibrary(rec);
      p.usedIn = env.id;
      await db.updateImage(p.id, { usedIn: p.usedIn });
      toast(`« ${p.name} » ajouté à l'enveloppe « ${env.name} ». Tu peux choisir sa rareté dans l'atelier.`);
    } catch (e) {
      console.warn('Ajout impossible', e);
      toast('Le sticker n\'a pas pu être ajouté. Vérifie ta connexion.');
    }
    renderCoffre();
  }

  // ---- Depuis l'atelier : ranger des stickers acceptés dans l'enveloppe ouverte ----
  const unfiledProposals = () => (state.proposals || []).filter((p) => coffreStatus(p) === 'unfiled');
  const unfiledDialog = $('#unfiledDialog');
  let unfiledEnv = null;
  let unfiledPick = new Set();
  function openUnfiledPicker(env) {
    unfiledEnv = env;
    unfiledPick = new Set();
    $('#unfiledTitle').textContent = `Ranger dans « ${env.name || 'Enveloppe'} »`;
    const grid = $('#unfiledGrid');
    grid.innerHTML = '';
    for (const p of unfiledProposals().sort((a, b) => (b.created || 0) - (a.created || 0))) {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'env-item star-pick unfiled-pick';
      cell.innerHTML = '<div class="env-item-img"><img alt=""><span class="env-owned unfiled-check" hidden>✓</span></div><span class="env-item-name"></span><span class="unfiled-author muted"></span>';
      cell.querySelector('img').src = p.data;
      cell.querySelector('.env-item-name').textContent = p.name;
      cell.querySelector('.unfiled-author').textContent = `par ${p.ownerName || p.owner}`;
      cell.addEventListener('click', () => {
        if (unfiledPick.has(p.id)) unfiledPick.delete(p.id); else unfiledPick.add(p.id);
        cell.classList.toggle('picked', unfiledPick.has(p.id));
        cell.querySelector('.unfiled-check').hidden = !unfiledPick.has(p.id);
        renderUnfiledButton();
      });
      grid.appendChild(cell);
    }
    renderUnfiledButton();
    unfiledDialog.hidden = false;
  }
  function renderUnfiledButton() {
    const n = unfiledPick.size;
    $('#unfiledAdd').disabled = !n;
    $('#unfiledAdd').textContent = n ? `Ajouter ${plural(n, 'sticker')}` : 'Choisis des stickers';
    $('#unfiledAll').textContent = unfiledPick.size === unfiledProposals().length ? 'Tout désélectionner' : 'Tout sélectionner';
  }
  $('#unfiledAll').addEventListener('click', () => {
    const all = unfiledProposals();
    const selectAll = unfiledPick.size !== all.length;
    unfiledPick = new Set(selectAll ? all.map((p) => p.id) : []);
    document.querySelectorAll('#unfiledGrid .unfiled-pick').forEach((cell, i) => {
      cell.classList.toggle('picked', selectAll);
      cell.querySelector('.unfiled-check').hidden = !selectAll;
    });
    renderUnfiledButton();
  });
  $('#unfiledClose').addEventListener('click', () => { unfiledDialog.hidden = true; });
  $('#unfiledAdd').addEventListener('click', async () => {
    const env = unfiledEnv;
    const list = unfiledProposals().filter((p) => unfiledPick.has(p.id));
    if (!env || !list.length) return;
    $('#unfiledAdd').disabled = true;
    let ok = 0;
    for (const p of list) {
      try {
        const rec = catalogOf(p);
        if (rec) {
          rec.envelope = env.id;
          rec.archived = false;
          rec.fromProposal = p.id;
          await db.updateImage(rec.id, { envelope: env.id, archived: false, fromProposal: p.id });
        } else {
          const nrec = {
            id: uid(), catalog: true, envelope: env.id, rarity: 'common',
            name: p.name, data: p.data, w: p.w, h: p.h, created: Date.now(),
            author: p.ownerName || p.owner, fromProposal: p.id,
          };
          await db.putImage(nrec);
          addImageToLibrary(nrec);
        }
        p.usedIn = env.id;
        await db.updateImage(p.id, { usedIn: p.usedIn });
        ok++;
      } catch (e) {
        console.warn('Rangement impossible', e);
      }
    }
    unfiledDialog.hidden = true;
    toast(ok === list.length
      ? `${plural(ok, 'sticker')} rangé${ok > 1 ? 's' : ''} dans « ${env.name} ». Choisis leur rareté ci-dessous.`
      : `${ok} sur ${list.length} rangé${ok > 1 ? 's' : ''} : vérifie ta connexion et réessaie pour les autres.`);
    renderAtelier();
  });

  // Change l'enveloppe d'un sticker proposé (ou le sort des archives). Les joueurs gardent leurs exemplaires.
  async function moveSticker(p, rec, envId) {
    const env = state.envelopes.find((e) => e.id === envId);
    if (!env) return;
    rec.envelope = env.id;
    rec.archived = false;
    rec.fromProposal = p.id;
    try {
      await db.updateImage(rec.id, { envelope: env.id, archived: false, fromProposal: p.id });
      p.usedIn = env.id;
      await db.updateImage(p.id, { usedIn: p.usedIn });
      toast(`« ${rec.name} » est maintenant dans l'enveloppe « ${env.name} ».`);
    } catch (e) {
      console.warn('Déplacement impossible', e);
      toast('Le sticker n\'a pas pu être déplacé. Vérifie ta connexion.');
    }
    renderCoffre();
  }

  async function deleteProposal(p) {
    const st = coffreStatus(p);
    const msg = st === 'archived'
      ? `Supprimer « ${p.name} » du coffre ? Tu ne pourras plus le remettre dans une enveloppe (les joueurs qui l'ont le gardent).`
      : st === 'accepted' && catalogOf(p)
        ? `Supprimer « ${p.name} » du coffre ? Le sticker reste dans son enveloppe.`
        : `Supprimer « ${p.name} » du coffre ?`;
    if (!(await askConfirm(msg, 'Supprimer'))) return;
    state.proposals = state.proposals.filter((x) => x.id !== p.id);
    db.deleteImage(p.id).catch(() => toast('La proposition n\'a pas pu être supprimée.'));
    renderCoffre();
  }

  // ---------------------------------------------------------------------------
  // Joueurs (administratrice) : qui a commencé à jouer, et lui écrire
  // ---------------------------------------------------------------------------
  let players = [];
  let playersSort = 'recent';
  let contestStats = {}; // joueur -> { count, last } : participations aux concours

  async function openPlayers() {
    if (!state.isAdmin) return;
    showScreen('players');
    $('#playersList').innerHTML = '<p class="muted">Chargement…</p>';
    try {
      players = await db.listPlayers();
    } catch (e) {
      console.warn('Liste des joueurs impossible', e);
      $('#playersList').innerHTML = '';
      toast('Impossible de charger les joueurs. Vérifie ta connexion.');
      return;
    }
    renderPlayers();
    try {
      const stats = {};
      for (const e of await db.listAllEntries()) {
        const st = stats[e.owner] || (stats[e.owner] = { count: 0, last: '' });
        st.count++;
        if ((e.contestDay || '') > st.last) st.last = e.contestDay;
      }
      contestStats = stats;
      renderPlayers();
    } catch (e) { console.warn('Participations aux concours indisponibles', e); }
  }
  $('#homePlayers').addEventListener('click', openPlayers);
  $('#playersBack').addEventListener('click', goHome);
  $('#playersSort').addEventListener('change', (e) => { playersSort = e.target.value; renderPlayers(); });
  $('#playersSearch').addEventListener('input', renderPlayers);

  const playerKey = (p) => p.key || normalizePseudo(p.pseudo || (p.id || '').replace(/^player-/, ''));
  const relDays = (t) => {
    if (!t) return '—';
    const days = Math.floor((Date.now() - t) / 86400000);
    if (days <= 0) return 'aujourd\'hui';
    if (days === 1) return 'hier';
    return `il y a ${days} jours`;
  };

  function renderPlayers() {
    const total = collectible().length;
    const q = normalizePseudo($('#playersSearch').value || '');
    const list = players
      .filter((p) => !q || playerKey(p).includes(q))
      .map((p) => {
        const inv = p.inventory || {};
        const distinct = Object.keys(inv).filter((id) => inv[id] > 0 && state.images.has(id)).length;
        const copies = Object.values(inv).reduce((a, b) => a + (b > 0 ? b : 0), 0);
        const lastSeen = p.lastSeen || (p.lastDaily ? new Date(p.lastDaily).getTime() : 0);
        return { p, distinct, copies, lastSeen };
      })
      .sort((a, b) => {
        if (playersSort === 'name') return (a.p.pseudo || '').localeCompare(b.p.pseudo || '', 'fr');
        if (playersSort === 'points') return (b.p.points || 0) - (a.p.points || 0);
        if (playersSort === 'collection') return b.distinct - a.distinct;
        if (playersSort === 'contest') return ((contestStats[playerKey(b.p)] || {}).count || 0) - ((contestStats[playerKey(a.p)] || {}).count || 0);
        return b.lastSeen - a.lastSeen;
      });

    // Options d'aménagement débloquées : total par option (l'administratrice les a toutes, on ne la compte pas).
    const real = players.filter((p) => !ADMIN_PSEUDOS.includes(playerKey(p)));
    $('#playersUnlocks').textContent = `Options débloquées : ${Object.keys(UNLOCKS).map((k) =>
      `${UNLOCK_ICONS[k]} ${UNLOCKS[k].label} ${real.filter((p) => p.unlocks && p.unlocks[k]).length}/${real.length}`).join(' · ')}`;
    const active7 = players.filter((p) => (p.lastSeen || 0) > Date.now() - 7 * 86400000).length;
    $('#playersCount').textContent = `${plural(players.length, 'joueur')} · ${active7} venu${active7 > 1 ? 's' : ''} ces 7 derniers jours`
      + (Object.keys(contestStats).length ? ` · ${plural(Object.values(contestStats).reduce((a, c) => a + c.count, 0), 'participation')} aux concours` : '');
    const body = $('#playersList');
    body.innerHTML = '';
    $('#playersEmpty').hidden = list.length > 0;
    for (const { p, distinct, copies, lastSeen } of list) {
      const key = playerKey(p);
      const row = document.createElement('article');
      row.className = 'player-row';
      row.innerHTML = `
        <div class="player-main">
          <h3 class="player-name"></h3>
          <p class="muted player-seen"></p>
        </div>
        <dl class="player-stats">
          <div><dt>Pièces</dt><dd class="s-points"></dd></div>
          <div><dt>Collection</dt><dd class="s-coll"></dd></div>
          <div><dt>Étoiles</dt><dd class="s-stars"></dd></div>
          <div><dt>Concours</dt><dd class="s-contest"></dd></div>
        </dl>
        <div class="player-unlocks"></div>
        <div class="player-actions">
          <button class="btn player-gift" title="Offrir des stickers">🎁<span class="label-long">&nbsp;Offrir</span></button>
          <button class="btn player-write" title="Envoyer un message dans sa boîte aux lettres">✉️<span class="label-long">&nbsp;Écrire</span></button>
          ${ADMIN_PSEUDOS.includes(key) ? '' : '<button class="btn player-delete" title="Supprimer le compte de ce joueur">🗑️</button>'}
        </div>`;
      row.querySelector('.player-name').textContent = ADMIN_PSEUDOS.includes(key) ? `${ADMIN_DISPLAY_NAME} 🛡️` : (p.pseudo || key);
      row.querySelector('.player-seen').textContent = `Vu ${relDays(lastSeen)}` + (p.firstSeen ? ` · depuis le ${dateFmt.format(p.firstSeen).replace(/ à .*/, '')}` : '');
      row.querySelector('.s-points').textContent = `${p.points || 0} 🪙`;
      row.querySelector('.s-coll').textContent = total ? `${distinct}/${total}` : `${distinct}`;
      row.querySelector('.s-coll').title = `${copies} exemplaires en tout`;
      row.querySelector('.s-stars').textContent = `🌟 ${p.stars || 0}`;
      const cs = contestStats[key];
      row.querySelector('.s-contest').textContent = `🏆 ${cs ? cs.count : 0}`;
      row.querySelector('.s-contest').title = cs ? `${plural(cs.count, 'participation')} · dernière : ${dayLabel(cs.last)}` : 'Aucune participation';
      // Options d'aménagement débloquées par ce joueur.
      const ul = row.querySelector('.player-unlocks');
      if (ADMIN_PSEUDOS.includes(key)) {
        ul.textContent = 'Toutes les options (administratrice)';
        ul.classList.add('muted');
      } else {
        const got = Object.keys(UNLOCKS).filter((k) => p.unlocks && p.unlocks[k]);
        if (!got.length) { ul.textContent = 'Aucune option débloquée'; ul.classList.add('muted'); }
        for (const k of got) {
          const chip = document.createElement('span');
          chip.className = 'unlock-chip';
          chip.textContent = `${UNLOCK_ICONS[k]} ${UNLOCKS[k].label}`;
          ul.appendChild(chip);
        }
      }
      row.querySelector('.player-write').addEventListener('click', () => openGift([{ key, name: p.pseudo || key }], 'write'));
      row.querySelector('.player-gift').addEventListener('click', () => openGift([{ key, name: p.pseudo || key }]));
      const del = row.querySelector('.player-delete');
      if (del) del.addEventListener('click', () => deletePlayerAccount(p, key));
      body.appendChild(row);
    }
  }

  // Supprimer le compte d'un joueur : avertissement, puis il faut retaper son pseudo.
  async function deletePlayerAccount(p, key) {
    if (ADMIN_PSEUDOS.includes(key)) return;
    const name = p.pseudo || key;
    const ok = await askDialog(`⚠️ Attention : supprimer le compte de « ${name} » efface définitivement ses pièces décorées, ses stickers, ses pièces 🪙, ses étoiles, ses messages et ses propositions en attente. Ses stickers déjà acceptés restent dans le jeu. Impossible de revenir en arrière.`, 'Continuer', undefined, true);
    if (!ok) return;
    const typed = await askDialog(`Dernière vérification : écris le pseudo « ${name} » pour confirmer la suppression.`, 'Supprimer définitivement', '', true);
    if (typed === null) return;
    if (normalizePseudo(typed) !== key) { toast('Le pseudo ne correspond pas : rien n\'a été supprimé.'); return; }
    try {
      const [rooms, mails, props, ...days] = await Promise.all([
        db.listRooms(key), db.listMail(key), db.listMyProposals(key),
        db.listContest(today()), db.listContest(shiftDay(today(), -1)),
      ]);
      for (const r of rooms.filter((x) => x.owner === key)) await db.deleteRoom(r.id);
      for (const m of mails) await db.deleteMail(m.id);
      for (const pr of props.filter((x) => x.status !== 'accepted')) await db.deleteImage(pr.id);
      for (const c of days.flat().filter((x) => x.kind === 'entry' && x.owner === key)) await db.deleteContest(c.id);
      await db.deletePlayer(playerDocId(key));
      players = players.filter((x) => playerKey(x) !== key);
      renderPlayers();
      toast(`Le compte de ${name} a été supprimé.`);
    } catch (e) {
      console.warn('Suppression impossible', e);
      toast('La suppression n\'a pas pu aller jusqu\'au bout. Vérifie ta connexion et réessaie.');
    }
  }

  // Offrir des stickers (et des pièces) à un joueur ou à tous, par la boîte aux lettres.
  const giftDialog = $('#giftDialog');
  let giftTargets = [];
  let giftPick = {};
  let giftMode = 'gift';
  const defaultSubject = () => (giftMode === 'gift' ? 'Un cadeau pour toi 🎁' : 'Un message pour toi ✉️');

  // mode 'gift' : cadeau (stickers ouverts) ; 'write' : message (titre + texte long, cadeau facultatif).
  function openGift(targets, mode = 'gift') {
    giftTargets = targets;
    giftPick = {};
    giftMode = mode;
    const who = targets.length === 1 ? targets[0].name : `tous les joueurs (${targets.length})`;
    $('#giftTitle').textContent = mode === 'gift' ? `Offrir à ${who} 🎁` : `Écrire à ${who} ✉️`;
    $('#giftSubject').value = '';
    $('#giftSubject').placeholder = defaultSubject();
    $('#giftText').value = '';
    $('#giftText').placeholder = mode === 'gift' ? 'Un petit cadeau pour toi !' : 'Écris ton message…';
    $('#giftStickers').open = mode === 'gift';
    $('#giftCoins').value = '0';
    const body = $('#giftList');
    body.innerHTML = '';
    const all = [...state.images.values()].filter((img) => img.catalog);
    const groups = state.envelopes.map((env) => [env.name || 'Enveloppe', all.filter((img) => img.envelope === env.id)]);
    groups.push(['Hors enveloppe', all.filter((img) => !envelopeExists(img.envelope))]);
    for (const [title, list] of groups) {
      if (!list.length) continue;
      const h = document.createElement('h3');
      h.className = 'star-env';
      h.textContent = title;
      body.appendChild(h);
      const grid = document.createElement('div');
      grid.className = 'env-grid env-grid-small';
      for (const img of list) {
        const cell = document.createElement('button');
        cell.className = 'env-item star-pick gift-pick';
        cell.dataset.rarity = img.rarity || 'common';
        cell.innerHTML = '<div class="env-item-img"><img alt=""><span class="env-owned gift-count" hidden></span></div><span class="env-item-name"></span><span class="gift-minus" role="button" title="Enlever" hidden>−</span>';
        cell.querySelector('img').src = img.url;
        cell.querySelector('.env-item-name').textContent = img.name;
        const refresh = () => {
          const n = giftPick[img.id] || 0;
          cell.classList.toggle('picked', n > 0);
          cell.querySelector('.gift-count').hidden = !n;
          cell.querySelector('.gift-count').textContent = `×${n}`;
          cell.querySelector('.gift-minus').hidden = !n;
          renderGiftSend();
        };
        cell.addEventListener('click', (e) => {
          if (e.target.closest('.gift-minus')) {
            giftPick[img.id] = Math.max(0, (giftPick[img.id] || 0) - 1);
            if (!giftPick[img.id]) delete giftPick[img.id];
          } else {
            giftPick[img.id] = (giftPick[img.id] || 0) + 1;
          }
          refresh();
        });
        grid.appendChild(cell);
      }
      body.appendChild(grid);
    }
    if (!body.children.length) body.innerHTML = '<p class="muted">Aucun sticker pour l\'instant : ajoute-en dans l\'atelier.</p>';
    renderGiftSend();
    giftDialog.hidden = false;
  }

  function giftCoins() { return Math.max(0, Math.round(Number($('#giftCoins').value) || 0)); }
  function renderGiftSend() {
    const n = Object.values(giftPick).reduce((a, b) => a + b, 0);
    const coins = giftCoins();
    const btn = $('#giftSend');
    const hasText = !!$('#giftText').value.trim();
    $('#giftStickerN').textContent = n ? `(${n})` : '';
    const parts = [];
    if (n) parts.push(plural(n, 'sticker'));
    if (coins) parts.push(`${coins} 🪙`);
    if (giftMode === 'gift') {
      btn.disabled = !n && !coins;
      btn.textContent = parts.length ? `Envoyer ${parts.join(' + ')}` : 'Choisis un cadeau';
    } else {
      btn.disabled = !hasText && !n && !coins;
      btn.textContent = parts.length ? `Envoyer + ${parts.join(' + ')}` : 'Envoyer le message';
    }
  }
  $('#giftCoins').addEventListener('input', renderGiftSend);
  $('#giftText').addEventListener('input', renderGiftSend);
  $('#giftCancel').addEventListener('click', () => { giftDialog.hidden = true; });
  $('#giftSend').addEventListener('click', async () => {
    const ids = [];
    for (const [id, n] of Object.entries(giftPick)) for (let i = 0; i < n; i++) ids.push(id);
    const coins = giftCoins();
    const typed = $('#giftText').value.trim();
    if (!ids.length && !coins && !(giftMode === 'write' && typed)) return;
    const text = typed || (ids.length || coins ? 'Un petit cadeau pour toi !' : '');
    const title = $('#giftSubject').value.trim() || ((ids.length || coins) ? 'Un cadeau pour toi 🎁' : defaultSubject());
    const btn = $('#giftSend');
    btn.disabled = true;
    try {
      for (const t of giftTargets) await sendMail(t.key, title, text, coins, ids.length ? ids : null);
      giftDialog.hidden = true;
      const what = (ids.length || coins) ? 'Cadeau envoyé' : 'Message envoyé';
      toast(giftTargets.length === 1 ? `${what} à ${giftTargets[0].name} !` : `${what} à ${plural(giftTargets.length, 'joueur')} !`);
    } catch (e) {
      console.warn('Cadeau impossible', e);
      toast('Le cadeau n\'a pas pu être envoyé. Vérifie ta connexion.');
      btn.disabled = false;
    }
  });
  function allTargets() {
    const targets = players
      .map((p) => ({ key: playerKey(p), name: p.pseudo || playerKey(p) }))
      .filter((t) => t.key && !ADMIN_PSEUDOS.includes(t.key));
    if (!targets.length) toast('Aucun joueur pour l\'instant.');
    return targets;
  }
  $('#giftAll').addEventListener('click', () => { const t = allTargets(); if (t.length) openGift(t); });
  $('#writeAll').addEventListener('click', () => { const t = allTargets(); if (t.length) openGift(t, 'write'); });

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
    let session = read(SESSION_KEY);
    // Session ouverte avec l'ancien pseudo : on passe directement sur « Administratrice ».
    if (session && normalizePseudo(session) === OLD_ADMIN) session = 'Administratrice';
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
    else if (place.screen === 'rooms') openRooms();
    else if (place.screen === 'shop') openShop(false);
    else if (place.screen === 'collection') openCollection();
    else if (place.screen === 'atelier') openAtelier();
    else if (place.screen === 'creations') openCreations();
    else if (place.screen === 'mail') openMail();
    else if (place.screen === 'news') openNews();
    else if (place.screen === 'contest') openContest();
    else if (place.screen === 'settings') openSettings();
    else if (place.screen === 'adminContest') openAdminContest();
    else if (place.screen === 'maintenance') openMaintenance();
    else if (place.screen === 'coffre') openCoffre();
    else if (place.screen === 'players') openPlayers();
  }

  init();
})();
