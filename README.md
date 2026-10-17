# Les jeux de Prunalie

## 🏠 Ma petite pièce (`stickers-iso/`)

Des pièces en isométrie à décorer avec tes propres stickers.

- **Menu principal** : après le pseudo, quatre entrées : Mes pièces, Boutique, Collection et (pour l'administratrice) Atelier.
- **Collection** : un classeur avec une page par enveloppe (onglets à sa couleur). Chaque sticker a sa pochette numérotée : ceux obtenus (avec le nombre d'exemplaires), et la silhouette de ceux qui restent à trouver. Toucher un sticker obtenu ouvre sa fiche.
- **Carte de tampons** : chaque enveloppe achetée donne un tampon ; 10 tampons donnent une étoile 🌟, qui permet de choisir n'importe quel sticker de n'importe quelle enveloppe (réglable avec `STAMPS_PER_STAR` dans `game.js`).
- **Vente** : dans la collection, la fiche d'un sticker a un bouton « Vendre… » qui demande combien d'exemplaires vendre (par ex. 2/6) et affiche les pièces gagnées (commun 10 🪙, rare 25 🪙, très rare 60 🪙 l'unité, réglable dans `RARITIES` de `game.js`). Les exemplaires posés dans les pièces ne sont jamais vendus.
- **Pseudo** : au démarrage, choisis un pseudo (pas de mot de passe). Reprends le même sur tous tes appareils pour retrouver tes pièces.
- **Mes pièces** : crée autant de pièces que tu veux, renomme-les, duplique-les ou supprime-les. Chaque pièce se sauvegarde toute seule.
- **Points** : chaque jour, à la première connexion, on gagne 100 🪙.
- **Boutique** : avec les points, on achète des enveloppes. Chaque enveloppe donne **un** sticker tiré au sort parmi ceux qu'elle contient (commun, rare ou très rare). Toucher une enveloppe montre son contenu : les stickers obtenus et la silhouette des autres.
- **Exemplaires** : chaque sticker obtenu se pose **une seule fois**, toutes pièces confondues. Pour le poser plusieurs fois, il faut l'obtenir plusieurs fois. Le retirer d'une pièce le rend de nouveau disponible.
- **Atelier** (réservé aux pseudos listés dans `ADMIN_PSEUDOS` dans `game.js`, aujourd'hui « Prunalie ») : créer les enveloppes (nom, prix, couleur), y ajouter les stickers et choisir leur rareté. Un bouton « ＋100 🪙 » permet de tester la boutique.

**Lancer le jeu :** ouvre `stickers-iso/index.html` dans un navigateur
(ou sers le dossier, par ex. `python3 -m http.server` dans `stickers-iso/`).

- **Poser** : glisser un sticker de la bibliothèque dans la pièce, ou cliquer dessus pour le poser au centre. Le chiffre sur chaque sticker indique les exemplaires qu'il reste à poser.
- **Déplacer** : glisser le sticker n'importe où ; on peut les superposer librement.
- **Taille / rotation** : poignée en bas à droite (taille), poignée du haut (rotation, Maj = pas de 15°), ou molette sur le sticker. Sur téléphone : pincer à deux doigts pour agrandir et tourner.
- **Zoom** : boutons ＋ / − à droite de la pièce, molette dans le vide, ou pincer à deux doigts dans le vide sur téléphone. Une fois zoomé, glisser dans le vide pour se déplacer ; ⤢ pour revoir toute la pièce.
- **Superposition** : barre d'outils ⏫ 🔼 🔽 ⏬ (ou PageUp / PageDown, Maj pour tout devant / tout derrière).
- **Autres** : ↔️ miroir (F), ⧉ dupliquer (Ctrl+D), 🗑️ supprimer (Suppr), flèches pour ajuster.
- Couleurs des murs et du sol personnalisables, avec une pipette pour reprendre une couleur (n'importe où à l'écran sur Chrome/Edge ordinateur, sinon en appuyant dans la pièce : une loupe suit le doigt, on relâche sur la bonne couleur), export de la pièce en PNG (sur téléphone : menu « ⋯ »).

Tout est sauvegardé automatiquement. Par défaut, la sauvegarde reste dans le navigateur (IndexedDB).

**Retrouver ses stickers sur tous ses appareils :** colle la configuration de ton projet Firebase
dans `stickers-iso/firebase-config.js`. Les stickers sont alors enregistrés dans Firestore
(collection `ma-petite-piece-stickers` pour les stickers des enveloppes, `ma-petite-piece` pour les
pièces, les joueurs — points et exemplaires — et les enveloppes, distingués par le champ `type`).
