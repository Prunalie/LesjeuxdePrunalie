# Les jeux de Prunalie

## 🏠 Ma petite pièce (`stickers-iso/`)

Des pièces en isométrie à décorer avec tes propres stickers.

- **Pseudo** : au démarrage, choisis un pseudo (pas de mot de passe). Reprends le même sur tous tes appareils pour retrouver tes pièces.
- **Mes pièces** : crée autant de pièces que tu veux, renomme-les, duplique-les ou supprime-les. Chaque pièce se sauvegarde toute seule.
- **Bibliothèque** : tes stickers importés sont partagés entre toutes tes pièces.

**Lancer le jeu :** ouvre `stickers-iso/index.html` dans un navigateur
(ou sers le dossier, par ex. `python3 -m http.server` dans `stickers-iso/`).

- **Importer** : bouton « ＋ Importer » ou glisser des images sur la page (les PNG à fond transparent rendent le mieux).
- **Poser** : glisser un sticker de la bibliothèque dans la pièce, ou cliquer dessus pour le poser au centre.
- **Déplacer** : glisser le sticker n'importe où ; on peut les superposer librement.
- **Taille / rotation** : poignée en bas à droite (taille), poignée du haut (rotation, Maj = pas de 15°), ou molette sur le sticker. Sur téléphone : pincer à deux doigts pour agrandir et tourner.
- **Superposition** : barre d'outils ⏫ 🔼 🔽 ⏬ (ou PageUp / PageDown, Maj pour tout devant / tout derrière).
- **Autres** : ↔️ miroir (F), ⧉ dupliquer (Ctrl+D), 🗑️ supprimer (Suppr), flèches pour ajuster.
- Couleurs des murs et du sol personnalisables, export de la pièce en PNG (sur téléphone : menu « ⋯ »).

Tout est sauvegardé automatiquement. Par défaut, la sauvegarde reste dans le navigateur (IndexedDB).

**Retrouver ses stickers sur tous ses appareils :** colle la configuration de ton projet Firebase
dans `stickers-iso/firebase-config.js`. Les stickers sont alors enregistrés dans Firestore
(collection `ma-petite-piece-stickers` pour les stickers, `ma-petite-piece` pour les pièces,
chaque document porte le pseudo de son propriétaire dans le champ `owner`).
