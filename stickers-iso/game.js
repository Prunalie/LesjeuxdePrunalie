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
    { group: 'Boutique', key: 'dailyEnvCount', label: 'Enveloppes du jour (prix réduit, 0 = toutes)', unit: 'enveloppes', def: () => 5, max: 100, step: 1 },
    { group: 'Boutique', key: 'sundayAllNormal', type: 'bool', label: 'Le dimanche, toutes les enveloppes à prix réduit', def: () => true },
    { group: 'Boutique', key: 'offPricePct', label: 'Hausse du prix des autres enveloppes', unit: '%', def: () => 100, max: 1000, step: 10 },
    { group: 'Boutique', key: 'packDiscountPct', label: 'Réduction sur le paquet « ×5 » (enveloppes du jour seulement)', unit: '% moins cher', def: () => 0, max: 90, step: 5 },
    { group: 'Boutique', key: 'decoPriceWall', label: 'Prix d\'un papier peint (boutique Décor)', unit: '🪙', def: () => 100, max: 100000, step: 10 },
    { group: 'Boutique', key: 'decoPriceFloor', label: 'Prix d\'un sol (boutique Décor)', unit: '🪙', def: () => 150, max: 100000, step: 10 },
    { group: 'Boutique', key: 'multiBuy', label: 'Enveloppes du bouton « ×… »', unit: 'enveloppes', def: () => MULTI_BUY, min: 2, max: 50, step: 1 },
    { group: 'Revente des stickers', key: 'sell_common', label: 'Revente d\'un commun', unit: '🪙', def: () => RARITIES.common.sell, max: 100000, step: 5 },
    { group: 'Revente des stickers', key: 'sell_rare', label: 'Revente d\'un rare', unit: '🪙', def: () => RARITIES.rare.sell, max: 100000, step: 5 },
    { group: 'Revente des stickers', key: 'sell_epic', label: 'Revente d\'un très rare', unit: '🪙', def: () => RARITIES.epic.sell, max: 100000, step: 5 },
    { group: 'Propositions de stickers', key: 'proposalReward', label: 'Pièces proposées quand je valide', unit: '🪙', def: () => PROPOSAL_REWARD, max: 100000, step: 10 },
    { group: 'Propositions de stickers', key: 'proposalGiveSticker', type: 'bool', label: 'Offrir aussi le sticker (1 exemplaire) au joueur qui l\'a proposé', def: () => true },
    { group: 'Propositions de stickers', key: 'maxPending', label: 'Propositions en attente par joueur', unit: 'au plus', def: () => MAX_PENDING, min: 1, max: 1000, step: 1 },
    { group: 'Options d\'aménagement (en étoiles)', key: 'unlock_garden', label: '🌳 Jardin', unit: '🌟', def: () => 2, max: 100, step: 1 },
    { group: 'Options d\'aménagement (en étoiles)', key: 'unlock_size', label: '📐 Taille sur mesure', unit: '🌟', def: () => 1, max: 100, step: 1 },
    { group: 'Options d\'aménagement (en étoiles)', key: 'unlock_decor', label: '🎨 Décor (papiers peints et sols)', unit: '🌟', def: () => 2, max: 100, step: 1 },
    { group: 'Options d\'aménagement (en étoiles)', key: 'unlock_levels', label: '🏢 Étages', unit: '🌟', def: () => 2, max: 100, step: 1 },
    { group: 'Concours', key: 'contestReward', label: 'Récompense du gagnant', unit: '🪙', def: () => 200, max: 100000, step: 10 },
    { group: 'Concours', key: 'contestReward2', label: 'Récompense du 2e', unit: '🪙', def: () => 50, max: 100000, step: 5 },
    { group: 'Concours', key: 'contestReward3', label: 'Récompense du 3e', unit: '🪙', def: () => 30, max: 100000, step: 5 },
    { group: 'Concours', key: 'contestSoloReward', label: 'Gagnant d\'office (une seule pièce)', unit: '🪙', def: () => Math.round(setting('contestReward') / 2), max: 100000, step: 10 },
    { group: 'Concours', key: 'contestJoinReward', label: 'Pour avoir participé (une fois par jour, à la première publication)', unit: '🪙', def: () => 50, max: 100000, step: 5 },
    { group: 'Concours', key: 'contestMilestoneEvery', label: 'Bonus de fidélité : tous les … concours auxquels on participe', unit: 'participations', def: () => 10, min: 1, max: 1000, step: 1 },
    { group: 'Concours', key: 'contestMilestoneReward', label: 'Bonus de fidélité (0 = pas de bonus)', unit: '🪙', def: () => 500, max: 1000000, step: 50 },
    { group: 'Concours', key: 'voteReward', label: 'Pour avoir fini ses duels', unit: '🪙', def: () => 20, max: 100000, step: 5 },
    { group: 'Concours', key: 'themeProposeReward', label: 'Pièces pour une idée de thème proposée', unit: '🪙', def: () => 5, max: 100000, step: 1 },
    { group: 'Concours', key: 'themeWinReward', label: 'Pièces quand l\'idée de thème d\'un joueur gagne', unit: '🪙', def: () => 100, max: 100000, step: 10 },
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
  // Thèmes de collections (ex. Nature & jardin, Magie…) : liste dans les réglages, chaque enveloppe porte l'id de son thème.
  // Essai : regroupement par thème visible seulement par l'administratrice.
  const envThemes = () => (Array.isArray(state.settings && state.settings.envThemes) ? state.settings.envThemes : []);
  const themesOn = () => !!state.isAdmin && envThemes().length > 0;
  const themeOfEnv = (env) => (env && env.theme && envThemes().find((t) => t.id === env.theme)) || null;
  const OTHER_THEME = { id: '', name: 'Autres' };
  // Enveloppes rangées par thème, dans l'ordre des thèmes ; celles sans thème à la fin (« Autres »).
  function groupByTheme(envs) {
    const groups = envThemes().map((t) => ({ theme: t, envs: envs.filter((e) => e.theme === t.id) })).filter((g) => g.envs.length);
    const rest = envs.filter((e) => !themeOfEnv(e));
    if (rest.length) groups.push({ theme: OTHER_THEME, envs: rest });
    return groups;
  }
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
      // Listes lourdes qui changent peu (catalogue, décor, enveloppes, nouveautés) : on affiche tout de suite
      // la copie gardée sur l'appareil, puis on la remet à jour en arrière-plan (cloudDb.onFresh).
      const docsOf = (snap) => snap.docs.map((d) => ({ ...d.data(), id: d.id }));
      // Le catalogue et le décor (~30 Mo) ne sont retéléchargés que si l'administratrice y a touché depuis la dernière fois
      // (réglage « catalogRev »). Les autres listes se remettent à jour à chaque connexion.
      const stale = {}; // clés dont la copie de l'appareil a servi : elles restent à vérifier
      const revalidators = {};
      const BIG = { catalog: true, decos: true };
      const bigQueries = {};
      const allFast = async (query, key) => {
        if (BIG[key]) bigQueries[key] = query;
        let cached = null;
        try { const c = await query.get({ source: 'cache' }); if (c.size) cached = docsOf(c); } catch (e) { /* pas de copie locale */ }
        if (!cached) return all(query);
        const check = () => query.get().then((snap) => { if (api.onFresh) api.onFresh(key, docsOf(snap)); });
        if (BIG[key]) { stale[key] = true; revalidators[key] = check; } else check().catch(() => {});
        return cached;
      };
      // Pour l'administratrice : un changement du catalogue ou du décor prévient les joueurs qu'il y a du nouveau.
      // Chaque modification note sa date (« updated ») : les joueurs ne relisent ensuite que ce qui a changé, au lieu des ~880
      // documents. Une suppression (invisible pour cette recherche) demande une relecture complète (« catalogFull »).
      const bumpRev = (full = false) => {
        if (!state.isAdmin) return;
        const now = Date.now();
        fsRooms().doc('settings').set(full ? { catalogRev: now, catalogFull: now } : { catalogRev: now }, { merge: true }).catch(() => {});
      };
      const fsRooms = () => rooms;
      // Les règles Firestore n'autorisent que deux collections : les pièces, joueurs et
      // enveloppes partagent « ma-petite-piece » (champ type), les stickers l'autre.
      const api = {
        listCatalog: () => allFast(images.where('catalog', '==', true), 'catalog'),
        // Papiers peints et sols (en test chez l'administratrice)
        // Lu en entier depuis Firebase (29 documents) : la copie de l'appareil pouvait être incomplète (seulement les décors
        // reçus par d'autres requêtes) et n'afficher qu'un sol ou un papier peint dans la boutique.
        listDecos: () => all(images.where('deco', '==', true)),
        // (Un sticker venu de la liste GitHub n'a pas son image en mémoire : on ne réécrit alors que ses champs,
        // sans jamais effacer l'image enregistrée dans Firebase.)
        putImage: ({ id, url, file, v, ...rec }) => images.doc(id).set(clean(rec.proposal || !playerVisible(id, rec) ? rec : { ...rec, updated: Date.now() }), rec.data ? {} : { merge: true }).then((r) => { bumpRev(); return r; }),
        // Mode « catalogue sur GitHub » : seulement ce qui a changé depuis la sauvegarde, et ce qui n'y est pas.
        listUpdatedSince: (since) => all(images.where('updated', '>', since)),
        listByEnvelopes: async (ids) => {
          const out = [];
          for (let i = 0; i < ids.length; i += 30) out.push(...await all(images.where('envelope', 'in', ids.slice(i, i + 30))));
          return out;
        },
        listUnfiled: () => all(images.where('envelope', '==', null)),
        listImagesByIds: async (ids) => {
          const out = [];
          for (let i = 0; i < ids.length; i += 30) out.push(...await all(images.where(firebase.firestore.FieldPath.documentId(), 'in', ids.slice(i, i + 30))));
          return out;
        },
        deleteImage: (id) => images.doc(id).delete().then((r) => {
          bumpRev(true);
          if (state.isAdmin) fsRooms().doc('settings').set({ catalogDeleted: firebase.firestore.FieldValue.arrayUnion(id) }, { merge: true }).catch(() => {});
          return r;
        }),
        isStale: () => !!(stale.catalog || stale.decos),
        revalidate: () => Promise.all(Object.keys(revalidators).map((k) => revalidators[k]().then(() => { delete stale[k]; }))),
        // Remise à jour partielle : seulement les stickers modifiés depuis « since » ; la copie de l'appareil les intègre,
        // puis on relit les listes depuis cette copie (sans lecture facturée).
        revalidateSince: async (since) => {
          await images.where('updated', '>', since).get();
          for (const k of Object.keys(bigQueries)) {
            const snap = await bigQueries[k].get({ source: 'cache' });
            if (api.onFresh) api.onFresh(k, docsOf(snap));
            delete stale[k];
          }
        },
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
        listEnvelopes: () => allFast(rooms.where('type', '==', 'envelope'), 'envelopes'),
        putEnvelope: ({ id, ...env }) => rooms.doc(id).set(clean({ ...env, type: 'envelope' })),
        deleteEnvelope: (id) => rooms.doc(id).delete(),
        // Propositions de stickers des joueurs (dans la collection des stickers, proposal: true)
        listMyProposals: async (owner) => (await all(images.where('owner', '==', owner))).filter((r) => r.proposal),
        listProposals: () => all(images.where('proposal', '==', true)),
        // Seulement celles en attente : bien plus léger que toutes les propositions (avec leurs images).
        listPendingProposals: () => all(images.where('proposal', '==', true).where('status', '==', 'pending')),
        // Change quelques champs sans renvoyer l'image.
        updateImage: (id, fields) => images.doc(id).set(clean(playerVisible(id) ? { ...fields, updated: Date.now() } : fields), { merge: true }).then((r) => { bumpRev(); return r; }),
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
        // Récupérer un cadeau une seule fois. Transaction d'abord ; si elle échoue (réseau, copie locale…), lecture directe
        // sur le serveur puis écriture : un peu moins sûre si deux appareils cliquent en même temps, mais le cadeau est récupérable.
        claimMail: async (id) => {
          const ref = rooms.doc(id);
          try {
            return await fs.runTransaction(async (tx) => {
              const d = await tx.get(ref);
              if (!d.exists || d.data().claimed) return false;
              tx.set(ref, { claimed: true, read: true }, { merge: true });
              return true;
            });
          } catch (e) {
            console.warn('Transaction impossible, lecture directe', e);
            const d = await ref.get({ source: 'server' });
            if (!d.exists || d.data().claimed) return false;
            await ref.set({ claimed: true, read: true }, { merge: true });
            return true;
          }
        },
        // Nouveautés écrites par l'administratrice (type « news »)
        // To-do de l'administratrice
        listTodos: () => all(rooms.where('type', '==', 'todo')),
        putTodo: ({ id, ...t }) => rooms.doc(id).set(clean({ ...t, type: 'todo' })),
        deleteTodo: (id) => rooms.doc(id).delete(),
        listNews: () => allFast(rooms.where('type', '==', 'news'), 'news'),
        // Signalements des joueurs (objets erronés, bugs)
        // Vote du thème du lendemain (propositions et votes)
        putThemeDoc: ({ id, ...r }) => rooms.doc(id).set(clean({ ...r, type: 'themevote' })),
        listThemeVote: (day) => all(rooms.where('themeDay', '==', day)),
        deleteThemeDoc: (id) => rooms.doc(id).delete(),
        putReport: ({ id, ...r }) => rooms.doc(id).set(clean({ ...r, type: 'report' })),
        listReports: () => all(rooms.where('type', '==', 'report')),
        deleteReport: (id) => rooms.doc(id).delete(),
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
      return api;
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
      listTodos: async () => (await getAll('settings')).filter((r) => r.type === 'todo'),
      putTodo: (t) => run('settings', 'readwrite', (s) => s.put({ ...t, type: 'todo' })),
      deleteTodo: (id) => run('settings', 'readwrite', (s) => s.delete(id)),
      listNews: () => getAll('news'),
      putThemeDoc: (r) => run('contest', 'readwrite', (s) => s.put({ ...r, type: 'themevote' })),
      listThemeVote: async (day) => (await getAll('contest')).filter((c) => c.themeDay === day),
      deleteThemeDoc: (id) => run('contest', 'readwrite', (s) => s.delete(id)),
      putReport: (r) => run('contest', 'readwrite', (s) => s.put({ ...r, type: 'report' })),
      listReports: async () => (await getAll('contest')).filter((c) => c.type === 'report'),
      deleteReport: (id) => run('contest', 'readwrite', (s) => s.delete(id)),
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
    saveTimer = setTimeout(saveRoom, 2500); // (chaque sauvegarde compte dans le quota d'écritures de Firebase)
  }

  // Traces : les dernières étapes du jeu, gardées sur l'appareil. Si la page plante, elles disent où (envoyées à l'administratrice si le joueur le veut).
  const TRACE_KEY = 'ma-petite-piece:traces';
  function crumb(msg) {
    try {
      const list = JSON.parse(localStorage.getItem(TRACE_KEY) || '[]');
      list.push(`${new Date().toLocaleTimeString('fr-FR')} ${msg}`);
      localStorage.setItem(TRACE_KEY, JSON.stringify(list.slice(-30)));
    } catch (e) { /* stockage indisponible */ }
  }
  // Diagnostic mémoire (pour les plantages sur iPhone) : images affichées et leur poids une fois décodées, dessins (canvas),
  // copies du concours gardées en mémoire. Safari ne donne pas la mémoire réelle : c'est une estimation.
  function memSnapshot() {
    try {
      let n = 0, px = 0, big = 0;
      for (const im of document.images) {
        if (!im.complete || !im.naturalWidth) continue;
        n++;
        const p = im.naturalWidth * im.naturalHeight;
        px += p;
        if (p > 800 * 800) big++;
      }
      let cvPx = 0, cvN = 0;
      for (const c of document.querySelectorAll('canvas')) { cvN++; cvPx += c.width * c.height; }
      let ctDocs = 0, ctMb = 0;
      if (typeof contestMem !== 'undefined') for (const m of contestMem.values()) { ctDocs += m.docs.length; for (const d of m.docs) if (d.image) ctMb += d.image.length; }
      const heap = performance && performance.memory && Number.isFinite(performance.memory.usedJSHeapSize) && performance.memory.usedJSHeapSize > 0 ? ` · JS ${Math.round(performance.memory.usedJSHeapSize / 1e6)} Mo` : '';
      const screen = Object.keys(screens || {}).find((k) => screens[k] && !screens[k].hidden) || '?';
      return `[${screen}] images ${n} (${big} grandes) ≈ ${Math.round(px * 4 / 1e6)} Mo · canvas ${cvN} ≈ ${Math.round(cvPx * 4 / 1e6)} Mo · concours ${ctDocs} docs ${Math.round(ctMb / 1e6 * 10) / 10} Mo${heap}`;
    } catch (e) { return 'mémoire ?'; }
  }
  // Toutes les 5 s sur les écrans lourds (concours, pièce) : une trace si l'estimation change nettement, pour voir ce qui précède un plantage.
  let lastMem = '';
  let lastMemMb = 0;
  setInterval(() => {
    try {
      if (!state.player || document.visibilityState !== 'visible') return;
      const scr = Object.keys(screens).find((k) => !screens[k].hidden);
      if (scr !== 'contest' && scr !== 'room') return;
      const snap = memSnapshot();
      const mb = (snap.match(/≈ (\d+) Mo/g) || []).reduce((a, x) => a + Number(x.replace(/\D/g, '')), 0);
      if (snap.slice(0, 12) !== lastMem.slice(0, 12) || Math.abs(mb - lastMemMb) >= 15) { crumb(`état ${snap}`); lastMem = snap; lastMemMb = mb; }
    } catch (e) { /* rien */ }
  }, 5000);
  window.addEventListener('error', (e) => crumb(`erreur : ${(e.message || '').slice(0, 120)}`));
  window.addEventListener('unhandledrejection', (e) => crumb(`erreur : ${String((e.reason && e.reason.message) || e.reason || '').slice(0, 120)}`));

  async function saveRoom() {
    crumb('sauvegarde de la pièce');
    clearTimeout(saveTimer);
    if (!savePending || !state.roomId) return;
    savePending = false;
    let thumb = '';
    try {
      crumb(`sauvegarde : dessin de la miniature (${state.stickers.length} stickers)`);
      const cv = await renderScene(0.3, state.colors.background || null);
      crumb('sauvegarde : miniature dessinée');
      thumb = cv.toDataURL('image/webp', 0.8);
      if (!thumb.startsWith('data:image/webp')) thumb = cv.toDataURL('image/png');
      crumb(`sauvegarde : miniature prête (${Math.round(thumb.length / 1024)} Ko)`);
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
      ...(currentRoom() && currentRoom().lentPlaced ? { lentPlaced: currentRoom().lentPlaced } : {}),
      ...(state.ambient < 100 ? { ambient: state.ambient } : {}),
      ...(state.lights.length ? { lights: state.lights.map((l) => ({ ...l })) } : {}),
      thumb,
      updated: Date.now(),
    };
    const i = state.rooms.findIndex((r) => r.id === room.id);
    if (i >= 0) state.rooms[i] = { ...room, stickers: [...room.stickers], colors: { ...room.colors }, shape: JSON.parse(JSON.stringify(room.shape)), ...(room.lights ? { lights: room.lights.map((l) => ({ ...l })) } : {}) };
    try {
      crumb('sauvegarde : envoi en ligne');
      await db.putRoom(room);
      crumb('sauvegarde : terminée');
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

  // Hauteur des murs commune à toute la maison (admin) : elle remplace celle de chaque pièce de la maison.
  function houseShape(id, shape) {
    const h = state.isAdmin && state.profile && state.profile.house;
    if (!h || !h.wallH || !Array.isArray(h.floors)) return shape;
    if (!h.floors.some((f) => (f.rooms || []).some((e) => e.id === id))) return shape;
    return { ...(shape || {}), h: h.wallH };
  }
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
  function roomGeom(shape, opts = null) {
    const sh = normShape(shape);
    const garden = sh.kind === 'garden';
    const levelsH = sh.levels.reduce((a, l) => a + l.h, 0);
    // Les murs dépassent toujours un peu du dernier étage.
    const wallTiles = garden ? Math.max(1.2, levelsH + 1.2) : Math.max(sh.h, levelsH + 2);
    const span = sh.w + sh.d;
    // Dans la maison, les pièces voisines sont dessinées à la même échelle et à un endroit imposé (opts).
    const k = opts && opts.k ? opts.k : Math.min(1, 840 / (span * TILE_X), 738 / (wallTiles * TILE_Z + span * TILE_Y + 18));
    const wallPx = wallTiles * TILE_Z * k;
    const C = opts && opts.origin ? { ...opts.origin } : {
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
    const curR = currentRoom();
    const inHouse = !!(houseOn() && curR && !curR.contestDay && houseEntries().some((e) => e.id === curR.id));
    room.innerHTML = roomSvg(state.colors, state.shape, inHouse ? { flat: true } : null);
    drawHouseNeighbors();
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
  function roomSvg(colors, shape, geomOpts = null) {
    const g = roomGeom(shape, geomOpts);
    const { sh, k, P, garden } = g;
    const base = garden ? { ...GARDEN_COLORS } : { ...DEFAULT_COLORS };
    const { wallLeft, wallRight, floor } = { ...base, ...colors };
    const defs = [];
    const decoFor = (key) => {
      const half = key === 'halfLeftDeco' || key === 'halfRightDeco' || key === 'postDeco';
      const d = colors && colors[key] && (garden ? (half || key === 'floorDeco' || key === 'levelFloorDeco') : !half) ? state.decos.get(colors[key]) : null;
      return d && d.w && d.h ? d : null;
    };
    // along : vecteur écran d'un carreau vers la droite du motif ; down : vers le bas du motif.
    // sx = -1 pour le mur de gauche, dont l'axe du motif va vers la gauche : un décalage « vers la droite » reste vers la droite à l'écran.
    const texture = (d, along, down, origin, sx = 1) => {
      const id = `deco${++decoSeq}`;
      const wu = Math.max(0.5, Math.min(12, Number(d.size) || 2)), hu = wu * d.h / d.w;
      const fx = (Number(d.offX) || 0) * sx, fy = Number(d.offY) || 0; // décalage réglé à la main, en part de motif
      origin = { x: origin.x + along.x * wu * fx + down.x * hu * fy, y: origin.y + along.y * wu * fx + down.y * hu * fy };
      const m = [along.x * wu / d.w, along.y * wu / d.w, down.x * hu / d.h, down.y * hu / d.h, origin.x, origin.y].map((n) => n.toFixed(5)).join(' ');
      defs.push(`<pattern id="${id}" patternUnits="userSpaceOnUse" x="0" y="0" width="${d.w}" height="${d.h}" patternTransform="matrix(${m})"><image href="${d.data}" width="${d.w}" height="${d.h}" preserveAspectRatio="none"/></pattern>`);
      return `url(#${id})`;
    };
    const decoWL = decoFor(garden ? 'halfLeftDeco' : 'wallLeftDeco'), decoWR = decoFor(garden ? 'halfRightDeco' : 'wallRightDeco'), decoF = decoFor('floorDeco'), decoLF = decoFor('levelFloorDeco');
    const W = sh.w, D = sh.d, Z = g.wallTiles;
    const C = P(0, 0), R = P(W, 0), L = P(0, D), B = P(W, D);
    const up = (p) => ({ x: p.x, y: p.y - g.wallPx });
    const off = (p, dx, dy) => ({ x: p.x + dx, y: p.y + dy });
    const T = 16 * Math.max(k, 0.5);
    const parts = [];

    // Murs (ou haies pour un jardin)
    const wallDown = { x: 0, y: TILE_Z * k * DECO_VK };
    const fillWL = decoWL ? texture(decoWL, { x: -TILE_X * k, y: TILE_Y * k }, wallDown, up(C), -1) : wallLeft;
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
      // Un demi-mur à motif (barrière, haie…) remplace le feuillage de son côté. Côté administratrice : plus de ronds du tout.
      if (!decoWL && !state.isAdmin) bumps(L, C, D, shade(wallLeft, 0.12));
      if (!decoWR && !state.isAdmin) bumps(C, R, W, shade(wallRight, 0.12));
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
      // Sol à motif de l'étage (plate-forme) : le motif part du coin du fond, à la hauteur du dessus.
      const top = decoLF ? texture(decoLF, { x: TILE_X * k, y: TILE_Y * k }, { x: -TILE_X * k, y: TILE_Y * k }, P(0, 0, z1)) : lc.levelFloor;
      // Face avant gauche (côté v = d) et face avant droite (côté u = w).
      parts.push(`<polygon points="${pts(P(0, lv.d, z), P(lv.w, lv.d, z), P(lv.w, lv.d, z1), P(0, lv.d, z1))}" fill="${lc.levelLeft}"/>`);
      parts.push(`<polygon points="${pts(P(lv.w, 0, z), P(lv.w, lv.d, z), P(lv.w, lv.d, z1), P(lv.w, 0, z1))}" fill="${lc.levelRight}"/>`);
      parts.push(`<polygon points="${pts(P(0, 0, z1), P(lv.w, 0, z1), P(lv.w, lv.d, z1), P(0, lv.d, z1))}" fill="${top}"/>`);
      if (!decoLF) floorPattern(parts, P, lv.w, lv.d, z1, lc.levelFloor, garden, k);
      // Petite bordure sur l'arête avant.
      parts.push(`<polyline points="${pts(P(0, lv.d, z1), P(lv.w, lv.d, z1), P(lv.w, 0, z1))}" fill="none" stroke="${shade(lc.levelFloor, -0.45)}" stroke-opacity=".5" stroke-width="2"/>`);
      z = z1;
    });

    // Jardin (côté administratrice) : des poteaux aux deux bouts des murs, avec ou sans demi-mur à motif.
    // Par défaut, un poteau en bois ; on peut en choisir un autre dans l'Atelier décor (type « Poteau »).
    const postsSvg = () => {
      if (!garden || !state.isAdmin) return ''; // côté administratrice pour l'instant
      const decoP = decoFor('postDeco');
      const spots = [[0, D], [W, 0]]; // aux deux bouts seulement, pas dans le coin
      const hpx = g.wallPx * 1.15;
      const lw = 2.5 * Math.max(k, 0.6);
      return spots.map(([u, v]) => {
        const b = P(u, v);
        if (decoP) {
          const wpx = hpx * decoP.w / decoP.h;
          return `<image href="${decoP.url}" x="${(b.x - wpx / 2).toFixed(1)}" y="${(b.y + TILE_Y * k * 0.2 - hpx).toFixed(1)}" width="${wpx.toFixed(1)}" height="${hpx.toFixed(1)}" preserveAspectRatio="xMidYMax meet"/>`;
        }
        // Poteau par défaut : un petit bloc de bois avec un chapeau un peu plus large.
        const wood = '#C9976A', ink = '#5A3E3A', zh = hpx / (TILE_Z * k);
        const box = (s, z0, z1) => {
          const A = (du, dv, z) => P(u + du * s, v + dv * s, z);
          return `<polygon points="${pts(A(-1, 1, z0), A(1, 1, z0), A(1, 1, z1), A(-1, 1, z1))}" fill="${shade(wood, -0.12)}" stroke="${ink}" stroke-width="${lw}" stroke-linejoin="round"/>`
            + `<polygon points="${pts(A(1, -1, z0), A(1, 1, z0), A(1, 1, z1), A(1, -1, z1))}" fill="${shade(wood, -0.3)}" stroke="${ink}" stroke-width="${lw}" stroke-linejoin="round"/>`
            + `<polygon points="${pts(A(-1, -1, z1), A(1, -1, z1), A(1, 1, z1), A(-1, 1, z1))}" fill="${shade(wood, 0.28)}" stroke="${ink}" stroke-width="${lw}" stroke-linejoin="round"/>`;
        };
        return box(0.17, 0, zh * 0.9) + box(0.24, zh * 0.9, zh);
      }).join('');
    };
    // Dans la maison : pas d'épaisseur ni de tranche de sol qui dépassent, pour que les sols des pièces voisines restent au même niveau.
    const flat = !!(geomOpts && geomOpts.flat);
    if (flat) return (defs.length ? `<defs>${defs.join('')}</defs>` : '') + parts.join('') + postsSvg();
    // Épaisseur des murs (tranche du dessus) et du sol
    if (!garden) {
      parts.push(`<polygon points="${pts(up(L), up(C), off(up(C), 0, -T / 2), off(up(L), -T, -T / 2))}" fill="${shade(wallLeft, 0.35)}"/>`);
      parts.push(`<polygon points="${pts(up(C), up(R), off(up(R), T, -T / 2), off(up(C), 0, -T / 2))}" fill="${shade(wallRight, 0.35)}"/>`);
    }
    // Bout du mur : pas pour un demi-mur à motif (jardin), il se termine net.
    if (!(garden && decoWL)) parts.push(`<polygon points="${pts(L, off(L, -T, -T / 2), off(up(L), -T, -T / 2), up(L))}" fill="${shade(wallLeft, -0.25)}"/>`);
    if (!(garden && decoWR)) parts.push(`<polygon points="${pts(R, off(R, T, -T / 2), off(up(R), T, -T / 2), up(R))}" fill="${shade(wallRight, -0.3)}"/>`);
    const SLAB = 18 * Math.max(k, 0.5);
    const slabColor = garden ? '#9b7653' : floor;
    const LT = off(L, -T, -T / 2), RT = off(R, T, -T / 2);
    parts.push(`<polygon points="${pts(LT, B, off(B, 0, SLAB), off(LT, 0, SLAB))}" fill="${shade(slabColor, -0.25)}"/>`);
    parts.push(`<polygon points="${pts(B, RT, off(RT, 0, SLAB), off(B, 0, SLAB))}" fill="${shade(slabColor, -0.38)}"/>`);
    parts.push(`<polygon points="${pts(LT, L, B)}" fill="${floor}"/>`);
    parts.push(`<polygon points="${pts(RT, R, B)}" fill="${floor}"/>`);


    return (defs.length ? `<defs>${defs.join('')}</defs>` : '') + parts.join('') + postsSvg();
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

  // Un joueur connecté avant l'ouverture du décor le charge à l'ouverture de la boutique ou d'une pièce.
  let decosTried = false;
  async function ensureDecos() {
    crumb('chargement du décor');
    if (!shopV2() || decosTried || state.decos.size) return;
    decosTried = true;
    try { (await withFallback((d) => d.listDecos())).forEach(addDeco); } catch (e) { decosTried = false; console.warn('Décor indisponible', e); }
  }

  // Prix d'un décor : un montant unique pour les sols, un autre pour les papiers peints (Réglages > Boutique).
  const decoPrice = (d) => setting(d.kind === 'floor' ? 'decoPriceFloor' : 'decoPriceWall');
  function addDeco(rec) {
    if (!rec.data) return;
    if ((rec.adminOnly || rec.kind === 'halfwall' || rec.kind === 'post') && !state.isAdmin) return; // décor privé : les joueurs ne le voient pas
    state.decos.set(rec.id, { ...rec, url: rec.data });
  }

  // ---------------------------------------------------------------------------
  // Catalogue sur GitHub (mode mixte)
  // La liste des stickers en vente et leurs images sont des fichiers du site (dossier catalogue/) : on ne les télécharge
  // plus depuis Firebase. Firebase ne fournit que ce qui a changé depuis la sauvegarde, les enveloppes pas encore dans la
  // liste (brouillons, programmées) et les stickers sans enveloppe.
  // ---------------------------------------------------------------------------
  let ghListed = new Set(); // stickers présents dans la liste GitHub
  // Une modification ne concerne les joueurs que si le sticker est (ou était) visible pour eux : sinon (brouillons, à ranger)
  // on ne la date pas, pour qu'ils ne la téléchargent pas. Une enveloppe qui passe en vente est lue à part.
  function playerVisible(id, rec = null) {
    if (ghListed.has(id)) return true;
    const img = rec || state.images.get(id) || state.decos.get(id);
    if (!img) return false;
    if (img.deco) return true;
    const env = state.envelopes.find((e) => e.id === img.envelope);
    return env ? isLive(env) : !!img.archived;
  }
  const ghCatalogOn = () => true; // tout le monde (coupure possible avec le réglage « ghCatalogOff »)
  async function loadGhCatalog(envelopes, settings, profile) {
    const t0 = Date.now();
    const res = await fetch('catalogue/liste.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`liste ${res.status}`);
    const L = await res.json();
    // Un sticker supprimé depuis la sauvegarde : la liste n'est plus fiable, on recharge tout depuis Firebase.
    if (settings && settings.ghCatalogOff) throw new Error('catalogue GitHub coupé dans les réglages');
    const deleted = new Set((settings && settings.catalogDeleted) || []); // supprimés depuis : retirés de la liste
    const base = new URL('catalogue/', location.href).href;
    const map = new Map();
    ghListed = new Set(L.items.map((o) => o.id));
    for (const o of L.items) if (o.catalog && !deleted.has(o.id)) map.set(o.id, { ...o, url: `${base}${o.file}?v=${o.v}` });
    const fromFb = (docs) => { for (const d of docs) if (d.catalog && d.data) map.set(d.id, d); };
    const covered = new Set(L.envelopes);
    // Enveloppes pas encore dans la liste : toutes pour l'administratrice (brouillons compris), seulement celles en vente pour les joueurs.
    const missingEnv = (envelopes || []).filter((e) => state.isAdmin || isLive(e)).map((e) => e.id).filter((id) => !covered.has(id));
    const [changed, inEnv, unfiled] = await Promise.all([
      // Joueurs : rien (la liste GitHub est refaite toutes les heures). Administratrice : les modifications récentes, tout de suite.
      state.isAdmin ? cloudDb.listUpdatedSince(L.snapshot - 2 * 3600 * 1000) : [],
      missingEnv.length ? cloudDb.listByEnvelopes(missingEnv) : [],
      state.isAdmin ? cloudDb.listUnfiled() : [],
    ]);
    fromFb(inEnv); fromFb(unfiled); fromFb(changed);
    // Stickers possédés qui ne sont nulle part (ex. cadeau d'un sticker jamais mis en vente) : on les demande un par un.
    const owned = Object.keys((profile && profile.inventory) || {}).filter((id) => !map.has(id));
    if (owned.length) fromFb(await cloudDb.listImagesByIds(owned).catch(() => []));
    crumb(`catalogue GitHub : ${L.items.length} + ${changed.length + inEnv.length + unfiled.length} Firebase (${Date.now() - t0} ms)`);
    return [...map.values()];
  }

  function addImageToLibrary(rec) {
    const url = rec.data || rec.url || (rec.blob ? URL.createObjectURL(rec.blob) : '');
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
  // Dans la pièce du concours, l'objet prêté du jour s'ajoute aux exemplaires que l'on possède (sans rien donner).
  const ownedHere = (id) => owned(id) + (lentId() === id ? 1 : 0);
  const available = (id) => ownedHere(id) - usedCount(id);

  // Filtre de la liste des stickers : null = toutes les collections, sinon l'id d'une enveloppe (ou NO_COLLECTION).
  const NO_COLLECTION = '__none';
  let libFilter = null;
  const collectionOf = (img) => (state.envelopes.some((e) => e.id === img.envelope) ? img.envelope : NO_COLLECTION);

  // Collections où le joueur a au moins un sticker, dans l'ordre de la boutique.
  function libCollections() {
    const mine = [...state.images.values()].filter((img) => ownedHere(img.id) > 0);
    const out = [];
    for (const env of state.envelopes) {
      const n = mine.filter((img) => collectionOf(img) === env.id).length;
      if (n) out.push({ id: env.id, name: env.name || 'Enveloppe', n });
    }
    const none = mine.filter((img) => collectionOf(img) === NO_COLLECTION).length;
    if (none) out.push({ id: NO_COLLECTION, name: 'Sans collection', n: none });
    return { list: out, total: mine.length };
  }

  // Thème d'un sticker (essai administratrice) : celui de son enveloppe ('' = Autres).
  const themeIdOfImg = (img) => { const t = themeOfEnv(state.envelopes.find((e) => e.id === img.envelope)); return t ? t.id : ''; };
  const THEME_FILTER = 'theme:';
  const libThemeOf = (f) => (f && f.startsWith(THEME_FILTER) ? f.slice(THEME_FILTER.length) : null);
  const libMatches = (img) => {
    if (!libFilter) return true;
    const th = libThemeOf(libFilter);
    return th !== null ? themeIdOfImg(img) === th : collectionOf(img) === libFilter;
  };

  function updateLibFilterButton() {
    const { list } = libCollections();
    const th = libThemeOf(libFilter);
    if (th !== null) {
      const t = th ? envThemes().find((x) => x.id === th) : OTHER_THEME;
      if (!themesOn() || !t) libFilter = null;
      else {
        const btn = $('#btnLibFilter');
        btn.classList.add('active');
        btn.hidden = false;
        $('#libFilterLabel').textContent = `\u00a0${t.name}`;
        btn.title = `Thème : ${t.name} (toucher pour changer)`;
        return;
      }
    }
    if (libFilter && !list.some((c) => c.id === libFilter)) libFilter = null; // plus aucun sticker de cette collection
    const cur = list.find((c) => c.id === libFilter);
    const btn = $('#btnLibFilter');
    btn.classList.toggle('active', !!cur);
    btn.hidden = list.length < 2 && !cur;
    $('#libFilterLabel').textContent = cur ? `\u00a0${cur.name}` : '\u00a0Collections';
    btn.title = cur ? `Collection : ${cur.name} (toucher pour changer)` : 'Filtrer les stickers par collection';
  }

  // Filtre des meubles. Avec les thèmes : d'abord la liste des thèmes, puis les collections du thème choisi
  // (retour possible vers les thèmes, ou « Toutes mes collections »).
  function openLibFilter(themeView) {
    const { list, total } = libCollections();
    const box = $('#libFilterList');
    box.innerHTML = '';
    const close = () => { $('#libFilterDialog').hidden = true; renderLibrary(); };
    const item = (id, label, n) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'lib-filter-item' + ((libFilter || null) === id ? ' active' : '');
      b.innerHTML = '<span class="lf-name"></span><span class="lf-n"></span>';
      b.querySelector('.lf-name').textContent = ((libFilter || null) === id ? '✓ ' : '') + label;
      b.querySelector('.lf-n').textContent = plural(n, 'sticker');
      b.addEventListener('click', () => { libFilter = id; close(); });
      box.appendChild(b);
      return b;
    };
    if (!themesOn()) {
      $('#libFilterTitle').textContent = 'Filtrer par collection';
      item(null, 'Toutes mes collections', total);
      list.forEach((c) => item(c.id, c.name, c.n));
      $('#libFilterDialog').hidden = false;
      return;
    }
    const envOf = (id) => state.envelopes.find((e) => e.id === id);
    const tid = (c) => { const t = themeOfEnv(envOf(c.id)); return t ? t.id : ''; };
    const themes = [...envThemes(), OTHER_THEME].map((t) => ({ t, cols: list.filter((c) => tid(c) === t.id) })).filter((x) => x.cols.length);
    const view = typeof themeView === 'string' ? themes.find((x) => x.t.id === themeView) : null;
    if (!view) {
      // Niveau 1 : les thèmes.
      $('#libFilterTitle').textContent = 'Filtrer par thème';
      item(null, 'Toutes mes collections', total);
      const curTheme = libThemeOf(libFilter);
      for (const { t, cols } of themes) {
        const inside = curTheme === t.id || cols.some((c) => c.id === libFilter);
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'lib-filter-item lf-theme' + (inside ? ' active' : '');
        b.innerHTML = '<span class="lf-name"></span><span class="lf-n"></span>';
        b.querySelector('.lf-name').textContent = `${inside ? '✓ ' : ''}🏷️ ${t.name}`;
        b.querySelector('.lf-n').textContent = `${plural(cols.length, 'collection')} ›`;
        b.addEventListener('click', () => openLibFilter(t.id));
        box.appendChild(b);
      }
    } else {
      // Niveau 2 : les collections du thème choisi.
      $('#libFilterTitle').textContent = view.t.name;
      const back = document.createElement('button');
      back.type = 'button';
      back.className = 'lib-filter-item lf-back';
      back.textContent = '← Tous les thèmes';
      back.addEventListener('click', () => openLibFilter());
      box.appendChild(back);
      item(THEME_FILTER + view.t.id, `Tout le thème « ${view.t.name} »`, view.cols.reduce((a, c) => a + c.n, 0)).classList.add('lf-theme');
      view.cols.forEach((c) => item(c.id, c.name, c.n));
      item(null, 'Toutes mes collections', total).classList.add('lf-all');
    }
    $('#libFilterDialog').hidden = false;
  }
  $('#btnLibFilter').addEventListener('click', () => openLibFilter());
  $('#libFilterClose').addEventListener('click', () => { $('#libFilterDialog').hidden = true; });
  $('#libFilterDialog').addEventListener('click', (e) => { if (e.target.id === 'libFilterDialog') $('#libFilterDialog').hidden = true; });

  // Vignettes de la liste : petites copies des stickers, créées seulement quand elles s'affichent. Avec une grosse collection,
  // des centaines d'images pleine taille saturent la mémoire d'un téléphone (iPhone : « un problème est survenu »).
  const thumbCache = new Map();   // id -> adresse de la petite vignette (en mémoire)
  const thumbPending = new Map(); // id -> fonctions à rappeler quand la vignette est prête
  const BLANK_GIF = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
  // Les vignettes sont aussi gardées sur l'appareil (stockage du navigateur) : après la première fois, elles s'affichent tout de suite.
  let thumbStore = null;
  if ('caches' in window) caches.open('mpp-thumbs-v1').then((c) => { thumbStore = c; }).catch(() => {});
  // (la version de l'image fait partie de la clé : un dessin remplacé refait sa vignette)
  const thumbKey = (img) => `/vignette/${encodeURIComponent(img.id)}-${img.created || 0}-${img.v || img.updated || 0}`;
  function smallUrl(img, cb) {
    if (thumbCache.has(img.id)) { cb(thumbCache.get(img.id)); return; }
    if (Math.max(img.w || 0, img.h || 0) <= 160) { thumbCache.set(img.id, img.url); cb(img.url); return; }
    if (thumbPending.has(img.id)) { thumbPending.get(img.id).push(cb); return; }
    thumbPending.set(img.id, [cb]);
    const done = (url) => { thumbCache.set(img.id, url); const list = thumbPending.get(img.id) || []; thumbPending.delete(img.id); list.forEach((f) => f(url)); };
    const make = () => {
      const el = new Image();
      el.onload = () => {
        try {
          const k = 160 / Math.max(el.naturalWidth, el.naturalHeight);
          const c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(el.naturalWidth * k));
          c.height = Math.max(1, Math.round(el.naturalHeight * k));
          c.getContext('2d').drawImage(el, 0, 0, c.width, c.height);
          c.toBlob((blob) => {
            if (!blob) { done(img.url); return; }
            if (thumbStore) thumbStore.put(thumbKey(img), new Response(blob)).catch(() => {});
            done(URL.createObjectURL(blob));
          }, 'image/png');
        } catch (e) { done(img.url); }
      };
      el.onerror = () => done(img.url);
      el.src = img.url;
    };
    if (thumbStore) {
      thumbStore.match(thumbKey(img)).then((res) => (res ? res.blob() : null))
        .then((blob) => { if (blob) done(URL.createObjectURL(blob)); else make(); })
        .catch(make);
    } else make();
  }
  // Après la connexion, on prépare doucement les vignettes des stickers du joueur (une toutes les 80 ms), pour que la liste soit instantanée.
  let warmTimer = 0;
  function warmThumbs() {
    crumb('préparation des vignettes');
    clearTimeout(warmTimer);
    const todo = [...state.images.values()].filter((i) => i.url && owned(i.id) > 0 && !thumbCache.has(i.id));
    let i = 0;
    const step = () => {
      if (i >= todo.length || !state.player) return;
      if (document.hidden) { warmTimer = setTimeout(step, 1000); return; }
      const img = todo[i++];
      smallUrl(img, () => { warmTimer = setTimeout(step, 80); });
    };
    warmTimer = setTimeout(step, 1500);
  }
  const thumbObserver = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const im = en.target;
      thumbObserver.unobserve(im);
      const img = state.images.get(im.dataset.imgId);
      if (img) smallUrl(img, (url) => { if (im.isConnected) im.src = url; });
    }
  }, { rootMargin: '300px' }) : null;

  let libSig = '';
  function renderLibrary() {
    crumb(`liste des stickers (${state.images.size} images)`);
    const all = [...state.images.values()].filter((img) => ownedHere(img.id) > 0);
    updateLibFilterButton();
    const mineAll = libFilter ? all.filter(libMatches) : all;
    // Les meubles les plus récents d'abord : date de sortie de leur enveloppe (ou de création du sticker si elle est plus récente).
    const envAt = new Map(state.envelopes.map((e) => [e.id, e.publishAt ? Date.parse(`${e.publishAt}T00:00:00`) : (e.created || 0)]));
    const recency = (img) => Math.max(img.created || 0, envAt.get(img.envelope) || 0);
    // L'objet imposé du concours (prêté) passe en premier.
    const lentNow = lentId();
    const mine = [...mineAll].sort((a, b) => Number(b.id === lentNow) - Number(a.id === lentNow) || recency(b) - recency(a));
    libraryEmpty.hidden = all.length > 0;
    // Même liste qu'avant (cas d'un sticker posé ou retiré) : on met seulement à jour les compteurs, sans reconstruire
    // les centaines de vignettes (ça faisait monter la mémoire et planter l'iPhone).
    const sig = `${libFilter || ''}|${lentNow || ''}|${mine.map((i) => i.id).join(',')}`;
    if (sig === libSig && libraryGrid.children.length === mine.length) {
      mine.forEach((img, k) => {
        const el = libraryGrid.children[k];
        const left = available(img.id), lent = lentNow === img.id;
        el.className = 'thumb' + (left > 0 ? '' : ' used-up') + (lent ? ' lent' : '');
        el.title = `${img.name} : ${left} à poser sur ${ownedHere(img.id)}${lent ? ' (1 prêté pour le concours)' : ''}`;
        el.querySelector('.thumb-count').textContent = `${Math.max(0, left)}/${ownedHere(img.id)}`;
      });
      return;
    }
    libSig = sig;
    if (thumbObserver) thumbObserver.disconnect();
    libraryGrid.innerHTML = '';
    for (const img of mine) {
      const left = available(img.id);
      const el = document.createElement('div');
      const lent = lentId() === img.id;
      el.className = 'thumb' + (left > 0 ? '' : ' used-up') + (lent ? ' lent' : '');
      el.dataset.rarity = img.rarity || 'common';
      el.title = `${img.name} : ${left} à poser sur ${ownedHere(img.id)}${lent ? ' (1 prêté pour le concours)' : ''}`;
      el.innerHTML = `<img alt=""><span class="thumb-count"></span>`;
      const tim = el.querySelector('img');
      if (thumbObserver) { tim.dataset.imgId = img.id; tim.src = thumbCache.get(img.id) || BLANK_GIF; if (!thumbCache.has(img.id)) thumbObserver.observe(tim); } else tim.src = img.url;
      el.querySelector('.thumb-count').textContent = `${Math.max(0, left)}/${ownedHere(img.id)}`;
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
    // Un exemplaire vendu entre-temps ne peut pas revenir dans la pièce (l'objet prêté du concours compte comme un exemplaire).
    for (const id of new Set(state.stickers.map((st) => st.imageId))) {
      let extra = usedCount(id) - ownedHere(id);
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
    const focusBtn = toolbar.querySelector('[data-act="focus"]');
    focusBtn.classList.toggle('active', !!state.focusId);
    focusBtn.setAttribute('aria-pressed', state.focusId ? 'true' : 'false');
    focusBtn.title = state.focusId ? 'Dégriser les autres meubles' : 'Griser les autres meubles pour déplacer cet objet sans être gêné';
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
      el.innerHTML = `<img alt="" draggable="false"><span class="handle handle-rotate" title="Tourner"></span><span class="handle handle-scale" title="Agrandir / réduire"></span><span class="handle handle-move" title="Déplacer sans avoir le doigt sur l'objet"></span>`;
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
      if (lightBarOpen && l.id === lightSel) {
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
    // La croix de déplacement : même geste que de tirer l'objet, mais le doigt reste à côté.
    else if (e.target.classList.contains('handle-move')) mode = 'move';

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
    if (!viewGesture.moved && ev.type === 'pointerup') {
      const nb = neighborAt(ev.clientX, ev.clientY);
      if (nb) goHouseRoom(nb); else select(null);
    }
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
    if (action === 'focus') { const on = !state.focusId; state.focusId = null; select(s.id, on); return; } // griser / dégriser les autres objets
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
      case 'delete': crumb('suppression d\'un sticker'); arr.splice(i, 1); state.selectedId = null; break;
      case 'light': {
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
  // Images des stickers pour le dessin de la pièce : une seule image décodée par sticker (et par taille), gardée d'une sauvegarde
  // à l'autre. Avant, chaque sauvegarde (toutes les ~3 s) décodait de nouveau chaque sticker en pleine taille : sur iPhone la
  // mémoire montait jusqu'au plantage. Pour la miniature, on prend la petite vignette (160 px) au lieu de l'image pleine taille.
  const sceneImgs = new Map();
  function sceneImage(img, small) {
    const key = img.id + (small ? '#s' : '');
    if (sceneImgs.has(key)) return Promise.resolve(sceneImgs.get(key));
    return new Promise((resolve, reject) => {
      const load = (url) => loadImageEl(url).then((el) => {
        if (sceneImgs.size >= 40) sceneImgs.delete(sceneImgs.keys().next().value);
        sceneImgs.set(key, el);
        resolve(el);
      }, reject);
      if (small) smallUrl(img, load); else load(img.url);
    });
  }

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
      try { el = await sceneImage(img, K <= 0.5); } catch (e) { console.warn('Sticker illisible, ignoré', img.name); continue; }
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

  // ---------------------------------------------------------------------------
  // Vue immersive (administratrice, en test) : la pièce occupe tout l'écran, vue depuis l'angle de devant, au premier plan.
  // Un curseur (ou le doigt) fait tourner le regard de gauche à droite ; une légère perspective donne l'impression de tourner la tête.
  // ---------------------------------------------------------------------------
  const imm = { url: '', t: 0.5, w: 0, h: 0 };
  async function openImmersive() {
    select(null);
    const box = $('#immersive');
    box.hidden = false;
    $('#immImg').hidden = true;
    $('#immLoading').hidden = false;
    try {
      // Rendu net pour l'écran (sans dépasser ~2,5 fois la taille de la scène), fond transparent pour recadrer sur la pièce.
      const k = Math.min(2.5, Math.max(1.2, (window.innerHeight * (window.devicePixelRatio || 1)) / STAGE_H * 1.4));
      const cv = await renderScene(k);
      const ctx = cv.getContext('2d');
      const { data, width, height } = ctx.getImageData(0, 0, cv.width, cv.height);
      let x0 = width, y0 = height, x1 = 0, y1 = 0;
      for (let y = 0; y < height; y += 3) for (let x = 0; x < width; x += 3) {
        if (data[(y * width + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      }
      if (x1 <= x0) { x0 = 0; y0 = 0; x1 = width - 1; y1 = height - 1; }
      const out = document.createElement('canvas');
      out.width = x1 - x0 + 1; out.height = y1 - y0 + 1;
      const o = out.getContext('2d');
      o.fillStyle = state.colors.background || DEFAULT_BACKGROUND;
      o.fillRect(0, 0, out.width, out.height);
      o.drawImage(cv, -x0, -y0);
      cv.width = cv.height = 0; // libère la mémoire tout de suite
      const blob = await new Promise((r) => out.toBlob(r, 'image/jpeg', 0.9));
      if (imm.url) URL.revokeObjectURL(imm.url);
      imm.url = URL.createObjectURL(blob);
      imm.w = out.width; imm.h = out.height;
      out.width = out.height = 0;
      $('#immImg').src = imm.url;
      $('#immImg').hidden = false;
      $('#immLoading').hidden = true;
      imm.t = 0.5;
      $('#immSlider').value = 500;
      layoutImmersive();
    } catch (e) {
      console.warn('Vue immersive impossible', e);
      box.hidden = true;
      toast('La vue immersive n\'a pas pu s\'ouvrir.');
    }
  }
  // Place l'image : elle remplit l'écran (un peu plus pour le premier plan), le curseur choisit la partie visible.
  function layoutImmersive() {
    const img = $('#immImg');
    if (!imm.w) return;
    const vw = window.innerWidth, vh = window.innerHeight;
    const z = Math.max(vh / imm.h, vw / imm.w) * 1.18; // premier plan : on est « dans » la pièce
    const w = imm.w * z, h = imm.h * z;
    const x = -(w - vw) * imm.t;          // gauche → droite
    const y = -(h - vh) * 0.62;           // regard un peu vers le sol
    const turn = (0.5 - imm.t) * 14;      // la tête tourne (degrés)
    img.style.width = `${w}px`;
    img.style.height = `${h}px`;
    img.style.transform = `translate(${x}px, ${y}px) rotateY(${turn}deg)`;
    img.style.transformOrigin = `${(imm.t * w)}px 50%`;
  }
  function closeImmersive() {
    $('#immersive').hidden = true;
    $('#immImg').removeAttribute('src');
    if (imm.url) { URL.revokeObjectURL(imm.url); imm.url = ''; }
    imm.w = imm.h = 0;
  }
  $('#btnImmersive').addEventListener('click', openImmersive);
  $('#immClose').addEventListener('click', closeImmersive);
  $('#immSlider').addEventListener('input', (e) => { imm.t = Number(e.target.value) / 1000; layoutImmersive(); });
  window.addEventListener('resize', () => { if (!$('#immersive').hidden) layoutImmersive(); });
  // Glisser le doigt sur la vue pour regarder ailleurs.
  {
    let drag = null;
    const view = $('#immView');
    view.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, t: imm.t }; view.setPointerCapture(e.pointerId); });
    view.addEventListener('pointermove', (e) => {
      if (!drag || !imm.w) return;
      const span = Math.max(1, imm.w * Math.max(window.innerHeight / imm.h, window.innerWidth / imm.w) * 1.18 - window.innerWidth);
      imm.t = clamp(drag.t - (e.clientX - drag.x) / span, 0, 1);
      $('#immSlider').value = Math.round(imm.t * 1000);
      layoutImmersive();
    });
    const end = () => { drag = null; };
    view.addEventListener('pointerup', end);
    view.addEventListener('pointercancel', end);
  }
  $('#btnExport2').addEventListener('click', exportRoom);
  $('#btnExport3').addEventListener('click', exportRoom);
  $('#btnContestDraftTop').addEventListener('click', () => $('#btnContestDraft').click());
  // Roue crantée de la pièce : petit menu (signaler un objet posé dans la pièce).
  const gearMenu = $('#roomGearMenu');
  const closeGear = () => { gearMenu.hidden = true; $('#btnRoomGear').setAttribute('aria-expanded', 'false'); };
  $('#btnRoomGear').addEventListener('click', (e) => {
    e.stopPropagation();
    gearMenu.hidden = !gearMenu.hidden;
    $('#btnRoomGear').setAttribute('aria-expanded', String(!gearMenu.hidden));
  });
  document.addEventListener('click', (e) => { if (!gearMenu.hidden && !e.target.closest('.stage-side')) closeGear(); });
  $('#btnRoomReport').addEventListener('click', () => {
    closeGear();
    if (!state.stickers.length) { toast('Pose d\'abord des objets dans la pièce.'); return; }
    openReport(true);
  });
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
    todo: $('#screenTodo'),
    house: $('#screenHouse'),
    settings: $('#screenSettings'),
    adminContest: $('#screenAdminContest'),
    maintenance: $('#screenMaintenance'),
  };
  function showScreen(name) {
    roomScreenActive = name === 'room';
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
  const OVERLAY_SEL = '.modal:not([hidden]), #duelView:not([hidden]), #colorPicker:not([hidden]), #immersive:not([hidden])';
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
    const label = btn.textContent;
    btn.textContent = 'Chargement…';
    try {
      await login(name);
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  });

  const dailyPoints = () => setting('dailyPoints');
  const playerDocId = (key) => 'player-' + key.replace(/\//g, '_');
  const today = () => new Date().toLocaleDateString('fr-CA'); // AAAA-MM-JJ, heure locale

  // Enveloppes : brouillon (invisible des joueurs), prévue un jour précis, ou en vente. Une seule nouvelle par jour.
  // Les anciennes enveloppes (sans réglage) sont en vente depuis toujours.
  const isLive = (env) => !env.draft && (!env.publishAt || env.publishAt <= today());
  const liveEnvelopes = () => state.envelopes.filter(isLive);
  // Nouvelle boutique (le stand) et décor : chez l'administratrice tout de suite, chez les joueurs à partir de demain.
  const SHOP_V2_FROM = '2026-11-02';
  const SHOP_V2_HOUR = 7; // ouverture aux joueurs à 7 h (heure de l'appareil)
  const launchAt = () => { const [y, m, d] = SHOP_V2_FROM.split('-').map(Number); return new Date(y, m - 1, d, SHOP_V2_HOUR, 0, 0).getTime(); };
  const shopV2 = () => state.isAdmin || Date.now() >= launchAt();
  // « NEW » : les enveloppes sorties aujourd'hui.
  const isNewEnvelope = (env) => isLive(env) && envSlotDay(env) === today();
  const envStatus = (env) => (env.draft ? 'draft' : isLive(env) ? 'live' : 'scheduled');
  // Jour « occupé » par une enveloppe : le jour prévu, ou à défaut le jour de sa création.
  const envSlotDay = (env) => (env.draft ? '' : env.publishAt || (env.created ? new Date(env.created).toLocaleDateString('fr-CA') : ''));
  const slotTaken = (day, exceptId) => state.envelopes.some((e) => e.id !== exceptId && envSlotDay(e) === day);
  function nextFreeDay(from = today(), exceptId = null) {
    let day = from;
    for (let i = 0; i < 800 && slotTaken(day, exceptId); i++) day = shiftDay(day, 1);
    return day;
  }

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

  // Les listes affichées depuis la copie de l'appareil sont remises à jour dès que le serveur répond.
  if (cloudDb) {
    cloudDb.onFresh = (key, docs) => {
      if (!state.player) return;
      if (key === 'catalog') {
        const ids = new Set(docs.map((d) => d.id));
        for (const [id, img] of [...state.images]) if (img.catalog && !ids.has(id)) state.images.delete(id);
        docs.forEach(addImageToLibrary);
      } else if (key === 'decos') {
        if (shopV2()) docs.forEach(addDeco);
      } else if (key === 'envelopes') {
        state.envelopes = sortEnvelopes(docs);
      } else if (key === 'news') {
        setNews(docs);
        renderNewsBadge();
      }
    };
  }

  async function login(name) {
    const key = normalizePseudo(name);
    state.isAdmin = ADMIN_PSEUDOS.includes(key);
    // Marqueur sur la page pour les réglages visuels réservés à l'administratrice (essais avant de les ouvrir à tous).
    if (state.isAdmin) document.documentElement.dataset.admin = '1'; else delete document.documentElement.dataset.admin;
    // Avant l'ouverture à tous, l'apparence Manoir est réservée à l'administratrice : un autre compte sur le même appareil garde l'apparence habituelle.
    applyTheme(themeMode() === 'manoir' && !state.isAdmin && !manoirOpen() ? 'auto' : themeMode());
    if (read(MANOIR_WELCOME_KEY)) setTimeout(welcomeManoir, 2500);
    // Le compte d'administration s'affiche « Admin » partout dans le jeu : le pseudo de
    // connexion n'apparaît jamais à l'écran (ni pré-rempli à l'accueil).
    const display = state.isAdmin ? ADMIN_DISPLAY_NAME : name;
    state.player = { key, name: display };
    if (state.isAdmin) { store(PSEUDO_KEY, null); store(SESSION_KEY, name); } else remember(name);
    $('#pseudoInput').value = state.isAdmin ? '' : $('#pseudoInput').value;
    $('#playerName').textContent = display;
    $('#playerName2').textContent = display;
    $('#homeAtelier').hidden = !state.isAdmin;
    $('#homeDecoAtelier').hidden = !state.isAdmin;
    $('#homeTodo').hidden = !state.isAdmin;
    $('#homeHouse').hidden = true; // fusionnée avec « Mes pièces » : l'entrée s'appelle « Ma maison »
    $('#homeAdmin').hidden = !state.isAdmin;
    state.images = new Map();
    state.decos = new Map();
    decosTried = false;
    let gained = 0;
    let isNew = false;
    try {
      if (state.isAdmin) await withFallback(migrateOldAdmin);
      const useGh = ghCatalogOn() && cloudDb && db === cloudDb;
      let [images, rooms, envelopes, profile, mails, mine, settings, news] = await withFallback((d) => Promise.all([
        useGh ? Promise.resolve(null) : d.listCatalog(), d.listRooms(state.player.key), d.listEnvelopes(), d.getPlayer(playerDocId(state.player.key)),
        d.listMail(state.player.key), d.listMyProposals(state.player.key), d.getSettings(),
        d.listNews().catch(() => []),
      ]));
      setNews(news);
      if (images === null && db !== cloudDb) images = await db.listCatalog(); // Firebase injoignable : copie locale
      else if (images === null) {
        try { images = await loadGhCatalog(envelopes, settings, profile); } catch (e) {
          console.warn('Catalogue GitHub indisponible : chargement depuis Firebase', e);
          crumb('catalogue GitHub indisponible');
          images = await cloudDb.listCatalog();
        }
      }
      if (shopV2()) (await withFallback((d) => d.listDecos()).catch(() => [])).forEach(addDeco);
      state.settings = { dailyPoints: DAILY_POINTS, ...(settings || {}) };
      if (cloudDb && db === cloudDb && cloudDb.isStale) {
        const REV_KEY = 'ma-petite-piece:catalogRev', CHECK_KEY = 'ma-petite-piece:catalogCheck';
        const FULL_KEY = 'ma-petite-piece:catalogFull', SINCE_KEY = 'ma-petite-piece:catalogSince';
        const rev = Number(settings && settings.catalogRev) || 0;
        const full = Number(settings && settings.catalogFull) || 0;
        const now = Date.now();
        const doneFull = () => { store(REV_KEY, String(rev)); store(FULL_KEY, String(full)); store(CHECK_KEY, String(now)); store(SINCE_KEY, String(now)); };
        const doneRev = () => { store(REV_KEY, String(rev)); store(SINCE_KEY, String(now)); };
        const lastSince = Number(read(SINCE_KEY) || 0);
        // Relecture complète (~880 documents) : après une suppression, sans date de dernière vérification, ou une fois par semaine.
        const changed = String(rev) !== read(REV_KEY);
        const lastFull = Number(read(CHECK_KEY) || 0);
        // (Première fois avec cette version : on garde l'ancienne règle, les modifications d'avant n'ont pas de date.)
        const needFull = !lastSince ? (changed || now - lastFull > 24 * 3600 * 1000)
          : ((full && String(full) !== read(FULL_KEY)) || now - lastFull > 7 * 24 * 3600 * 1000);
        if (cloudDb.isStale() && needFull) cloudDb.revalidate().then(doneFull).catch(() => {});
        // Sinon, seulement ce qui a changé (avec un jour de marge pour les horloges décalées).
        else if (cloudDb.isStale() && changed) cloudDb.revalidateSince(lastSince - 24 * 3600 * 1000).then(doneRev)
          .catch(() => cloudDb.revalidate().then(doneFull).catch(() => {})); // en cas de souci : relecture complète
        else if (!cloudDb.isStale()) doneFull();
        // Rien n'a changé : la copie de l'appareil est à jour à cette date.
        else if (!changed) { store(SINCE_KEY, String(now)); if (!read(FULL_KEY)) store(FULL_KEY, String(full)); }
      }
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
    if (state.isAdmin) loadThemeWinner(today());
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
      for (const k of ['points', 'inventory', 'stars', 'stamps', 'unlocks', 'savedColors', 'contestChecked', 'contestWins', 'newsSeen', 'lastDaily', 'voteRewardDay', 'joinRewardDay', 'contestCount', 'contestMilestones', 'stairsGift', 'decos', 'house', 'nightPlayer']) {
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
    if (r && r.contestDay) $('#contestBannerText').textContent = contestBannerText(r.contestDay);
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
  // Apparence « Mon manoir enchanté » (en test, administratrice seulement) : feuille de style et polices chargées à la demande.
  const GAME_TITLES = { classic: 'Ma petite pièce', manoir: 'Mon manoir enchanté' };
  function loadManoirAssets() {
    if (document.getElementById('manoirCss')) return;
    const v = (document.querySelector('script[src*="game.js"]') || {}).src || '';
    const ver = (v.match(/\?v=\d+/) || [''])[0];
    const fonts = document.createElement('link');
    fonts.rel = 'stylesheet';
    fonts.href = 'https://fonts.googleapis.com/css2?family=Cinzel:wght@600;700&family=Cormorant+Garamond:wght@600;700&display=swap';
    const css = document.createElement('link');
    css.id = 'manoirCss';
    css.rel = 'stylesheet';
    css.href = `manoir.css${ver}`;
    document.head.append(fonts, css);
  }
  function applyTheme(mode) {
    const root = document.documentElement;
    if (mode === 'manoir') {
      loadManoirAssets();
      root.dataset.skin = 'manoir';
      root.dataset.theme = 'dark';
    } else {
      delete root.dataset.skin;
      if (mode === 'light' || mode === 'dark') root.dataset.theme = mode; else delete root.dataset.theme;
    }
    const title = mode === 'manoir' ? GAME_TITLES.manoir : GAME_TITLES.classic;
    document.title = title;
    document.querySelectorAll('#screenStart h1').forEach((h) => { h.textContent = title; });
  }
  // Ouverture de l'apparence Manoir à tous les joueurs : le 14 novembre 2026 à 5 h (heure de Paris). Elle devient l'apparence
  // par défaut ; l'ancienne reste disponible (Auto, Clair ou Sombre, dans Paramètres).
  const MANOIR_OPEN_AT = Date.parse('2026-11-14T05:00:00+01:00');
  const manoirOpen = () => Date.now() >= MANOIR_OPEN_AT;
  const MANOIR_SWITCH_KEY = 'ma-petite-piece:manoir-ouvert';
  const MANOIR_WELCOME_KEY = 'ma-petite-piece:manoir-accueil'; // mot d'accueil à montrer (gardé jusqu'à ce qu'il soit vu)
  // Une seule fois par appareil, à l'ouverture : tout le monde passe au Manoir, même avec un choix Clair/Sombre enregistré avant.
  if (manoirOpen() && !read(MANOIR_SWITCH_KEY)) {
    if (read(THEME_KEY) !== 'manoir') store(MANOIR_WELCOME_KEY, '1');
    store(THEME_KEY, null);
    store(MANOIR_SWITCH_KEY, '1');
  }
  const themeMode = () => {
    const t = read(THEME_KEY);
    if (t === 'light' || t === 'dark' || t === 'manoir' || t === 'auto') return t;
    return manoirOpen() ? 'manoir' : 'auto';
  };
  applyTheme(themeMode());

  // Côté de la croix qui déplace un objet : au choix, gardé sur cet appareil (à droite par défaut).
  const MOVE_SIDE_KEY = 'ma-petite-piece:move-side';
  const moveSide = () => (read(MOVE_SIDE_KEY) === 'left' ? 'left' : 'right');
  const applyMoveSide = () => { document.documentElement.dataset.moveSide = moveSide(); };
  applyMoveSide();

  const prefsDialog = $('#prefsDialog');
  function renderPrefs() {
    const mode = themeMode();
    document.querySelectorAll('.theme-choice').forEach((b) => {
      const on = b.dataset.themeMode === mode;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on);
    });
    const device = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'sombre' : 'clair';
    // Apparence Manoir : proposée à tous à partir de l'ouverture (avant, seulement à l'administratrice).
    document.querySelectorAll('.theme-choice[data-theme-mode="manoir"]').forEach((b) => { b.hidden = !state.isAdmin && !manoirOpen(); });
    $('#themeHint').textContent = mode === 'manoir'
      ? (manoirOpen() ? 'Apparence « Mon manoir enchanté ». Pour retrouver l\'ancienne apparence, choisis Auto, Clair ou Sombre.' : 'Apparence « Mon manoir enchanté » (en test).')
      : mode === 'auto'
        ? `Automatique : le jeu suit ton appareil (en ce moment : ${device}).`
        : `Le jeu reste ${mode === 'dark' ? 'sombre' : 'clair'}, quel que soit ton appareil.`;
    if (mode !== 'manoir' && manoirOpen()) $('#themeHint').textContent = `Ancienne apparence. ${$('#themeHint').textContent} Choisis ✨ Manoir pour la nouvelle.`;
    document.querySelectorAll('.move-choice').forEach((b) => {
      const on = b.dataset.moveSide === moveSide();
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on);
    });
    $('#prefsName').textContent = state.player ? state.player.name : '';
  }
  document.querySelectorAll('.move-choice').forEach((b) => b.addEventListener('click', () => {
    store(MOVE_SIDE_KEY, b.dataset.moveSide === 'left' ? 'left' : null);
    applyMoveSide();
    renderPrefs();
  }));
  document.querySelectorAll('.theme-choice').forEach((b) => b.addEventListener('click', () => {
    const mode = b.dataset.themeMode;
    // « Auto » est enregistré tel quel : sans choix, l'apparence par défaut est le Manoir (après l'ouverture).
    store(THEME_KEY, mode === 'auto' && !manoirOpen() ? null : mode);
    applyTheme(mode);
    renderPrefs();
  }));
  // Le jour de l'ouverture : un mot d'accueil, avec la possibilité de remettre tout de suite l'ancienne apparence.
  async function welcomeManoir() {
    if (!state.player || !read(MANOIR_WELCOME_KEY)) return;
    if (themeMode() !== 'manoir') { store(MANOIR_WELCOME_KEY, null); return; }
    // un autre message est ouvert (plantage, nouveautés…) : on attend qu'il soit fermé
    if (!confirmDialog.hidden || !$('#newsDialog').hidden) { setTimeout(welcomeManoir, 1500); return; }
    store(MANOIR_WELCOME_KEY, null);
    const cancel = $('#confirmCancel');
    const old = cancel.textContent;
    cancel.textContent = 'Remettre l\'ancienne';
    const keep = await askConfirm('Bienvenue dans « Mon manoir enchanté » ✨ Le jeu fait peau neuve ! Tu préfères l\'ancienne apparence ? Tu peux la remettre ici, ou plus tard dans Paramètres (Auto, Clair ou Sombre).', 'J\'adore !');
    cancel.textContent = old;
    if (!keep) { store(THEME_KEY, 'auto'); applyTheme('auto'); toast('Ancienne apparence remise. Le Manoir reste disponible dans Paramètres.'); }
  }
  $('#btnPrefs').addEventListener('click', () => { renderPrefs(); prefsDialog.hidden = false; });
  $('#prefsClose').addEventListener('click', () => { prefsDialog.hidden = true; });
  prefsDialog.addEventListener('click', (e) => { if (e.target === prefsDialog) prefsDialog.hidden = true; });

  // Signaler un objet erroné ou un bug : le joueur écrit à l'administratrice (visible dans Coffre > Signalements).
  const reportDialog = $('#reportDialog');
  let reportKind = 'object';
  let reportPicks = new Set(); // objets choisis (on peut en signaler plusieurs d'un coup)
  const reportObserver = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const im = en.target;
      reportObserver.unobserve(im);
      const img = state.images.get(im.dataset.imgId);
      if (img) smallUrl(img, (url) => { if (im.isConnected) im.src = url; });
    }
  }, { rootMargin: '200px' }) : null;
  function renderReportGrid() {
    const q = normalizeText($('#reportSearch').value);
    const grid = $('#reportGrid');
    grid.innerHTML = '';
    // Les objets déjà choisis restent en tête, même pendant une recherche.
    const inRoom = reportRoomOnly ? new Set(state.stickers.map((st) => st.imageId)) : null;
    const list = [...state.images.values()].filter((i) => i.catalog && (inRoom ? inRoom.has(i.id) : owned(i.id) > 0) && (reportPicks.has(i.id) || !q || normalizeText(i.name || '').includes(q)))
      .sort((a, b) => Number(reportPicks.has(b.id)) - Number(reportPicks.has(a.id)) || (a.name || '').localeCompare(b.name || '', 'fr'));
    // Tous les objets (avant : seulement les 120 premiers) ; les vignettes se chargent quand elles apparaissent à l'écran.
    if (reportObserver) reportObserver.disconnect();
    for (const img of list) {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'env-item report-pick' + (reportPicks.has(img.id) ? ' picked' : '');
      cell.innerHTML = '<div class="env-item-img"><img alt=""></div><span class="env-item-name"></span>';
      cell.querySelector('.env-item-name').textContent = img.name;
      const im = cell.querySelector('img');
      im.src = thumbCache.get(img.id) || BLANK_GIF;
      if (!thumbCache.has(img.id)) {
        if (reportObserver) { im.dataset.imgId = img.id; reportObserver.observe(im); } else smallUrl(img, (url) => { if (im.isConnected) im.src = url; });
      }
      cell.addEventListener('click', () => { if (reportPicks.has(img.id)) reportPicks.delete(img.id); else reportPicks.add(img.id); renderReportGrid(); renderReportSend(); });
      grid.appendChild(cell);
    }
    if (!list.length) grid.innerHTML = '<p class="muted">Aucun objet trouvé.</p>';
  }
  function renderReportSend() {
    $('#reportSend').disabled = reportKind === 'object' ? !reportPicks.size : $('#reportBugText').value.trim().length < 5;
    $('#reportSend').textContent = reportKind === 'object' && reportPicks.size > 1 ? `Envoyer (${reportPicks.size} objets)` : 'Envoyer';
  }
  let reportRoomOnly = false; // depuis la pièce : seulement les objets posés dans cette pièce
  function openReport(roomOnly = false) {
    reportRoomOnly = roomOnly === true;
    $('#reportTitle').textContent = reportRoomOnly ? 'Signaler un objet de la pièce 🚩' : 'Signaler un problème 🚩';
    reportPicks = new Set();
    $('#reportSearch').value = '';
    $('#reportObjNote').value = '';
    $('#reportBugText').value = '';
    setReportTab('object');
    prefsDialog.hidden = true;
    reportDialog.hidden = false;
  }
  function setReportTab(kind) {
    reportKind = kind;
    document.querySelectorAll('#reportTabs .deco-tab').forEach((t) => t.classList.toggle('active', t.dataset.kind === kind));
    $('#reportObject').hidden = kind !== 'object';
    $('#reportBug').hidden = kind !== 'bug';
    if (kind === 'object') renderReportGrid();
    renderReportSend();
  }
  document.querySelectorAll('#reportTabs .deco-tab').forEach((t) => t.addEventListener('click', () => setReportTab(t.dataset.kind)));
  $('#reportSearch').addEventListener('input', renderReportGrid);
  $('#reportBugText').addEventListener('input', renderReportSend);
  $('#btnReport').addEventListener('click', () => openReport());
  $('#reportClose').addEventListener('click', () => { reportDialog.hidden = true; });
  reportDialog.addEventListener('click', (e) => { if (e.target === reportDialog) reportDialog.hidden = true; });
  $('#reportSend').addEventListener('click', async () => {
    if (!state.player) return;
    const me = state.player;
    let list;
    if (reportKind === 'object') {
      // Un signalement par objet (l'administratrice les voit regroupés par objet dans le Coffre).
      const note = $('#reportObjNote').value.trim();
      list = [...reportPicks].map((id) => state.images.get(id)).filter(Boolean)
        .map((img) => ({ id: `rp-${me.key}-${img.id}`, kind: 'sticker', stickerId: img.id, stickerName: img.name || '', note }));
      if (!list.length) return;
    } else {
      let traces = '';
      try { traces = (JSON.parse(read(TRACE_KEY) || '[]') || []).join('\n'); } catch (e) { /* rien */ }
      list = [{ id: `rp-bug-${me.key}-${Date.now()}`, kind: 'bug', note: $('#reportBugText').value.trim(), traces, device: navigator.userAgent }];
    }
    const now = Date.now();
    for (const r of list) { r.owner = me.key; r.ownerName = me.name; r.created = now; }
    $('#reportSend').disabled = true;
    try {
      await Promise.all(list.map((r) => db.putReport(r)));
      reportDialog.hidden = true;
      toast('Merci, c\'est envoyé à l\'administratrice ✉️');
    } catch (e) {
      console.warn('Signalement impossible', e);
      toast('Le message n\'a pas pu être envoyé. Vérifie ta connexion.');
      renderReportSend();
    }
  });

  // Se déconnecter : le bouton d'avant, maintenant dans les paramètres.
  // Aussi depuis l'écran « Le jeu est en maintenance » (sinon on reste coincé sur ce compte).
  $('#maintLogout').addEventListener('click', () => { $('#maintScreen').hidden = true; $('#btnLogout').click(); });
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
    if (houseOn() && !screens.house.hidden) renderHouse();
  }

  function openRoom(id) {
    const r = state.rooms.find((x) => x.id === id);
    if (!r) return;
    crumb(`ouverture de la pièce ${r.contestDay ? 'du concours' : 'normale'} (${(r.stickers || []).length} stickers) ${memSnapshot()}`);
    // Pièce du concours : la page du concours (avec les grandes images des participations) est vidée pour libérer la mémoire ;
    // elle se recharge au retour.
    if (r.contestDay) $('#ctBody').innerHTML = '';
    if (maintBlocked(r.contestDay ? 'contest' : 'rooms')) return;
    // Décor chargé à la demande si besoin (joueur connecté avant l'ouverture du décor).
    ensureDecos().then(() => { if (state.decos.size && state.roomId === id) { drawRoom(); syncDecoSwatches(); } });
    roomScreenActive = true;
    state.roomId = r.id;
    renderHouseNav();
    state.roomName = r.name;
    view.zoom = 1; view.x = 0; view.y = 0;
    state.colors = { ...DEFAULT_COLORS, ...r.colors };
    state.shape = normShape(houseShape(r.id, r.shape));
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
    $('#btnLight').hidden = false;
    toolbar.querySelector('[data-act="light"]').hidden = false;
    $('#roomName').value = r.name;
    // Pièce du concours : bouton « Publier », et retour vers le concours.
    screens.room.classList.toggle('contest-mode', !!r.contestDay);
    $('#btnContestPublish').hidden = !r.contestDay;
    $('#btnContestPublish2').hidden = !r.contestDay;
    $('#btnContestDraft').hidden = !r.contestDay;
    $('#btnContestDraftTop').hidden = !r.contestDay; // la disquette en haut, à la place de l'appareil photo
    $('#btnImmersive').hidden = !state.isAdmin;
    const backName = houseOn() ? 'Ma maison' : 'Mes pièces';
    $('#btnBack').title = r.contestDay ? 'Retour au concours' : `Retour à ${backName.toLowerCase()}`;
    $('#btnBack .label-long').innerHTML = r.contestDay ? '&nbsp;Concours' : `&nbsp;${backName}`;
    $('#contestBanner').hidden = !r.contestDay;
    if (r.contestDay) $('#contestBannerText').textContent = contestBannerText(r.contestDay);
    renderContestTheme(r);
    setSaveStatus('Sauvegardé ✓');
    syncColorInputs();
    // Objet imposé du jour : posé au milieu de la pièce à la première ouverture (si on l'enlève, on ne le remet pas).
    let lent = null;
    try { lent = lentId(); } catch (e) { console.warn('Objet prêté indisponible', e); }
    if (lent && r.lentPlaced !== lent && !state.stickers.some((s) => s.imageId === lent)) {
      const img = state.images.get(lent);
      if (img && img.w && img.h) {
        const k = STICKER_DEFAULT_SIZE / Math.max(img.w, img.h);
        state.stickers.push({ id: uid(), imageId: lent, x: STAGE_W / 2, y: 430, w: img.w * k, h: img.h * k, rot: 0, flip: false });
        scheduleSave();
      }
    }
    if (lent) r.lentPlaced = lent;
    // Diagnostic iPhone : chaque étape de l'ouverture, puis l'état quelques instants après (un plantage ici n'attend pas 5 s).
    crumb(`pièce : ${state.stickers.length} objets, ${state.lights.length} lumières, ambiance ${state.ambient}, décor ${state.colors.wallLeftDeco || state.colors.wallRightDeco ? 'mur' : '-'}/${state.colors.floorDeco ? 'sol' : '-'}, forme ${state.shape && state.shape.kind === 'garden' ? 'jardin' : 'pièce'}, objet imposé ${lent ? 'oui' : 'non'}`);
    drawRoom();
    crumb('pièce : décor dessiné');
    renderStickers();
    crumb('pièce : objets placés');
    showScreen('room');
    crumb('pièce : affichée');
    const opened = state.roomId;
    [700, 2000, 4000].forEach((ms) => setTimeout(() => { if (state.roomId === opened && !screens.room.hidden) crumb(`pièce +${ms / 1000} s ${memSnapshot()}`); }, ms));
  }

  // ---------------------------------------------------------------------------
  // Aménager la pièce : jardin, taille sur mesure, étages (options à débloquer avec des étoiles)
  // ---------------------------------------------------------------------------
  const UNLOCKS = {
    garden: { label: 'Jardin', cost: 2, desc: 'Transforme une pièce en jardin : haies, pelouse et ciel.' },
    size: { label: 'Taille sur mesure', cost: 1, desc: 'Choisis la largeur, la profondeur et la hauteur des murs.' },
    decor: { label: 'Décor', cost: 2, desc: 'Ouvre la boutique de papiers peints et de sols pour décorer tes pièces.' },
    levels: { label: 'Étages', cost: 2, desc: 'Ajoute jusqu\'à 3 niveaux surélevés au fond de la pièce. Un escalier gratuit 🪜 t\'est envoyé par message.' },
  };
  const UNLOCK_ICONS = { garden: '🌳', size: '📐', decor: '🎨', levels: '🏢' };
  const unlockCost = (key) => setting('unlock_' + key);
  const isUnlocked = (key) => state.isAdmin || !!(state.profile.unlocks && state.profile.unlocks[key]);
  // Le décor : l'administratrice peut tester comme un joueur (à débloquer avec des étoiles).
  const decorUnlocked = () => (state.isAdmin && !decoAsPlayer) || !!(state.profile.unlocks && state.profile.unlocks.decor);
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
    if (!shapeDialog.hidden) renderShapeDialog();
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
      const cr = currentRoom();
      if (sh.kind !== 'garden') {
        if (cr && houseShape(cr.id, {}).h) { const p = document.createElement('p'); p.className = 'muted shape-hint'; p.textContent = 'Hauteur des murs : réglée pour toute la maison (dans « Ma maison »).'; inner.appendChild(p); }
        else slider(inner, 'Hauteur des murs', sh.h, WALL_MIN, WALL_MAX, (v) => changeShape('h', (x) => { x.h = v; }));
      }
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
    if (houseOn()) { openHouse(null, 'home'); return; }
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
    await ensureDecos();
    shopView = shopV2() ? 'choice' : 'envelopes'; // le stand (et le décor) : administratrice maintenant, joueurs à partir de demain
    standPage = 0;
    renderShop();
    showScreen('shop');
  }

  $('#homeShop').addEventListener('click', () => openShop(false));
  $('#btnLibShop').addEventListener('click', () => openShop(true));
  $('#shopBack').addEventListener('click', () => {
    if (shopV2() && shopView !== 'choice') { shopView = 'choice'; renderShopChoice(); applyShopView(); window.scrollTo(0, 0); return; }
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

  // Enveloppes du jour : quelques-unes à prix réduit (les mêmes pour tout le monde,
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
  // Le dimanche, toutes les enveloppes sont à prix réduit (réglable dans Paramétrage).
  const allNormalDay = (day = today()) => setting('sundayAllNormal') && new Date(day + 'T12:00:00').getDay() === 0;
  function dailyEnvelopeIds(day = today(), ignoreSunday = false) {
    const shop = liveEnvelopes().filter((env) => stickersOf(env.id).length);
    const n = setting('dailyEnvCount');
    if (!n || shop.length <= n || (!ignoreSunday && allNormalDay(day))) return new Set(shop.map((e) => e.id));
    // Les nouvelles enveloppes du jour sont toujours dans les enveloppes du jour, avant les autres.
    const fresh = shop.filter((e) => envSlotDay(e) === day).map((e) => e.id);
    const room = Math.max(0, n - fresh.length);
    const chosen = dailyPicks(day).filter((id) => !fresh.includes(id) && shop.some((e) => e.id === id)).slice(0, room);
    // S'il en manque (aucun choix, ou moins de n), on complète au hasard.
    const rest = shop.filter((e) => !fresh.includes(e.id) && !chosen.includes(e.id))
      .sort((a, b) => seededRank(day + a.id) - seededRank(day + b.id))
      .slice(0, room - chosen.length).map((e) => e.id);
    return new Set([...fresh, ...chosen, ...rest]);
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
    $('#shopStamps').hidden = false; // la carte de tampons reste dans la barre du haut, sur toutes les pages de la boutique
    $('#decoAsPlayerRow').hidden = !state.isAdmin || shopView === 'envelopes';
    $('#shopTitle').textContent = shopView === 'envelopes' && shopV2() ? 'Toutes les enveloppes' : (shopView === 'deco' ? 'Décor' : 'Boutique');
    $('#shopBack').title = shopView === 'choice' || !shopV2() ? 'Retour' : 'Retour à la boutique';
  }

  const STAND_HEAD = "<defs><pattern id=\"stWood\" width=\"40\" height=\"10\" patternUnits=\"userSpaceOnUse\"><rect width=\"40\" height=\"10\" fill=\"#8A5634\"/><path d=\"M0 2.5 H40 M0 7.5 H26 M32 7.5 H40\" stroke=\"#6F4226\" stroke-width=\"1.1\" stroke-linecap=\"round\" opacity=\".75\"/><path d=\"M6 5 H18\" stroke=\"#A06A44\" stroke-width=\"1\" stroke-linecap=\"round\" opacity=\".6\"/></pattern></defs><ellipse cx=\"170\" cy=\"489\" rx=\"150\" ry=\"8\" fill=\"#5A3E3A\" opacity=\".12\"/>\n<rect x=\"24\" y=\"74\" width=\"292\" height=\"353\" fill=\"#FFEFE0\"/>\n<rect x=\"12\" y=\"78\" width=\"12\" height=\"365\" rx=\"3\" fill=\"#E8B98A\" stroke=\"#5A3E3A\" stroke-width=\"3\"/>\n<rect x=\"316\" y=\"78\" width=\"12\" height=\"365\" rx=\"3\" fill=\"#E8B98A\" stroke=\"#5A3E3A\" stroke-width=\"3\"/>\n<rect x=\"24\" y=\"164\" width=\"292\" height=\"10\" rx=\"3\" fill=\"#E8B98A\" stroke=\"#5A3E3A\" stroke-width=\"2.500\"/>\n<rect x=\"24\" y=\"300\" width=\"292\" height=\"10\" rx=\"3\" fill=\"#E8B98A\" stroke=\"#5A3E3A\" stroke-width=\"2.500\"/>";
  const STAND_IVY = "<!-- lierre sur les poteaux -->\n<path d=\"M18 80 Q8 125 20 165 T17 250 T19 345\" fill=\"none\" stroke=\"#4E8A66\" stroke-width=\"2.800\" stroke-linecap=\"round\"/><path d=\"M322 80 Q332 125 320 165 T323 250 T321 345\" fill=\"none\" stroke=\"#4E8A66\" stroke-width=\"2.800\" stroke-linecap=\"round\"/><path transform=\"translate(14.0 96.0) rotate(30)\" d=\"M0 0 C3.9 -4.9 10.4 -4.2 13 0 C10.4 4.2 3.9 4.9 0 0 Z\" fill=\"#9ED8B3\" stroke=\"#5A3E3A\" stroke-width=\"1.800\" stroke-linejoin=\"round\"/><path transform=\"translate(326.0 106.0) rotate(150)\" d=\"M0 0 C3.9 -4.9 10.4 -4.2 13 0 C10.4 4.2 3.9 4.9 0 0 Z\" fill=\"#7CC59B\" stroke=\"#5A3E3A\" stroke-width=\"1.800\" stroke-linejoin=\"round\"/><path transform=\"translate(14.0 123.0) rotate(150)\" d=\"M0 0 C3.9 -4.9 10.4 -4.2 13 0 C10.4 4.2 3.9 4.9 0 0 Z\" fill=\"#7CC59B\" stroke=\"#5A3E3A\" stroke-width=\"1.800\" stroke-linejoin=\"round\"/><path transform=\"translate(326.0 133.0) rotate(30)\" d=\"M0 0 C3.9 -4.9 10.4 -4.2 13 0 C10.4 4.2 3.9 4.9 0 0 Z\" fill=\"#9ED8B3\" stroke=\"#5A3E3A\" stroke-width=\"1.800\" stroke-linejoin=\"round\"/><path transform=\"translate(14.0 150.0) rotate(30)\" d=\"M0 0 C3.9 -4.9 10.4 -4.2 13 0 C10.4 4.2 3.9 4.9 0 0 Z\" fill=\"#9ED8B3\" stroke=\"#5A3E3A\" stroke-width=\"1.800\" stroke-linejoin=\"round\"/><path transform=\"translate(326.0 160.0) rotate(150)\" d=\"M0 0 C3.9 -4.9 10.4 -4.2 13 0 C10.4 4.2 3.9 4.9 0 0 Z\" fill=\"#7CC59B\" stroke=\"#5A3E3A\" stroke-width=\"1.800\" stroke-linejoin=\"round\"/><path transform=\"translate(14.0 177.0) rotate(150)\" d=\"M0 0 C3.9 -4.9 10.4 -4.2 13 0 C10.4 4.2 3.9 4.9 0 0 Z\" fill=\"#7CC59B\" stroke=\"#5A3E3A\" stroke-width=\"1.800\" stroke-linejoin=\"round\"/><path transform=\"translate(326.0 187.0) rotate(30)\" d=\"M0 0 C3.9 -4.9 10.4 -4.2 13 0 C10.4 4.2 3.9 4.9 0 0 Z\" fill=\"#9ED8B3\" stroke=\"#5A3E3A\" stroke-width=\"1.800\" stroke-linejoin=\"round\"/><path transform=\"translate(14.0 204.0) rotate(30)\" d=\"M0 0 C3.9 -4.9 10.4 -4.2 13 0 C10.4 4.2 3.9 4.9 0 0 Z\" fill=\"#9ED8B3\" stroke=\"#5A3E3A\" stroke-width=\"1.800\" stroke-linejoin=\"round\"/><path transform=\"translate(326.0 214.0) rotate(150)\" d=\"M0 0 C3.9 -4.9 10.4 -4.2 13 0 C10.4 4.2 3.9 4.9 0 0 Z\" fill=\"#7CC59B\" stroke=\"#5A3E3A\" stroke-width=\"1.800\" stroke-linejoin=\"round\"/><path transform=\"translate(14.0 231.0) rotate(150)\" d=\"M0 0 C3.9 -4.9 10.4 -4.2 13 0 C10.4 4.2 3.9 4.9 0 0 Z\" fill=\"#7CC59B\" stroke=\"#5A3E3A\" stroke-width=\"1.800\" stroke-linejoin=\"round\"/><path transform=\"translate(326.0 241.0) rotate(30)\" d=\"M0 0 C3.9 -4.9 10.4 -4.2 13 0 C10.4 4.2 3.9 4.9 0 0 Z\" fill=\"#9ED8B3\" stroke=\"#5A3E3A\" stroke-width=\"1.800\" stroke-linejoin=\"round\"/><path transform=\"translate(14.0 258.0) rotate(30)\" d=\"M0 0 C3.9 -4.9 10.4 -4.2 13 0 C10.4 4.2 3.9 4.9 0 0 Z\" fill=\"#9ED8B3\" stroke=\"#5A3E3A\" stroke-width=\"1.800\" stroke-linejoin=\"round\"/><path transform=\"translate(326.0 268.0) rotate(150)\" d=\"M0 0 C3.9 -4.9 10.4 -4.2 13 0 C10.4 4.2 3.9 4.9 0 0 Z\" fill=\"#7CC59B\" stroke=\"#5A3E3A\" stroke-width=\"1.800\" stroke-linejoin=\"round\"/><path transform=\"translate(14.0 285.0) rotate(150)\" d=\"M0 0 C3.9 -4.9 10.4 -4.2 13 0 C10.4 4.2 3.9 4.9 0 0 Z\" fill=\"#7CC59B\" stroke=\"#5A3E3A\" stroke-width=\"1.800\" stroke-linejoin=\"round\"/><path transform=\"translate(326.0 295.0) rotate(30)\" d=\"M0 0 C3.9 -4.9 10.4 -4.2 13 0 C10.4 4.2 3.9 4.9 0 0 Z\" fill=\"#9ED8B3\" stroke=\"#5A3E3A\" stroke-width=\"1.800\" stroke-linejoin=\"round\"/><path transform=\"translate(14.0 312.0) rotate(30)\" d=\"M0 0 C3.9 -4.9 10.4 -4.2 13 0 C10.4 4.2 3.9 4.9 0 0 Z\" fill=\"#9ED8B3\" stroke=\"#5A3E3A\" stroke-width=\"1.800\" stroke-linejoin=\"round\"/><path transform=\"translate(326.0 322.0) rotate(150)\" d=\"M0 0 C3.9 -4.9 10.4 -4.2 13 0 C10.4 4.2 3.9 4.9 0 0 Z\" fill=\"#7CC59B\" stroke=\"#5A3E3A\" stroke-width=\"1.800\" stroke-linejoin=\"round\"/><path transform=\"translate(14.0 339.0) rotate(150)\" d=\"M0 0 C3.9 -4.9 10.4 -4.2 13 0 C10.4 4.2 3.9 4.9 0 0 Z\" fill=\"#7CC59B\" stroke=\"#5A3E3A\" stroke-width=\"1.800\" stroke-linejoin=\"round\"/><path transform=\"translate(326.0 349.0) rotate(30)\" d=\"M0 0 C3.9 -4.9 10.4 -4.2 13 0 C10.4 4.2 3.9 4.9 0 0 Z\" fill=\"#9ED8B3\" stroke=\"#5A3E3A\" stroke-width=\"1.800\" stroke-linejoin=\"round\"/><path d=\"M26.5 92 Q32.5 120 24.5 150\" fill=\"none\" stroke=\"#4E8A66\" stroke-width=\"2.600\" stroke-linecap=\"round\"/><path transform=\"translate(28.5 106.0) rotate(25)\" d=\"M0 0 C3.3 -4.2 8.8 -3.5 11 0 C8.8 3.5 3.3 4.2 0 0 Z\" fill=\"#9ED8B3\" stroke=\"#5A3E3A\" stroke-width=\"1.800\" stroke-linejoin=\"round\"/><path transform=\"translate(26.5 124.0) rotate(155)\" d=\"M0 0 C3.3 -4.2 8.8 -3.5 11 0 C8.8 3.5 3.3 4.2 0 0 Z\" fill=\"#9ED8B3\" stroke=\"#5A3E3A\" stroke-width=\"1.800\" stroke-linejoin=\"round\"/><path transform=\"translate(28.5 142.0) rotate(25)\" d=\"M0 0 C3.3 -4.2 8.8 -3.5 11 0 C8.8 3.5 3.3 4.2 0 0 Z\" fill=\"#9ED8B3\" stroke=\"#5A3E3A\" stroke-width=\"1.800\" stroke-linejoin=\"round\"/><path d=\"M313.5 92 Q319.5 120 311.5 150\" fill=\"none\" stroke=\"#4E8A66\" stroke-width=\"2.600\" stroke-linecap=\"round\"/><path transform=\"translate(315.5 106.0) rotate(25)\" d=\"M0 0 C3.3 -4.2 8.8 -3.5 11 0 C8.8 3.5 3.3 4.2 0 0 Z\" fill=\"#9ED8B3\" stroke=\"#5A3E3A\" stroke-width=\"1.800\" stroke-linejoin=\"round\"/><path transform=\"translate(313.5 124.0) rotate(155)\" d=\"M0 0 C3.3 -4.2 8.8 -3.5 11 0 C8.8 3.5 3.3 4.2 0 0 Z\" fill=\"#9ED8B3\" stroke=\"#5A3E3A\" stroke-width=\"1.800\" stroke-linejoin=\"round\"/><path transform=\"translate(315.5 142.0) rotate(25)\" d=\"M0 0 C3.3 -4.2 8.8 -3.5 11 0 C8.8 3.5 3.3 4.2 0 0 Z\" fill=\"#9ED8B3\" stroke=\"#5A3E3A\" stroke-width=\"1.800\" stroke-linejoin=\"round\"/><path transform=\"translate(34.0 22.0) rotate(-110)\" d=\"M0 0 C4.5 -5.7 12.0 -4.8 15 0 C12.0 4.8 4.5 5.7 0 0 Z\" fill=\"#7CC59B\" stroke=\"#5A3E3A\" stroke-width=\"1.800\" stroke-linejoin=\"round\"/><path transform=\"translate(34.0 22.0) rotate(-90)\" d=\"M0 0 C4.5 -5.7 12.0 -4.8 15 0 C12.0 4.8 4.5 5.7 0 0 Z\" fill=\"#7CC59B\" stroke=\"#5A3E3A\" stroke-width=\"1.800\" stroke-linejoin=\"round\"/><path transform=\"translate(34.0 22.0) rotate(-70)\" d=\"M0 0 C4.5 -5.7 12.0 -4.8 15 0 C12.0 4.8 4.5 5.7 0 0 Z\" fill=\"#7CC59B\" stroke=\"#5A3E3A\" stroke-width=\"1.800\" stroke-linejoin=\"round\"/><path transform=\"translate(306.0 22.0) rotate(-110)\" d=\"M0 0 C4.5 -5.7 12.0 -4.8 15 0 C12.0 4.8 4.5 5.7 0 0 Z\" fill=\"#7CC59B\" stroke=\"#5A3E3A\" stroke-width=\"1.800\" stroke-linejoin=\"round\"/><path transform=\"translate(306.0 22.0) rotate(-90)\" d=\"M0 0 C4.5 -5.7 12.0 -4.8 15 0 C12.0 4.8 4.5 5.7 0 0 Z\" fill=\"#7CC59B\" stroke=\"#5A3E3A\" stroke-width=\"1.800\" stroke-linejoin=\"round\"/><path transform=\"translate(306.0 22.0) rotate(-70)\" d=\"M0 0 C4.5 -5.7 12.0 -4.8 15 0 C12.0 4.8 4.5 5.7 0 0 Z\" fill=\"#7CC59B\" stroke=\"#5A3E3A\" stroke-width=\"1.800\" stroke-linejoin=\"round\"/>";
  const STAND_COUNTER = "<!-- comptoir -->\n<path transform=\"translate(40 360) rotate(-105)\" d=\"M0 0 C4.2 -5.3 11.2 -4.5 14 0 C11.2 4.5 4.2 5.3 0 0 Z\" fill=\"#7CC59B\" stroke=\"#5A3E3A\" stroke-width=\"1.800\" stroke-linejoin=\"round\"/><path transform=\"translate(40 360) rotate(-80)\" d=\"M0 0 C4.8 -6.1 12.8 -5.1 16 0 C12.8 5.1 4.8 6.1 0 0 Z\" fill=\"#9ED8B3\" stroke=\"#5A3E3A\" stroke-width=\"1.800\" stroke-linejoin=\"round\"/><path transform=\"translate(40 360) rotate(-55)\" d=\"M0 0 C4.2 -5.3 11.2 -4.5 14 0 C11.2 4.5 4.2 5.3 0 0 Z\" fill=\"#7CC59B\" stroke=\"#5A3E3A\" stroke-width=\"1.800\" stroke-linejoin=\"round\"/><path transform=\"translate(100 360) rotate(-105)\" d=\"M0 0 C4.2 -5.3 11.2 -4.5 14 0 C11.2 4.5 4.2 5.3 0 0 Z\" fill=\"#7CC59B\" stroke=\"#5A3E3A\" stroke-width=\"1.800\" stroke-linejoin=\"round\"/><path transform=\"translate(100 360) rotate(-80)\" d=\"M0 0 C4.8 -6.1 12.8 -5.1 16 0 C12.8 5.1 4.8 6.1 0 0 Z\" fill=\"#9ED8B3\" stroke=\"#5A3E3A\" stroke-width=\"1.800\" stroke-linejoin=\"round\"/><path transform=\"translate(100 360) rotate(-55)\" d=\"M0 0 C4.2 -5.3 11.2 -4.5 14 0 C11.2 4.5 4.2 5.3 0 0 Z\" fill=\"#7CC59B\" stroke=\"#5A3E3A\" stroke-width=\"1.800\" stroke-linejoin=\"round\"/><path transform=\"translate(236 360) rotate(-105)\" d=\"M0 0 C4.2 -5.3 11.2 -4.5 14 0 C11.2 4.5 4.2 5.3 0 0 Z\" fill=\"#7CC59B\" stroke=\"#5A3E3A\" stroke-width=\"1.800\" stroke-linejoin=\"round\"/><path transform=\"translate(236 360) rotate(-80)\" d=\"M0 0 C4.8 -6.1 12.8 -5.1 16 0 C12.8 5.1 4.8 6.1 0 0 Z\" fill=\"#9ED8B3\" stroke=\"#5A3E3A\" stroke-width=\"1.800\" stroke-linejoin=\"round\"/><path transform=\"translate(236 360) rotate(-55)\" d=\"M0 0 C4.2 -5.3 11.2 -4.5 14 0 C11.2 4.5 4.2 5.3 0 0 Z\" fill=\"#7CC59B\" stroke=\"#5A3E3A\" stroke-width=\"1.800\" stroke-linejoin=\"round\"/><path transform=\"translate(296 360) rotate(-105)\" d=\"M0 0 C4.2 -5.3 11.2 -4.5 14 0 C11.2 4.5 4.2 5.3 0 0 Z\" fill=\"#7CC59B\" stroke=\"#5A3E3A\" stroke-width=\"1.800\" stroke-linejoin=\"round\"/><path transform=\"translate(296 360) rotate(-80)\" d=\"M0 0 C4.8 -6.1 12.8 -5.1 16 0 C12.8 5.1 4.8 6.1 0 0 Z\" fill=\"#9ED8B3\" stroke=\"#5A3E3A\" stroke-width=\"1.800\" stroke-linejoin=\"round\"/><path transform=\"translate(296 360) rotate(-55)\" d=\"M0 0 C4.2 -5.3 11.2 -4.5 14 0 C11.2 4.5 4.2 5.3 0 0 Z\" fill=\"#7CC59B\" stroke=\"#5A3E3A\" stroke-width=\"1.800\" stroke-linejoin=\"round\"/>\n<rect x=\"8\" y=\"437\" width=\"324\" height=\"44\" rx=\"10\" fill=\"#E8B98A\" stroke=\"#5A3E3A\" stroke-width=\"3\"/>\n<rect x=\"2\" y=\"427\" width=\"336\" height=\"14\" rx=\"7\" fill=\"#F3CFA3\" stroke=\"#5A3E3A\" stroke-width=\"3\"/>";
  const STAND_NEW_SIGN = "<rect x=\"30\" y=\"418\" width=\"6\" height=\"9\" fill=\"#C9976A\" stroke=\"#5A3E3A\" stroke-width=\"2\"/><rect x=\"122\" y=\"418\" width=\"6\" height=\"9\" fill=\"#C9976A\" stroke=\"#5A3E3A\" stroke-width=\"2\"/><rect x=\"14\" y=\"358\" width=\"130\" height=\"60\" rx=\"9\" fill=\"#C9976A\" stroke=\"#5A3E3A\" stroke-width=\"3\"/><rect x=\"19\" y=\"363\" width=\"120\" height=\"50\" rx=\"5\" fill=\"url(#stWood)\" stroke=\"#5A3E3A\" stroke-width=\"2\"/><circle cx=\"17.5\" cy=\"388\" r=\"1.600\" fill=\"#5A3E3A\"/><circle cx=\"140.5\" cy=\"388\" r=\"1.600\" fill=\"#5A3E3A\"/><path transform=\"translate(57 372) scale(.5) translate(-13 -18)\" d=\"M13 4 L17 14 L27 18 L17 22 L13 32 L9 22 L-1 18 L9 14 Z\" fill=\"#FFD96B\"/>\n<text x=\"68\" y=\"378\" font-family=\"Fredoka,sans-serif\" font-weight=\"700\" font-size=\"16\" fill=\"#FFD96B\">NEW</text>\n<text x=\"79\" y=\"394\" text-anchor=\"middle\" font-family=\"Fredoka,sans-serif\" font-weight=\"500\" font-size=\"12.500\" fill=\"#FFF8EF\">2 nouvelles</text>\n<text x=\"79\" y=\"408\" text-anchor=\"middle\" font-family=\"Fredoka,sans-serif\" font-weight=\"500\" font-size=\"12.500\" fill=\"#FFF8EF\">enveloppes</text>";
  const STAND_SUN_SIGN = "<rect x=\"212\" y=\"418\" width=\"6\" height=\"9\" fill=\"#C9976A\" stroke=\"#5A3E3A\" stroke-width=\"2\"/><rect x=\"308\" y=\"418\" width=\"6\" height=\"9\" fill=\"#C9976A\" stroke=\"#5A3E3A\" stroke-width=\"2\"/><rect x=\"196\" y=\"358\" width=\"134\" height=\"60\" rx=\"9\" fill=\"#C9976A\" stroke=\"#5A3E3A\" stroke-width=\"3\"/><rect x=\"201\" y=\"363\" width=\"124\" height=\"50\" rx=\"5\" fill=\"url(#stWood)\" stroke=\"#5A3E3A\" stroke-width=\"2\"/><circle cx=\"199.5\" cy=\"388\" r=\"1.600\" fill=\"#5A3E3A\"/><circle cx=\"326.5\" cy=\"388\" r=\"1.600\" fill=\"#5A3E3A\"/><g transform=\"translate(220 372)\"><circle r=\"4\" fill=\"#FFD96B\"/><path d=\"M0 -8 V-6 M0 6 V8 M-8 0 H-6 M6 0 H8 M-5.600 -5.600 L-4.200 -4.200 M4.200 4.200 L5.600 5.600 M5.600 -5.600 L4.200 -4.200 M-4.200 4.200 L-5.600 5.600\" stroke=\"#FFD96B\" stroke-width=\"1.600\" stroke-linecap=\"round\"/></g>\n<text x=\"232\" y=\"378\" font-family=\"Fredoka,sans-serif\" font-weight=\"700\" font-size=\"15\" fill=\"#FFD96B\">Dimanche :</text><text x=\"263\" y=\"394\" text-anchor=\"middle\" font-family=\"Fredoka,sans-serif\" font-weight=\"500\" font-size=\"12.5\" fill=\"#FFF8EF\">tout à petit</text><text x=\"263\" y=\"408\" text-anchor=\"middle\" font-family=\"Fredoka,sans-serif\" font-weight=\"500\" font-size=\"12.5\" fill=\"#FFF8EF\">prix !</text>";
  const STAND_REST = "<path transform=\"translate(170 409) rotate(-90)\" d=\"M0 0 C8.4 -10.6 22.4 -9.0 28 0 C22.4 9.0 8.4 10.6 0 0 Z\" fill=\"#5FB27F\" stroke=\"#5A3E3A\" stroke-width=\"1.800\" stroke-linejoin=\"round\"/><path transform=\"translate(170 409) rotate(-62)\" d=\"M0 0 C7.2 -9.1 19.2 -7.7 24 0 C19.2 7.7 7.2 9.1 0 0 Z\" fill=\"#9ED8B3\" stroke=\"#5A3E3A\" stroke-width=\"1.800\" stroke-linejoin=\"round\"/><path transform=\"translate(170 409) rotate(-118)\" d=\"M0 0 C7.2 -9.1 19.2 -7.7 24 0 C19.2 7.7 7.2 9.1 0 0 Z\" fill=\"#9ED8B3\" stroke=\"#5A3E3A\" stroke-width=\"1.800\" stroke-linejoin=\"round\"/><path transform=\"translate(170 409) rotate(-40)\" d=\"M0 0 C5.4 -6.8 14.4 -5.8 18 0 C14.4 5.8 5.4 6.8 0 0 Z\" fill=\"#7CC59B\" stroke=\"#5A3E3A\" stroke-width=\"1.800\" stroke-linejoin=\"round\"/><path transform=\"translate(170 409) rotate(-140)\" d=\"M0 0 C5.4 -6.8 14.4 -5.8 18 0 C14.4 5.8 5.4 6.8 0 0 Z\" fill=\"#7CC59B\" stroke=\"#5A3E3A\" stroke-width=\"1.800\" stroke-linejoin=\"round\"/><polygon transform=\"translate(170 427)\" points=\"-11,-18 11,-18 9,0 -9,0\" fill=\"#F7A8B8\" stroke=\"#5A3E3A\" stroke-width=\"2.200\" stroke-linejoin=\"round\"/>";
  const STAND_SLATE = "<!-- panneau des prix : ardoise fixée sur le comptoir -->\n<rect x=\"84\" y=\"442\" width=\"172\" height=\"34\" rx=\"8\" fill=\"#C9976A\" stroke=\"#5A3E3A\" stroke-width=\"3\"/>\n<rect x=\"90\" y=\"447\" width=\"160\" height=\"24\" rx=\"5\" fill=\"url(#stWood)\" stroke=\"#5A3E3A\" stroke-width=\"2\"/>\n<circle cx=\"87.500\" cy=\"459\" r=\"1.800\" fill=\"#5A3E3A\"/><circle cx=\"252.500\" cy=\"459\" r=\"1.800\" fill=\"#5A3E3A\"/>";
  const STAND_AFTER_SLATE = "<path transform=\"translate(46 459)\" d=\"M0 6 C-10 -4 -3 -13 0 -7 C3 -13 10 -4 0 6 Z\" fill=\"#F0658A\" stroke=\"#5A3E3A\" stroke-width=\"2.200\" stroke-linejoin=\"round\"/>\n<path transform=\"translate(294 459)\" d=\"M0 -9 L2.800 -2.800 L9 -2.200 L4.300 2 L5.700 8.500 L0 5 L-5.700 8.500 L-4.300 2 L-9 -2.200 L-2.800 -2.800 Z\" fill=\"#FFD96B\" stroke=\"#5A3E3A\" stroke-width=\"2.200\" stroke-linejoin=\"round\"/>\n<path transform=\"translate(9 438) rotate(60)\" d=\"M0 0 C3.0 -3.8 8.0 -3.2 10 0 C8.0 3.2 3.0 3.8 0 0 Z\" fill=\"#9ED8B3\" stroke=\"#5A3E3A\" stroke-width=\"1.800\" stroke-linejoin=\"round\"/><path transform=\"translate(331 443) rotate(120)\" d=\"M0 0 C3.0 -3.8 8.0 -3.2 10 0 C8.0 3.2 3.0 3.8 0 0 Z\" fill=\"#7CC59B\" stroke=\"#5A3E3A\" stroke-width=\"1.800\" stroke-linejoin=\"round\"/><path transform=\"translate(9 451) rotate(120)\" d=\"M0 0 C3.0 -3.8 8.0 -3.2 10 0 C8.0 3.2 3.0 3.8 0 0 Z\" fill=\"#9ED8B3\" stroke=\"#5A3E3A\" stroke-width=\"1.800\" stroke-linejoin=\"round\"/><path transform=\"translate(331 456) rotate(60)\" d=\"M0 0 C3.0 -3.8 8.0 -3.2 10 0 C8.0 3.2 3.0 3.8 0 0 Z\" fill=\"#7CC59B\" stroke=\"#5A3E3A\" stroke-width=\"1.800\" stroke-linejoin=\"round\"/><path transform=\"translate(9 464) rotate(60)\" d=\"M0 0 C3.0 -3.8 8.0 -3.2 10 0 C8.0 3.2 3.0 3.8 0 0 Z\" fill=\"#9ED8B3\" stroke=\"#5A3E3A\" stroke-width=\"1.800\" stroke-linejoin=\"round\"/><path transform=\"translate(331 469) rotate(120)\" d=\"M0 0 C3.0 -3.8 8.0 -3.2 10 0 C8.0 3.2 3.0 3.8 0 0 Z\" fill=\"#7CC59B\" stroke=\"#5A3E3A\" stroke-width=\"1.800\" stroke-linejoin=\"round\"/>";
  const STAND_AWNING = "<!-- auvent -->\n<g stroke=\"#5A3E3A\" stroke-width=\"3\" stroke-linejoin=\"round\">\n<path d=\"M6 30 H47 V74 A20.500 20.500 0 0 1 6 74 Z\" fill=\"#F0658A\"/>\n<path d=\"M47 30 H88 V74 A20.500 20.500 0 0 1 47 74 Z\" fill=\"#FFF8EF\"/>\n<path d=\"M88 30 H129 V74 A20.500 20.500 0 0 1 88 74 Z\" fill=\"#F0658A\"/>\n<path d=\"M129 30 H170 V74 A20.500 20.500 0 0 1 129 74 Z\" fill=\"#FFF8EF\"/>\n<path d=\"M170 30 H211 V74 A20.500 20.500 0 0 1 170 74 Z\" fill=\"#F0658A\"/>\n<path d=\"M211 30 H252 V74 A20.500 20.500 0 0 1 211 74 Z\" fill=\"#FFF8EF\"/>\n<path d=\"M252 30 H293 V74 A20.500 20.500 0 0 1 252 74 Z\" fill=\"#F0658A\"/>\n<path d=\"M293 30 H334 V74 A20.500 20.500 0 0 1 293 74 Z\" fill=\"#FFF8EF\"/>\n</g>\n<rect x=\"0\" y=\"20\" width=\"340\" height=\"14\" rx=\"7\" fill=\"#B03A5B\" stroke=\"#5A3E3A\" stroke-width=\"3\"/>";

  // ---------------------------------------------------------------------------
  // Le stand de la boutique (design « Boutique ») : 6 enveloppes par page (2 étagères de 3).
  // Jour normal : les enveloppes du jour ; dimanche : toutes les enveloppes, à parcourir avec les flèches.
  // ---------------------------------------------------------------------------
  const STAND_PER_PAGE = 6;
  const escXml = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let standPage = 0;
  let standAlt = false; // administratrice : voir le visuel de l'autre type de jour (demain, ou le dimanche)

  function standModel() {
    const live = liveEnvelopes().filter((env) => stickersOf(env.id).length);
    const realSunday = allNormalDay();
    const sunday = standAlt ? !realSunday : realSunday;
    let list = live;
    if (!sunday && setting('dailyEnvCount')) {
      const ids = dailyEnvelopeIds(realSunday ? shiftDay(today(), 1) : today(), true);
      list = live.filter((env) => ids.has(env.id));
    }
    // Aperçu du lendemain (administratrice, un dimanche) : les enveloppes prévues demain sont les nouvelles.
    let nNew = live.filter(isNewEnvelope).length;
    if (standAlt && realSunday) {
      const tomorrow = shiftDay(today(), 1);
      const coming = state.envelopes.filter((e) => !e.draft && e.publishAt === tomorrow && stickersOf(e.id).length);
      list = [...coming, ...list.filter((e) => !coming.includes(e))];
      nNew = coming.length;
    }
    // Les nouvelles enveloppes d'abord, puis l'ordre de la boutique.
    const fresh = (e) => (standAlt && realSunday ? e.publishAt === shiftDay(today(), 1) : isNewEnvelope(e));
    list = [...list].sort((a, b) => Number(fresh(b)) - Number(fresh(a)));
    const newIds = new Set(standAlt && realSunday
      ? list.filter((e) => e.publishAt === shiftDay(today(), 1)).map((e) => e.id)
      : live.filter(isNewEnvelope).map((e) => e.id));
    return { list, sunday, realSunday, live, nNew, newIds };
  }

  function standEnvelope(env, i, isNew = false) {
    const col = i % 3, row = Math.floor(i / 3);
    const x = [36.7, 134, 231.3][col], y = [164, 300][row];
    const rot = [-4, 3, -3, 3, -3, 4][i], lrot = [-1.5, 1.2, -1, 1.4, -1.3, 1][i];
    const cx = x + 36, ly = y + 10;
    const body = env.color || ENVELOPE_COLORS[0], flap = shade(body, -0.2), seal = env.seal || DEFAULT_SEAL;
    const name = env.name || 'Enveloppe';
    const shown = name.length > 17 ? name.slice(0, 16) + '…' : name;
    const fit = shown.length > 11 ? ' textLength="82" lengthAdjust="spacingAndGlyphs"' : '';
    return `<g class="st-slot" data-env="${escXml(env.id)}" tabindex="0" role="button" aria-label="${escXml(name)}, ${shopPrice(env)} pièces">`
      + `<g class="st-env"><g transform="translate(${x} ${y}) rotate(${rot} 36 0)"><rect x="0" y="-52" width="72" height="52" rx="7" fill="${body}" stroke="#5A3E3A" stroke-width="2.8"/>`
      + `<path d="M3 -49 L36 -22 L69 -49" fill="${flap}" stroke="#5A3E3A" stroke-width="2.8" stroke-linejoin="round"/>`
      + `<circle cx="36" cy="-22" r="9" fill="${seal}" stroke="#5A3E3A" stroke-width="2.4"/>`
      + `<path transform="translate(36 -22) scale(1.15)" d="M0 -4 L1.2 -1.2 L4 -1 L1.9 0.9 L2.5 3.7 L0 2.2 L-2.5 3.7 L-1.9 0.9 L-4 -1 L-1.2 -1.2 Z" fill="#fff"/>`
      // Étiquette NEW sur l'enveloppe sortie aujourd'hui
      + (isNew ? `<g transform="translate(44 -63) rotate(9 17 9)"><rect x="0" y="0" width="36" height="19" rx="9.5" fill="#F0658A" stroke="#5A3E3A" stroke-width="2.4"/><text x="18" y="14" text-anchor="middle" font-family="Fredoka,sans-serif" font-weight="700" font-size="12" fill="#fff">NEW</text></g>` : '')
      + `</g></g>`
      + `<g transform="rotate(${lrot} ${cx} ${ly})"><path d="M${cx - 28} ${ly} V${ly + 8} M${cx + 28} ${ly} V${ly + 8}" stroke="#5A3E3A" stroke-width="2" stroke-linecap="round"/>`
      + `<circle cx="${cx - 28}" cy="${ly}" r="2.4" fill="#5A3E3A"/><circle cx="${cx + 28}" cy="${ly}" r="2.4" fill="#5A3E3A"/>`
      + `<rect x="${cx - 46}" y="${ly + 8}" width="92" height="25" rx="9" fill="#FFF8EF" stroke="#5A3E3A" stroke-width="2.4"/>`
      + `<text x="${cx}" y="${ly + 25.5}" text-anchor="middle" font-family="Fredoka,sans-serif" font-weight="600" font-size="13.5" fill="#5A3E3A"${fit}>${escXml(shown)}</text></g></g>`;
  }

  function standSvg(pageItems, { nNew, sunday, priceMin, priceMax, newIds }) {
    const slots = pageItems.map((env, i) => standEnvelope(env, i, newIds.has(env.id))).join('');
    const newSign = nNew > 0
      ? STAND_NEW_SIGN.replace('2 nouvelles', `${nNew} nouvelle${nNew > 1 ? 's' : ''}`).replace('>enveloppes<', `>enveloppe${nNew > 1 ? 's' : ''}<`) : '';
    const sunSign = sunday ? STAND_SUN_SIGN : '';
    // Ardoise du prix : un seul prix, ou « 50 et plus » s'il varie.
    const txt = String(priceMin);
    const coinX = 106 + txt.length * 11 + 12;
    const label = 'l\'enveloppe';
    const slate = STAND_SLATE
      + `<text x="106" y="465.5" font-family="Fredoka,sans-serif" font-weight="700" font-size="19" fill="#FFF8EF">${txt}</text>`
      + `<circle cx="${coinX}" cy="459" r="8" fill="#FFC84A" stroke="#FFF8EF" stroke-width="2"/><circle cx="${coinX}" cy="459" r="3.6" fill="none" stroke="#E39A1B" stroke-width="1.8"/>`
      + `<text x="${coinX + 14}" y="464" font-family="Fredoka,sans-serif" font-weight="500" font-size="12.5" fill="#FFF8EF">${label}</text>`;
    return `<svg viewBox="0 0 340 499" width="100%" role="group" aria-label="Le stand de la boutique avec les enveloppes">${STAND_HEAD}${slots}${STAND_IVY}${STAND_COUNTER}${newSign}${sunSign}${STAND_REST}${slate}${STAND_AFTER_SLATE}${STAND_AWNING}</svg>`;
  }

  // Prix affiché sur l'ardoise : le plus courant des enveloppes de la page (le prix de chacune est dans son aperçu).
  function commonPrice(prices) {
    const count = new Map();
    for (const p of prices) count.set(p, (count.get(p) || 0) + 1);
    return [...count.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
  }

  // Dessine la page d'accueil de la boutique (le stand).
  function renderShopChoice() {
    if (!shopV2()) return;
    renderStampCard();
    const { list, sunday, realSunday, live, nNew, newIds } = standModel();
    const pages = Math.max(1, Math.ceil(list.length / STAND_PER_PAGE));
    standPage = Math.min(Math.max(0, standPage), pages - 1);
    const items = list.slice(standPage * STAND_PER_PAGE, (standPage + 1) * STAND_PER_PAGE);
    const prices = items.map(shopPrice);
    $('#standTitle').textContent = sunday ? 'Enveloppes du dimanche' : 'Enveloppes du jour';
    const wrap = $('#standSvg');
    wrap.innerHTML = items.length
      ? standSvg(items, { nNew, sunday, priceMin: commonPrice(prices), priceMax: commonPrice(prices), newIds })
      : '<p class="muted stand-empty">Aucune enveloppe en vente pour l\'instant. Reviens bientôt !</p>';
    $('#standPrev').hidden = standPage <= 0;
    $('#standNext').hidden = standPage >= pages - 1;
    $('#standAll span').textContent = `Voir toutes les enveloppes (${live.length})`;
    // Bouton Décor : « Nouveau », ou le prix en étoiles s'il faut encore le débloquer.
    const pill = $('#standDecoPill');
    if (decorUnlocked()) pill.innerHTML = `<svg width="12" height="12" viewBox="0 0 32 32" aria-hidden="true"><path d="M13 4 L17 14 L27 18 L17 22 L13 32 L9 22 L-1 18 L9 14 Z" transform="translate(3 -3) scale(.85)" fill="#FFD96B" stroke="#fff" stroke-width="2.6" stroke-linejoin="round"/></svg>Nouveau`;
    else pill.innerHTML = `${unlockCost('decor')}<svg width="13" height="13" viewBox="0 0 28 28" aria-hidden="true"><path d="M14 3 L17.5 10.5 L25.5 11.5 L19.5 17 L21.2 25 L14 21 L6.8 25 L8.5 17 L2.5 11.5 L10.5 10.5 Z" fill="#FFD96B" stroke="#fff" stroke-width="2.5" stroke-linejoin="round"/></svg>`;
    const walls = decoList('wall', true).length;
    const floors = decoList('floor', true).length;
    $('#standDeco').setAttribute('aria-label', `Décor : ${plural(walls, 'papier peint')} et ${plural(floors, 'sol')} en vente${decorUnlocked() ? ', nouveau' : `, à débloquer pour ${unlockCost('decor')} étoiles`}`);
    $('#decoRelock').hidden = !(state.isAdmin && decoAsPlayer && state.profile.unlocks && state.profile.unlocks.decor);
    // Administratrice : voir aussi le visuel de l'autre type de jour.
    $('#standPreviewRow').hidden = !state.isAdmin;
    $('#standPreview').checked = standAlt;
    if (state.isAdmin) {
      const tomorrowN = Math.min(STAND_PER_PAGE, dailyEnvelopeIds(shiftDay(today(), 1), true).size);
      $('#standPreviewText').textContent = realSunday
        ? `Voir le visuel de demain (jour normal : ${plural(dailyEnvelopeIds(shiftDay(today(), 1), true).size, 'enveloppe')} du jour, ${tomorrowN} sur la première page)`
        : 'Voir le visuel du dimanche (toutes les enveloppes à prix réduit, avec les flèches)';
    }
  }
  $('#standSvg').addEventListener('click', (e) => {
    const slot = e.target.closest('.st-slot');
    const env = slot && state.envelopes.find((x) => x.id === slot.dataset.env);
    if (env) showEnvelope(env);
  });
  $('#standSvg').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const slot = e.target.closest && e.target.closest('.st-slot');
    const env = slot && state.envelopes.find((x) => x.id === slot.dataset.env);
    if (env) { e.preventDefault(); showEnvelope(env); }
  });
  $('#standPrev').addEventListener('click', () => { standPage--; renderShopChoice(); });
  $('#standNext').addEventListener('click', () => { standPage++; renderShopChoice(); });
  $('#standPreview').addEventListener('change', (e) => { standAlt = e.target.checked; standPage = 0; renderShopChoice(); });
  $('#standAll').addEventListener('click', () => { shopView = 'envelopes'; renderShop(); window.scrollTo(0, 0); });

  function renderShop() {
    applyShopView();
    renderShopChoice();
    renderPoints();
    $('#shopDaily').textContent = `${dailyPoints()} 🪙`;
    renderStampCard();
    const grid = $('#shopGrid');
    grid.innerHTML = '';
    const all = liveEnvelopes().filter((env) => stickersOf(env.id).length);
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
    if (shopV2()) {
      // Liste complète : les dernières sorties en haut (les enveloppes du jour sont déjà au stand).
      const newest = [...all].sort((a, b) => (envSlotDay(b) || '').localeCompare(envSlotDay(a) || '') || (b.created || 0) - (a.created || 0));
      if (themesOn()) {
        // Essai (administratrice) : les enveloppes rangées par thème, les dernières sorties en premier dans chaque thème.
        heading('Toutes les enveloppes', 'Rangées par thème, les dernières sorties en premier.');
        for (const g of groupByTheme(newest)) envs.push({ heading: `🏷️ ${g.theme.name}`, sub: plural(g.envs.length, 'enveloppe') }, ...g.envs);
      } else {
        heading('Toutes les enveloppes', 'Les dernières sorties en premier.');
        envs.push(...newest);
      }
    } else if (others.length) {
      heading('⭐ Les enveloppes du jour', 'Prix réduit aujourd\'hui · elles changent à minuit');
      envs.push(...featured, 'toggle');
      if (shopShowOthers) envs.push(null, ...others);
    } else {
      if (allNormalDay() && featured.length && setting('dailyEnvCount')) heading('☀️ Dimanche : toutes les enveloppes à prix réduit !', 'Profites-en pour compléter ta collection · retour des enveloppes du jour demain');
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
      if (env && env.heading) { heading(env.heading, env.sub); continue; }
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
      if (isNewEnvelope(env)) {
        const tag = document.createElement('span');
        tag.className = 'new-badge';
        tag.textContent = 'NEW';
        tag.title = 'Nouvelle enveloppe du jour';
        card.appendChild(tag);
      }
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
    const envs = onlyEnv ? [onlyEnv] : liveEnvelopes();
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
    atelierThemesMode = false;
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
      draft: true, // préparée à l'avance : les joueurs ne la voient qu'une fois publiée
    };
    // Rangée à la fin (après celles déjà ordonnées).
    if (state.envelopes.some((e) => Number.isFinite(e.order))) env.order = state.envelopes.length;
    state.envelopes.push(env);
    db.putEnvelope(env).catch(() => toast('L\'enveloppe n\'a pas pu être enregistrée.'));
    atelierOpen = env.id;
    renderAtelier();
    toast('Enveloppe créée en brouillon 📝 Les joueurs ne la voient pas : publie-la quand elle est prête (une nouvelle par jour est conseillée).');
  });

  // Publication : brouillon, jour prévu ou en vente. Une seule nouvelle enveloppe par jour.
  async function setEnvelopePublication(env, draft, publishAt) {
    const before = { draft: env.draft, publishAt: env.publishAt };
    if (draft) { env.draft = true; delete env.publishAt; } else { delete env.draft; env.publishAt = publishAt; }
    try { await db.putEnvelope(env); } catch (e) {
      Object.assign(env, before);
      if (before.draft === undefined) delete env.draft;
      if (before.publishAt === undefined) delete env.publishAt;
      toast('Le changement n\'a pas pu être enregistré. Vérifie ta connexion.');
    }
    renderAtelier();
  }
  // Plusieurs enveloppes le même jour : possible, mais on prévient (une nouvelle par jour est conseillée).
  async function confirmSameDay(env, day) {
    const others = state.envelopes.filter((e) => e.id !== env.id && envSlotDay(e) === day);
    if (!others.length) return true;
    const when = day === today() ? 'aujourd\'hui' : `le ${dayLabel(day)}`;
    const names = others.map((e) => `« ${e.name || 'Enveloppe'} »`).join(', ');
    return askConfirm(`⚠️ ${others.length > 1 ? 'Des enveloppes sortent' : 'Une enveloppe sort'} déjà ${when} : ${names}. Les joueurs auront ${others.length + 1} nouvelles enveloppes le même jour, alors qu'on en conseille une seule par jour. Publier quand même ?`, 'Publier quand même');
  }
  function renderPublishBox(box, env) {
    const st = envStatus(env);
    box.innerHTML = '<p class="atelier-publish-info"></p><div class="atelier-publish-actions"></div>';
    const info = box.querySelector('p');
    const actions = box.querySelector('.atelier-publish-actions');
    info.textContent = st === 'draft' ? '📝 Brouillon : les joueurs ne la voient pas. Conseil : une seule nouvelle enveloppe par jour.'
      : st === 'scheduled' ? `📅 Sortira le ${dayLabel(env.publishAt)} : les joueurs ne la voient pas avant.`
        : `✅ En vente${env.publishAt ? ` depuis le ${dayLabel(env.publishAt)}` : ''}.`;
    box.dataset.status = st;
    if (st === 'live') return;
    const btn = (label, cls, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn ' + cls; b.textContent = label; b.addEventListener('click', fn); actions.appendChild(b); return b; };
    const need = () => { if (stickersOf(env.id).length) return true; toast('Cette enveloppe est vide : ajoute-lui des stickers avant de la publier.'); return false; };
    btn('Publier aujourd\'hui', 'btn-primary', async () => {
      if (!need()) return;
      if (!(await confirmSameDay(env, today()))) return;
      setEnvelopePublication(env, false, today());
    });
    btn('📅 Prochain jour libre', '', () => {
      if (!need()) return;
      const day = nextFreeDay(today(), env.id);
      setEnvelopePublication(env, false, day).then(() => toast(`Elle sortira ${day === today() ? 'aujourd\'hui' : 'le ' + dayLabel(day)}.`));
    });
    const date = document.createElement('input');
    date.type = 'date';
    date.className = 'field atelier-publish-date';
    date.min = today();
    date.value = env.publishAt && env.publishAt >= today() ? env.publishAt : '';
    date.setAttribute('aria-label', 'Choisir le jour de sortie');
    date.addEventListener('change', async () => {
      if (!date.value) return;
      if (!need()) { date.value = ''; return; }
      if (!(await confirmSameDay(env, date.value))) { date.value = env.publishAt && env.publishAt >= today() ? env.publishAt : ''; return; }
      setEnvelopePublication(env, false, date.value);
    });
    actions.appendChild(date);
    if (st === 'scheduled') btn('Repasser en brouillon', 'btn-ghost', () => setEnvelopePublication(env, true));
  }

  // Planifie tous les brouillons qui ont des stickers : une enveloppe par jour, à partir du premier jour libre.
  async function planDrafts() {
    const drafts = state.envelopes.filter((e) => e.draft && stickersOf(e.id).length)
      .sort((a, b) => (Number.isFinite(a.order) ? a.order : 1e9) - (Number.isFinite(b.order) ? b.order : 1e9) || (a.created || 0) - (b.created || 0));
    if (!drafts.length) { toast('Aucun brouillon avec des stickers à planifier.'); return; }
    const first = nextFreeDay(today());
    if (!(await askConfirm(`Planifier ${plural(drafts.length, 'brouillon')} : une enveloppe par jour, à partir de ${first === today() ? 'aujourd\'hui' : 'le ' + dayLabel(first)} ? Tu pourras changer chaque jour ensuite.`, 'Planifier'))) return;
    let day = first;
    for (const env of drafts) {
      day = nextFreeDay(day, env.id);
      delete env.draft;
      env.publishAt = day;
      db.putEnvelope(env).catch(() => toast('Une enveloppe n\'a pas pu être enregistrée.'));
      day = shiftDay(day, 1);
    }
    renderAtelier();
    toast(`${plural(drafts.length, 'enveloppe')} planifiée${drafts.length > 1 ? 's' : ''} 📅`);
  }
  $('#atelierPlan').addEventListener('click', planDrafts);

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
      $('#atelierSearch').hidden = atelierReorder || atelierDaily || atelierThemesMode;
      $('#atelierFilter').hidden = atelierReorder || atelierDaily || atelierThemesMode;
      if (!atelierReorder && !atelierDaily && !atelierThemesMode) renderAtelierFilter();
      $('#atelierThemes').textContent = atelierThemesMode ? '✓ Terminé' : '🏷️ Thèmes';
      $('#atelierThemes').classList.toggle('btn-primary', atelierThemesMode);
      $('#atelierThemes').hidden = atelierReorder || atelierDaily;
      $('#atelierOrder').textContent = atelierReorder ? '✓ Terminé' : '↕️ Ordre de la boutique';
      $('#atelierOrder').classList.toggle('btn-primary', atelierReorder);
      $('#atelierOrder').hidden = state.envelopes.length < 2 || atelierDaily;
      $('#atelierDaily').textContent = atelierDaily ? '✓ Terminé' : '⭐ Enveloppes du jour';
      $('#atelierDaily').classList.toggle('btn-primary', atelierDaily);
      $('#atelierDaily').hidden = atelierReorder || atelierThemesMode;
      if (atelierThemesMode) { $('#atelierOrder').hidden = true; renderAtelierThemes(listEl); } else if (atelierReorder) renderAtelierOrder(listEl);
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
            <label class="atelier-field env-theme-field"><span>Thème</span></label>
          </div>
          <button class="btn btn-ghost atelier-del" title="Supprimer l'enveloppe">🗑️</button>
        </div>
        <div class="atelier-publish"></div>
        <p class="atelier-count muted"></p>
        <div class="atelier-grid"></div>
        <div class="atelier-add-row">
          <label class="btn atelier-add">＋ Ajouter des stickers<input type="file" accept="image/*" multiple hidden></label>
          <button type="button" class="btn atelier-unfiled">📥 Stickers à ranger <span class="atelier-unfiled-n"></span></button>
        </div>`;
      sec.querySelector('.atelier-art').appendChild(envelopeArt(env));
      sec.querySelector('.env-theme-field').appendChild(themeSelect(env));
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

      renderPublishBox(sec.querySelector('.atelier-publish'), env);
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
      const nUnfiled = unfiledStickers().length;
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
  // Les décors privés (🔒) ne sont ni en vente ni chez les joueurs : l'administratrice les pose gratuitement.
  const decoList = (kind, forShop = false) => [...state.decos.values()].filter((d) => d.kind === kind && ((!d.adminOnly && d.kind !== 'halfwall' && d.kind !== 'post') || (!forShop && state.isAdmin && !decoAsPlayer))).sort(decoByName);
  // Aperçu à plat : la largeur de la vignette représente 4 carreaux de pièce, donc un motif de « taille 2 »
  // y apparaît deux fois, un motif de « taille 1 » quatre fois (au plus un motif entier si la taille est grande).
  const decoBgSize = (d) => `${Math.min(100, Math.max(8, ((Number(d.size) || 2) / 4) * 100))}% auto`;
  function decoThumb(d) {
    const el = document.createElement('span');
    el.className = 'deco-thumb';
    el.style.backgroundImage = `url("${d.url}")`;
    el.style.backgroundSize = decoBgSize(d);
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
    halfLeftDeco: { kind: 'halfwall', title: 'Demi-mur · côté gauche', other: 'halfRightDeco', otherName: 'côté droit' },
    halfRightDeco: { kind: 'halfwall', title: 'Demi-mur · côté droit', other: 'halfLeftDeco', otherName: 'côté gauche' },
    postDeco: { kind: 'post', title: 'Poteaux du jardin', other: null },
    levelFloorDeco: { kind: 'floor', title: 'Sol à motif · étage (plate-forme)', other: null },
  };
  let decoSlot = 'wallLeftDeco';
  const decoSwatches = [...document.querySelectorAll('.deco-swatch')];
  function syncDecoSwatches() {
    const garden = normShape(state.shape).kind === 'garden';
    const show = state.isAdmin || (shopV2() && decorUnlocked());
    for (const b of decoSwatches) {
      // Jardin : seulement le sol à motif, et côté administratrice pour l'instant.
      const half = b.dataset.deco.startsWith('half') || b.dataset.deco === 'postDeco';
      b.hidden = !show || (garden ? !(state.isAdmin && (half || b.dataset.deco === 'floorDeco')) : half);
      const d = state.decos.get(state.colors[b.dataset.deco] || '');
      b.classList.toggle('empty', !d);
      b.style.backgroundImage = d ? `url("${d.url}")` : '';
      b.textContent = d ? '' : '🖼️';
      b.title = d ? `${d.name} (touche pour changer)` : (b.dataset.deco.endsWith('floorDeco') ? 'Choisir un sol à motif' : half ? 'Choisir un demi-mur' : 'Choisir un papier peint');
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
      p.textContent = slot.kind === 'post' ? 'Aucun poteau pour l\'instant : importe-en dans l\'Atelier décor (les poteaux par défaut restent en place).' : slot.kind === 'halfwall' ? 'Aucun demi-mur pour l\'instant : importe-en dans l\'Atelier décor.' : slot.kind === 'floor' ? 'Aucun sol pour l\'instant : il y en a à la boutique (🎨 Décor).' : 'Aucun papier peint pour l\'instant : il y en a à la boutique (🎨 Décor).';
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
  // Page Décor de la boutique : papiers peints et sols en cartes (maquette « Ma petite pièce – Décor »).
  const DV_ICON = {
    wall: '<svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5 L12 9 V21 L3 17 Z M12 9 L21 5 V17 L12 21 Z" fill="#FFE08A" stroke="#5A3E3A" stroke-width="2.6" stroke-linejoin="round"/></svg>',
    floor: '<svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 6 L21 11 L12 16 L3 11 Z" fill="#C9E8D9" stroke="#5A3E3A" stroke-width="2.6" stroke-linejoin="round"/></svg>',
  };
  const DV_SECTION = {
    wall: { title: 'Papiers peints', tag: 'Mur', bg: '#FFE08A', icon: '<svg width="28" height="28" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5 L12 9 V21 L3 17 Z" fill="#FFF8EF" stroke="#5A3E3A" stroke-width="2" stroke-linejoin="round"/><path d="M12 9 L21 5 V17 L12 21 Z" fill="#F7A8B8" stroke="#5A3E3A" stroke-width="2" stroke-linejoin="round"/></svg>' },
    floor: { title: 'Sols', tag: 'Sol', bg: '#C9E8D9', icon: '<svg width="28" height="28" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 6 L21 11 L12 16 L3 11 Z" fill="#FFF8EF" stroke="#5A3E3A" stroke-width="2" stroke-linejoin="round"/><path d="M3 11 V14 L12 19 L21 14 V11" fill="#DDAB70" stroke="#5A3E3A" stroke-width="2" stroke-linejoin="round"/></svg>' },
  };
  const DV_CHECK = '<svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10.5 L8.5 15 L16 5.5" fill="none" stroke="#5A3E3A" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  let decoShopKind = 'wall'; // onglet affiché : papiers peints ou sols, séparés
  function renderDecoShop() {
    const list = $('#decoShopList');
    list.innerHTML = '';
    const kinds = ['wall', 'floor'].filter((k) => decoList(k, true).length);
    if (kinds.length && !kinds.includes(decoShopKind)) decoShopKind = kinds[0];
    $('#decoTabs').hidden = kinds.length < 2;
    document.querySelectorAll('#decoTabs .dv-tab').forEach((t) => t.classList.toggle('active', t.dataset.kind === decoShopKind));
    if (!kinds.length) { list.innerHTML = '<p class="muted deco-empty">Rien en vente pour l\'instant.</p>'; return; }
    for (const kind of kinds) {
      const meta = DV_SECTION[kind];
      const sec = document.createElement('section');
      sec.className = 'dv-sec';
      sec.id = kind === 'wall' ? 'decoSecWall' : 'decoSecFloor';
      sec.hidden = kind !== decoShopKind;
      sec.innerHTML = `<div class="dv-sec-head"><span class="dv-sec-icon" style="background:${meta.bg}">${meta.icon}</span><h2></h2></div>`;
      sec.querySelector('h2').textContent = meta.title;
      let grid = null, last = null;
      for (const d of decoList(kind, true)) {
        const col = d.collection || 'Sans collection';
        if (col !== last) {
          const pill = document.createElement('div');
          pill.className = 'dv-collection';
          pill.textContent = col;
          sec.appendChild(pill);
          grid = document.createElement('div');
          grid.className = 'dv-grid';
          sec.appendChild(grid);
          last = col;
        }
        const own = decoOwned(d.id);
        const card = document.createElement('div');
        card.className = 'dv-card';
        card.innerHTML = `<div class="dv-preview"><span class="dv-tag">${DV_ICON[kind]}${meta.tag}</span></div><div class="dv-name"></div>`;
        card.querySelector('.dv-preview').style.backgroundImage = `url("${d.url}")`;
        card.querySelector('.dv-preview').style.backgroundSize = decoBgSize(d);
        card.querySelector('.dv-name').textContent = d.name;
        // Tester : un aperçu dans une pièce vide, sans rien acheter ni modifier.
        const test = document.createElement('button');
        test.type = 'button';
        test.className = 'dv-test';
        test.textContent = '👁 Tester';
        test.setAttribute('aria-label', `Voir ${d.name} dans une pièce`);
        test.addEventListener('click', () => openDecoPreview(d));
        card.querySelector('.dv-preview').appendChild(test);
        if (own) {
          const o = document.createElement('div');
          o.className = 'dv-own';
          o.innerHTML = `${DV_CHECK}À toi`;
          card.appendChild(o);
        } else {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'dv-buy';
          b.innerHTML = `${decoPrice(d)}${COIN_SVG(20)}`;
          b.setAttribute('aria-label', `Acheter ${d.name} pour ${decoPrice(d)} pièces`);
          b.addEventListener('click', () => buyDeco(d));
          card.appendChild(b);
        }
        grid.appendChild(card);
      }
      list.appendChild(sec);
    }
  }
  document.querySelectorAll('#decoTabs .dv-tab').forEach((tab) => tab.addEventListener('click', () => {
    decoShopKind = tab.dataset.kind === 'floor' ? 'floor' : 'wall';
    renderDecoShop();
    window.scrollTo(0, 0);
  }));
  // Aperçu d'un papier peint ou d'un sol dans une pièce vide (aucune pièce du joueur n'est touchée).
  function openDecoPreview(d) {
    $('#decoPreviewTitle').textContent = d.name;
    const colors = { ...DEFAULT_COLORS };
    if (d.kind === 'wall') { colors.wallLeftDeco = d.id; colors.wallRightDeco = d.id; } else colors.floorDeco = d.id;
    $('#decoPreviewSvg').innerHTML = roomSvg(colors, null);
    const box = $('#decoPreviewActions');
    box.innerHTML = '';
    if (!decoOwned(d.id)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn btn-primary';
      b.innerHTML = `Acheter · ${decoPrice(d)}${COIN_SVG(18)}`;
      b.addEventListener('click', () => { $('#decoPreview').hidden = true; buyDeco(d); });
      box.appendChild(b);
    }
    $('#decoPreview').hidden = false;
  }
  $('#decoPreviewClose').addEventListener('click', () => { $('#decoPreview').hidden = true; });
  $('#decoPreview').addEventListener('click', (e) => { if (e.target.id === 'decoPreview') $('#decoPreview').hidden = true; });
  async function buyDeco(d) {
    if (decoOwned(d.id)) return;
    if ((state.profile.points || 0) < decoPrice(d)) { toast(`Il te manque ${decoPrice(d) - (state.profile.points || 0)} 🪙.`); return; }
    if (!(await askConfirm(`Acheter « ${d.name} » pour ${decoPrice(d)} 🪙 ?`, 'Acheter'))) return;
    if ((state.profile.points || 0) < decoPrice(d)) return;
    state.profile.points -= decoPrice(d);
    state.profile.decos = { ...(state.profile.decos || {}), [d.id]: true };
    renderPoints();
    saveProfile();
    toast(`« ${d.name} » est à toi ! Tu le trouves dans 🎨 Couleurs, quand tu décores une pièce.`);
    renderDecoShop();
  }
  $('#standDeco').addEventListener('click', async () => {
    if (!decorUnlocked()) {
      await unlock('decor');
      renderShopChoice();
      if (!decorUnlocked()) return;
    }
    shopView = 'deco';
    renderDecoShop();
    applyShopView();
    window.scrollTo(0, 0);
  });
  $('#decoRelock').addEventListener('click', () => { state.profile.unlocks = { ...(state.profile.unlocks || {}), decor: false }; saveProfile(); renderShopChoice(); });
  $('#decoAsPlayer').addEventListener('change', (e) => {
    decoAsPlayer = e.target.checked;
    if (shopView === 'deco' && !decorUnlocked()) shopView = 'choice'; // test joueur : retour à l'écran de choix
    renderShopChoice();
    renderDecoShop();
    applyShopView();
  });

  // Atelier : importer et régler les décors
  // Filtres : type (papiers peints / sols), collection et recherche.
  let decoAdminKind = 'all', decoAdminCol = '', decoAdminQuery = '';
  function renderDecoAdmin() {
    const list = $('#decoAdminList');
    list.innerHTML = '';
    const everything = [...state.decos.values()].sort((a, b) => a.kind.localeCompare(b.kind) || decoByName(a, b));
    const collections = [...new Set(everything.map((d) => d.collection).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'fr'));
    // Compteurs des onglets, liste des collections.
    const counts = { all: everything.length, halfwall: everything.filter((d) => d.kind === 'halfwall').length, post: everything.filter((d) => d.kind === 'post').length, wall: everything.filter((d) => d.kind === 'wall').length, floor: everything.filter((d) => d.kind === 'floor').length };
    document.querySelectorAll('#decoAdminTabs .deco-tab').forEach((t) => {
      t.classList.toggle('active', t.dataset.kind === decoAdminKind);
      t.querySelector('span').textContent = counts[t.dataset.kind];
    });
    if (decoAdminCol && !collections.includes(decoAdminCol)) decoAdminCol = '';
    const colSel = $('#decoAdminCollection');
    colSel.innerHTML = '';
    colSel.add(new Option('Toutes les collections', ''));
    for (const c of collections) colSel.add(new Option(c, c));
    colSel.value = decoAdminCol;
    const q = normalizePseudo(decoAdminQuery);
    const items = everything.filter((d) => (decoAdminKind === 'all' || d.kind === decoAdminKind)
      && (!decoAdminCol || d.collection === decoAdminCol)
      && (!q || normalizePseudo(`${d.name || ''} ${d.collection || ''}`).includes(q)));
    $('#decoAdminEmpty').hidden = items.length > 0;
    $('#decoAdminEmpty').textContent = everything.length ? 'Aucun décor ne correspond à ce filtre.' : 'Aucun décor pour l\'instant : importe tes premiers motifs.';
    for (const d of items) {
      const card = document.createElement('article');
      card.className = 'deco-admin-card';
      card.innerHTML = `
        <div class="deco-preview"></div>
        <div class="deco-admin-fields">
          <label><span>Nom</span><input class="field" data-f="name" maxlength="40"></label>
          <label><span>Type</span><select class="field" data-f="kind"><option value="wall">Papier peint</option><option value="floor">Sol</option><option value="halfwall">Demi-mur (jardin)</option><option value="post">Poteau (jardin)</option></select></label>
          <label><span>Collection</span><input class="field" data-f="collection" maxlength="40" list="decoCollections"></label>
          <label><span>Prix 🪙</span><input class="field" data-f="price" type="number" min="0" step="10"></label>
          <label><span>Taille (carreaux)</span><input class="field" data-f="size" type="number" min="0.5" max="12" step="0.5"></label>
          <label class="deco-private"><input type="checkbox" data-f="adminOnly"><span>🔒 Privé : visible seulement par moi, pas en vente</span></label>
        </div>
        <div class="deco-admin-btns">
          <button class="btn btn-primary deco-admin-test" type="button" title="Voir ce décor dans une pièce, avec des meubles">👁️<span class="label-long">&nbsp;Tester</span></button>
          <button class="btn btn-ghost deco-admin-del" type="button" title="Supprimer ce décor">🗑️</button>
        </div>`;
      card.querySelector('.deco-preview').style.backgroundImage = `url("${d.url}")`;
      card.querySelector('.deco-preview').style.backgroundSize = decoBgSize(d);
      const save = (field, value) => {
        d[field] = value;
        db.updateImage(d.id, { [field]: value }).catch(() => toast('Le réglage n\'a pas pu être enregistré. Vérifie ta connexion.'));
      };
      const f = (name) => card.querySelector(`[data-f="${name}"]`);
      f('name').value = d.name || '';
      f('kind').value = d.kind;
      f('collection').value = d.collection || '';
      // Prix unique pour tous les papiers peints / tous les sols : réglé dans Réglages > Boutique.
      f('price').closest('label').hidden = true;
      f('size').value = d.size || 2;
      f('adminOnly').checked = !!d.adminOnly;
      f('adminOnly').addEventListener('change', () => save('adminOnly', f('adminOnly').checked));
      f('name').addEventListener('change', () => save('name', f('name').value.trim() || 'Décor'));
      f('kind').addEventListener('change', () => save('kind', f('kind').value));
      f('collection').addEventListener('change', () => save('collection', f('collection').value.trim()));
      f('size').addEventListener('change', () => {
        save('size', Math.max(0.5, Math.min(12, Number(f('size').value) || 2)));
        card.querySelector('.deco-preview').style.backgroundSize = decoBgSize(d);
      });
      card.querySelector('.deco-admin-test').addEventListener('click', () => openDecoTest(d));
      card.querySelector('.deco-admin-test').hidden = d.kind === 'post'; // pas d'aperçu pour les poteaux
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
        const rec = { id: uid(), deco: true, kind, name: file.name.replace(/\.[^.]+$/, '').slice(0, 40) || 'Décor', collection: '', price: kind === 'floor' ? 150 : 100, size: 2, data, w, h, created: Date.now(), ...($('#decoImportPrivate').checked ? { adminOnly: true } : {}) };
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
  // Tester un décor dans une pièce avec des meubles, sans quitter l'atelier : la taille se règle ici en direct.
  const decoTest = $('#decoTest');
  let decoTestFor = null, decoTestSeed = 0;
  function renderDecoTest() {
    const d = decoTestFor;
    if (!d) return;
    const half = d.kind === 'halfwall'; // demi-mur : testé dans un jardin
    const wall = d.kind === 'wall' || half;
    $('#decoTestTitle').textContent = `Tester : ${d.name}`;
    $('#decoTestTargetRow').hidden = !wall;
    $('#decoTestTargetRow span').textContent = half ? 'Demi-mur sur' : 'Papier peint sur';
    $('#decoTestSize').textContent = String(d.size || 2);
    $('#decoPadWall').hidden = !wall;
    $('#decoPadFloor').hidden = wall;
    // Décor complémentaire (l'autre type) pour juger l'ensemble.
    const withSel = $('#decoTestWith');
    const prev = withSel.value;
    $('#decoTestWithLabel').textContent = wall ? 'Avec ce sol' : 'Avec ce papier peint';
    withSel.innerHTML = '';
    withSel.add(new Option('Couleur unie', ''));
    for (const o of decoList(wall ? 'floor' : 'wall')) withSel.add(new Option(o.name, o.id));
    withSel.value = [...withSel.options].some((o) => o.value === prev) ? prev : '';
    const colors = { ...DEFAULT_COLORS };
    const target = $('#decoTestTarget').value;
    const other = withSel.value;
    if (wall) {
      if (target !== 'right') colors[half ? 'halfLeftDeco' : 'wallLeftDeco'] = d.id;
      if (target !== 'left') colors[half ? 'halfRightDeco' : 'wallRightDeco'] = d.id;
      if (other) colors.floorDeco = other;
    } else {
      colors.floorDeco = d.id;
      if (other) { colors.wallLeftDeco = other; colors.wallRightDeco = other; }
    }
    // Quelques meubles du jeu posés au sol (tirés au hasard, comme dans une vraie pièce).
    const testShape = half ? { kind: 'garden', w: 8, d: 8, h: 5, levels: [] } : null;
    if (half) Object.assign(colors, GARDEN_COLORS);
    const g = roomGeom(testShape);
    const pool = [...state.images.values()].filter((i) => i.catalog && i.url && i.w && i.h);
    let seed = decoTestSeed * 9301 + 49297;
    const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
    const picks = [];
    while (picks.length < 5 && pool.length) picks.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
    const spots = [[0.3, 0.3], [0.72, 0.3], [0.3, 0.72], [0.72, 0.72], [0.5, 0.52]].slice(0, picks.length);
    const items = picks.map((img, i) => {
      const p = g.P(g.sh.w * spots[i][0], g.sh.d * spots[i][1]);
      const k = Math.min(190 / img.w, 170 / img.h) * Math.max(g.k, 0.6);
      return { img, x: p.x, y: p.y, w: img.w * k, h: img.h * k };
    }).sort((a, b) => a.y - b.y);
    $('#decoTestStage').innerHTML = roomSvg(colors, testShape)
      + items.map((it) => `<image href="${it.img.url}" x="${(it.x - it.w / 2).toFixed(1)}" y="${(it.y - it.h).toFixed(1)}" width="${it.w.toFixed(1)}" height="${it.h.toFixed(1)}" preserveAspectRatio="xMidYMid meet"/>`).join('');
    $('#decoTestShuffle').hidden = !pool.length && picks.length < 2;
  }
  function openDecoTest(d) {
    decoTestFor = d;
    decoTestSeed = 1;
    $('#decoTestTarget').value = 'both';
    $('#decoTestWith').value = '';
    renderDecoTest();
    decoTest.hidden = false;
  }
  function closeDecoTest() {
    decoTest.hidden = true;
    decoTestFor = null;
    renderDecoAdmin(); // la taille a pu changer
  }
  const saveDecoTestSize = (delta) => {
    const d = decoTestFor;
    if (!d) return;
    d.size = Math.max(0.5, Math.min(12, (Number(d.size) || 2) + delta));
    db.updateImage(d.id, { size: d.size }).catch(() => toast('La taille n\'a pas pu être enregistrée. Vérifie ta connexion.'));
    renderDecoTest();
  };
  $('#decoTestSmaller').addEventListener('click', () => saveDecoTestSize(-0.5));
  $('#decoTestBigger').addEventListener('click', () => saveDecoTestSize(0.5));
  // Position du motif : décalage enregistré avec le décor (valable pour toutes les pièces qui l'utilisent).
  let decoMoveSave = 0;
  function moveDecoTest(mx, my) {
    const d = decoTestFor;
    if (!d) return;
    const step = Number($('#decoTestStep').value) || 0.1;
    const wrap = (v) => Math.round((((v % 1) + 1) % 1) * 1000) / 1000;
    d.offX = wrap((Number(d.offX) || 0) + mx * step);
    d.offY = wrap((Number(d.offY) || 0) + my * step);
    renderDecoTest();
    clearTimeout(decoMoveSave);
    decoMoveSave = setTimeout(() => db.updateImage(d.id, { offX: d.offX, offY: d.offY }).catch(() => toast('La position n\'a pas pu être enregistrée. Vérifie ta connexion.')), 400);
  }
  decoTest.querySelectorAll('.deco-pad button').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.reset) {
      const d = decoTestFor;
      if (!d) return;
      d.offX = 0; d.offY = 0;
      renderDecoTest();
      db.updateImage(d.id, { offX: 0, offY: 0 }).catch(() => toast('La position n\'a pas pu être enregistrée.'));
      return;
    }
    moveDecoTest(Number(b.dataset.mx), Number(b.dataset.my));
  }));
  $('#decoTestTarget').addEventListener('change', renderDecoTest);
  $('#decoTestWith').addEventListener('change', renderDecoTest);
  $('#decoTestShuffle').addEventListener('click', () => { decoTestSeed++; renderDecoTest(); });
  $('#decoTestClose').addEventListener('click', closeDecoTest);
  decoTest.addEventListener('click', (e) => { if (e.target === decoTest) closeDecoTest(); });

  function openDecoAtelier() {
    if (!state.isAdmin) return;
    renderDecoAdmin();
    showScreen('decoAdmin');
  }
  $('#homeDecoAtelier').addEventListener('click', openDecoAtelier);
  $('#decoAdminBack').addEventListener('click', goHome);
  document.querySelectorAll('#decoAdminTabs .deco-tab').forEach((t) => t.addEventListener('click', () => {
    decoAdminKind = t.dataset.kind;
    if (decoAdminKind !== 'all') $('#decoImportKind').value = decoAdminKind; // on importe dans l'onglet choisi
    renderDecoAdmin();
  }));
  $('#decoAdminSearch').addEventListener('input', (e) => { decoAdminQuery = e.target.value; renderDecoAdmin(); });
  $('#decoAdminCollection').addEventListener('change', (e) => { decoAdminCol = e.target.value; renderDecoAdmin(); });

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
  let atelierThemesMode = false;
  let dailyDayOffset = 0;
  const shopCount = () => liveEnvelopes().filter((env) => stickersOf(env.id).length).length;
  function renderAtelierDaily(listEl) {
    const n = setting('dailyEnvCount');
    const day = shiftDay(today(), dailyDayOffset);
    const shop = liveEnvelopes().filter((env) => stickersOf(env.id).length);
    const head = document.createElement('div');
    head.className = 'atelier-daily-head';
    // Nombre d'enveloppes du jour mises à disposition (0 = toutes à prix réduit).
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
      head.innerHTML = '<p class="muted">Toutes les enveloppes sont à prix réduit. Ajoute-en avec « ＋ » pour n\'en mettre que quelques-unes à disposition chaque jour.</p>';
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
    if (allNormalDay(day)) head.querySelector('.atelier-daily-info').textContent = `☀️ Ce jour-là est un dimanche : toutes les enveloppes sont à prix réduit, ce choix ne sert pas. ${head.querySelector('.atelier-daily-info').textContent}`;
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
      b.querySelector('.muted').textContent = `${env.price ?? DEFAULT_PRICE} 🪙 · ${plural(content.length, 'sticker')}` + (mine ? ' · choisie par toi' : on ? (envSlotDay(env) === day ? ' · nouvelle : toujours à disposition' : ' · tirée au sort') : '');
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
  $('#atelierThemes').addEventListener('click', () => { atelierThemesMode = !atelierThemesMode; renderAtelier(); });

  // Atelier > Thèmes : créer, renommer, réordonner, supprimer les thèmes, et ranger chaque enveloppe dans un thème.
  async function saveThemes(list, msg) {
    state.settings.envThemes = list;
    await saveSettings(msg);
    renderAtelier();
  }
  function themeSelect(env) {
    const sel = document.createElement('select');
    sel.className = 'field theme-select';
    sel.setAttribute('aria-label', `Thème de ${env.name || 'l\'enveloppe'}`);
    sel.innerHTML = '<option value="">Autres (sans thème)</option>' + envThemes().map((t) => `<option value="${t.id}"></option>`).join('');
    envThemes().forEach((t, i) => { sel.options[i + 1].textContent = t.name; });
    sel.value = themeOfEnv(env) ? env.theme : '';
    sel.addEventListener('change', () => {
      if (sel.value) env.theme = sel.value; else delete env.theme;
      db.putEnvelope(env).then(() => toast(`« ${env.name} » rangée dans ${themeOfEnv(env) ? `« ${themeOfEnv(env).name} »` : '« Autres »'}`))
        .catch(() => toast('L\'enveloppe n\'a pas pu être enregistrée.'));
    });
    return sel;
  }
  function renderAtelierThemes(listEl) {
    const themes = envThemes();
    const help = document.createElement('p');
    help.className = 'muted';
    help.textContent = 'Les thèmes regroupent les collections dans la Collection, le filtre des meubles (dans les pièces) et « Toutes les enveloppes » de la boutique. Pour l\'instant, toi seule vois ce regroupement.';
    listEl.appendChild(help);
    const box = document.createElement('section');
    box.className = 'theme-admin';
    box.innerHTML = '<h3>Mes thèmes</h3><ol class="theme-list"></ol><form class="theme-new"><input class="field" maxlength="40" placeholder="Nom du nouveau thème" aria-label="Nom du nouveau thème"><button class="btn btn-primary" type="submit">＋ Créer</button></form>';
    const ol = box.querySelector('.theme-list');
    themes.forEach((t, i) => {
      const li = document.createElement('li');
      li.className = 'theme-row';
      const n = state.envelopes.filter((e) => e.theme === t.id).length;
      li.innerHTML = `<input class="field theme-name" maxlength="40" aria-label="Nom du thème"><span class="muted theme-n">${plural(n, 'collection')}</span>
        <button type="button" class="btn" data-mv="-1" title="Monter" ${i ? '' : 'disabled'}>▲</button>
        <button type="button" class="btn" data-mv="1" title="Descendre" ${i < themes.length - 1 ? '' : 'disabled'}>▼</button>
        <button type="button" class="btn btn-ghost" data-del title="Supprimer le thème">🗑️</button>`;
      const inp = li.querySelector('.theme-name');
      inp.value = t.name;
      inp.addEventListener('change', () => {
        const name = inp.value.trim();
        if (!name) { inp.value = t.name; return; }
        saveThemes(themes.map((x) => (x.id === t.id ? { ...x, name } : x)), 'Thème renommé ✓');
      });
      li.querySelectorAll('[data-mv]').forEach((b) => b.addEventListener('click', () => {
        const list = [...themes];
        const j = i + Number(b.dataset.mv);
        [list[i], list[j]] = [list[j], list[i]];
        saveThemes(list);
      }));
      li.querySelector('[data-del]').addEventListener('click', async () => {
        if (!(await askConfirm(`Supprimer le thème « ${t.name} » ? ${n ? `Ses ${plural(n, 'collection')} iront dans « Autres » (rien n'est supprimé).` : ''}`, 'Supprimer'))) return;
        for (const env of state.envelopes.filter((e) => e.theme === t.id)) { delete env.theme; db.putEnvelope(env).catch(() => {}); }
        saveThemes(themes.filter((x) => x.id !== t.id), 'Thème supprimé');
      });
      ol.appendChild(li);
    });
    if (!themes.length) ol.insertAdjacentHTML('beforeend', '<li class="muted">Aucun thème pour l\'instant : crée le premier ci-dessous.</li>');
    box.querySelector('.theme-new').addEventListener('submit', (e) => {
      e.preventDefault();
      const name = box.querySelector('.theme-new input').value.trim();
      if (!name) return;
      if (themes.some((t) => normalizeText(t.name) === normalizeText(name))) { toast('Ce thème existe déjà.'); return; }
      saveThemes([...themes, { id: 'th-' + uid(), name }], `Thème « ${name} » créé ✓`);
    });
    listEl.appendChild(box);
    // Ranger les enveloppes : une liste par thème, avec un menu pour changer de thème.
    const sort = document.createElement('section');
    sort.className = 'theme-admin';
    sort.innerHTML = '<h3>Ranger les collections</h3>';
    for (const g of groupByTheme(state.envelopes)) {
      const h = document.createElement('h4');
      h.className = 'theme-group-title';
      h.textContent = `${g.theme.name} · ${g.envs.length}`;
      sort.appendChild(h);
      for (const env of [...g.envs].sort((a, b) => (a.name || '').localeCompare(b.name || '', 'fr'))) {
        const row = document.createElement('div');
        row.className = 'theme-env-row';
        row.innerHTML = '<div class="atelier-tile-art"></div><strong></strong>';
        row.querySelector('.atelier-tile-art').appendChild(envelopeArt(env));
        row.querySelector('strong').textContent = env.name || 'Enveloppe';
        const sel = themeSelect(env);
        sel.addEventListener('change', () => setTimeout(renderAtelier, 50));
        row.appendChild(sel);
        sort.appendChild(row);
      }
    }
    listEl.appendChild(sort);
  }

  // Liste des enveloppes en tuiles (avec recherche par nom d'enveloppe ou de sticker).
  // Filtre de la liste : toutes, brouillons, programmées, en vente.
  let atelierFilterKind = 'all';
  let atelierFilterTheme = null; // null = tous les thèmes, '' = Autres (sans thème), sinon l'id du thème
  function renderAtelierFilter() {
    const box = $('#atelierFilter');
    box.innerHTML = '';
    const count = (k) => state.envelopes.filter((e) => envStatus(e) === k).length;
    for (const [k, label] of [['all', 'Toutes'], ['draft', '📝 Brouillons'], ['scheduled', '📅 Programmées'], ['live', '🛍️ En vente']]) {
      const n = k === 'all' ? state.envelopes.length : count(k);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'deco-tab' + (atelierFilterKind === k ? ' active' : '');
      b.textContent = `${label} (${n})`;
      b.addEventListener('click', () => { atelierFilterKind = k; renderAtelier(); });
      box.appendChild(b);
    }
    // Filtre par thème (menu déroulant : il peut y avoir beaucoup de thèmes).
    if (envThemes().length) {
      if (atelierFilterTheme && !envThemes().some((t) => t.id === atelierFilterTheme)) atelierFilterTheme = null;
      const sel = document.createElement('select');
      sel.className = 'field atelier-theme-filter' + (atelierFilterTheme !== null ? ' active' : '');
      sel.setAttribute('aria-label', 'Filtrer par thème');
      const opts = [['all', `🏷️ Tous les thèmes (${state.envelopes.length})`],
        ...envThemes().map((t) => [t.id, `🏷️ ${t.name} (${state.envelopes.filter((e) => e.theme === t.id).length})`]),
        ['', `🏷️ Autres (${state.envelopes.filter((e) => !themeOfEnv(e)).length})`]];
      for (const [v, label] of opts) { const o = document.createElement('option'); o.value = v; o.textContent = label; sel.appendChild(o); }
      sel.value = atelierFilterTheme === null ? 'all' : atelierFilterTheme;
      sel.addEventListener('change', () => { atelierFilterTheme = sel.value === 'all' ? null : sel.value; renderAtelier(); });
      box.appendChild(sel);
    }
  }
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
    // Les dernières sorties (ou prévues) en haut ; l'ordre de la boutique se règle à part (↕️).
    const dayKey = (e) => envSlotDay(e) || (e.created ? new Date(e.created).toLocaleDateString('fr-CA') : '');
    const newestFirst = [...state.envelopes].sort((a, b) => dayKey(b).localeCompare(dayKey(a)) || (b.created || 0) - (a.created || 0));
    for (const env of newestFirst) {
      const list = stickersOf(env.id);
      const hits = q ? list.filter((img) => normalizeText(img.name).includes(q)) : [];
      if (atelierFilterKind !== 'all' && envStatus(env) !== atelierFilterKind) continue;
      if (atelierFilterTheme !== null && (themeOfEnv(env) ? env.theme : '') !== atelierFilterTheme) continue;
      if (q && !normalizeText(env.name).includes(q) && !hits.length) continue;
      shown++;
      const st = envStatus(env);
      const sub = (st === 'draft' ? '📝 Brouillon · ' : st === 'scheduled' ? `📅 Sort le ${dayLabel(env.publishAt)} · ` : '')
        + (list.length ? plural(list.length, 'sticker') : 'Vide : pas dans la boutique')
        + ` · ${env.price ?? DEFAULT_PRICE} 🪙` + (themeOfEnv(env) ? ` · 🏷️ ${themeOfEnv(env).name}` : '') + (list.length && isDailyEnvelope(env) && setting('dailyEnvCount') ? ' · ⭐ du jour' : '')
        + (hits.length ? ` · contient « ${hits.slice(0, 2).map((h) => h.name).join(' », « ')} »${hits.length > 2 ? '…' : ''}` : '');
      tile(envelopeArt(env), env.name || 'Enveloppe', sub, async () => { atelierOpen = env.id; renderAtelier(); await refreshCoffreCount(); if (atelierOpen === env.id) renderAtelier(); }, (list.length ? '' : 'empty') + (st === 'live' ? '' : ' unpublished'));
    }
    const arch = archivedStickers();
    const archHits = q ? arch.filter((img) => normalizeText(img.name).includes(q)) : arch;
    if (archHits.length && atelierFilterKind === 'all' && atelierFilterTheme === null) {
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
  const collectible = () => [...state.images.values()].filter((img) => liveEnvelopes().some((e) => e.id === img.envelope));

  // Duels restant à voter pour le concours d'hier (mis en valeur sur la tuile du menu).
  let homeVote = { day: null, at: 0, left: 0 };
  function renderContestTile() {
    $('#homeContestTheme').textContent = ctPreLaunch() ? 'Nouveau concours à 5 h !' : themeOf(today());
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

  // Compte à rebours de la grosse mise à jour (jusqu'à minuit, heure de l'appareil, le jour d'ouverture).
  let countdownTimer = 0;
  // Prochaine mise à jour annoncée : la nouvelle boutique, puis le nouveau concours (sans dire ce que c'est).
  const countdownTarget = () => [launchAt(), contestLaunchAt()].find((t) => t > Date.now()) || 0;
  let countdownGoal = 0;
  function renderCountdown() {
    const box = $('#homeCountdown');
    if (!countdownGoal) countdownGoal = countdownTarget();
    const left = countdownGoal - Date.now();
    if (left <= 0) {
      box.hidden = true;
      clearInterval(countdownTimer);
      countdownTimer = 0;
      // Le jour J : on recharge la page d'accueil pour activer la nouvelle boutique tout de suite.
      if (!screens.home.hidden && !box.dataset.done) { box.dataset.done = '1'; setTimeout(() => location.reload(), 1500); }
      return;
    }
    box.hidden = false;
    const s = Math.floor(left / 1000), dd = Math.floor(s / 86400), hh = Math.floor((s % 86400) / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
    const two = (n) => String(n).padStart(2, '0');
    $('#cdTimer').textContent = `${dd ? `${dd} j ` : ''}${two(hh)} h ${two(mm)} min ${two(ss)} s`;
    const sameDay = new Date().toDateString() === new Date(countdownGoal).toDateString();
    const dayWord = sameDay ? 'aujourd\'hui' : (new Date(Date.now() + 86400000).toDateString() === new Date(countdownGoal).toDateString() ? 'demain' : `dans ${dd + 1} jours`);
    $('#cdWhen').textContent = `${dayWord} à ${new Date(countdownGoal).getHours()} h`;
  }
  function startCountdown() {
    clearInterval(countdownTimer);
    countdownTimer = 0;
    $('#homeCountdown').hidden = true;
    countdownGoal = countdownTarget();
    if (!countdownGoal) return;
    renderCountdown();
    countdownTimer = setInterval(() => { if (!screens.home.hidden) renderCountdown(); }, 1000);
  }

  function goHome() {
    startCountdown();
    renderPoints();
    renderContestTile();
    refreshHomeVote();
    if (state.profile) claimContestRewards();
    const all = collectible();
    const got = all.filter((img) => owned(img.id) > 0).length;
    const envs = liveEnvelopes().filter((env) => stickersOf(env.id).length).length;
    const nRooms = realRooms().length;
    // L'administratrice a une seule entrée : « Ma maison » (pièces placées + brouillons).
    $('#homeRooms .card-title').textContent = houseOn() ? 'Ma maison' : 'Mes pièces';
    const placed = houseOn() ? houseEntries().length : 0;
    $('#homeRoomsSub').textContent = !nRooms ? (houseOn() ? 'Crée ta première pièce' : 'Crée ta première pièce')
      : houseOn() ? `${plural(placed, 'pièce')} placée${placed > 1 ? 's' : ''}${nRooms > placed ? ` · ${plural(nRooms - placed, 'brouillon')}` : ''}` : plural(nRooms, 'pièce');
    const stars = state.profile.stars || 0;
    if (stars) $('#homeShopSub').innerHTML = `${STAR_SVG(15)} ${plural(stars, 'étoile')} à utiliser`;
    else $('#homeShopSub').textContent = envs ? `${plural(envs, 'enveloppe')} en vente` : 'Bientôt des enveloppes';
    $('#homeCollectionSub').textContent = all.length ? `${got}/${all.length} stickers obtenus` : 'Classeur vide';
    $('#homeCollectionBar').style.width = all.length ? `${Math.round((got / all.length) * 100)}%` : '0%';
    $('#homeAdmin').hidden = !state.isAdmin;
    const pending = state.myProposals.filter((x) => x.status === 'pending').length;
    $('#homeCreationsSub').textContent = pending ? `${plural(pending, 'proposition')} en attente` : 'Envoie tes dessins';
    renderMailBadge();
    $('#homeCoffre').hidden = !state.isAdmin;
    $('#homePlayers').hidden = !state.isAdmin;
    if (state.isAdmin) { refreshCoffreCount(); refreshNewPlayersDot(); }
    renderMaintTiles();
    showScreen('home');
    if (maintBlocked('all', true)) return;
  }

  function openRooms() {
    if (maintBlocked('rooms')) return;
    if (houseOn()) { openHouse(null, 'home'); return; }
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
  // Pages du classeur : la collection la plus récente d'abord (date de sortie dans la boutique).
  const binderPages = () => liveEnvelopes().filter((env) => stickersOf(env.id).length)
    .sort((a, b) => (envSlotDay(b) || '').localeCompare(envSlotDay(a) || '') || (b.created || 0) - (a.created || 0));
  // Classeur rangé par thème (essai administratrice) : null = tous les thèmes, sinon l'id du thème ('' = Autres).
  let binderTheme = null;
  function themedBinderPages() {
    const all = binderPages();
    if (!themesOn()) return all;
    const groups = groupByTheme(all);
    if (binderTheme !== null && !groups.some((g) => g.theme.id === binderTheme)) binderTheme = null;
    return binderTheme === null ? groups.flatMap((g) => g.envs) : groups.find((g) => g.theme.id === binderTheme).envs;
  }
  function renderBinderThemes() {
    const box = $('#binderThemes');
    box.hidden = !themesOn();
    if (box.hidden) return;
    box.innerHTML = '';
    const chip = (id, label, n) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'binder-theme' + (binderTheme === id ? ' active' : '');
      b.setAttribute('aria-pressed', binderTheme === id);
      b.textContent = `${label} · ${n}`;
      b.addEventListener('click', () => { binderTheme = id; binderPage = 0; renderCollection(); });
      box.appendChild(b);
    };
    const groups = groupByTheme(binderPages());
    chip(null, 'Tous', binderPages().length);
    groups.forEach((g) => chip(g.theme.id, g.theme.name, g.envs.length));
  }

  function openCollection(page) {
    if (maintBlocked('collection')) return;
    if (page !== undefined) binderPage = page;
    renderCollection();
    showScreen('collection');
  }

  function renderCollection() {
    $('#collectionHint').textContent = `Touche un sticker obtenu pour voir sa fiche ou le vendre. Revente : commun ${setting('sell_common')} 🪙, rare ${setting('sell_rare')} 🪙, très rare ${setting('sell_epic')} 🪙.`;
    renderBinderThemes();
    const pages = themedBinderPages();
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
      id: 'n-2026-11-07a', date: Date.UTC(2026, 10, 7, 5, 30), title: 'Signaler un problème 🚩',
      items: [
        'Un objet est mal découpé ou a une erreur ? Dans ⚙️ Paramètres, touche « Signaler un problème », choisis l\'objet et dis-nous ce qui ne va pas.',
        'Tu as rencontré un bug ? Tu peux aussi nous le raconter au même endroit, avec « Un bug ».',
        'Merci : ça nous aide à rendre le jeu plus joli et plus fiable ! 💛',
      ],
    },
    {
      id: 'n-2026-11-04a', date: Date.UTC(2026, 10, 4, 22, 0), title: 'Déplacer un objet : à toi de choisir ✥',
      items: [
        'Dans ⚙️ Paramètres, tu peux choisir de quel côté se trouve la croix ✥ qui déplace un objet sans le cacher avec ton doigt : à gauche ou à droite.',
        'L\'agrandissement de l\'objet passe automatiquement de l\'autre côté.',
      ],
    },
    {
      // Programmée : visible des joueurs à partir de 5 h le 5 novembre (heure de leur appareil), comme l'ouverture du nouveau concours.
      id: 'n-2026-11-05a', date: new Date(2026, 10, 5, 5, 0, 0).getTime(), title: 'Le concours change : une pièce et un thème 🏆',
      items: [
        'La page du Concours a un nouveau look : 3 étapes, Créer, Voter et Résultats, avec les flèches du bas pour passer de l\'une à l\'autre.',
        'Chaque jour, une pièce à décorer (chambre, salon…) avec un thème : un thème, une couleur ou un objet.',
        'Quand le thème est un objet, il est prêté à tous pour la journée : tu peux le poser dans la pièce du concours, même si tu ne l\'as pas.',
      ],
    },
    {
      id: 'n-2026-11-03a', date: Date.UTC(2026, 10, 3, 0, 30), title: 'Nouveau : la lumière 💡',
      items: [
        'Dans ta pièce, le bouton 💡 règle la lumière : de plein jour jusqu\'à la nuit.',
        'Touche un objet puis 💡 pour y ajouter un point lumineux : choisis sa couleur, son intensité et déplace-le où tu veux.',
        'Les objets éclairés restent bien visibles, même quand la pièce est dans le noir. À toi de créer de belles ambiances !',
      ],
    },
    {
      // Programmée : visible des joueurs à partir de 7 h le 2 novembre (heure de leur appareil), comme l'ouverture de la nouvelle boutique.
      id: 'n-2026-11-02a', date: launchAt(), title: 'Grosse mise à jour : la nouvelle boutique ! 🛍️',
      items: [
        'La boutique a un nouveau look : un joli stand avec les enveloppes du jour sur deux étagères. Touche une enveloppe pour voir ce qu\'elle contient, et la flèche pour voir les suivantes.',
        'Nouveau : le Décor 🎨 ! Des papiers peints et des sols pour tes pièces, vendus un par un. Il se débloque avec 2 étoiles 🌟, puis tu les poses dans 🎨 Couleurs quand tu décores une pièce.',
        'Tu peux mettre un papier peint différent sur chaque mur, ou le même sur les deux.',
      ],
    },
    {
      id: 'n-2026-10-29a', date: Date.UTC(2026, 9, 29, 8, 0), title: 'Le dimanche, tout est à prix réduit ☀️',
      items: [
        'Chaque dimanche, toutes les enveloppes de la boutique sont à prix réduit, pas seulement celles du jour.',
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
        'Chaque jour, quelques enveloppes de la boutique sont à prix réduit : ce sont les enveloppes du jour, les mêmes pour tout le monde.',
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
    // Une annonce programmée (date à venir) n'est visible que de l'administratrice, pour la relire avant.
    state.news = [...BUILTIN_NEWS, ...(fromDb || [])].filter((n) => state.isAdmin || !n.date || n.date <= Date.now())
      .sort((a, b) => (b.date || 0) - (a.date || 0));
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
    if (n.date && n.date > Date.now()) el.querySelector('time').textContent += ' · programmée : les joueurs la verront à cette date';
    const ul = el.querySelector('ul');
    for (const it of n.items || []) {
      const li = document.createElement('li');
      li.textContent = it;
      ul.appendChild(li);
    }
    ul.hidden = !(n.items || []).length;
    el.querySelector('.mail-text').textContent = n.text || '';
    el.querySelector('.mail-text').hidden = !n.text;
    // Administratrice : combien de joueurs ont lu cette nouveauté (ceux arrivés après sa sortie ne comptent pas).
    if (withDelete && n.date && n.date <= Date.now()) {
      const info = document.createElement('p');
      info.className = 'news-readers muted';
      if (newsReaders) {
        const eligible = newsReaders.filter((p) => !(p.firstSeen && p.firstSeen > n.date));
        const read = eligible.filter((p) => (p.newsSeen || 0) >= n.date).length;
        info.textContent = eligible.length ? `👁️ ${read} joueur${read > 1 ? 's' : ''} sur ${eligible.length} ${read > 1 ? 'l\'ont' : 'l\'a'} lue` : '👁️ Aucun joueur concerné pour l\'instant';
      } else info.textContent = '👁️ Lecture : chargement…';
      el.appendChild(info);
    }
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

  let newsReaders = null; // joueurs (sans l'administratrice) avec leur dernière nouveauté lue
  function openNews() {
    if (maintBlocked('news')) return;
    renderNews();
    showScreen('news');
    markNewsSeen();
    if (state.isAdmin) {
      db.listPlayers().then((l) => {
        newsReaders = l.filter((p) => !ADMIN_PSEUDOS.includes(String(p.key || '').toLowerCase()));
        if (!screens.news.hidden) renderNews();
      }).catch((e) => { console.warn('Lecteurs des nouveautés indisponibles', e); });
    }
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
  // ---------------------------------------------------------------------------
  // Nouveau concept du concours (test chez l'administratrice) : chaque jour, une PIÈCE tirée au sort
  // + un THÈME qui peut être un objet (prêté à tous ce jour-là), une couleur ou un thème général.
  // ---------------------------------------------------------------------------
  const DEFAULT_CONTEST_ROOMS = ['Chambre', 'Salon', 'Bureau', 'Entrée', 'Salon de thé'];
  const DEFAULT_CONTEST_COLORS = [
    { name: 'Rose', hex: '#e8a0ad' }, { name: 'Vert', hex: '#6a9f58' }, { name: 'Bleu', hex: '#8cc3d8' },
    { name: 'Jaune', hex: '#f0c46c' }, { name: 'Violet', hex: '#ab9bd6' }, { name: 'Orange', hex: '#e8906b' },
    { name: 'Marron', hex: '#8a5d3b' }, { name: 'Blanc', hex: '#fffaf3' }, { name: 'Noir', hex: '#2e2b28' },
  ];
  const FREE_ROOM = 'Comme tu veux'; // « type de pièce » : aucune pièce imposée
  const contestRooms = () => {
    const l = Array.isArray(state.settings.contestRooms) ? state.settings.contestRooms.filter(Boolean) : [];
    return l.length ? l : DEFAULT_CONTEST_ROOMS;
  };
  const contestColors = () => {
    const l = Array.isArray(state.settings.contestColors) ? state.settings.contestColors.filter((c) => c && c.name) : [];
    return l.length ? l : DEFAULT_CONTEST_COLORS;
  };
  // Activé sur le compte de l'administratrice seulement, pour l'instant (case à cocher dans le menu Concours).
  // Nouveau concours (pièce + thème, couleur ou objet) et nouvelle page en 3 étapes : pour tout le monde à partir de
  // 5 h le 5 novembre (heure de l'appareil). Avant, seulement chez l'administratrice. Les jours d'avant gardent leur ancien thème.
  const CONTEST_NEW_FROM = '2026-11-05';
  const CONTEST_NEW_HOUR = 5;
  const contestLaunchAt = () => { const [y, m, d] = CONTEST_NEW_FROM.split('-').map(Number); return new Date(y, m - 1, d, CONTEST_NEW_HOUR, 0, 0).getTime(); };
  const contestLaunched = () => Date.now() >= contestLaunchAt();
  const contestV2 = () => contestLaunched();
  // Entre minuit et l'ouverture (5 h), le concours du 5 novembre est fermé pour les joueurs : le nouveau thème n'est pas encore là.
  const ctPreLaunch = () => !state.isAdmin && !contestLaunched() && today() >= CONTEST_NEW_FROM;
  const v2Day = (day) => contestV2() && (!contestLaunched() || day >= CONTEST_NEW_FROM);
  // Objets que le jeu peut imposer : ceux des enveloppes en vente, avec un vrai nom (pas un simple numéro).
  // Nom présentable d'un objet (certains n'ont qu'un numéro).
  const objectLabel = (i) => (/\p{L}{3}/u.test(i.name || '') && !/^[0-9a-f]{16,}$/i.test(i.name || '') ? i.name : 'Objet sans nom');
  // all = vrai : tous les objets du catalogue (choix à la main) ; sinon seulement ceux tirés au sort automatiquement.
  function contestObjectPool(all = false) {
    if (all) return [...state.images.values()].filter((i) => i.catalog && i.url).sort((a, b) => objectLabel(a).localeCompare(objectLabel(b), 'fr') || a.id.localeCompare(b.id));
    const live = new Set(liveEnvelopes().map((e) => e.id));
    return [...state.images.values()]
      .filter((i) => i.catalog && live.has(i.envelope) && /\p{L}{3}/u.test(i.name || '') && !/^[0-9a-f]{16,}$/i.test(i.name || ''))
      .sort((a, b) => a.id.localeCompare(b.id));
  }
  const planOfBase = (day) => { const w = themeWinners[day]; delete themeWinners[day]; try { return planOf(day); } finally { if (w) themeWinners[day] = w; } };
  function planOf(day) {
    let ov = (state.settings.contestPlanOverrides && state.settings.contestPlanOverrides[day]) || {};
    const { y, m, dd } = parseDay(day);
    const idx = Math.round((Date.UTC(y, m - 1, dd) - Date.UTC(2026, 0, 1)) / 86400000);
    // Idée élue par le vote de la veille (côté administratrice pour l'instant) : elle remplace le tirage, sauf choix manuel.
    // Un thème n'impose pas de pièce ; un objet ou une couleur gardent la pièce tirée.
    const win = themeVoteOn() && !ov.kind && !ov.value ? themeWinners[day] : null;
    if (win) {
      if (win.type === 'theme') return { day, room: ov.room && ov.room !== FREE_ROOM ? ov.room : '', kind: 'general', value: win.label, text: win.label };
      ov = win.type === 'object' ? { ...ov, kind: 'object', objectId: win.imageId } : { ...ov, kind: 'color', value: win.label };
    }
    const rooms = contestRooms();
    let room = ov.room;
    if (!room) {
      // Chaque pièce revient une fois par tour de liste, dans un ordre mélangé.
      const cycle = Math.floor(idx / rooms.length);
      const order = [...rooms].sort((a, b) => seededRank(`${cycle}r${a}`) - seededRank(`${cycle}r${b}`));
      room = order[((idx % rooms.length) + rooms.length) % rooms.length];
    }
    let kind = ov.kind;
    if (!kind) { const k = seededRank(`${day}kind`) % 10; kind = k < 4 ? 'object' : k < 6 ? 'color' : 'general'; }
    if (ov.room === FREE_ROOM || room === FREE_ROOM) room = ''; // « Comme tu veux » : rien n'est écrit pour les joueurs
    const plan = { day, room, kind };
    if (kind === 'object') {
      let img = ov.objectId && state.images.get(ov.objectId);
      if (!img) { const pool = contestObjectPool(); img = pool.length ? pool[seededRank(`${day}obj`) % pool.length] : null; }
      if (img) { plan.objectId = img.id; plan.objectName = objectLabel(img); plan.text = `objet : ${plan.objectName}`; return plan; }
      plan.kind = kind = 'general'; // aucun objet possible : on retombe sur un thème général
    }
    if (kind === 'color') {
      const colors = contestColors();
      const c = colors.find((x) => x.name === ov.value) || colors[seededRank(`${day}col`) % colors.length];
      plan.colorName = c.name; plan.colorHex = c.hex; plan.text = `couleur : ${c.name}`;
      return plan;
    }
    plan.value = ov.value && contestThemes().includes(ov.value) ? ov.value : autoThemeOf(day);
    plan.text = plan.value;
    plan.room = ov.room && ov.room !== FREE_ROOM ? ov.room : ''; // un thème général suffit, sauf si une pièce est imposée à la main
    return plan;
  }
  // Objet prêté à tous aujourd'hui, dans la pièce du concours seulement : en plus de ceux qu'on possède.
  let roomScreenActive = false; // vrai pendant qu'une pièce est ouverte (pas dans la collection, la boutique…)
  // Appelée très souvent (pour chaque sticker de la liste) : on garde le résultat tant que rien n'a changé.
  let lentCache = { key: '', val: null };
  function lentId() {
    if (!v2Day(today()) || !roomScreenActive) return null;
    const r = currentRoom();
    if (!r || !r.contestDay || r.contestDay !== today()) return null;
    const day = today();
    const key = `${r.id}|${day}|${JSON.stringify((state.settings.contestPlanOverrides || {})[day] || {})}|${state.images.size}|${liveEnvelopes().length}`;
    if (lentCache.key !== key) {
      const p = planOf(day);
      lentCache = { key, val: p.kind === 'object' ? p.objectId : null };
    }
    return lentCache.val;
  }
  // Essai (administratrice) : cartouche du thème en haut de la pièce du concours (pièce imposée, thème, objet ou couleur).
  function renderContestTheme(r) {
    const box = $('#contestTheme');
    const on = !!(r && r.contestDay && state.isAdmin);
    box.hidden = !on;
    $('#contestBanner').classList.toggle('admin-off', on); // le bandeau du bas fait doublon
    if (!on) return;
    const day = r.contestDay;
    box.innerHTML = '<span class="ct-kicker"></span><strong class="ct-main"></strong><span class="ct-sub"></span>';
    let main, sub = '', extra = null;
    if (!v2Day(day)) main = themeOf(day);
    else {
      const p = planOf(day);
      if (p.kind === 'object') {
        main = p.objectName;
        sub = 'Objet à placer';
        const img = state.images.get(p.objectId);
        if (img) { extra = document.createElement('img'); extra.className = 'ct-obj'; extra.alt = ''; smallUrl(img, (u) => { extra.src = u; }); }
      } else if (p.kind === 'color') {
        main = p.colorName;
        sub = 'Couleur';
        extra = document.createElement('span'); extra.className = 'ct-swatch'; extra.style.background = p.colorHex;
      } else main = p.value || p.text;
      if (p.room) sub = `${p.room}${sub ? ` · ${sub}` : ''}`;
    }
    box.querySelector('.ct-kicker').textContent = day === today() ? 'Concours' : `Concours du ${dayLabel(day)}`;
    box.querySelector('.ct-main').textContent = main;
    box.querySelector('.ct-sub').textContent = sub;
    box.querySelector('.ct-sub').hidden = !sub;
    if (extra) box.prepend(extra);
    box.classList.toggle('has-extra', !!extra);
  }
  function contestBannerText(day) {
    if (!v2Day(day)) return `Pièce du concours · thème « ${themeOf(day)} » · tous tes stickers sont disponibles ici`;
    const p = planOf(day);
    return `Pièce du concours · ${p.room ? `${p.room} · ` : ''}${p.text}${p.kind === 'object' ? ' (prêté à tous aujourd\'hui)' : ''}`;
  }

  // Thème choisi à la main par l'administratrice pour ce jour (sinon la rotation de la liste).
  function themeOf(day) {
    if (v2Day(day)) { const p = planOf(day); return p.room ? `${p.room} · ${p.text}` : p.text; }
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

  // Lectures du concours : chaque jour contient des centaines de petits documents (participations + duels).
  // Un concours terminé (après 20 h le lendemain) ne change plus : on le garde sur l'appareil et on ne le relit plus.
  // Un concours en cours est gardé 3 minutes en mémoire (rouvrir la page ne relit pas tout).
  const contestMem = new Map(); // jour -> { docs, at }
  const CONTEST_TTL = 3 * 60000;
  let contestStore = null;
  if ('caches' in window) caches.open('mpp-contest-v1').then((c) => { contestStore = c; }).catch(() => {});
  const contestFinal = (day) => Date.now() > voteEnd(day) + 10 * 60000;
  const contestTouched = () => { // après un vote, une publication ou un retrait
    for (const day of contestMem.keys()) if (!contestFinal(day) && contestStore) contestStore.delete(`/concours/${day}`).catch(() => {});
    contestMem.clear();
  };
  async function contestDocs(day, fresh = false) {
    const final = contestFinal(day);
    const m = contestMem.get(day);
    if (m && !fresh && (final || Date.now() - m.at < CONTEST_TTL)) return m.docs;
    const key = `/concours/${day}`;
    // Copie de l'appareil : définitive pour un concours terminé, 3 minutes sinon (même après un redémarrage du jeu).
    if (!fresh && contestStore && db === cloudDb && !state.isAdmin) {
      try {
        const res = await contestStore.match(key);
        if (res) {
          const saved = await res.json();
          const docs = Array.isArray(saved) ? saved : saved.docs;
          const at = Array.isArray(saved) ? Date.now() : saved.at;
          if (final || Date.now() - at < CONTEST_TTL) { contestMem.set(day, { docs, at }); return docs; }
        }
      } catch (e) { /* copie illisible : on relit */ }
    }
    const docs = await db.listContest(day);
    const at = Date.now();
    contestMem.set(day, { docs, at });
    if (contestStore && db === cloudDb) contestStore.put(key, new Response(JSON.stringify({ at, docs }))).catch(() => {});
    return docs;
  }
  async function loadContestDay(day, fresh = false) {
    const docs = await contestDocs(day, fresh);
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
    // Place au classement (égalités partagées : 1, 1, 3…) ; 0 = pas classé (pas de vote, ou aucun duel disputé).
    const place = (o) => {
      if (!winners.length || solo) return 0;
      if (winners.includes(o)) return 1;
      if (!seen[o]) return 0;
      return 1 + entries.filter((e) => rate(e.owner) > rate(o)).length;
    };
    return { day, entries, duels, votes, wins, seen, rate, winners, solo, place };
  }
  const rewardOf = (res) => (res.solo ? soloReward() : contestReward());
  // Récompenses du 2e et du 3e : à partir du concours du 13 novembre 2026 (résultats le 14 à 20 h).
  const PODIUM_REWARDS_FROM = '2026-11-13';
  const podiumReward = (day, place) => (day < PODIUM_REWARDS_FROM ? 0 : place === 2 ? setting('contestReward2') : place === 3 ? setting('contestReward3') : 0);

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
    const podium = []; // 2e et 3e places récompensées
    try {
      for (let d = from; d <= last; d = shiftDay(d, 1)) {
        const res = await loadContestDay(d);
        if (res.winners.includes(state.player.key)) wins.push({ day: d, res });
        else {
          const place = res.place(state.player.key);
          if (podiumReward(d, place) > 0) podium.push({ day: d, res, place });
        }
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
      for (const { day, res, place } of podium) {
        const id = `contest-podium-${day}-${me}`;
        if (state.mails.some((m) => m.id === id)) continue;
        const reward = podiumReward(day, place);
        const entry = res.entries.find((e) => e.owner === me);
        const room = entry && entry.roomName ? ` « ${entry.roomName} »` : '';
        const when = dateFmt.format(new Date(`${day}T12:00:00`)).replace(/ à .*/, '');
        const medal = place === 2 ? '🥈' : '🥉';
        const score = res.seen[me] ? ` Elle a gagné ${res.wins[me] || 0} duel${(res.wins[me] || 0) > 1 ? 's' : ''} sur ${res.seen[me]} (${Math.round(res.rate(me) * 100)} %).` : '';
        const m = {
          id, to: me, title: `${medal} Tu es ${place}e du concours « ${themeOf(day)} » !`,
          text: `Bravo ! Ta pièce${room} est arrivée ${place}e au concours du ${when}, sur le thème « ${themeOf(day)} ».${score}\n\nVoici ta récompense : ${reward} 🪙.`,
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
    } else if (podium.length) {
      renderMailBadge();
      const p0 = podium[0];
      setTimeout(() => toast(`${p0.place === 2 ? '🥈' : '🥉'} Tu es ${p0.place}e du concours « ${themeOf(p0.day)} » ! Ta récompense t'attend dans ta boîte aux lettres 💌`), 1500);
    }
    saveProfile();
  }

  let contestData = { today: null, vote: null, results: null };
  async function openContest() {
    crumb('ouverture du concours');
    cv3Sub = null;
    if (maintBlocked('contest')) return;
    showScreen('contest');
    renderPoints();
    $('#ctBody').innerHTML = '<p class="muted">Chargement…</p>';
    try {
      const [t, v, r] = await Promise.all([
        loadContestDay(today()), loadContestDay(shiftDay(today(), -1)), loadContestDay(lastRevealedDay()),
      ]);
      contestData = { today: t, vote: v, results: r };
      crumb(`concours chargé : ${t.entries.length}/${v.entries.length}/${r.entries.length} participations, ${v.duels.length} duels`);
      setTimeout(() => crumb(`concours affiché ${memSnapshot()}`), 1500);
      claimContestRewards();
    } catch (e) {
      console.warn('Concours indisponible', e);
      $('#ctBody').innerHTML = '<p class="muted">Impossible de charger le concours. Vérifie ta connexion.</p>';
      return;
    }
    try {
      renderContest();
    } catch (e) {
      console.error('Concours', e);
      $('#ctBody').innerHTML = `<p class="muted">Le concours n'a pas pu s'afficher (${cvEsc(String(e && e.message || e).slice(0, 120))}). Recharge la page ; si ça continue, envoie cette phrase à l'administratrice.</p>`;
    }
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
        contestTouched();
        if (!screens.adminContest.hidden) refreshAdminContest(); else openContest();
      });
      card.querySelector('.ct-actions').appendChild(del);
    }
    return card;
  }

  // Carte « Pièce du jour + thème du jour » (nouveau concept) : le thème peut être un objet prêté, une couleur ou un thème.
  function planCardEl(day) {
    const p = planOf(day);
    const el = document.createElement('div');
    el.className = 'ct-plan';
    el.innerHTML = '<div class="ct-plan-row"><span class="ct-plan-k">Pièce</span><strong class="ct-plan-room"></strong></div><div class="ct-plan-row"><span class="ct-plan-k">Thème</span><span class="ct-plan-theme"></span></div><p class="muted ct-small-text ct-plan-note" hidden></p>';
    el.querySelector('.ct-plan-room').textContent = p.room;
    if (!p.room) el.querySelector('.ct-plan-row').hidden = true;
    const th = el.querySelector('.ct-plan-theme');
    const note = el.querySelector('.ct-plan-note');
    if (p.kind === 'object') {
      const img = state.images.get(p.objectId);
      th.innerHTML = '<img class="ct-plan-img" alt=""><strong></strong>';
      if (img) th.querySelector('img').src = img.url;
      th.querySelector('strong').textContent = p.objectName;
      note.hidden = false;
      note.textContent = 'Cet objet est prêté à tous les joueurs, aujourd\'hui seulement, dans la pièce du concours : pose-le même si tu ne l\'as pas. Si tu l\'as déjà, tu peux poser celui-ci en plus des tiens.';
    } else if (p.kind === 'color') {
      th.innerHTML = '<span class="ct-plan-swatch"></span><strong></strong>';
      th.querySelector('.ct-plan-swatch').style.background = p.colorHex;
      th.querySelector('strong').textContent = `Couleur : ${p.colorName}`;
    } else {
      th.innerHTML = '<strong></strong>';
      th.querySelector('strong').textContent = p.value;
    }
    return el;
  }

  // ---------------------------------------------------------------------------
  // Nouveau design du concours (côté administratrice) : 3 pages — Créer, Voter, Résultats —
  // avec les flèches rondes en bas. Le thème peut être une pièce + un thème / une couleur / un objet.
  // ---------------------------------------------------------------------------
  const cv3On = () => state.isAdmin || contestLaunched();
  let cv3Step = 0;
  const CV_INK = '#5A3E3A';
  // Apparence Manoir : ciel étoilé avec une pièce-bibliothèque, pinceau magique (maquette « Mon manoir enchanté »).
  const CV_MANOIR = {
    hero: `<svg style="position:absolute;inset:0" width="100%" height="100%" viewBox="0 0 330 104" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><circle cx="8" cy="15" r="1.8" fill="#FFF6D6" opacity="0.57"/><circle cx="18" cy="99" r="1.0" fill="#FFF6D6" opacity="0.86"/><circle cx="49" cy="102" r="0.8" fill="#FFF6D6" opacity="0.83"/><circle cx="48" cy="58" r="1.8" fill="#FFF6D6" opacity="0.76"/><circle cx="70" cy="63" r="0.8" fill="#FFF6D6" opacity="0.51"/><circle cx="307" cy="44" r="1.0" fill="#FFF6D6" opacity="0.60"/><circle cx="130" cy="64" r="1.0" fill="#FFF6D6" opacity="0.61"/><circle cx="74" cy="62" r="0.8" fill="#FFF6D6" opacity="0.98"/><circle cx="274" cy="40" r="1.0" fill="#FFF6D6" opacity="0.57"/><circle cx="260" cy="42" r="0.8" fill="#FFF6D6" opacity="0.87"/><circle cx="284" cy="69" r="1.0" fill="#FFF6D6" opacity="0.60"/><circle cx="143" cy="41" r="1.3" fill="#FFF6D6" opacity="0.82"/><circle cx="75" cy="8" r="1.3" fill="#FFF6D6" opacity="0.65"/><circle cx="188" cy="52" r="1.3" fill="#FFF6D6" opacity="0.98"/><circle cx="318" cy="103" r="1.3" fill="#FFF6D6" opacity="0.95"/><circle cx="184" cy="98" r="1.3" fill="#FFF6D6" opacity="0.55"/><circle cx="66" cy="96" r="1.3" fill="#FFF6D6" opacity="0.85"/><circle cx="35" cy="44" r="1.3" fill="#FFF6D6" opacity="0.82"/><circle cx="323" cy="24" r="1.8" fill="#FFF6D6" opacity="0.60"/><circle cx="112" cy="44" r="0.8" fill="#FFF6D6" opacity="0.78"/><circle cx="42" cy="14" r="0.8" fill="#FFF6D6" opacity="0.98"/><circle cx="69" cy="20" r="1.0" fill="#FFF6D6" opacity="0.74"/><path d="M40 21 Q41.35 28.65 49 30 Q41.35 31.35 40 39 Q38.65 31.35 31 30 Q38.65 28.65 40 21Z" fill="#F4D58A"/><path d="M290 15 Q291.65 24.35 301 26 Q291.65 27.65 290 37 Q288.35 27.65 279 26 Q288.35 24.35 290 15Z" fill="#FFFFFF"/><path d="M262 71 Q263.05 76.95 269 78 Q263.05 79.05 262 85 Q260.95 79.05 255 78 Q260.95 76.95 262 71Z" fill="#F4D58A"/><path d="M66 70 Q66.9 75.1 72 76 Q66.9 76.9 66 82 Q65.1 76.9 60 76 Q65.1 75.1 66 70Z" fill="#FFFFFF"/></svg><div class="mn-hero-room"><svg viewBox="0 0 240 200" width="118" height="98" aria-hidden="true" style="display:block"><defs><linearGradient id="rbN" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0E1438"/><stop offset="1" stop-color="#37478A"/></linearGradient><radialGradient id="rbG"><stop offset="0" stop-color="#FFD76A" stop-opacity=".8"/><stop offset="1" stop-color="#FFD76A" stop-opacity="0"/></radialGradient></defs><ellipse cx="120" cy="178" rx="96" ry="13" fill="#000" opacity=".3"/><polygon points="40,120 120,80 120,10 40,50" fill="#5E3178" stroke="#1B0F14" stroke-width="3" stroke-linejoin="round"/><polygon points="120,80 200,120 200,50 120,10" fill="#7A2F3F" stroke="#1B0F14" stroke-width="3" stroke-linejoin="round"/><polygon points="120,80 200,120 120,160 40,120" fill="#8A5A3A" stroke="#1B0F14" stroke-width="3" stroke-linejoin="round"/><polygon points="40,120 120,160 120,172 40,132" fill="#5E3A22" stroke="#1B0F14" stroke-width="3" stroke-linejoin="round"/><polygon points="120,160 200,120 200,132 120,172" fill="#4A2D1A" stroke="#1B0F14" stroke-width="3" stroke-linejoin="round"/><g transform="translate(40 50) skewY(-26.57)"><rect x="4" y="4" width="70" height="58" fill="#35201A" stroke="#1B0F14" stroke-width="2.4"/><rect x="8.0" y="16.0" width="9.7" height="40.0" rx="1.5" fill="#B5543A" stroke="#1B0F14" stroke-width="1.4"/><rect x="8.0" y="23.2" width="9.7" height="2" fill="#E6B85C" opacity=".9"/><rect x="8.0" y="44.0" width="9.7" height="2" fill="#E6B85C" opacity=".9"/><rect x="18.3" y="17.0" width="14.4" height="39.0" rx="1.5" fill="#2F5D62" stroke="#1B0F14" stroke-width="1.4"/><rect x="18.3" y="24.0" width="14.4" height="2" fill="#E6B85C" opacity=".9"/><rect x="18.3" y="44.3" width="14.4" height="2" fill="#E6B85C" opacity=".9"/><rect x="33.3" y="11.1" width="12.2" height="44.9" rx="1.5" fill="#6E2F4A" stroke="#1B0F14" stroke-width="1.4"/><rect x="33.3" y="19.2" width="12.2" height="2" fill="#E6B85C" opacity=".9"/><rect x="33.3" y="42.5" width="12.2" height="2" fill="#E6B85C" opacity=".9"/><rect x="46.1" y="20.2" width="9.8" height="35.8" rx="1.5" fill="#6E2F4A" stroke="#1B0F14" stroke-width="1.4"/><rect x="46.1" y="26.7" width="9.8" height="2" fill="#E6B85C" opacity=".9"/><rect x="46.1" y="45.3" width="9.8" height="2" fill="#E6B85C" opacity=".9"/><rect x="56.5" y="16.0" width="11.8" height="40.0" rx="1.5" fill="#E8D5A8" stroke="#1B0F14" stroke-width="1.4"/><rect x="56.5" y="23.2" width="11.8" height="2" fill="#E6B85C" opacity=".9"/><rect x="56.5" y="44.0" width="11.8" height="2" fill="#E6B85C" opacity=".9"/><rect x="4" y="30" width="70" height="4" fill="#6B4630" stroke="#1B0F14" stroke-width="1.600"/></g><g transform="translate(120 10) skewY(26.57)"><path d="M18 58 V32 Q18 14 40 14 Q62 14 62 32 V58Z" fill="url(#rbN)" stroke="#E6B85C" stroke-width="3.200" stroke-linejoin="round"/><g transform="translate(18 14)"><circle cx="13" cy="9" r="1.8" fill="#FFF6D6" opacity="0.74"/><circle cx="8" cy="5" r="1.3" fill="#FFF6D6" opacity="0.90"/><circle cx="35" cy="14" r="1.3" fill="#FFF6D6" opacity="0.64"/><circle cx="11" cy="9" r="1.0" fill="#FFF6D6" opacity="0.97"/><circle cx="5" cy="33" r="1.3" fill="#FFF6D6" opacity="0.90"/><circle cx="12" cy="18" r="1.3" fill="#FFF6D6" opacity="0.54"/><circle cx="28" cy="35" r="1.0" fill="#FFF6D6" opacity="0.59"/><circle cx="23" cy="8" r="1.3" fill="#FFF6D6" opacity="0.50"/><circle cx="16" cy="36" r="1.3" fill="#FFF6D6" opacity="0.92"/><circle cx="24" cy="23" r="1.3" fill="#FFF6D6" opacity="0.72"/></g><circle cx="48" cy="28" r="7" fill="#FFF0B8"/><circle cx="51" cy="26" r="6" fill="#0E1438"/><path d="M40 14 V58 M18 38 H62" stroke="#E6B85C" stroke-width="2"/></g><polygon points="120,98 154,115 120,132 86,115" fill="#6E2F4A" stroke="#E6B85C" stroke-width="2.600" stroke-linejoin="round"/><polygon points="120,106 138,115 120,124 102,115" fill="none" stroke="#E6B85C" stroke-width="1.400"/><circle cx="150" cy="112" r="18" fill="url(#rbG)"/><rect x="145" y="108" width="9" height="14" rx="2" fill="#FBEFD2" stroke="#1B0F14" stroke-width="2"/><path d="M149.500 98 Q154 105 149.500 108 Q145 105 149.500 98Z" fill="#FFC94D" stroke="#B5543A" stroke-width="1.200"/><g transform="translate(66 122)"><path d="M-9 0 H9 L7 12 H-7Z" fill="#B5543A" stroke="#1B0F14" stroke-width="2.200" stroke-linejoin="round"/><path d="M0 0 C-14 -4 -16 -18 -4 -22 C-4 -12 0 -8 0 0 M0 0 C14 -4 16 -18 4 -22 C4 -12 0 -8 0 0" fill="#6FCF97" stroke="#1B0F14" stroke-width="2.200" stroke-linejoin="round"/></g><path d="M100 52 Q101.2 58.8 108 60 Q101.2 61.2 100 68 Q98.8 61.2 92 60 Q98.8 58.8 100 52Z" fill="#FFE08A"/><path d="M176 24 Q176.9 29.1 182 30 Q176.9 30.9 176 36 Q175.1 30.9 170 30 Q175.1 29.1 176 24Z" fill="#FFFFFF"/><path d="M58 19 Q58.75 23.25 63 24 Q58.75 24.75 58 29 Q57.25 24.75 53 24 Q57.25 23.25 58 19Z" fill="#FFE08A"/></svg></div>`,
    palette: `<svg width="30" height="30" viewBox="0 0 32 32" aria-hidden="true"><path d="M5 27 L21 11" fill="none" stroke="#1B0F14" stroke-width="5" stroke-linecap="round"/><path d="M5 27 L21 11" fill="none" stroke="#8A5A3A" stroke-width="2.200" stroke-linecap="round"/><path d="M23 3 Q23.800 8 29 9 Q23.800 10 23 15 Q22.200 10 17 9 Q22.200 8 23 3Z" fill="#FFE08A" stroke="#1B0F14" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/></svg>`,
  };
  const manoirOn = () => document.documentElement.dataset.skin === 'manoir';
  const CV_ICON = {
    swords: `<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3 L16 16 M21 3 L8 16 M12 19 L19 12 M12 19 L5 12 M16 16 L21 21 M8 16 L3 21" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" fill="none"/></svg>`,
    clock: `<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.6"/><path d="M12 7 V12 L15.5 14" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>`,
    trophy: `<svg width="30" height="30" viewBox="0 0 32 32" aria-hidden="true"><path d="M9 4 H23 V13 A7 7 0 0 1 9 13 Z" fill="#FFC84A" stroke="#5A3E3A" stroke-width="2.4" stroke-linejoin="round"/><path d="M9 7 H4 V10 A5 5 0 0 0 9 15 M23 7 H28 V10 A5 5 0 0 1 23 15" fill="none" stroke="#5A3E3A" stroke-width="2.4"/><rect x="13" y="20" width="6" height="5" fill="#FFC84A" stroke="#5A3E3A" stroke-width="2.4"/><rect x="9" y="25" width="14" height="4" rx="1.5" fill="#B08AD8" stroke="#5A3E3A" stroke-width="2.4"/></svg>`,
    left: `<svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5 L8 12 L15 19" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    right: `<svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5 L16 12 L9 19" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    chev: `<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5 L16 12 L9 19" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    palette: `<svg width="30" height="30" viewBox="0 0 32 32" aria-hidden="true"><path d="M16 4 C8 4 3 9 3 15 C3 22 9 27 15 27 C18 27 18 24 16.500 22.500 C15 21 16 19 18 19 H23 C26 19 29 17 29 14 C29 8 23 4 16 4 Z" fill="#FFF8EF" stroke="#5A3E3A" stroke-width="2.4" stroke-linejoin="round"/><circle cx="10" cy="13" r="2.4" fill="#E8527C"/><circle cx="16" cy="9.500" r="2.400" fill="#FFC84A"/><circle cx="22" cy="12" r="2.400" fill="#5FB27F"/><circle cx="10" cy="20" r="2.400" fill="#6FB5E0"/></svg>`,
    scroll: `<svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4 H18 V17 A3 3 0 0 1 15 20 H6 A3 3 0 0 0 9 17 V6 A2 2 0 0 0 7 4 Z" fill="#FFE08A" stroke="#5A3E3A" stroke-width="2.200" stroke-linejoin="round"/><path d="M12 9 H15 M12 13 H15" stroke="#5A3E3A" stroke-width="2" stroke-linecap="round"/></svg>`,
    hero: `<svg viewBox="0 0 160 110" width="150" aria-hidden="true"><ellipse cx="80" cy="100" rx="58" ry="7" fill="#5A3E3A" opacity=".13"/><path d="M80 12 L134 38 V66 L80 92 L26 66 V38 Z" fill="#CDE8F4" stroke="#5A3E3A" stroke-width="3" stroke-linejoin="round"/><path d="M80 12 V64 L26 38 M80 64 L134 38" fill="none" stroke="#5A3E3A" stroke-width="3" stroke-linejoin="round"/><path d="M26 66 L80 92 L134 66 L80 40 Z" fill="#E1AE6C" stroke="#5A3E3A" stroke-width="3" stroke-linejoin="round"/><path d="M62 62 L80 52 L98 62 L80 72 Z" fill="#6FB5E0" stroke="#5A3E3A" stroke-width="2.400" stroke-linejoin="round"/><rect x="38" y="44" width="16" height="14" rx="3" fill="#E8906B" stroke="#5A3E3A" stroke-width="2.400"/><path d="M46 44 C40 36 44 28 46 26 C50 30 52 38 46 44 Z" fill="#5FB27F" stroke="#5A3E3A" stroke-width="2.400" stroke-linejoin="round"/><rect x="106" y="52" width="16" height="14" rx="3" fill="#F7A8B8" stroke="#5A3E3A" stroke-width="2.400"/><path d="M114 52 C108 44 112 36 114 34 C118 38 120 46 114 52 Z" fill="#5FB27F" stroke="#5A3E3A" stroke-width="2.400" stroke-linejoin="round"/></svg>`,
  };
  const cvInfo = (html, label) => `<details class="cv3-info"><summary aria-label="${label}"><span aria-hidden="true">i</span></summary><div class="cv3-bubble">${html}</div></details>`;
  const cvEsc = (t) => escXml(String(t == null ? '' : t));
  function openCtImage(e) {
    $('#ctViewImg').src = e.image;
    $('#ctViewTitle').textContent = `${e.ownerName || e.owner}${e.roomName ? ' · ' + e.roomName : ''}`;
    $('#ctView').hidden = false;
  }
  // Le thème d'un jour, pour l'affichage : pièce (si le nouveau fonctionnement est actif) + thème, couleur ou objet.
  function cvThemeBlock(day, label) {
    const el = document.createElement('div');
    el.className = 'cv3-theme-block';
    if (!v2Day(day)) {
      el.innerHTML = `<div class="cv3-k">${label}</div><h2 class="cv3-big"></h2>`;
      el.querySelector('h2').textContent = themeOf(day);
      return el;
    }
    const p = planOf(day);
    // Thème général : il suffit, pas de pièce imposée.
    if (!p.room && p.kind === 'general') {
      el.innerHTML = `<div class="cv3-k">${label === 'Pièce du jour' ? 'Thème du jour' : label}</div><h2 class="cv3-big"></h2>`;
      el.querySelector('h2').textContent = p.text;
      return el;
    }
    let theme;
    if (p.kind === 'object') {
      const img = state.images.get(p.objectId);
      // L'objet imposé est mis en avant : grande image dans un cadre, et ce qu'il faut en faire.
      theme = `<div class="cv3-objcard">${img ? `<img class="cv3-obj" src="${cvEsc(img.url)}" alt="">` : ''}<div class="cv3-objinfo"><span class="cv3-objname">${cvEsc(p.objectName)}</span>${day === today() ? '<span class="cv3-objnote">Prêté pour aujourd\'hui</span>' : ''}</div></div>`;
    } else if (p.kind === 'color') {
      theme = `<span class="cv3-swatch" style="background:${cvEsc(p.colorHex)}"></span><span>${cvEsc(p.colorName)}</span>`;
    } else theme = `<span>${cvEsc(p.value)}</span>`;
    const kindLabel = p.kind === 'object' ? 'Objet à placer' : p.kind === 'color' ? 'Couleur imposée' : 'Thème';
    el.innerHTML = p.room
      ? `<div class="cv3-k">${label}</div><h2 class="cv3-big cv3-room-name"></h2><div class="cv3-k cv3-k2">${kindLabel}</div><div class="cv3-theme">${theme}</div>`
      : `<div class="cv3-k">${label === 'Pièce du jour' ? 'Thème du jour' : label}</div><div class="cv3-k cv3-k2">${kindLabel}</div><div class="cv3-theme">${theme}</div>`;
    if (p.room) el.querySelector('.cv3-room-name').textContent = p.room;
    return el;
  }

  // ---------------------------------------------------------------------------
  // Vote du thème du lendemain (côté administratrice pour l'instant).
  // Chaque jour, une liste d'une dizaine d'idées est tirée dans la « Banque d'idées » (thèmes, objets, couleurs) ; chacun a
  // 3 cœurs à distribuer. L'idée qui a le plus de cœurs devient le thème du lendemain. Les joueurs proposent des thèmes
  // (2 par jour, validés par l'administratrice) ; l'idée d'un joueur qui gagne rejoint la liste officielle et lui rapporte des pièces.
  // ---------------------------------------------------------------------------
  const themeVoteOn = () => state.isAdmin;
  const THEME_HEARTS = 3, THEME_PROPS_PER_DAY = 2, THEME_TEXT_MAX = 30, BALLOT = { theme: 4, object: 2, color: 2 };
  const themeWinners = {}; // jour -> idée élue la veille { type, label, imageId?, propId?, owner? }
  let cv3Sub = null;       // 'themevote' : sous-page du concours
  let themeVoteData = null;
  const docSlug = (t) => `${String(t).replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 24)}_${seededRank(String(t)).toString(36)}`;

  // La banque d'idées : tout ce qui peut être proposé au vote.
  function ideaBank(poolDocs) {
    const accepted = poolDocs.filter((d) => d.kind === 'prop' && d.status === 'accepted');
    const official = contestThemes();
    const themes = official.map((t) => ({ id: `t:${t}`, type: 'theme', label: t, src: 'liste' }));
    for (const p of accepted) if (!official.some((t) => normalizeText(t) === normalizeText(p.text))) themes.push({ id: `t:${p.text}`, type: 'theme', label: p.text, src: 'joueur', owner: p.owner, ownerName: p.ownerName, propId: p.id });
    const objects = contestObjectPool().map((i) => ({ id: `o:${i.id}`, type: 'object', label: objectLabel(i), imageId: i.id, src: 'liste' }));
    const colors = contestColors().map((c) => ({ id: `c:${c.name}`, type: 'color', label: c.name, hex: c.hex, src: 'liste' }));
    return { themes, objects, colors };
  }
  // Le choix du jour : le même pour tout le monde (tirage fixé par la date), sans l'idée déjà retenue aujourd'hui.
  function ballotFor(day, poolDocs) {
    const bank = ideaBank(poolDocs);
    const todayPlan = planOfBase(shiftDay(day, -1));
    const used = new Set([todayPlan && todayPlan.kind === 'general' ? `t:${todayPlan.value}` : '', todayPlan && todayPlan.objectId ? `o:${todayPlan.objectId}` : '', todayPlan && todayPlan.colorName ? `c:${todayPlan.colorName}` : '']);
    const pick = (list, n, prefer = []) => {
      const ok = list.filter((c) => !used.has(c.id)).sort((a, b) => seededRank(`${day}|${a.id}`) - seededRank(`${day}|${b.id}`));
      const first = ok.filter((c) => prefer.includes(c.src)).slice(0, Math.min(2, n));
      return [...first, ...ok.filter((c) => !first.includes(c))].slice(0, n);
    };
    return [...pick(bank.themes, BALLOT.theme, ['joueur']), ...pick(bank.objects, BALLOT.object), ...pick(bank.colors, BALLOT.color)];
  }
  function ballotTally(day, poolDocs, heartDocs) {
    const ballot = ballotFor(day, poolDocs);
    const count = {};
    for (const h of heartDocs.filter((x) => x.kind === 'heart')) count[h.cand] = (count[h.cand] || 0) + 1;
    const cands = ballot.map((c) => ({ ...c, n: count[c.id] || 0 }));
    const ranked = [...cands].sort((a, b) => b.n - a.n || seededRank(`${day}|${a.id}`) - seededRank(`${day}|${b.id}`));
    return { cands, hearts: heartDocs.filter((x) => x.kind === 'heart'), leader: ranked.length && ranked[0].n > 0 ? ranked[0] : null };
  }
  async function loadThemeVoteData(day) {
    const [poolDocs, heartDocs] = await Promise.all([db.listThemeVote('pool'), db.listThemeVote(day)]);
    return { day, pool: poolDocs.filter((d) => d.kind === 'prop'), ...ballotTally(day, poolDocs, heartDocs) };
  }
  // L'idée élue pour un jour (votée la veille) : chargée pour que planOf puisse l'utiliser. Si c'est l'idée d'un joueur :
  // elle rejoint la liste officielle et son auteur reçoit des pièces (une seule fois).
  async function loadThemeWinner(day) {
    if (!themeVoteOn()) return;
    try {
      const d = await loadThemeVoteData(day);
      const w = d.leader;
      const before = themeWinners[day] && themeWinners[day].id;
      if (w) themeWinners[day] = w; else delete themeWinners[day];
      if (w && w.propId) await rewardThemeWinner(day, w);
      if (before !== (w && w.id)) { renderContestTile(); if (!screens.contest.hidden) renderContest(); }
    } catch (e) { /* vote indisponible : on garde le tirage */ }
  }
  async function rewardThemeWinner(day, w) {
    const list = Array.isArray(state.settings.contestThemes) && state.settings.contestThemes.length ? state.settings.contestThemes : DEFAULT_THEMES;
    if (!list.some((t) => normalizeText(t) === normalizeText(w.label))) {
      state.settings.contestThemes = [...list, w.label];
      await saveSettings();
    }
    const reward = setting('themeWinReward');
    const m = { id: `theme-win-${w.propId}`, to: w.owner, title: '🏆 Ton thème a gagné !', text: `Bravo ! Ton idée de thème « ${w.label} » a été élue par les joueurs pour le concours du ${dateFmt.format(new Date(`${day}T12:00:00`)).replace(/ à .*/, '')}. Elle rejoint la liste officielle des thèmes.`, reward, read: false, claimed: false, created: Date.now() };
    try { if (await db.createMail(m)) toast(`Le thème « ${w.label} » est élu : récompense envoyée à son auteur ✉️`); } catch (e) { /* on réessaiera */ }
  }
  async function openThemeVote() {
    cv3Sub = 'themevote';
    $('#ctBody').innerHTML = '<p class="muted">Chargement…</p>';
    const day = shiftDay(today(), 1);
    try { themeVoteData = await loadThemeVoteData(day); } catch (e) { themeVoteData = { day, pool: [], cands: [], hearts: [], leader: null }; toast('Le vote du thème n\'est pas disponible. Vérifie ta connexion.'); }
    renderContest();
  }
  function renderThemeVote(body) {
    const me = state.player.key;
    const d = themeVoteData;
    body.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'cv3';
    body.appendChild(wrap);
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'cv3-link-btn';
    back.textContent = '← Retour au concours';
    back.addEventListener('click', () => { cv3Sub = null; renderContest(); });
    wrap.appendChild(back);
    const reload = async () => { try { themeVoteData = await loadThemeVoteData(d.day); } catch (e) { /* on garde l'affichage */ } renderContest(); };
    const myHearts = d.hearts.filter((h) => h.voter === me);
    const left = THEME_HEARTS - myHearts.length;
    // --- Le choix du jour : 3 cœurs à distribuer
    const card = document.createElement('section');
    card.className = 'cv3-card';
    card.innerHTML = `<div class="cv3-head"><div class="cv3-head-main"><div class="cv3-k">Vote jusqu'à minuit</div><h2 class="cv3-big">Thème de demain</h2></div>${cvInfo('Distribue tes ' + THEME_HEARTS + ' cœurs entre les idées qui te plaisent : un thème, un objet ou une couleur. L\'idée qui a le plus de cœurs est choisie pour le concours de demain. Tu ne peux pas voter pour ta propre idée.', 'Plus d\'infos : le vote du thème')}</div>
      <div class="cv3-chips"><span class="cv3-chip b">❤️ ${left} cœur${left > 1 ? 's' : ''} à donner</span></div><div class="tv-list"></div>`;
    wrap.appendChild(card);
    const list = card.querySelector('.tv-list');
    if (!d.cands.length) list.innerHTML = '<p class="muted">Pas d\'idées pour l\'instant : ajoute des thèmes à ta liste ou propose-en !</p>';
    const max = Math.max(1, ...d.cands.map((c) => c.n));
    for (const c of d.cands) {
      const row = document.createElement('div');
      row.className = 'tv-row' + (d.leader && d.leader.id === c.id ? ' lead' : '');
      const kind = c.type === 'object' ? 'Objet' : c.type === 'color' ? 'Couleur' : 'Thème';
      const img = c.imageId && state.images.get(c.imageId);
      row.innerHTML = `<div class="tv-visual"></div><div class="tv-main"><span class="tv-kind"></span><strong class="tv-text"></strong><span class="tv-bar"><i></i></span></div><span class="tv-n"></span><div class="tv-act"></div>`;
      const vis = row.querySelector('.tv-visual');
      if (img) vis.innerHTML = `<img alt="" src="${cvEsc(img.url)}">`;
      else if (c.hex) vis.innerHTML = `<span class="cv3-swatch" style="background:${cvEsc(c.hex)}"></span>`;
      else vis.hidden = true;
      row.querySelector('.tv-kind').textContent = c.src === 'joueur' ? `${kind} · idée de ${c.owner === me ? 'toi' : (c.ownerName || c.owner)}` : kind;
      row.querySelector('.tv-text').textContent = `${d.leader && d.leader.id === c.id ? '🏆 ' : ''}${c.label}`;
      row.querySelector('.tv-bar i').style.width = `${Math.round((c.n / max) * 100)}%`;
      row.querySelector('.tv-n').textContent = `${c.n} ❤️`;
      if (c.owner !== me) {
        const mine = myHearts.find((h) => h.cand === c.id);
        const b = document.createElement('button');
        b.className = 'btn ' + (mine ? '' : 'btn-primary');
        b.textContent = mine ? '❤️ Donné' : '🤍 Donner';
        b.disabled = !mine && left <= 0;
        b.addEventListener('click', async () => {
          try {
            if (mine) await db.deleteThemeDoc(mine.id);
            else await db.putThemeDoc({ id: `th-${d.day}-${me}-${docSlug(c.id)}`, kind: 'heart', themeDay: d.day, cand: c.id, voter: me, created: Date.now() });
          } catch (err) { toast('Le vote n\'a pas pu être enregistré. Vérifie ta connexion.'); return; }
          reload();
        });
        row.querySelector('.tv-act').appendChild(b);
      }
      list.appendChild(row);
    }
    // --- Proposer un thème (2 par jour, validé par l'administratrice)
    const todayProps = d.pool.filter((p) => p.owner === me && p.proposedDay === today());
    const propCard = document.createElement('section');
    propCard.className = 'cv3-card';
    propCard.innerHTML = `<h3 class="cv3-h3">Proposer un thème</h3>
      <p class="cv3-note">${todayProps.length}/${THEME_PROPS_PER_DAY} aujourd'hui · +${setting('themeProposeReward')} 🪙 par idée envoyée, +${setting('themeWinReward')} 🪙 si elle gagne. Elle passe d'abord par l'administratrice.</p>
      <form class="tv-form"><input class="field tv-input" type="text" maxlength="${THEME_TEXT_MAX}" placeholder="Ton idée de thème (ex : Fête foraine)" aria-label="Ton idée de thème"><button class="btn btn-primary" type="submit">Proposer</button></form>
      <div class="tv-mine"></div>`;
    wrap.appendChild(propCard);
    propCard.querySelector('.tv-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const inp = propCard.querySelector('.tv-input');
      const text = inp.value.trim().replace(/\s+/g, ' ');
      if (text.length < 2) { toast('Écris un thème d\'au moins 2 lettres.'); return; }
      if (todayProps.length >= THEME_PROPS_PER_DAY) { toast(`Tu as déjà fait ${THEME_PROPS_PER_DAY} propositions aujourd'hui : reviens demain !`); return; }
      if (contestThemes().some((t) => normalizeText(t) === normalizeText(text)) || d.pool.some((p) => p.status !== 'refused' && normalizeText(p.text) === normalizeText(text))) { toast('Cette idée existe déjà.'); return; }
      const id = `tp-${me}-${Date.now()}`;
      try {
        await db.putThemeDoc({ id, kind: 'prop', themeDay: 'pool', text, owner: me, ownerName: state.player.name, created: Date.now(), proposedDay: today(), status: 'pending' });
      } catch (err) { toast('La proposition n\'a pas pu être envoyée. Vérifie ta connexion.'); return; }
      const reward = setting('themeProposeReward');
      if (reward > 0) { state.profile.points = (state.profile.points || 0) + reward; saveProfile(); renderPoints(); }
      toast(`Idée envoyée 🗳️${reward > 0 ? ` +${reward} 🪙` : ''} : elle sera validée avant le vote.`);
      reload();
    });
    const mineBox = propCard.querySelector('.tv-mine');
    for (const p of d.pool.filter((x) => x.owner === me).sort((a, b) => (b.created || 0) - (a.created || 0)).slice(0, 6)) {
      const li = document.createElement('p');
      li.className = 'tv-minerow';
      li.textContent = `${p.status === 'accepted' ? '✅' : p.status === 'refused' ? '✕' : '⏳'} ${p.text}${p.status === 'pending' ? ' · en attente de validation' : p.status === 'refused' ? ' · refusée' : ' · acceptée'}`;
      mineBox.appendChild(li);
    }
    // --- Administratrice : idées à valider
    const pending = d.pool.filter((p) => p.status === 'pending').sort((a, b) => (a.created || 0) - (b.created || 0));
    if (state.isAdmin && pending.length) {
      const vc = document.createElement('section');
      vc.className = 'cv3-card';
      vc.innerHTML = `<h3 class="cv3-h3">Idées à valider (${pending.length})</h3><div class="tv-list"></div>`;
      for (const p of pending) {
        const row = document.createElement('div');
        row.className = 'tv-row';
        row.innerHTML = '<div class="tv-main"><strong class="tv-text"></strong><span class="tv-kind"></span></div><div class="tv-act"></div>';
        row.querySelector('.tv-text').textContent = p.text;
        row.querySelector('.tv-kind').textContent = `par ${p.ownerName || p.owner}`;
        const act = row.querySelector('.tv-act');
        const set = (status) => async () => {
          try { await db.putThemeDoc({ ...p, status }); } catch (err) { toast('Le choix n\'a pas pu être enregistré.'); return; }
          reload();
        };
        const ok = document.createElement('button'); ok.className = 'btn btn-primary'; ok.textContent = '✓ Accepter'; ok.addEventListener('click', set('accepted'));
        const no = document.createElement('button'); no.className = 'btn btn-ghost'; no.textContent = '✕ Refuser'; no.addEventListener('click', set('refused'));
        act.append(ok, no);
        vc.querySelector('.tv-list').appendChild(row);
      }
      wrap.appendChild(vc);
    }
    const tip = document.createElement('p');
    tip.className = 'cv3-note';
    const w = themeWinners[today()];
    tip.textContent = w ? `Idée élue pour aujourd'hui : ${w.label}.` : 'À minuit, l\'idée qui a le plus de cœurs devient le thème du concours.';
    wrap.appendChild(tip);
  }

  // Étape 2 « Voter » : carte compacte du vote du thème de demain (le thème en tête, et l'accès aux propositions).
  let themeVoteLoading = false;
  function cvThemeCard(page) {
    const day = shiftDay(today(), 1);
    const card = document.createElement('section');
    card.className = 'cv3-card cv3-themecard';
    const ready = themeVoteData && themeVoteData.day === day;
    if (!ready && !themeVoteLoading) {
      themeVoteLoading = true;
      loadThemeVoteData(day).then((data) => { themeVoteData = data; })
        .catch(() => { themeVoteData = { day, pool: [], cands: [], hearts: [], leader: null }; })
        .finally(() => { themeVoteLoading = false; if (cv3Step === 1 && !cv3Sub && !screens.contest.hidden) renderContest(); });
    }
    const d = ready ? themeVoteData : null;
    const lead = d && d.leader;
    card.innerHTML = `<div class="cv3-head"><div class="cv3-head-main"><div class="cv3-k">Vote jusqu'à minuit</div><h3 class="cv3-h3 tv-card-title">Thème de demain</h3></div></div>
      <p class="cv3-note tv-card-lead"></p>
      <button type="button" class="cv3-cta tv-card-btn"><span>Voter · proposer une idée</span></button>`;
    card.querySelector('.tv-card-lead').textContent = !d ? 'Chargement…'
      : lead ? `🏆 En tête : ${lead.label} (${lead.n} ❤️)` : `${plural(d.cands.length, 'idée')} au choix, pas encore de cœurs.`;
    card.querySelector('.tv-card-btn').addEventListener('click', openThemeVote);
    page.appendChild(card);
  }

  function renderContestV3() {
    const body = $('#ctBody');
    if (cv3Sub === 'themevote' && themeVoteOn() && themeVoteData) { renderThemeVote(body); return; }
    cv3Sub = null;
    body.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'cv3';
    body.appendChild(wrap);
    const steps = [
      { name: 'Créer', sub: 'avant minuit', tint: 'pink' },
      { name: 'Voter', sub: 'jusqu\'à 20 h', tint: 'butter' },
      { name: 'Résultats', sub: 'dévoilés à 20 h', tint: 'mint' },
    ];
    const nav = document.createElement('nav');
    nav.className = 'cv3-steps';
    nav.setAttribute('aria-label', 'Les 3 étapes du concours');
    steps.forEach((s, i) => {
      if (i) nav.insertAdjacentHTML('beforeend', `<span class="cv3-sep" aria-hidden="true">${CV_ICON.chev}</span>`);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `cv3-step ${s.tint}${i === cv3Step ? ' on' : ''}`;
      b.innerHTML = `<span class="cv3-num" data-n="${i + 1}">${i + 1}</span><span class="cv3-step-name">${s.name}</span><span class="cv3-step-sub">${s.sub}</span>`;
      if (i === cv3Step) b.setAttribute('aria-current', 'step');
      b.addEventListener('click', () => { cv3Step = i; renderContestV3(); });
      nav.appendChild(b);
    });
    wrap.appendChild(nav);
    const page = document.createElement('div');
    page.className = 'cv3-page';
    wrap.appendChild(page);
    [cvPageCreate, cvPageVote, cvPageResults][cv3Step](page);
    if (cv3Step === 1 && themeVoteOn()) cvThemeCard(page);
    // Flèches du bas
    const foot = document.createElement('footer');
    foot.className = 'cv3-foot';
    const arrow = (dir, enabled) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cv3-arrow';
      b.disabled = !enabled;
      b.setAttribute('aria-label', dir < 0 ? 'Étape précédente' : 'Étape suivante');
      b.innerHTML = dir < 0 ? CV_ICON.left : CV_ICON.right;
      b.addEventListener('click', () => { cv3Step += dir; renderContestV3(); window.scrollTo(0, 0); });
      return b;
    };
    foot.appendChild(arrow(-1, cv3Step > 0));
    const mid = document.createElement('div');
    mid.className = 'cv3-foot-mid';
    mid.innerHTML = `<span class="cv3-dots">${steps.map((_, i) => `<i class="${i === cv3Step ? 'on' : ''}"></i>`).join('')}</span><span>Étape ${cv3Step + 1} sur 3 · ${steps[cv3Step].name}</span>`;
    foot.appendChild(mid);
    foot.appendChild(arrow(1, cv3Step < 2));
    wrap.appendChild(foot);
  }

  // Page 1 : créer sa pièce du concours
  function cvPageCreate(page) {
    const me = state.player.key;
    const t = contestData.today;
    const card = document.createElement('section');
    card.className = 'cv3-card';
    card.setAttribute('aria-label', 'Thème du jour');
    const joinR = setting('contestJoinReward'), winR = contestReward();
    const every = setting('contestMilestoneEvery'), prize = setting('contestMilestoneReward');
    const rewards = [];
    if (joinR > 0) rewards.push([`+${joinR}`, 'Pour ta participation', 'c1']);
    rewards.push([`+${winR}`, 'Pour le gagnant du concours', 'c2']);
    if (prize > 0) rewards.push([`+${prize}`, `Toutes les ${every} participations`, 'c3']);
    const infoText = v2Day(t.day)
      ? 'Chaque jour, une pièce à décorer (chambre, salon…) avec un thème : un thème général, une couleur ou un objet. Décore-la avec tous les meubles que tu as obtenus, même ceux posés dans tes autres pièces. Quand tu quittes, elle s\'enregistre automatiquement en brouillon. Clique sur « Publier » pour participer avant minuit. Les votes auront lieu demain. Si le thème est un objet, il est prêté à tous aujourd\'hui, dans la pièce du concours.'
      : 'Pour participer au concours, décore une pièce sur le thème du jour avec tous les meubles que tu as obtenus, même ceux posés dans tes autres pièces. Quand tu quittes, elle s\'enregistre automatiquement en brouillon. Clique sur « Publier » pour participer au concours du jour avant minuit. Les votes de ce thème auront lieu demain.';
    card.innerHTML = `<div class="cv3-hero">${manoirOn() ? CV_MANOIR.hero : CV_ICON.hero}</div>
      <div class="cv3-head"><div class="cv3-head-main"></div>${cvInfo(cvEsc(infoText), 'Plus d\'infos : comment créer ma pièce')}</div>
      <h3 class="cv3-h3">Récompenses</h3>
      <div class="cv3-rewards">${rewards.map(([v, l, c]) => `<div class="cv3-reward"><span class="cv3-pill ${c}">${v} ${COIN_SVG(20)}</span><span>${l}</span></div>`).join('')}</div>
      <div class="cv3-cta-zone"></div>
      <div class="cv3-tiles"></div>`;
    card.querySelector('.cv3-head-main').appendChild(cvThemeBlock(t.day, v2Day(t.day) ? 'Pièce du jour' : 'Thème du jour'));
    // Bouton principal, ou brouillon / participation en cours
    const zone = card.querySelector('.cv3-cta-zone');
    const mine = t.entries.find((e) => e.owner === me);
    const myRoom = state.rooms.find((r) => r.contestDay === t.day);
    if (mine) {
      const p = document.createElement('p');
      p.className = 'cv3-note ok';
      p.innerHTML = `Ta participation est publiée <b>✓</b> Tu peux encore modifier ta pièce et la republier jusqu'à minuit.`;
      zone.appendChild(p);
    }
    if (myRoom && !(blankContestRoom(myRoom) && !mine)) {
      const pending = !mine || !myRoom.publishedAt || (myRoom.updated || 0) - myRoom.publishedAt > 3000;
      const hour = (ts) => new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
      const dr = document.createElement('div');
      dr.className = 'cv3-draft';
      dr.innerHTML = `<button type="button" class="cv3-draft-img" aria-label="Reprendre ma pièce">${myRoom.thumb ? '<img alt="">' : `<svg viewBox="0 0 1000 760" xmlns="http://www.w3.org/2000/svg">${roomSvg(myRoom.colors, myRoom.shape)}</svg>`}</button>
        <div class="cv3-draft-info"><strong></strong><span></span></div>`;
      if (myRoom.thumb) dr.querySelector('img').src = myRoom.thumb;
      dr.querySelector('strong').textContent = mine ? (pending ? 'Modifications pas encore publiées' : 'Pièce publiée, à jour') : 'Mon brouillon';
      dr.querySelector('span').textContent = `Enregistré à ${hour(myRoom.updated || Date.now())} · ${plural((myRoom.stickers || []).length, 'sticker')}${pending ? ' · « Publier » dans la pièce quand elle est prête' : ''}`;
      dr.querySelector('.cv3-draft-img').addEventListener('click', openContestRoom);
      zone.appendChild(dr);
      const go = document.createElement('button');
      go.type = 'button';
      go.className = 'cv3-cta';
      go.innerHTML = `${CV_ICON.palette}<span>Reprendre ma pièce</span>`;
      go.addEventListener('click', openContestRoom);
      zone.appendChild(go);
      const reset = document.createElement('button');
      reset.type = 'button';
      reset.className = 'cv3-link-btn';
      reset.textContent = 'Recommencer à zéro';
      reset.addEventListener('click', async () => {
        const msg = mine
          ? 'Effacer ton brouillon et repartir d\'une autre pièce ? Ta participation déjà publiée reste en place tant que tu n\'en publies pas une nouvelle.'
          : 'Effacer ton brouillon et repartir de zéro ou d\'une autre pièce ?';
        if (!(await askConfirm(msg, 'Recommencer'))) return;
        state.rooms = state.rooms.filter((x) => x.id !== myRoom.id);
        db.deleteRoom(myRoom.id).catch(() => {});
        openContestRoom();
      });
      zone.appendChild(reset);
    } else {
      const go = document.createElement('button');
      go.type = 'button';
      go.className = 'cv3-cta';
      go.innerHTML = `${manoirOn() ? CV_MANOIR.palette : CV_ICON.palette}<span>Créer ma pièce du concours</span>`;
      go.addEventListener('click', openContestRoom);
      zone.appendChild(go);
    }
    // Deux tuiles : mes participations, aujourd'hui
    const tiles = card.querySelector('.cv3-tiles');
    const cnt = state.profile.contestCount || 0;
    let mineTile = `<div class="cv3-tile"><div class="cv3-k">Mes participations</div><div class="cv3-count"><b>${cnt}</b>${prize > 0 ? `<span>sur ${(Math.floor(cnt / every) + 1) * every}</span>` : ''}</div>`;
    if (prize > 0) {
      const filled = cnt % every;
      mineTile += `<div class="cv3-dots2" aria-hidden="true">${Array.from({ length: every }, (_, i) => `<i class="${i < filled ? 'on' : ''}"></i>`).join('')}</div>
        <div class="cv3-tile-sub">Encore ${every - filled} pour +${prize} ${COIN_SVG(16)}</div>`;
    } else mineTile += '<div class="cv3-tile-sub">participations au total</div>';
    mineTile += '</div>';
    const n = t.entries.length;
    tiles.innerHTML = mineTile + `<div class="cv3-tile"><div class="cv3-k">Aujourd'hui</div><div class="cv3-count"><b>${n}</b><span>participation${n > 1 ? 's' : ''}</span></div><div class="cv3-tile-sub">de joueurs au concours</div></div>`;
    page.appendChild(card);
    // Admin : les pièces publiées aujourd'hui, avec « Retirer »
    if (state.isAdmin && t.entries.length) {
      const det = document.createElement('details');
      det.className = 'cv3-admin';
      det.innerHTML = `<summary>Participations du jour (admin) · ${t.entries.length}</summary><div class="ct-grid"></div>`;
      const grid = det.querySelector('.ct-grid');
      t.entries.forEach((e) => grid.appendChild(entryCard(e, { canModerate: true })));
      page.appendChild(det);
    }
    const hist = document.createElement('button');
    hist.type = 'button';
    hist.className = 'cv3-hist';
    hist.innerHTML = `${CV_ICON.scroll}<span>Mon historique des concours</span>${CV_ICON.chev}`;
    hist.addEventListener('click', openContestHistory);
    page.appendChild(hist);
  }

  // Page 2 : voter en duels
  function cvPageVote(page) {
    const me = state.player.key;
    const v = contestData.vote;
    const card = document.createElement('section');
    card.className = 'cv3-card';
    card.setAttribute('aria-label', 'Vote');
    const head = document.createElement('div');
    head.className = 'cv3-head';
    const main = document.createElement('div');
    main.className = 'cv3-head-main';
    main.appendChild(cvThemeBlock(v.day, 'Vote'));
    head.appendChild(main);
    head.insertAdjacentHTML('beforeend', cvInfo(`Dans chaque duel, clique sur ta pièce préférée en fonction du thème imposé. Remporte ${voteReward()} pièces à la fin des votes.`, 'Plus d\'infos : comment voter'));
    card.appendChild(head);
    page.appendChild(card);
    const msg = (text, cls = '') => { const p = document.createElement('p'); p.className = 'cv3-note ' + cls; p.textContent = text; card.appendChild(p); };
    if (voteMaintenance()) { msg('Le vote est momentanément fermé pour maintenance. Tu peux toujours créer et publier ta pièce du concours : le vote reviendra bientôt !'); return; }
    if (votingOver()) {
      msg('Le vote d\'hier est terminé : le gagnant est dévoilé !', 'ok');
      const go = document.createElement('button');
      go.type = 'button'; go.className = 'cv3-cta';
      go.innerHTML = `${CV_ICON.trophy}<span>Voir les résultats</span>`;
      go.addEventListener('click', () => { cv3Step = 2; renderContestV3(); });
      card.appendChild(go);
      return;
    }
    if (state.isAdmin && voteMaintenanceOn()) msg('Test admin : le vote est en maintenance pour les joueurs.');
    const plan = duelPlan(v, me);
    if (!v.entries.length) { msg('Personne n\'a participé hier : rien à voter aujourd\'hui.'); return; }
    if (v.entries.length === 1) { msg(`Une seule participation hier : pas de vote aujourd'hui. ${v.entries[0].owner === me ? 'Tu gagnes' : `${v.entries[0].ownerName || v.entries[0].owner} gagne`} d'office à 20 h !`); return; }
    if (!plan.total) { msg('Tu as participé hier et il n\'y a qu\'une autre pièce : tu ne peux pas voter aujourd\'hui. Les autres joueurs départagent !'); return; }
    const chips = document.createElement('div');
    chips.className = 'cv3-chips';
    chips.innerHTML = `<span class="cv3-chip b">${CV_ICON.swords} ${plan.total} duel${plan.total > 1 ? 's' : ''}</span><span class="cv3-chip">+${voteReward()} ${COIN_SVG(18)} en récompense</span>`;
    card.appendChild(chips);
    const finished = plan.done >= plan.total;
    const dots = document.createElement('div');
    dots.className = 'cv3-progress';
    dots.innerHTML = `<span class="cv3-dots2">${Array.from({ length: Math.min(plan.total, 12) }, (_, i) => `<i class="${i < plan.done ? 'on' : i === plan.done ? 'cur' : ''}"></i>`).join('')}</span><span>${finished ? 'Duels terminés' : `Duel ${plan.done + 1} sur ${plan.total}`}</span>`;
    card.appendChild(dots);
    if (finished) {
      msg(`Merci ! Tu as fait ${plan.total > 1 ? `tes ${plan.total} duels` : 'ton duel'} du jour.${(state.profile.voteRewardDay || '') === v.day ? ` (+${voteReward()} pièces reçues)` : ''}`, 'ok');
    } else {
      // Aperçu du duel en cours ; « Voter » ouvre la page de vote en grand (une pièce à toucher, images plus grandes).
      if (!duelCurrent || duelCurrent.day !== v.day || !plan.left.some((p) => p.join('|') === [...duelCurrent.pair].sort().join('|'))) {
        duelCurrent = { day: v.day, pair: nextDuel(v, plan) };
      }
      const [a, b] = duelCurrent.pair;
      const arena = document.createElement('button');
      arena.type = 'button';
      arena.className = 'cv3-arena';
      arena.setAttribute('aria-label', 'Ouvrir le vote');
      [a, b].forEach((owner, i) => {
        const e = v.entries.find((x) => x.owner === owner);
        const pick = document.createElement('span');
        pick.className = 'cv3-pick' + (i ? ' r' : ' l');
        pick.innerHTML = '<img alt="">';
        pick.querySelector('img').src = e.image;
        arena.appendChild(pick);
      });
      arena.insertBefore(Object.assign(document.createElement('span'), { className: 'cv3-vs', textContent: 'VS' }), arena.children[1]);
      arena.addEventListener('click', () => openDuelView(v));
      card.appendChild(arena);
      const when = document.createElement('p');
      when.className = 'cv3-when';
      when.innerHTML = `${CV_ICON.clock}<span>Gagnant dévoilé à 20 h !</span>`;
      card.appendChild(when);
      const vote = document.createElement('button');
      vote.type = 'button';
      vote.className = 'cv3-cta cv3-vote';
      vote.innerHTML = `${CV_ICON.swords}<span>Voter${plan.done ? ` · ${plan.done}/${plan.total}` : ''}</span>`;
      vote.addEventListener('click', () => openDuelView(v));
      card.appendChild(vote);
    }
    if (state.isAdmin && plan.done) {
      const r = document.createElement('button');
      r.type = 'button';
      r.className = 'cv3-link-btn';
      r.textContent = 'Recommencer mes votes (test admin)';
      r.addEventListener('click', () => resetMyDuels(v));
      card.appendChild(r);
    }
    if (state.isAdmin && v.duels.length) {
      const det = document.createElement('details');
      det.className = 'cv3-admin';
      det.innerHTML = '<summary>Classement provisoire (admin)</summary>';
      det.appendChild(provisionalRanking(v));
      page.appendChild(det);
    }
  }

  // Page 3 : résultats, podium
  function cvPageResults(page) {
    const me = state.player.key;
    const r = contestData.results;
    const card = document.createElement('section');
    card.className = 'cv3-card';
    card.setAttribute('aria-label', 'Derniers résultats');
    const head = document.createElement('div');
    head.className = 'cv3-head';
    const main = document.createElement('div');
    main.className = 'cv3-head-main';
    main.appendChild(cvThemeBlock(r.day, r.day === shiftDay(today(), -1) ? 'Résultats de ce soir' : 'Derniers résultats'));
    head.appendChild(main);
    head.insertAdjacentHTML('beforeend', cvInfo('Le score indique les duels gagnés sur les duels disputés.', 'Plus d\'infos : le score'));
    card.appendChild(head);
    page.appendChild(card);
    const msg = (html, cls = '') => { const p = document.createElement('p'); p.className = 'cv3-note ' + cls; p.innerHTML = html; card.appendChild(p); };
    if (!r.entries.length) { msg('Pas de participation ce jour-là.'); return; }
    msg(r.solo ? `Une seule participation : gagnante d'office, avec ${soloReward()} ${COIN_SVG(18)}`
      : r.winners.length > 1 ? `Égalité ! ${r.winners.length} gagnants cette fois, qui partagent la 1re place.`
        : r.winners.length ? 'Bravo au gagnant !' : 'Aucun vote : pas de gagnant cette fois.');
    // Récompenses du podium (1er, 2e, 3e), comme sur la page Créer.
    if (!r.solo && r.winners.length) {
      const podiumOn = r.day >= PODIUM_REWARDS_FROM;
      const list = [[`+${contestReward()}`, r.winners.length > 1 ? '🏆 Pour chaque gagnant' : '🏆 Pour le 1er', 'c2']];
      {
        // Les pastilles du 2e et du 3e s'affichent toujours (même pour un concours d'avant ces récompenses).
        if (setting('contestReward2') > 0) list.push([`+${setting('contestReward2')}`, '🥈 Pour le 2e', 'c2']);
        if (setting('contestReward3') > 0) list.push([`+${setting('contestReward3')}`, '🥉 Pour le 3e', 'c2']);
      }
      const box = document.createElement('div');
      box.className = 'cv3-rewards';
      box.innerHTML = list.map(([v, l, c]) => `<div class="cv3-reward"><span class="cv3-pill ${c}">${v} ${COIN_SVG(20)}</span><span>${l}</span></div>`).join('');
      card.appendChild(box);
      if (!podiumOn && (setting('contestReward2') > 0 || setting('contestReward3') > 0)) {
        msg(`Nouveau : à partir des résultats du 14 novembre, le 2e reçoit ${setting('contestReward2')} ${COIN_SVG(18)} et le 3e ${setting('contestReward3')} ${COIN_SVG(18)}.`);
      }
    }
    const ranked = [...r.entries].sort((a, b) => r.rate(b.owner) - r.rate(a.owner) || (r.wins[b.owner] || 0) - (r.wins[a.owner] || 0));
    // Place partagée en cas d'égalité (même pourcentage de duels gagnés) : 1, 1, 3…
    const placeOf = (e) => (r.winners.includes(e.owner) ? 1 : 1 + ranked.filter((x) => r.rate(x.owner) > r.rate(e.owner) || r.winners.includes(x.owner)).length);
    const score = (e) => (r.seen[e.owner] ? `${CV_ICON.swords}<span>${r.wins[e.owner] || 0}/${r.seen[e.owner]} · ${Math.round(r.rate(e.owner) * 100)} %</span>` : '');
    const top = ranked.slice(0, 3);
    const order = (top.length === 1 ? [top[0]] : top.length === 2 ? [top[1], top[0]] : [top[1], top[0], top[2]]).map((e) => [e, placeOf(e)]);
    const pod = document.createElement('div');
    pod.className = 'cv3-podium';
    for (const [e, rank] of order) {
      const col = document.createElement('div');
      col.className = 'cv3-col r' + rank;
      col.innerHTML = `${r.winners.includes(e.owner) ? `<span class="cv3-trophy">${CV_ICON.trophy}</span>` : ''}
        <button type="button" class="cv3-pod-img" aria-label="Agrandir la pièce"><img alt=""></button>
        <div class="cv3-pod-name"><b></b>${e.owner === me ? '<i class="cv3-toi">toi</i>' : ''}</div>
        <div class="cv3-pod-score">${score(e)}</div>
        <div class="cv3-block"><span>${rank}</span></div>`;
      col.querySelector('img').src = e.image;
      col.querySelector('b').textContent = e.ownerName || e.owner;
      col.querySelector('.cv3-pod-img').addEventListener('click', () => openCtImage(e));
      pod.appendChild(col);
    }
    card.appendChild(pod);
    const rest = ranked.slice(3);
    if (rest.length) {
      const list = document.createElement('div');
      list.className = 'cv3-rest';
      rest.forEach((e, i) => {
        const row = document.createElement('div');
        row.className = 'cv3-row';
        row.innerHTML = `<button type="button" class="cv3-row-img" aria-label="Agrandir la pièce"><img alt=""></button>
          <div class="cv3-row-info"><b></b>${e.owner === me ? '<i class="cv3-toi">toi</i>' : ''}<span class="cv3-pod-score">${score(e)}</span></div><span class="cv3-rank">${placeOf(e)}</span>`;
        row.querySelector('img').src = e.image;
        row.querySelector('b').textContent = e.ownerName || e.owner;
        row.querySelector('.cv3-row-img').addEventListener('click', () => openCtImage(e));
        list.appendChild(row);
      });
      card.appendChild(list);
    }
  }

  function renderContest() {
    // Nouvelle page en 3 étapes ; si elle plante, on retombe sur l'ancienne page plutôt que de laisser un écran vide.
    screens.contest.classList.toggle('cv3-on', cv3On());
    if (cv3On()) {
      try { renderContestV3(); return; } catch (e) {
        console.error('Page du concours', e);
        screens.contest.classList.remove('cv3-on');
        toast('Le concours s\'affiche en version simple : ' + String(e && e.message || e).slice(0, 80));
      }
    }
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
    // Fermé jusqu'à l'ouverture du nouveau concours (5 h) : un message à la place de la création, le vote et les résultats restent là.
    const closed = ctPreLaunch();
    if (closed) {
      const cc = section('ct-today', '🔒 Le nouveau concours ouvre à 5 h', 'Reviens tout à l\'heure : une nouvelle pièce et un nouveau thème t\'attendent !');
      // Pour que l'administratrice sache à qui cet horaire pose problème.
      const night = document.createElement('button');
      night.type = 'button';
      night.className = 'btn night-btn';
      const done = !!(state.profile && state.profile.nightPlayer);
      night.textContent = done ? '🌙 C\'est noté, merci !' : '🌙 Je joue d\'habitude à cette heure-là';
      night.disabled = done;
      night.addEventListener('click', reportNightPlayer);
      cc.appendChild(night);
      const hint = document.createElement('p');
      hint.className = 'muted ct-small-text';
      hint.textContent = 'Un petit signe à l\'administratrice pour qu\'elle adapte l\'heure des mises à jour.';
      cc.appendChild(hint);
    }
    const c1 = closed ? document.createElement('div') : section('ct-today', `Thème du jour : ${themeOf(t.day)}`,
      `Décore une pièce sur ce thème et publie-la avant minuit${setting('contestJoinReward') > 0 ? ` (+${setting('contestJoinReward')} 🪙 pour ta participation)` : ''}. Demain, tout le monde vote jusqu'à 20 h, puis on dévoile le gagnant : il reçoit ${contestReward()} 🪙.`);
    if (contestV2()) c1.insertBefore(planCardEl(t.day), c1.firstChild);
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
    {
      const every = setting('contestMilestoneEvery'), prize = setting('contestMilestoneReward');
      if (prize > 0) {
        const cnt = state.profile.contestCount;
        const bonus = document.createElement('p');
        bonus.className = 'muted ct-small-text';
        bonus.textContent = cnt === undefined
          ? `🎁 Tous les ${every} concours auxquels tu participes : +${prize} 🪙 de bonus !`
          : `🎁 Bonus de fidélité : ${cnt % every}/${every} participations avant tes +${prize} 🪙 (${plural(cnt, 'participation')} au total).`;
        c1.appendChild(bonus);
      }
    }
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
      contestTouched();
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
  $('#duelZoomClose').addEventListener('click', () => { $('#duelZoom').hidden = true; });
  $('#duelZoom').addEventListener('click', (e) => { if (e.target.id === 'duelZoom') $('#duelZoom').hidden = true; });
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
      const cell = document.createElement('div');
      cell.className = 'duel-cell';
      const btn = document.createElement('button');
      btn.className = 'duel-pick';
      // Pas de nom pendant le duel : on vote pour la pièce, pas pour la personne.
      btn.innerHTML = '<img alt="Pièce du concours"><span class="duel-choose">❤️ Je préfère</span>';
      btn.querySelector('img').src = e.image;
      btn.addEventListener('click', () => castDuel(v, a, b, owner, btn));
      // Agrandir la pièce en grand écran, pour mieux la voir avant de choisir.
      const zoom = document.createElement('button');
      zoom.type = 'button';
      zoom.className = 'duel-zoom-btn';
      zoom.title = 'Agrandir la pièce';
      zoom.setAttribute('aria-label', 'Agrandir la pièce');
      zoom.textContent = '⤢';
      zoom.addEventListener('click', () => {
        $('#duelZoomImg').src = e.image;
        $('#duelZoomVote').onclick = () => { $('#duelZoom').hidden = true; castDuel(v, a, b, owner, btn); };
        $('#duelZoom').hidden = false;
      });
      cell.append(btn, zoom);
      arena.appendChild(cell);
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
      contestTouched();
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

  // « Je joue d'habitude à cette heure-là » : un message dans la boîte aux lettres de l'administratrice, une seule fois par joueur.
  async function reportNightPlayer() {
    if (!state.profile || state.profile.nightPlayer) return;
    state.profile.nightPlayer = Date.now();
    saveProfile();
    const m = {
      id: `night-${state.player.key}`, to: ADMIN_PSEUDOS[0], title: `🌙 ${state.player.name} joue la nuit`,
      text: `${state.player.name} a signalé jouer d'habitude entre minuit et 5 h : la mise à jour de 5 h peut interrompre ses parties.`,
      reward: 0, read: false, claimed: false, created: Date.now(),
    };
    try { await db.createMail(m); } catch (e) { console.warn('Signalement impossible', e); }
    toast('C\'est noté, merci ! 🌙');
    renderContest();
  }

  async function openContestRoom() {
    if (ctPreLaunch()) { toast('Le nouveau concours ouvre à 5 h : reviens tout à l\'heure !'); return; }
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
      // Deux choix d'abord ; les pièces ne s'affichent qu'après « À partir d'une de mes pièces ».
      $('#ctStartChoice').hidden = false;
      $('#ctStartPick').hidden = true;
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
      $('#ctStartFromRoom').onclick = () => { $('#ctStartChoice').hidden = true; $('#ctStartPick').hidden = false; };
      $('#ctStartBack').onclick = () => { $('#ctStartPick').hidden = true; $('#ctStartChoice').hidden = false; };
      $('#ctStartCancel').onclick = () => done(null);
      dlg.hidden = false;
    });
  }

  // Publier la pièce du concours ouverte (image de la pièce telle qu'elle est).
  async function publishContestRoom() {
    const r = currentRoom();
    if (!r || !r.contestDay) return;
    if (ctPreLaunch()) { toast('Le nouveau concours ouvre à 5 h : reviens tout à l\'heure !'); return; }
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
      contestTouched();
      const cur = currentRoom();
      if (cur) cur.publishedAt = Date.now();
      savePending = true;
      await saveRoom();
      // Première publication du jour : pièces de participation (tout de suite), et bonus de fidélité tous les N concours
      // (par message, à récupérer dans la boîte aux lettres).
      let joinMsg = '';
      if (state.profile.joinRewardDay !== r.contestDay) {
        await refreshProfile();
        if (state.profile.joinRewardDay !== r.contestDay) {
          const me = state.player.key;
          const join = setting('contestJoinReward');
          if (join > 0) {
            state.profile.points = (state.profile.points || 0) + join;
            joinMsg = ` +${join} 🪙 pour ta participation !`;
          }
          // Nombre de participations : relevé dans l'historique la première fois, puis tenu à jour.
          let count;
          try {
            count = state.profile.contestCount === undefined ? (await db.listMyContest(me)).length : state.profile.contestCount + 1;
          } catch (e) { console.warn('Participations non comptées', e); }
          let milestones = state.profile.contestMilestones || 0;
          let bonus = 0;
          if (count !== undefined) {
            const every = setting('contestMilestoneEvery'), prize = setting('contestMilestoneReward');
            const due = Math.floor(count / every) - milestones;
            milestones = Math.max(milestones, Math.floor(count / every));
            if (prize > 0 && due > 0) bonus = due * prize;
          }
          if (bonus > 0) {
            const m = {
              id: `contest-bonus-${r.contestDay}-${me}`, to: me, title: '🎉 Bonus de fidélité !',
              text: `Tu as participé à ${count} concours : bravo pour ta fidélité !\n\nVoici ta récompense : ${bonus} 🪙.`,
              reward: bonus, read: false, claimed: false, created: Date.now(),
            };
            try {
              if (await db.createMail(m)) state.mails.push(m);
              renderMailBadge();
              joinMsg += ` 🎉 ${count}e participation : ${bonus} 🪙 de bonus t'attendent dans ta boîte aux lettres 💌`;
            } catch (e) {
              console.warn('Message du bonus impossible', e);
              state.profile.points = (state.profile.points || 0) + bonus; // plutôt que de perdre le bonus
              joinMsg += ` 🎉 ${count}e participation : +${bonus} 🪙 de bonus !`;
            }
          }
          state.profile.joinRewardDay = r.contestDay;
          if (count !== undefined) { state.profile.contestCount = count; state.profile.contestMilestones = milestones; }
          saveProfile();
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
  // Plan des 7 prochains jours (pièce + thème), que l'on peut forcer jour par jour.
  const PLAN_KINDS = { object: 'Objet', color: 'Couleur', general: 'Thème général' };
  async function setPlanOverride(day, patch) {
    const all = { ...(state.settings.contestPlanOverrides || {}) };
    const oldest = shiftDay(today(), -10);
    for (const d of Object.keys(all)) if (d < oldest) delete all[d];
    const cur = { ...(all[day] || {}), ...patch };
    for (const k of Object.keys(cur)) if (cur[k] === '' || cur[k] == null) delete cur[k];
    if (Object.keys(cur).length) all[day] = cur; else delete all[day];
    state.settings.contestPlanOverrides = all;
    renderPlanAdmin();
    renderContestTile();
    await saveSettings();
  }
  function renderPlanAdmin() {
    const box = $('#acPlan');
    box.innerHTML = '';
    const rooms = contestRooms();
    for (let i = 0; i < 7; i++) {
      const day = shiftDay(today(), i);
      const ov = (state.settings.contestPlanOverrides && state.settings.contestPlanOverrides[day]) || {};
      const p = planOf(day);
      const row = document.createElement('div');
      row.className = 'ac-plan-row' + (ov.room || ov.kind ? ' forced' : '');
      row.innerHTML = `<div class="ac-plan-head"><strong class="ac-plan-day"></strong><span class="ac-plan-sum"></span></div>
        <div class="ac-plan-ctl">
          <select class="coffre-select ac-plan-room" aria-label="Pièce"></select>
          <select class="coffre-select ac-plan-kind" aria-label="Type de thème"></select>
          <span class="ac-plan-value"></span>
        </div>`;
      row.querySelector('.ac-plan-day').textContent = i === 0 ? 'Aujourd\'hui' : i === 1 ? 'Demain' : dayLabel(day);
      row.querySelector('.ac-plan-sum').textContent = p.room ? `${p.room} · ${p.text}` : p.text;
      const rs = row.querySelector('.ac-plan-room');
      rs.add(new Option(p.room ? `🎲 Pièce : ${p.room}` : 'Pas de pièce imposée', ''));
      rs.add(new Option(`${FREE_ROOM} (pas de pièce imposée)`, FREE_ROOM));
      const roomList = ov.room && !rooms.includes(ov.room) ? [ov.room, ...rooms] : rooms;
      for (const r of roomList) if (r !== FREE_ROOM) rs.add(new Option(r, r));
      rs.value = ov.room || '';
      rs.addEventListener('change', () => setPlanOverride(day, { room: rs.value }));
      const ks = row.querySelector('.ac-plan-kind');
      ks.add(new Option(`🎲 Type : ${PLAN_KINDS[p.kind] || 'Thème général'}`, ''));
      for (const [k, label] of Object.entries(PLAN_KINDS)) ks.add(new Option(label, k));
      ks.value = ov.kind || '';
      ks.addEventListener('change', () => setPlanOverride(day, { kind: ks.value, value: '', objectId: '' }));
      const val = row.querySelector('.ac-plan-value');
      if (p.kind === 'object') {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn ac-plan-obj';
        const img = state.images.get(p.objectId);
        b.innerHTML = '<img alt=""><span></span>';
        if (img) b.querySelector('img').src = img.url;
        b.querySelector('span').textContent = ov.objectId ? p.objectName : `🎲 ${p.objectName}`;
        b.addEventListener('click', () => openObjectPicker(day));
        val.appendChild(b);
        if (ov.objectId) {
          const auto = document.createElement('button');
          auto.type = 'button'; auto.className = 'btn btn-ghost'; auto.textContent = '🎲';
          auto.title = 'Revenir au tirage au sort';
          auto.addEventListener('click', () => setPlanOverride(day, { objectId: '' }));
          val.appendChild(auto);
        }
      } else {
        const vs = document.createElement('select');
        vs.className = 'coffre-select';
        vs.setAttribute('aria-label', p.kind === 'color' ? 'Couleur' : 'Thème général');
        const autoVal = p.kind === 'color' ? p.colorName : p.value;
        vs.add(new Option(`🎲 ${autoVal}`, ''));
        const opts = p.kind === 'color' ? contestColors().map((c) => c.name) : contestThemes();
        for (const o of opts) vs.add(new Option(o, o));
        vs.value = opts.includes(ov.value) ? ov.value : '';
        vs.addEventListener('change', () => setPlanOverride(day, { value: vs.value }));
        val.appendChild(vs);
      }
      box.appendChild(row);
    }
    $('#acRooms').value = rooms.join('\n');
    $('#acColors').value = contestColors().map((c) => `${c.name} ${c.hex}`).join('\n');
  }
  // Choix d'un objet précis pour un jour.
  const acObjPicker = $('#acObjPicker');
  let acObjDay = null;
  function openObjectPicker(day) {
    acObjDay = day;
    $('#acObjSearch').value = '';
    renderObjectPicker();
    acObjPicker.hidden = false;
  }
  function renderObjectPicker() {
    const q = normalizeText($('#acObjSearch').value);
    const pool = contestObjectPool(true).filter((i) => !q || normalizeText(objectLabel(i)).includes(q));
    $('#acObjCount').textContent = `${plural(pool.length, 'objet')} possible${pool.length > 1 ? 's' : ''}${pool.length > 400 ? ' (les 400 premiers sont affichés : précise ta recherche)' : ''}`;
    const list = $('#acObjList');
    list.innerHTML = '';
    for (const img of pool.slice(0, 400)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ac-obj-item';
      b.innerHTML = '<img alt="" loading="lazy"><span></span>';
      b.querySelector('img').src = img.url;
      b.querySelector('span').textContent = objectLabel(img);
      b.addEventListener('click', () => { acObjPicker.hidden = true; setPlanOverride(acObjDay, { kind: 'object', objectId: img.id, value: '' }); });
      list.appendChild(b);
    }
  }
  $('#acObjSearch').addEventListener('input', renderObjectPicker);
  $('#acObjPickClose').addEventListener('click', () => { acObjPicker.hidden = true; });
  acObjPicker.addEventListener('click', (e) => { if (e.target === acObjPicker) acObjPicker.hidden = true; });
  $('#acListsSave').addEventListener('click', async () => {
    const rooms = $('#acRooms').value.split('\n').map((x) => x.trim()).filter(Boolean);
    const colors = [];
    for (const line of $('#acColors').value.split('\n').map((x) => x.trim()).filter(Boolean)) {
      const m = line.match(/^(.*?)\s*(#[0-9a-fA-F]{6})?$/);
      const name = (m && m[1] ? m[1] : line).trim();
      if (name) colors.push({ name, hex: m && m[2] ? m[2].toLowerCase() : '#cccccc' });
    }
    const themes = $('#acThemes').value.split('\n').map((x) => x.trim()).filter(Boolean);
    // Modifier la liste décale le tirage au sort : on fige d'abord les jours déjà joués et aujourd'hui,
    // pour que seuls les jours à venir suivent la nouvelle liste.
    const frozen = { ...(state.settings.contestThemeOverrides || {}) };
    const plans = { ...(state.settings.contestPlanOverrides || {}) };
    for (let i = -10; i <= 0; i++) {
      const day = shiftDay(today(), i);
      if (day < CONTEST_NEW_FROM) { if (!frozen[day]) frozen[day] = themeOf(day); continue; }
      const p = planOf(day);
      if (p.kind === 'general' && !(plans[day] && plans[day].value)) plans[day] = { ...(plans[day] || {}), value: p.value };
    }
    state.settings.contestThemeOverrides = frozen;
    state.settings.contestPlanOverrides = plans;
    state.settings.contestRooms = rooms;
    state.settings.contestColors = colors;
    state.settings.contestThemes = themes;
    await saveSettings(`Listes enregistrées ✓ ${plural(rooms.length || DEFAULT_CONTEST_ROOMS.length, 'pièce')}, ${themes.length ? plural(themes.length, 'thème') : 'thèmes par défaut'}, ${plural(colors.length || DEFAULT_CONTEST_COLORS.length, 'couleur')}.`);
    renderPlanAdmin();
    renderContestTile();
  });

  let acTimer = null;
  async function openAdminContest() {
    if (!state.isAdmin) return;
    showScreen('adminContest');
    $('#acThemes').value = (Array.isArray(state.settings.contestThemes) && state.settings.contestThemes.length ? state.settings.contestThemes : DEFAULT_THEMES).join('\n');
    renderPlanAdmin();
    await refreshAdminContest();
    clearInterval(acTimer);
    // Mise à jour automatique pendant que l'écran est ouvert.
    // (toutes les 3 minutes, et seulement si l'écran est vraiment affiché : avant, toutes les 15 s, ça vidait le quota de Firebase)
    acTimer = setInterval(() => {
      if (screens.adminContest.hidden) { clearInterval(acTimer); return; }
      if (document.visibilityState !== 'visible') return;
      refreshAdminContest();
    }, 3 * 60000);
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
      [v, t] = await Promise.all([loadContestDay(shiftDay(today(), -1), true), loadContestDay(today(), true)]);
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
          toast(`Le cadeau n'a pas pu être récupéré (${(e && (e.code || e.message) || 'erreur').toString().slice(0, 60)}). Vérifie ta connexion.`);
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
    try { state.reports = await db.listReports(); } catch (e) { /* signalements indisponibles */ }
    const n = state.proposals.filter((p) => p.status === 'pending').length;
    const nr = (state.reports || []).length;
    $('#homeCoffreSub').textContent = (n ? `${plural(n, 'proposition')} à regarder` : 'Rien à valider') + (nr ? ` · 🚩 ${plural(nr, 'signalement')}` : '');
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

  // Archive un sticker accepté qui n'est dans aucune enveloppe (onglet « À ranger »).
  async function archiveProposal(p) {
    const rec = catalogOf(p);
    if (rec) { await archiveSticker(rec); return !!rec.archived; }
    const nrec = {
      id: uid(), catalog: true, envelope: null, archived: true, rarity: 'common',
      name: p.name, data: p.data, w: p.w, h: p.h, created: Date.now(),
      author: p.ownerName || p.owner, fromProposal: p.id,
    };
    try { await db.putImage(nrec); addImageToLibrary(nrec); return true; } catch (e) { console.warn('Archivage impossible', e); toast('Le sticker n\'a pas pu être archivé. Vérifie ta connexion.'); return false; }
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

  // Signalements des joueurs : objets erronés (regroupés par objet) et bugs.
  function renderReports() {
    const list = $('#coffreList');
    const reports = state.reports || [];
    $('#coffreEmpty').hidden = reports.length > 0;
    $('#coffreEmpty').textContent = 'Aucun signalement pour l\'instant.';
    const remove = async (ids) => {
      await Promise.all(ids.map((id) => db.deleteReport(id).catch(() => {})));
      state.reports = (state.reports || []).filter((r) => !ids.includes(r.id));
      renderCoffre();
      refreshCoffreCount();
    };
    const byStickers = new Map();
    for (const r of reports.filter((x) => x.kind === 'sticker')) { if (!byStickers.has(r.stickerId)) byStickers.set(r.stickerId, []); byStickers.get(r.stickerId).push(r); }
    for (const [sid, rs] of byStickers) {
      const img = state.images.get(sid);
      const card = document.createElement('article');
      card.className = 'coffre-card';
      card.innerHTML = '<div class="env-item-img"><img alt=""></div><div class="coffre-info"><h3></h3><p class="muted coffre-meta"></p><ul class="report-notes"></ul><div class="coffre-actions"></div></div>';
      if (img) card.querySelector('img').src = img.url;
      card.querySelector('h3').textContent = (img && img.name) || rs[0].stickerName || 'Objet';
      card.querySelector('.coffre-meta').textContent = `🚩 ${plural(rs.length, 'signalement')}${img && img.toFix ? ' · déjà à modifier 🏷️' : ''}`;
      const ul = card.querySelector('.report-notes');
      for (const r of rs) { const li = document.createElement('li'); li.textContent = `${r.ownerName || r.owner}${r.note ? ` : ${r.note}` : ''}`; ul.appendChild(li); }
      const actions = card.querySelector('.coffre-actions');
      const ids = rs.map((r) => r.id);
      if (img && !img.toFix) {
        const fix = document.createElement('button');
        fix.className = 'btn btn-primary';
        fix.textContent = '🏷️ Mettre à modifier';
        fix.addEventListener('click', async () => { await setToFix(img, true); toast(`« ${img.name} » est à modifier 🏷️`); remove(ids); });
        actions.appendChild(fix);
      }
      const ignore = document.createElement('button');
      ignore.className = 'btn btn-ghost';
      ignore.textContent = img && img.toFix ? 'Effacer' : 'Ignorer';
      ignore.addEventListener('click', () => remove(ids));
      actions.appendChild(ignore);
      list.appendChild(card);
    }
    for (const r of reports.filter((x) => x.kind === 'bug').sort((a, b) => (b.created || 0) - (a.created || 0))) {
      const card = document.createElement('article');
      card.className = 'coffre-card';
      card.innerHTML = '<div class="coffre-info"><h3></h3><p class="report-text"></p><details class="report-details"><summary>Détails techniques</summary><pre class="report-pre"></pre></details><div class="coffre-actions"></div></div>';
      card.querySelector('h3').textContent = `🐞 ${r.ownerName || r.owner} · ${r.created ? dateFmt.format(r.created) : ''}`;
      card.querySelector('.report-text').textContent = r.note || '';
      card.querySelector('.report-pre').textContent = `${r.device || ''}\n\n${r.traces || '(pas de traces)'}`;
      const del = document.createElement('button');
      del.className = 'btn btn-ghost';
      del.textContent = 'Supprimer';
      del.addEventListener('click', () => remove([r.id]));
      card.querySelector('.coffre-actions').appendChild(del);
      list.appendChild(card);
    }
  }

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
        // Le tag reste : c'est à l'administratrice de vérifier le nouveau dessin et de retirer le tag elle-même.
        if (img.updated !== before) { toast('Dessin remplacé ✓ Vérifie-le, puis retire le tag quand c\'est bon.'); renderCoffre(); }
      });
      const done = document.createElement('button');
      done.className = 'btn btn-ghost';
      done.textContent = '✓ C\'est bon, retirer le tag';
      done.addEventListener('click', async () => { await setToFix(img, false); renderCoffre(); });
      // Pour tester le dessin dans une pièce : un exemplaire de plus dans les objets de l'administratrice.
      const mine = document.createElement('button');
      mine.className = 'btn';
      mine.textContent = '➕ Dans mes objets';
      mine.title = 'Ajouter un exemplaire de cet objet à ta collection, pour le poser dans une pièce';
      mine.addEventListener('click', () => {
        state.profile.inventory = state.profile.inventory || {};
        state.profile.inventory[img.id] = (state.profile.inventory[img.id] || 0) + 1;
        saveProfile();
        toast(`« ${img.name} » est dans tes objets (${state.profile.inventory[img.id]} exemplaire${state.profile.inventory[img.id] > 1 ? 's' : ''}) ✓`);
      });
      actions.append(dl, rep, mine, done);
      list.appendChild(card);
    }
  }

  function renderCoffre() {
    if (document.activeElement !== coffreRewardInput) coffreRewardInput.value = proposalReward();
    document.querySelectorAll('.coffre-tab').forEach((tab) => {
      const n = tab.dataset.filter === 'tofix' ? toFixList().length : tab.dataset.filter === 'reports' ? (state.reports || []).length : state.proposals.filter((p) => coffreStatus(p) === tab.dataset.filter).length;
      tab.classList.toggle('active', tab.dataset.filter === coffreFilter);
      tab.querySelector('span').textContent = n;
    });
    const list = $('#coffreList');
    list.innerHTML = '';
    $('#coffreEmpty').textContent = 'Rien ici pour l\'instant.';
    if (coffreFilter === 'tofix') { $('#coffreAcceptAll').hidden = true; renderToFix(); return; }
    if (coffreFilter === 'reports') { $('#coffreAcceptAll').hidden = true; renderReports(); return; }
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
          // Un sticker à ranger qu'on ne veut pas ranger maintenant : on l'archive.
          if (!(rec && rec.archived)) button('📦 Archiver', '', async () => { if (await archiveProposal(p)) { toast(`« ${p.name} » est archivé 📦`); renderCoffre(); } });
        } else {
          if (rec && rec.archived) note('📦 Archivé', 'coffre-archived');
          else button('📦 Archiver', '', async () => { if (await archiveProposal(p)) { toast(`« ${p.name} » est archivé 📦`); renderCoffre(); } });
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

  // Montant de la récompense : réglé tout en haut du Coffre (même réglage que dans Paramétrage).
  const coffreRewardInput = $('#coffreReward');
  function coffreReward() {
    const v = Math.max(0, Math.round(Number(coffreRewardInput.value)));
    if (coffreRewardInput.value === '' || !Number.isFinite(v)) { coffreRewardInput.value = proposalReward(); return proposalReward(); }
    if (v !== proposalReward()) { state.settings.proposalReward = v; saveSettings(); }
    return v;
  }
  coffreRewardInput.addEventListener('change', coffreReward);

  async function acceptProposal(p) {
    const reward = coffreReward();
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
    const reward = coffreReward();
    if (!(await askConfirm(`Valider les ${list.length} propositions en attente, avec ${reward} 🪙 pour chaque joueur ?${give ? ' (Chacun recevra aussi son sticker en 1 exemplaire.)' : ''}`, `Tout valider (${list.length})`))) return;
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
  // Stickers validés mais dans aucune enveloppe : on les prend directement dans le catalogue (déjà chargé), sans dépendre
  // du chargement de toutes les propositions des joueurs (très lourd : le bouton restait grisé).
  const unfiledStickers = () => [...state.images.values()].filter((i) => i.catalog && !i.deco && !i.kind && !i.archived && !envelopeExists(i.envelope));
  const unfiledDialog = $('#unfiledDialog');
  let unfiledEnv = null;
  let unfiledPick = new Set();
  function openUnfiledPicker(env) {
    unfiledEnv = env;
    unfiledPick = new Set();
    $('#unfiledTitle').textContent = `Ranger dans « ${env.name || 'Enveloppe'} »`;
    const grid = $('#unfiledGrid');
    grid.innerHTML = '';
    for (const r of unfiledStickers().sort((a, b) => (b.created || 0) - (a.created || 0))) {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'env-item star-pick unfiled-pick';
      cell.innerHTML = '<div class="env-item-img"><img alt=""><span class="env-owned unfiled-check" hidden>✓</span></div><span class="env-item-name"></span><span class="unfiled-author muted"></span>';
      cell.querySelector('img').src = r.url;
      cell.querySelector('.env-item-name').textContent = r.name;
      cell.querySelector('.unfiled-author').textContent = r.author ? `par ${r.author}` : '';
      cell.addEventListener('click', () => {
        if (unfiledPick.has(r.id)) unfiledPick.delete(r.id); else unfiledPick.add(r.id);
        cell.classList.toggle('picked', unfiledPick.has(r.id));
        cell.querySelector('.unfiled-check').hidden = !unfiledPick.has(r.id);
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
    $('#unfiledArchive').disabled = !n;
    $('#unfiledAll').textContent = unfiledPick.size === unfiledStickers().length ? 'Tout désélectionner' : 'Tout sélectionner';
  }
  $('#unfiledAll').addEventListener('click', () => {
    const all = unfiledStickers();
    const selectAll = unfiledPick.size !== all.length;
    unfiledPick = new Set(selectAll ? all.map((p) => p.id) : []);
    document.querySelectorAll('#unfiledGrid .unfiled-pick').forEach((cell, i) => {
      cell.classList.toggle('picked', selectAll);
      cell.querySelector('.unfiled-check').hidden = !selectAll;
    });
    renderUnfiledButton();
  });
  $('#unfiledClose').addEventListener('click', () => { unfiledDialog.hidden = true; });
  // Archiver la sélection plutôt que de la ranger dans cette enveloppe.
  $('#unfiledArchive').addEventListener('click', async () => {
    const list = unfiledStickers().filter((r) => unfiledPick.has(r.id));
    if (!list.length) return;
    $('#unfiledArchive').disabled = true;
    let ok = 0;
    for (const r of list) { await archiveSticker(r); if (r.archived) ok++; }
    unfiledDialog.hidden = true;
    toast(`${plural(ok, 'sticker')} archivé${ok > 1 ? 's' : ''} 📦 : retrouve-${ok > 1 ? 'les' : 'le'} dans les Archives de l'atelier.`);
    renderAtelier();
  });
  $('#unfiledAdd').addEventListener('click', async () => {
    const env = unfiledEnv;
    const list = unfiledStickers().filter((r) => unfiledPick.has(r.id));
    if (!env || !list.length) return;
    $('#unfiledAdd').disabled = true;
    let ok = 0;
    for (const rec of list) {
      try {
        await db.updateImage(rec.id, { envelope: env.id, archived: false });
        rec.envelope = env.id;
        rec.archived = false;
        if (rec.fromProposal) {
          // Garde le lien avec la proposition d'origine (Coffre), sans bloquer si elle est introuvable.
          db.updateImage(rec.fromProposal, { usedIn: env.id }).catch(() => {});
          const p = (state.proposals || []).find((x) => x.id === rec.fromProposal);
          if (p) p.usedIn = env.id;
        }
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
  // Ma maison (test administratrice) : les pièces sont assemblées dans la même vue isométrique que la personnalisation.
  // Chaque pièce occupe un rectangle (sa largeur × sa profondeur, en carreaux) posé sur un plan commun. Dans une pièce,
  // on voit les voisines autour, dans le noir ; la pièce où l'on est reste allumée. Les étages viendront ensuite : les
  // données sont rangées par étage (house.floors[0] = le rez-de-chaussée).
  // ---------------------------------------------------------------------------
  const houseOn = () => state.isAdmin;
  const HOUSE_DIM = '<defs><filter id="houseDim" x="-5%" y="-5%" width="110%" height="110%" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values="0.26 0 0 0 0.02  0 0.26 0 0 0.02  0 0 0.36 0 0.07  0 0 0 1 0"/></filter></defs>';
  let houseFocus = null; // pièce allumée dans le plan de la maison
  const roomById = (id) => state.rooms.find((r) => r.id === id);
  const footprint = (id) => { const r = roomById(id); const sh = normShape(r && r.shape); return { w: sh.w, d: sh.d }; };
  function getHouse() {
    const p = state.profile;
    if (!p.house || !Array.isArray(p.house.floors) || !p.house.floors.length) p.house = { floors: [{ rooms: [] }] };
    return p.house;
  }
  // Pièces de la maison avec leur place (gu, gv = coin du fond, en carreaux). Une place manquante est trouvée automatiquement.
  function houseEntries() {
    const list = getHouse().floors[0].rooms;
    const ids = new Set(realRooms().map((r) => r.id));
    const kept = list.filter((e) => ids.has(e.id));
    let changed = kept.length !== list.length;
    const placed = [];
    for (const e of kept) {
      if (!Number.isFinite(e.gu) || !Number.isFinite(e.gv)) { const sp = houseSpot(e.id, placed); e.gu = sp.gu; e.gv = sp.gv; changed = true; }
      delete e.size;
      placed.push(e);
    }
    // Toutes les pièces partagent une même hauteur de murs : à défaut, la plus haute de celles déjà posées.
    if (kept.length && !getHouse().wallH) {
      getHouse().wallH = Math.max(...kept.map((e) => normShape((roomById(e.id) || {}).shape).h));
      changed = true;
    }
    if (changed) { getHouse().floors[0].rooms = kept; saveProfile(); }
    return kept;
  }
  const boxOf = (e) => { const f = footprint(e.id); return { u0: e.gu, v0: e.gv, u1: e.gu + f.w, v1: e.gv + f.d }; };
  const boxesOverlap = (a, b) => a.u0 < b.u1 && a.u1 > b.u0 && a.v0 < b.v1 && a.v1 > b.v0;
  // Première place libre contre une pièce déjà posée (à droite, à gauche, derrière ou devant), la plus proche du centre.
  function houseSpot(id, entries) {
    const f = footprint(id);
    if (!entries.length) return { gu: 0, gv: 0 };
    const boxes = entries.map(boxOf);
    const free = (u, v) => !boxes.some((b) => boxesOverlap(b, { u0: u, v0: v, u1: u + f.w, v1: v + f.d }));
    const cands = [];
    for (const b of boxes) cands.push([b.u1, b.v0], [b.u0 - f.w, b.v0], [b.u0, b.v0 - f.d], [b.u0, b.v1]);
    const ok = cands.filter(([u, v]) => free(u, v)).sort((x, y) => (Math.abs(x[0]) + Math.abs(x[1])) - (Math.abs(y[0]) + Math.abs(y[1])));
    return ok.length ? { gu: ok[0][0], gv: ok[0][1] } : { gu: Math.max(...boxes.map((b) => b.u1)), gv: 0 };
  }
  // Une pièce (murs, sol, objets) dessinée à l'échelle kw, son coin du fond en `origin`. Dans le noir si dim.
  function houseRoomSvg(r, kw, origin, dim) {
    const shp = houseShape(r.id, r.shape);
    const g0 = roomGeom(shp);
    const f = kw / g0.k;
    const stickers = (r.stickers || []).map((st) => {
      const img = state.images.get(st.imageId);
      if (!img) return '';
      const w = st.w * f, h = st.h * f;
      const x = origin.x + (st.x - g0.C.x) * f, y = origin.y + (st.y - g0.C.y) * f;
      return `<image href="${img.url}" x="${(x - w / 2).toFixed(1)}" y="${(y - h / 2).toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" preserveAspectRatio="none" transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${st.rot || 0}) scale(${st.flip ? -1 : 1} 1) translate(${(-x).toFixed(1)} ${(-y).toFixed(1)})"/>`;
    }).join('');
    return `<g class="nb-room" data-room="${escXml(r.id)}"${dim ? ' filter="url(#houseDim)"' : ''}>${roomSvg(r.colors || {}, shp, { k: kw, origin, flat: true })}${stickers}</g>`;
  }
  // Dans une pièce : les voisines autour, dans le noir (dessinées derrière la pièce, hors de l'export en image).
  function drawHouseNeighbors() {
    const svg = $('#houseNb');
    if (!svg) return;
    const cur = currentRoom();
    const entries = houseOn() && cur && !cur.contestDay ? houseEntries() : [];
    const me = entries.find((e) => e.id === cur.id);
    if (!me) { svg.innerHTML = ''; return; }
    const g = roomGeom(state.shape);
    const out = [...entries].filter((e) => e.id !== cur.id).sort((a, b) => (a.gu + a.gv) - (b.gu + b.gv)).map((e) => {
      const r = roomById(e.id);
      if (!r) return '';
      const du = e.gu - me.gu, dv = e.gv - me.gv;
      return houseRoomSvg(r, g.k, { x: g.C.x + (du - dv) * TILE_X * g.k, y: g.C.y + (du + dv) * TILE_Y * g.k }, true);
    });
    svg.innerHTML = HOUSE_DIM + out.join('');
  }
  // Touche sur une pièce voisine (dans le noir) : on y va. Renvoie son id, ou null si on a touché la pièce actuelle.
  function neighborAt(x, y) {
    if (!houseOn()) return null;
    for (const el of document.elementsFromPoint(x, y)) {
      if (el.id === 'room' || el.id === 'houseNb' || el.id === 'stage' || el.id === 'stickerLayer' || el.id === 'lightLayer' || el.id === 'lightHandles' || el === stageArea) continue;
      if (el.closest && el.closest('#room')) return null;
      const g = el.closest && el.closest('.nb-room');
      if (g && g.closest('#houseNb')) return g.dataset.room;
    }
    return null;
  }
  async function goHouseRoom(id) {
    if (!id) return;
    select(null);
    await saveRoom();
    openRoom(id);
  }
  function renderHouseNav() {
    const r = currentRoom();
    $('#btnHouse').hidden = !(houseOn() && r && !r.contestDay);
  }

  // Le plan de la maison : toutes les pièces dans la vue isométrique, la pièce choisie allumée.
  function renderHouse() {
    const entries = houseEntries();
    const svg = $('#housePlan');
    if (!entries.some((e) => e.id === houseFocus)) houseFocus = null; // rien n'est choisi tant qu'on ne touche pas une pièce
    $('#houseView').classList.toggle('empty', !entries.length);
    if (!entries.length) svg.innerHTML = '';
    else {
      // Toutes les pièces à l'échelle 1 ; la caméra (zoom, déplacement) agit sur le viewBox.
      const draw = (e, dim) => houseRoomSvg(roomById(e.id), 1, { x: (e.gu - e.gv) * TILE_X, y: (e.gu + e.gv) * TILE_Y }, dim);
      const back = [...entries].filter((e) => e.id !== houseFocus).sort((a, b) => (a.gu + a.gv) - (b.gu + b.gv));
      const lit = entries.find((e) => e.id === houseFocus);
      const labels = entries.map((e) => {
        const r = roomById(e.id), sh = normShape(r.shape);
        const x = (e.gu - e.gv + (sh.w - sh.d) / 2) * TILE_X, y = (e.gu + e.gv + (sh.w + sh.d) / 2) * TILE_Y;
        const on = e.id === houseFocus;
        const name = escXml(r.name.length > 16 ? r.name.slice(0, 15) + '…' : r.name);
        return `<g class="house-label${on ? ' on' : ''}" transform="translate(${x.toFixed(1)} ${y.toFixed(1)})" pointer-events="none"><rect x="-${(name.length * 5.6 + 14).toFixed(0)}" y="-14" width="${(name.length * 11.2 + 28).toFixed(0)}" height="28" rx="14" fill="${on ? '#FFF8EF' : '#2c2433'}" stroke="${on ? '#5A3E3A' : '#6b5c78'}" stroke-width="2.5"/><text y="6" text-anchor="middle" font-family="Fredoka,sans-serif" font-weight="600" font-size="16" fill="${on ? '#5A3E3A' : '#cbbfd6'}">${name}</text></g>`;
      }).join('');
      // Au plan, tout est allumé (on assemble) ; la pièce choisie a juste un halo. Le noir est réservé à l'intérieur d'une pièce.
      const all = [...entries].sort((a, b) => (a.gu + a.gv) - (b.gu + b.gv));
      svg.innerHTML = all.map((e) => draw(e, false).replace('<g class="nb-room"', e.id === houseFocus ? '<g class="nb-room sel"' : '<g class="nb-room"')).join('') + labels;
    }
    applyHouseView();
    // Barre de la pièce choisie : Entrer, Taille, Déplacer… (rien n'est affiché si aucune pièce n'est choisie)
    if (houseFocus !== houseToolFor) { houseTool = null; houseToolFor = houseFocus; }
    const box = $('#houseControls');
    box.innerHTML = '';
    const me = entries.find((e) => e.id === houseFocus);
    const room = me && roomById(me.id);
    if (room) {
      const f = footprint(room.id);
      const t = document.createElement('p');
      t.className = 'house-focus-name';
      t.textContent = `${room.name} · ${f.w} × ${f.d} carreaux`;
      box.appendChild(t);
      const bar = document.createElement('div');
      bar.className = 'house-bar';
      box.appendChild(bar);
      const btn = (label, cls, fn, title, host = bar) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn ' + cls; b.innerHTML = label; if (title) b.title = title; b.addEventListener('click', fn); host.appendChild(b); return b; };
      const row1 = document.createElement('div'), row2 = document.createElement('div');
      row1.className = row2.className = 'house-bar-row';
      bar.append(row1, row2);
      btn('✏️ Entrer dans la pièce', 'btn-primary', () => goHouseRoom(room.id), 'Décorer cette pièce', row1);
      btn('Retirer', 'btn-ghost', () => { getHouse().floors[0].rooms = entries.filter((e) => e !== me); houseFocus = null; saveProfile(); renderHouse(); fitHouse(); }, 'La pièce n\'est pas supprimée : elle reste dans les brouillons.', row1);
      btn('📐 Taille', houseTool === 'size' ? 'active' : '', () => { houseTool = houseTool === 'size' ? null : 'size'; renderHouse(); }, 'Changer la taille de la pièce', row2);
      btn('✥ Déplacer', houseTool === 'move' ? 'active' : '', () => { houseTool = houseTool === 'move' ? null : 'move'; renderHouse(); }, 'Déplacer la pièce', row2);
      if (houseTool === 'size') {
        // Taille : les voisines s'écartent toutes seules si besoin.
        const sz = normShape(room.shape);
        for (const [axis, lab] of [['w', 'Largeur'], ['d', 'Profondeur']]) {
          const row = document.createElement('div');
          row.className = 'house-step';
          row.innerHTML = `<span class="muted">${lab} :</span>`;
          for (const d of [-1, 1]) {
            const b = document.createElement('button');
            b.type = 'button'; b.className = 'btn'; b.textContent = d < 0 ? '−' : '+';
            b.setAttribute('aria-label', `${lab} ${d < 0 ? 'moins' : 'plus'}`);
            b.addEventListener('click', () => resizeHouseRoom(me, axis, d));
            row.appendChild(b);
            if (d < 0) { const v = document.createElement('strong'); v.textContent = `${sz[axis]}`; row.appendChild(v); }
          }
          box.appendChild(row);
        }
      } else if (houseTool === 'move') {
        // Les flèches suivent les deux directions du plan (comme les murs de la pièce) : en croix, avec « Rapprocher » à côté.
        const pad = document.createElement('div');
        pad.className = 'house-movebox';
        const cross = document.createElement('div');
        cross.className = 'house-cross';
        const cell = { '↖': 'a1', '↗': 'a3', '↙': 'a7', '↘': 'a9' };
        const dirs = [['↖', -1, 0, 'vers le haut à gauche'], ['↗', 0, -1, 'vers le haut à droite'], ['↙', 0, 1, 'vers le bas à gauche'], ['↘', 1, 0, 'vers le bas à droite']];
        for (const [label, du, dv, title] of dirs) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'btn ' + cell[label];
          b.textContent = label;
          b.title = `Déplacer ${title}`;
          b.setAttribute('aria-label', `Déplacer la pièce ${title}`);
          b.addEventListener('click', () => moveHouseRoom(me, du * houseStep, dv * houseStep));
          cross.appendChild(b);
        }
        const mid = document.createElement('span');
        mid.className = 'cross-mid';
        mid.textContent = '✥';
        cross.appendChild(mid);
        pad.appendChild(cross);
        const side = document.createElement('div');
        side.className = 'house-moveside';
        side.innerHTML = `<span class="muted">Pas : ${houseStep} carreau${houseStep > 1 ? 'x' : ''}</span>`;
        btn('Rapprocher', '', () => snapHouseRoom(me), 'Colle la pièce contre ses voisines', side);
        pad.appendChild(side);
        box.appendChild(pad);
      }
    }
    renderHouseSettings(entries);
    const used = new Set(entries.map((e) => e.id));
    const freeRooms = realRooms().filter((r) => !used.has(r.id));
    $('#houseRoomsCount').textContent = freeRooms.length ? `· ${plural(freeRooms.length, 'brouillon')}` : '';
    if (!$('#housePanel').hidden) renderHouseDrafts(freeRooms);
  }
  let houseStep = 1;
  let houseTool = null, houseToolFor = null; // outil ouvert dans la barre : 'size' | 'move'
  // Roue crantée : réglages communs à toute la maison (pas de déplacement, hauteur des murs).
  function renderHouseSettings(entries) {
    const box = $('#houseSettings');
    if (box.hidden) return;
    box.innerHTML = '<strong>Réglages</strong>';
    const row = (label) => { const d = document.createElement('div'); d.className = 'house-step'; d.innerHTML = `<span class="muted">${label}</span>`; box.appendChild(d); return d; };
    const st = row('Pas de déplacement :');
    for (const n of [1, 4]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'deco-tab' + (houseStep === n ? ' active' : '');
      b.textContent = `${n} carreau${n > 1 ? 'x' : ''}`;
      b.addEventListener('click', () => { houseStep = n; renderHouse(); });
      st.appendChild(b);
    }
    const hh = row('Hauteur des murs (toute la maison) :');
    const first = entries[0] && roomById(entries[0].id);
    const cur = getHouse().wallH || (first ? normShape(first.shape).h : 5);
    const setH = (v) => { getHouse().wallH = clamp(v, WALL_MIN, WALL_MAX); saveProfile(); renderHouse(); fitHouse(); };
    for (const d of [-1, 1]) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'btn'; b.textContent = d < 0 ? '−' : '+'; b.setAttribute('aria-label', d < 0 ? 'Murs plus bas' : 'Murs plus hauts');
      b.addEventListener('click', () => setH(cur + d));
      hh.appendChild(b);
      if (d < 0) { const v = document.createElement('strong'); v.textContent = cur; hh.appendChild(v); }
    }
  }
  $('#houseGear').addEventListener('click', () => { const box = $('#houseSettings'); box.hidden = !box.hidden; renderHouse(); });
  // Une pièce ne peut pas en recouvrir une autre.
  function moveHouseRoom(e, du, dv) {
    const moved = { ...e, gu: e.gu + du, gv: e.gv + dv };
    if (houseEntries().some((o) => o.id !== e.id && boxesOverlap(boxOf(moved), boxOf(o)))) { toast('Il y a déjà une pièce à cet endroit : elles ne peuvent pas se chevaucher.'); return; }
    e.gu = moved.gu; e.gv = moved.gv;
    saveProfile();
    renderHouse();
  }
  // Change la taille d'une pièce depuis le plan. Les voisines qui se retrouvent recouvertes sont repoussées (et ainsi de suite).
  function resizeHouseRoom(e, axis, delta) {
    const r = roomById(e.id);
    if (!r) return;
    const sh = normShape(r.shape);
    const nv = clamp(sh[axis] + delta, SIZE_MIN, SIZE_MAX);
    if (nv === sh[axis]) return;
    r.shape = normShape({ ...sh, [axis]: nv });
    r.thumb = '';
    r.updated = Date.now();
    db.putRoom(r).catch(() => toast('La nouvelle taille n\'a pas pu être enregistrée.'));
    if (delta > 0) {
      const entries = houseEntries();
      const key = axis === 'w' ? 'gu' : 'gv';
      const queue = [e];
      let guard = 0;
      while (queue.length && guard++ < 300) {
        const a = queue.shift();
        for (const o of entries) {
          if (o === a || o === e || !boxesOverlap(boxOf(a), boxOf(o))) continue;
          const b = boxOf(a);
          o[key] = axis === 'w' ? b.u1 : b.v1;
          queue.push(o);
        }
      }
    }
    saveProfile();
    renderHouse();
  }
  // Colle la pièce contre ses voisines : on la fait glisser vers le centre tant qu'elle ne chevauche rien.
  function snapHouseRoom(e) {
    const others = houseEntries().filter((o) => o.id !== e.id);
    if (!others.length) return;
    let moved = true, guard = 0;
    while (moved && guard++ < 60) {
      moved = false;
      for (const [du, dv] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const cx = others.reduce((a, o) => a + o.gu, 0) / others.length, cy = others.reduce((a, o) => a + o.gv, 0) / others.length;
        const nxt = { ...e, gu: e.gu + du, gv: e.gv + dv };
        const closer = Math.abs(nxt.gu - cx) + Math.abs(nxt.gv - cy) < Math.abs(e.gu - cx) + Math.abs(e.gv - cy);
        if (closer && !others.some((o) => boxesOverlap(boxOf(nxt), boxOf(o)))) { e.gu = nxt.gu; e.gv = nxt.gv; moved = true; break; }
      }
    }
    saveProfile();
    renderHouse();
  }
  function addToHouse(id) {
    const sp = houseSpot(id, houseEntries());
    getHouse().floors[0].rooms.push({ id, gu: sp.gu, gv: sp.gv });
    houseFocus = id;
    saveProfile();
    setHousePanel(false);
    renderHouse();
    fitHouse();
  }
  // Les pièces pas encore placées sont des brouillons : on peut les ouvrir, les placer, les renommer, les copier ou les supprimer.
  function renderHouseDrafts(free) {
    const box = $('#houseDrafts');
    box.innerHTML = `<h3 class="house-drafts-title">Brouillons <span class="muted">(pas encore dans la maison)</span></h3>`;
    const row = document.createElement('div');
    row.className = 'house-drafts-row';
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'house-draft house-draft-new';
    add.innerHTML = '<span class="room-new-plus">＋</span><span>Nouvelle pièce</span>';
    add.addEventListener('click', createRoom);
    row.appendChild(add);
    for (const r of free.sort((a, b) => (b.updated || 0) - (a.updated || 0))) {
      const card = document.createElement('article');
      card.className = 'house-draft';
      const preview = r.thumb ? '<img class="room-thumb" alt="">' : `<svg class="room-thumb" viewBox="0 0 1000 760" xmlns="http://www.w3.org/2000/svg">${roomSvg(r.colors, r.shape)}</svg>`;
      card.innerHTML = `<button class="room-open" title="Ouvrir">${preview}</button><p class="house-draft-name"></p>
        <div class="house-draft-actions"><button data-act="place" class="btn btn-primary" title="Placer dans la maison">＋ Maison</button>
        <button data-room-act="rename" title="Renommer">✏️</button><button data-room-act="duplicate" title="Dupliquer">⧉</button><button data-room-act="delete" title="Supprimer" class="danger">🗑️</button></div>`;
      if (r.thumb) card.querySelector('img').src = r.thumb;
      if (r.colors && r.colors.background) card.querySelector('.room-open').style.background = r.colors.background;
      card.querySelector('.house-draft-name').textContent = `${r.name || 'Sans nom'} · ${footprint(r.id).w}×${footprint(r.id).d}`;
      card.querySelector('.room-open').addEventListener('click', () => openRoom(r.id));
      card.querySelector('.house-draft-actions').addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        if (b.dataset.act === 'place') addToHouse(r.id);
        else if (b.dataset.roomAct) roomAction(b.dataset.roomAct, r);
      });
      row.appendChild(card);
    }
    box.appendChild(row);
  }
  function openHousePicker() {
    const used = new Set(houseEntries().map((e) => e.id));
    const free = realRooms().filter((r) => !used.has(r.id)).sort((a, b) => (b.updated || 0) - (a.updated || 0));
    const box = $('#housePickList');
    box.innerHTML = '';
    for (const r of free) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ct-start-room';
      b.innerHTML = (r.thumb ? '<img class="room-thumb" alt="">' : `<svg class="room-thumb" viewBox="0 0 1000 760" xmlns="http://www.w3.org/2000/svg">${roomSvg(r.colors, r.shape)}</svg>`) + '<span class="ct-start-name"></span>';
      if (r.thumb) b.querySelector('img').src = r.thumb;
      b.querySelector('.ct-start-name').textContent = `${r.name} (${footprint(r.id).w} × ${footprint(r.id).d})`;
      b.addEventListener('click', () => {
        const sp = houseSpot(r.id, houseEntries());
        getHouse().floors[0].rooms.push({ id: r.id, gu: sp.gu, gv: sp.gv });
        houseFocus = r.id;
        saveProfile();
        $('#housePicker').hidden = true;
        renderHouse();
        fitHouse();
      });
      box.appendChild(b);
    }
    $('#housePicker').hidden = false;
  }
  $('#housePickClose').addEventListener('click', () => { $('#housePicker').hidden = true; });
  $('#housePicker').addEventListener('click', (e) => { if (e.target.id === 'housePicker') $('#housePicker').hidden = true; });
  // Caméra du plan (plein écran) : on déplace avec un doigt ou la souris, on zoome en pinçant ou avec la molette.
  const hv = { cx: 0, cy: 0, upp: 1, fit: 1 }; // upp = unités du dessin par pixel d'écran
  const houseStageEl = $('#houseView');
  function houseBounds() {
    const entries = houseEntries();
    if (!entries.length) return null;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const e of entries) {
      const sh = normShape(houseShape(e.id, roomById(e.id).shape));
      const X = (e.gu - e.gv) * TILE_X, Y = (e.gu + e.gv) * TILE_Y;
      minX = Math.min(minX, X - sh.d * TILE_X); maxX = Math.max(maxX, X + sh.w * TILE_X);
      minY = Math.min(minY, Y - Math.max(sh.h, 3) * TILE_Z); maxY = Math.max(maxY, Y + (sh.w + sh.d) * TILE_Y);
    }
    return { minX, maxX, minY, maxY };
  }
  function applyHouseView() {
    const rect = houseStageEl.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const w = rect.width * hv.upp, h = rect.height * hv.upp;
    $('#housePlan').setAttribute('viewBox', `${(hv.cx - w / 2).toFixed(1)} ${(hv.cy - h / 2).toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)}`);
  }
  // Tout voir : toute la maison dans l'écran.
  function fitHouse() {
    const b = houseBounds();
    const rect = houseStageEl.getBoundingClientRect();
    if (!b || !rect.width) return;
    const pad = 40;
    hv.upp = Math.max((b.maxX - b.minX + pad * 2) / rect.width, (b.maxY - b.minY + pad * 2) / (rect.height * 0.85));
    hv.fit = hv.upp;
    hv.cx = (b.minX + b.maxX) / 2;
    hv.cy = (b.minY + b.maxY) / 2 + (rect.height * 0.04) * hv.upp; // un peu plus haut : la barre flottante est en bas
    applyHouseView();
  }
  function zoomHouse(factor, clientX, clientY) {
    const rect = houseStageEl.getBoundingClientRect();
    const px = (clientX ?? rect.left + rect.width / 2) - (rect.left + rect.width / 2);
    const py = (clientY ?? rect.top + rect.height / 2) - (rect.top + rect.height / 2);
    const upp = Math.min(Math.max(hv.upp / factor, 0.2), Math.max(hv.fit * 2.4, 0.5));
    // Le point sous le doigt reste en place.
    hv.cx += px * (hv.upp - upp);
    hv.cy += py * (hv.upp - upp);
    hv.upp = upp;
    applyHouseView();
  }
  const hPointers = new Map();
  let hMoved = false, hPinch = 0;
  houseStageEl.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.house-float, .house-zoom, .house-settings, .house-panel, .house-rooms-btn, .house-info-btn, .house-info')) return;
    houseStageEl.setPointerCapture(e.pointerId);
    hPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (hPointers.size === 1) hMoved = false;
    if (hPointers.size === 2) { const [a, b] = [...hPointers.values()]; hPinch = Math.hypot(a.x - b.x, a.y - b.y); hMoved = true; }
  });
  houseStageEl.addEventListener('pointermove', (e) => {
    const p = hPointers.get(e.pointerId);
    if (!p) return;
    if (hPointers.size === 2) {
      const before = [...hPointers.values()];
      hPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const now = [...hPointers.values()];
      const d = Math.hypot(now[0].x - now[1].x, now[0].y - now[1].y);
      const mx = (now[0].x + now[1].x) / 2, my = (now[0].y + now[1].y) / 2;
      const pmx = (before[0].x + before[1].x) / 2, pmy = (before[0].y + before[1].y) / 2;
      hv.cx -= (mx - pmx) * hv.upp; hv.cy -= (my - pmy) * hv.upp; // déplacement des deux doigts
      if (hPinch) zoomHouse(d / hPinch, mx, my);
      hPinch = d;
      return;
    }
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.tx = (p.tx || 0) + Math.abs(dx); p.ty = (p.ty || 0) + Math.abs(dy);
    if (p.tx + p.ty > 8) hMoved = true;
    if (hMoved) { hv.cx -= dx * hv.upp; hv.cy -= dy * hv.upp; applyHouseView(); }
    p.x = e.clientX; p.y = e.clientY;
  });
  const hEnd = (e) => {
    const had = hPointers.has(e.pointerId);
    hPointers.delete(e.pointerId);
    if (!had) return;
    if (!hPointers.size && !hMoved && e.type === 'pointerup') {
      // Simple toucher : on choisit la pièce touchée.
      let found = null;
      for (const el of document.elementsFromPoint(e.clientX, e.clientY)) {
        const g = el.closest && el.closest('.nb-room');
        if (g && g.closest('#housePlan')) { found = g.dataset.room; break; }
      }
      // Toucher à côté des pièces : plus aucune pièce n'est choisie (et les réglages se referment).
      houseFocus = found;
      $('#houseSettings').hidden = true;
      $('#houseInfo').hidden = true;
      setHousePanel(false);
      renderHouse();
    }
    if (hPointers.size < 2) hPinch = 0;
  };
  houseStageEl.addEventListener('pointerup', hEnd);
  houseStageEl.addEventListener('pointercancel', hEnd);
  houseStageEl.addEventListener('wheel', (e) => { e.preventDefault(); zoomHouse(Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY); }, { passive: false });
  $('#houseZoomIn').addEventListener('click', () => zoomHouse(1.4));
  $('#houseZoomOut').addEventListener('click', () => zoomHouse(1 / 1.4));
  $('#houseFit').addEventListener('click', fitHouse);
  // Les pièces (brouillons) : un bouton ouvre la liste, qui se referme d'un toucher ailleurs.
  $('#houseInfoBtn').addEventListener('click', () => {
    const box = $('#houseInfo');
    box.hidden = !box.hidden;
    $('#houseInfoBtn').setAttribute('aria-expanded', String(!box.hidden));
  });
  const setHousePanel = (open) => { $('#housePanel').hidden = !open; };
  $('#houseRoomsBtn').addEventListener('click', () => { setHousePanel($('#housePanel').hidden); $('#houseSettings').hidden = true; renderHouse(); });
  $('#housePanelClose').addEventListener('click', () => setHousePanel(false));
  if (window.ResizeObserver) new ResizeObserver(() => { if (!screens.house.hidden) applyHouseView(); }).observe(houseStageEl);
  let houseFrom = 'home';
  function openHouse(focusId = null, from = 'home') {
    if (!houseOn()) return;
    houseFrom = from;
    houseFocus = focusId;
    setHousePanel(false);
    $('#houseSettings').hidden = true;
    showScreen('house');
    renderHouse();
    fitHouse();
  }
  $('#homeHouse').addEventListener('click', () => openHouse(null, 'home'));
  $('#btnHouse').addEventListener('click', async () => { const id = state.roomId; select(null); await saveRoom(); state.roomId = null; openHouse(id, 'room'); });
  $('#houseBack').addEventListener('click', () => { if (houseFrom === 'room' && houseFocus && roomById(houseFocus)) openRoom(houseFocus); else goHome(); });

  // ---------------------------------------------------------------------------
  // To-do (administratrice) : idées et tâches, qu'on peut ajouter, modifier, ranger et cocher
  // ---------------------------------------------------------------------------
  const TODO_CATS = { todo: 'À faire', later: 'Peut-être plus tard', bug: 'Petit défaut' };
  // Liste de départ : reprise de IDEES.md (importée une seule fois, à la première ouverture).
  const TODO_SEED = [
    ['todo', 0, '**Papiers peints et sols** (en test chez l\'administratrice) : motifs plats importés dans l\'Atelier décor, vendus un par un dans la boutique (2 étoiles pour débloquer), choisis par pièce. À ouvrir aux joueurs une fois testé.'],
    ['todo', 0, '**Troc** : échanger des stickers entre joueurs.'],
    ['todo', 0, '**Mini-jeux pour gagner des pièces** (par exemple un Memory avec les stickers).'],
    ['todo', 0, '**Voter pour le thème suivant** du concours.'],
    ['todo', 0, '**Ma maison** : avoir sa maison à décorer (plusieurs pièces réunies), et pouvoir aller visiter la maison des autres joueurs.'],
    ['todo', 0, '**Boîte à idées pour les joueurs** : un espace où les joueurs envoient leurs idées pour le jeu, que l\'administratrice lit de son côté.'],
    ['todo', 1, '**Historique de mes pièces de concours** : thème, date et résultat de chaque participation.'],
    ['todo', 1, '**Concours du jour** : un thème par jour, on publie sa pièce, vote le lendemain jusqu\'à 20 h, gagnant dévoilé et récompensé à 20 h. Thèmes et récompense réglables dans l\'Atelier.'],
    ['todo', 1, 'Palette de couleurs : 8 couleurs en mémoire, curseurs placés sur la couleur actuelle.'],
    ['todo', 1, 'Couleurs des murs et du sol des étages.'],
    ['todo', 1, '**Nouveautés** : fenêtre « Quoi de neuf ? » à la connexion et menu ✨ Nouveautés (l\'administratrice peut en écrire).'],
    ['todo', 1, '**Aménager les pièces** (à débloquer avec des étoiles) : jardin, taille sur mesure, étages au fond de la pièce. Prix réglables dans l\'Atelier.'],
    ['todo', 1, 'Nombre d\'étoiles affiché à côté des pièces.'],
    ['todo', 1, '**Étoile depuis une collection** : bouton « 🌟 Utiliser une étoile » dans le classeur (et « 🌟 Étoile » dans l\'aperçu d\'une enveloppe), qui ne propose que les stickers de cette enveloppe.'],
    ['todo', 1, '**Agrandir la fenêtre de sélection des stickers** (le panneau où on choisit les stickers à poser dans une pièce). Bouton ⤢ à côté de la Boutique.'],
    ['todo', 1, '**Télécharger une image** : bouton ⬇️ dans le Coffre (image envoyée par le joueur) et dans l\'Atelier (dessin d\'un sticker), en PNG.'],
    ['todo', 1, '**Remplacer l\'image d\'un sticker** : pouvoir réimporter une nouvelle image sur un sticker existant (pour améliorer son dessin) sans le perdre : les joueurs qui l\'ont et les pièces où il est posé gardent le sticker, avec le nouveau dessin.'],
    ['todo', 1, 'Atelier réorganisé : liste des enveloppes, recherche, une enveloppe à la fois.'],
    ['todo', 1, 'Offrir des stickers et des pièces aux joueurs.'],
    ['todo', 1, '**Enveloppes du jour** : 5 enveloppes à prix réduit chaque jour, les autres plus chères (réglable dans Paramétrage).'],
    ['todo', 1, 'Message de bienvenue et cadeau de bienvenue (réglable dans Paramétrage) pour les nouveaux joueurs.'],
    ['todo', 1, 'Messages aux joueurs avec un titre et un texte long (à un joueur ou à tous).'],
    ['todo', 1, 'Coffre : onglet « À ranger » et archives.'],
  ];
  let todos = [];
  let todoTab = 'todo';
  let todoEditing = null; // id de l'élément en cours de modification

  const cleanTodoText = (t) => t.replace(/\*\*/g, '');
  async function loadTodos() {
    let list = (await db.listTodos()) || [];
    if (!list.some((t) => t.meta)) {
      // Première ouverture : on reprend la liste d'idées de départ (identifiants fixes : jamais en double).
      const now = Date.now();
      const seeded = TODO_SEED.map(([cat, done, text], i) => ({
        id: `todo-seed-${String(i + 1).padStart(2, '0')}`, cat, done: !!done, text: cleanTodoText(text),
        order: i + 1, created: now - (TODO_SEED.length - i) * 1000, ...(done ? { doneAt: now - (TODO_SEED.length - i) * 1000 } : {}),
      }));
      for (const t of seeded) { if (!list.some((x) => x.id === t.id)) await db.putTodo(t); }
      await db.putTodo({ id: 'todo-meta', meta: true, seeded: true });
      list = [...list.filter((x) => !x.meta), ...seeded.filter((t) => !list.some((x) => x.id === t.id)), { id: 'todo-meta', meta: true }];
    }
    todos = list.filter((t) => !t.meta);
  }
  async function saveTodo(t) {
    t.updated = Date.now();
    try { await db.putTodo(t); } catch (e) {
      console.warn('To-do non enregistrée', e);
      toast('Le changement n\'a pas pu être enregistré. Vérifie ta connexion.');
    }
  }
  const todoSorted = (cat) => todos.filter((t) => (cat === 'done' ? t.done : !t.done && t.cat === cat))
    .sort((a, b) => (cat === 'done' ? (b.doneAt || 0) - (a.doneAt || 0) : (a.order || 0) - (b.order || 0) || (a.created || 0) - (b.created || 0)));

  function renderTodo() {
    document.querySelectorAll('#todoTabs .deco-tab').forEach((tab) => {
      tab.classList.toggle('active', tab.dataset.cat === todoTab);
      tab.querySelector('span').textContent = todoSorted(tab.dataset.cat).length;
    });
    const list = $('#todoList');
    list.innerHTML = '';
    const items = todoSorted(todoTab);
    $('#todoEmpty').hidden = items.length > 0;
    $('#todoEmpty').textContent = todoTab === 'done' ? 'Rien de fait pour l\'instant : coche une tâche quand elle est terminée.' : 'Rien ici pour l\'instant. Ajoute une idée avec le champ du haut !';
    $('#homeTodoSub').textContent = `${plural(todoSorted('todo').length, 'chose')} à faire`;
    items.forEach((t, i) => {
      const li = document.createElement('li');
      li.className = 'todo-item' + (t.done ? ' done' : '');
      li.innerHTML = `
        <input type="checkbox" class="todo-check" aria-label="Fait">
        <div class="todo-body"><span class="todo-text" tabindex="0" role="button" title="Toucher pour modifier"></span><span class="todo-meta muted"></span></div>
        <div class="todo-actions">
          <button type="button" class="btn btn-ghost todo-up" title="Monter" aria-label="Monter">▲</button>
          <button type="button" class="btn btn-ghost todo-down" title="Descendre" aria-label="Descendre">▼</button>
          <select class="coffre-select todo-cat" aria-label="Changer de rubrique" title="Changer de rubrique"></select>
          <button type="button" class="btn btn-ghost todo-del" title="Supprimer" aria-label="Supprimer">🗑️</button>
        </div>`;
      const check = li.querySelector('.todo-check');
      check.checked = !!t.done;
      check.addEventListener('change', async () => {
        t.done = check.checked;
        if (t.done) t.doneAt = Date.now(); else delete t.doneAt;
        await saveTodo(t);
        renderTodo();
      });
      const textEl = li.querySelector('.todo-text');
      textEl.textContent = t.text;
      li.querySelector('.todo-meta').textContent = t.done ? `${TODO_CATS[t.cat] || ''}${t.doneAt ? ' · fait le ' + new Date(t.doneAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' }) : ''}` : '';
      const startEdit = () => {
        const box = document.createElement('textarea');
        box.className = 'field todo-edit';
        box.rows = Math.max(2, Math.ceil(t.text.length / 38));
        box.maxLength = 600;
        box.value = t.text;
        textEl.replaceWith(box);
        box.focus();
        let finished = false;
        const finish = async (save) => {
          if (finished) return;
          finished = true;
          const v = box.value.trim();
          if (save && v && v !== t.text) { t.text = v; await saveTodo(t); }
          renderTodo();
        };
        box.addEventListener('blur', () => finish(true));
        box.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') { e.preventDefault(); finish(false); }
          else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); box.blur(); }
        });
      };
      textEl.addEventListener('click', startEdit);
      textEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') startEdit(); });
      for (const [k, label] of Object.entries(TODO_CATS)) li.querySelector('.todo-cat').add(new Option(label, k));
      li.querySelector('.todo-cat').value = t.cat;
      li.querySelector('.todo-cat').addEventListener('change', async (e) => {
        t.cat = e.target.value;
        t.order = Math.max(0, ...todos.filter((x) => x.cat === t.cat).map((x) => x.order || 0)) + 1;
        await saveTodo(t);
        renderTodo();
      });
      const move = async (dir) => {
        const j = i + dir;
        if (j < 0 || j >= items.length) return;
        // On renumérote la rubrique pour que l'échange soit stable.
        items.forEach((x, n) => { x.order = n + 1; });
        [items[i].order, items[j].order] = [items[j].order, items[i].order];
        await Promise.all([saveTodo(items[i]), saveTodo(items[j])]);
        renderTodo();
      };
      const up = li.querySelector('.todo-up'), down = li.querySelector('.todo-down');
      up.disabled = t.done || i === 0;
      down.disabled = t.done || i === items.length - 1;
      up.hidden = down.hidden = !!t.done;
      up.addEventListener('click', () => move(-1));
      down.addEventListener('click', () => move(1));
      li.querySelector('.todo-del').addEventListener('click', async () => {
        if (!(await askConfirm(`Supprimer « ${t.text.slice(0, 80)}${t.text.length > 80 ? '…' : ''} » ?`, 'Supprimer'))) return;
        todos = todos.filter((x) => x.id !== t.id);
        db.deleteTodo(t.id).catch(() => toast('La suppression n\'a pas pu être enregistrée.'));
        renderTodo();
      });
      list.appendChild(li);
    });
  }
  async function openTodo() {
    if (!state.isAdmin) return;
    showScreen('todo');
    $('#todoList').innerHTML = '<li class="muted">Chargement…</li>';
    try {
      await loadTodos();
    } catch (e) {
      console.warn('To-do indisponible', e);
      $('#todoList').innerHTML = '';
      toast('Impossible de charger ta to-do. Vérifie ta connexion.');
      return;
    }
    renderTodo();
  }
  $('#homeTodo').addEventListener('click', openTodo);
  $('#todoBack').addEventListener('click', goHome);
  document.querySelectorAll('#todoTabs .deco-tab').forEach((tab) => tab.addEventListener('click', () => { todoTab = tab.dataset.cat; renderTodo(); }));
  $('#todoForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = $('#todoText').value.trim();
    if (!text) return;
    const cat = $('#todoCat').value;
    const t = {
      id: `todo-${uid()}`, cat, done: false, text,
      order: Math.max(0, ...todos.filter((x) => x.cat === cat).map((x) => x.order || 0)) + 1, created: Date.now(),
    };
    todos.push(t);
    $('#todoText').value = '';
    todoTab = cat;
    renderTodo();
    await saveTodo(t);
  });

  // ---------------------------------------------------------------------------
  // Joueurs (administratrice) : qui a commencé à jouer, et lui écrire
  // ---------------------------------------------------------------------------
  let players = [];
  let playersSort = 'recent';
  let contestStats = {}; // joueur -> { count, last } : participations aux concours

  // Petit point rouge sur le bouton Joueurs : un joueur est arrivé depuis ta dernière visite de la page.
  let dotAt = 0;
  async function refreshNewPlayersDot() {
    if (!state.isAdmin || Date.now() - dotAt < 10 * 60000) return;
    dotAt = Date.now();
    if (!state.profile.playersSeenAt) { state.profile.playersSeenAt = Date.now(); saveProfile(); return; }
    try {
      const l = await db.listPlayers();
      const fresh = l.filter((p) => !ADMIN_PSEUDOS.includes(playerKey(p)) && (p.firstSeen || 0) > state.profile.playersSeenAt);
      const dot = $('#homePlayers .new-dot');
      $('#homeAdmin .menu-dot').hidden = !fresh.length;
      dot.hidden = !fresh.length;
      dot.title = fresh.length ? `${fresh.length} ${fresh.length > 1 ? 'nouveaux joueurs' : 'nouveau joueur'}` : '';
    } catch (e) { /* tant pis, pas de point */ }
  }
  async function openPlayers() {
    if (!state.isAdmin) return;
    state.profile.playersSeenAt = Date.now(); saveProfile(); dotAt = 0;
    $('#homePlayers .new-dot').hidden = true;
    $('#homeAdmin .menu-dot').hidden = true;
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
    const nights = players.filter((p) => p.nightPlayer).length;
    const active7 = players.filter((p) => (p.lastSeen || 0) > Date.now() - 7 * 86400000).length;
    $('#playersCount').textContent = `${plural(players.length, 'joueur')} · ${active7} venu${active7 > 1 ? 's' : ''} ces 7 derniers jours`
      + (Object.keys(contestStats).length ? ` · ${plural(Object.values(contestStats).reduce((a, c) => a + c.count, 0), 'participation')} aux concours` : '')
      + (nights ? ` · 🌙 ${nights} jou${nights > 1 ? 'ent' : 'e'} d'habitude la nuit (minuit-5 h)` : '');
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
      row.querySelector('.player-name').textContent = (ADMIN_PSEUDOS.includes(key) ? `${ADMIN_DISPLAY_NAME} 🛡️` : (p.pseudo || key)) + (p.nightPlayer ? ' 🌙' : '');
      if (p.nightPlayer) row.querySelector('.player-name').title = 'A signalé jouer d\'habitude entre minuit et 5 h';
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
  // Après un plantage : proposer de prévenir l'administratrice, avec les dernières étapes (pour qu'elle trouve la cause).
  // Témoin « vivant » : posé au démarrage, retiré quand la page passe en arrière-plan ou se ferme. S'il est encore là au démarrage suivant,
  // la page s'est arrêtée alors qu'elle était affichée (plantage).
  const ALIVE_KEY = 'ma-petite-piece:vivant';
  const diedVisible = !!read(ALIVE_KEY);
  const markAlive = () => store(ALIVE_KEY, String(Date.now()));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') store(ALIVE_KEY, null); else markAlive(); });
  window.addEventListener('pagehide', () => store(ALIVE_KEY, null));
  markAlive();

  async function offerCrashReport() {
    if (!state.player || state.isAdmin) return;
    let traces = '';
    try { traces = (JSON.parse(read(TRACE_KEY) || '[]') || []).join('\n'); } catch (e) { /* rien */ }
    if (!(await askConfirm('Le jeu s\'est arrêté la dernière fois. Prévenir l\'administratrice pour qu\'elle puisse corriger ?', 'Oui, la prévenir'))) return;
    const m = {
      id: `crash-${state.player.key}-${Date.now()}`, to: ADMIN_PSEUDOS[0], title: `⚠️ Plantage chez ${state.player.name}`,
      text: `${state.player.name} a eu un plantage. Dernières étapes :\n${traces || '(aucune)'}\n\nAppareil : ${navigator.userAgent}\nÉcran : ${window.innerWidth}×${window.innerHeight} ×${window.devicePixelRatio || 1} · stickers chargés : ${state.images.size} · possédés : ${Object.keys((state.profile && state.profile.inventory) || {}).length} · maintenant : ${memSnapshot()}`,
      reward: 0, read: false, claimed: false, created: Date.now(),
    };
    try { await db.createMail(m); toast('Merci, c\'est envoyé ✉️'); } catch (e) { toast('Le message n\'a pas pu être envoyé.'); }
  }

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
    let crashed = false;
    try { place = JSON.parse(read(PLACE_KEY)) || {}; } catch (e) { /* écran inconnu */ }
    // Si la dernière réouverture d'un écran a fait planter la page, on ne la refait pas : on arrive sur l'accueil (sinon le joueur
    // ne peut plus se connecter, la page replante à chaque fois).
    const RESTORE_KEY = 'ma-petite-piece:restauration';
    if (read(RESTORE_KEY)) { store(RESTORE_KEY, null); store(PLACE_KEY, null); place = {}; crashed = true; }
    else if (place.screen && place.screen !== 'home') { store(RESTORE_KEY, place.screen); setTimeout(() => store(RESTORE_KEY, null), 8000); }
    try {
      await login(session);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Jouer';
    }
    if (crashed || diedVisible) setTimeout(offerCrashReport, 1500);
    // iPhone / iPad : on ne rouvre pas une pièce automatiquement au démarrage (la mémoire est au plus haut juste après la connexion).
    const appleDevice = /iPhone|iPad|iPod/i.test(navigator.userAgent);
    if (place.screen === 'room' && !appleDevice && state.rooms.some((r) => r.id === place.roomId)) openRoom(place.roomId);
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
