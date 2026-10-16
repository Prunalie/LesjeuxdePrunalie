# Les jeux de Prunalie

## 🏠 Ma petite pièce (`stickers-iso/`)

Une pièce en isométrie à décorer avec tes propres stickers.

**Lancer le jeu :** ouvre `stickers-iso/index.html` dans un navigateur
(ou sers le dossier, par ex. `python3 -m http.server` dans `stickers-iso/`).

- **Importer** : bouton « ＋ Importer » ou glisser des images sur la page (les PNG à fond transparent rendent le mieux).
- **Poser** : glisser un sticker de la bibliothèque dans la pièce, ou cliquer dessus pour le poser au centre.
- **Déplacer** : glisser le sticker n'importe où ; on peut les superposer librement.
- **Taille / rotation** : poignée en bas à droite (taille), poignée du haut (rotation, Maj = pas de 15°), ou molette sur le sticker.
- **Superposition** : barre d'outils ⏫ 🔼 🔽 ⏬ (ou PageUp / PageDown, Maj pour tout devant / tout derrière).
- **Autres** : ↔️ miroir (F), ⧉ dupliquer (Ctrl+D), 🗑️ supprimer (Suppr), flèches pour ajuster.
- Couleurs des murs et du sol personnalisables, export de la pièce en PNG.

Tout est sauvegardé automatiquement. Par défaut, la sauvegarde reste dans le navigateur (IndexedDB).

**Retrouver ses stickers sur tous ses appareils :** colle la configuration de ton projet Firebase
dans `stickers-iso/firebase-config.js`. Les stickers sont alors enregistrés dans Firestore
(collections `ma-petite-piece-stickers` et `ma-petite-piece`).
