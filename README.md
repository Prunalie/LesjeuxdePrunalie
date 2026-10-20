# Les jeux de Prunalie

## 🏠 Ma petite pièce (`stickers-iso/`)

Des pièces en isométrie à décorer avec tes propres stickers.

- **Menu principal** : après le pseudo, quatre entrées : Mes pièces, Boutique, Collection et (pour l'administratrice) Atelier.
- **Collection** : un classeur avec une page par enveloppe (onglets à sa couleur). Chaque sticker a sa pochette numérotée : ceux obtenus (avec le nombre d'exemplaires), et la silhouette de ceux qui restent à trouver. Toucher un sticker obtenu ouvre sa fiche.
- **Carte de tampons** : chaque enveloppe achetée donne un tampon ; 10 tampons donnent une étoile 🌟 (on peut aussi l'acheter 1000 🪙, `STAR_PRICE`), qui permet de choisir n'importe quel sticker de n'importe quelle enveloppe (réglable avec `STAMPS_PER_STAR` dans `game.js`).
- **Proposer un sticker** : les joueurs envoient leurs propres images (30 en attente au plus par défaut, réglable dans l'Atelier). Elles arrivent dans le **Coffre** de l'administratrice, qui les valide (en offrant des pièces, 100 🪙 par défaut) ou les refuse, puis range les images acceptées dans une enveloppe (le sticker garde le nom de son auteur).
- **Joueurs** 👥 (administratrice) : liste des joueurs qui ont commencé à jouer, avec leurs pièces, leur collection, leurs étoiles et leur dernière visite ; recherche, tri, et bouton « Écrire » pour leur envoyer un message (avec des pièces en cadeau si on veut).
- **Boîte aux lettres** 📬 : chaque validation ou refus envoie un message au joueur ; les pièces offertes se récupèrent depuis le message. Un badge sur le menu signale les nouveaux messages.
- **Vente** : dans la collection, la fiche d'un sticker a un bouton « Vendre… » qui demande combien d'exemplaires vendre (par ex. 2/6) et affiche les pièces gagnées (commun 10 🪙, rare 25 🪙, très rare 60 🪙 l'unité, réglable dans `RARITIES` de `game.js`). Les exemplaires posés dans les pièces ne sont jamais vendus.
- **Pseudo** : au démarrage, choisis un pseudo (pas de mot de passe). Reprends le même sur tous tes appareils pour retrouver tes pièces.
- **Mes pièces** : crée autant de pièces que tu veux, renomme-les, duplique-les ou supprime-les. Chaque pièce se sauvegarde toute seule.
- **Points** : chaque jour, à la première connexion, on gagne des pièces (100 🪙 par défaut, réglable par l'administratrice dans l'Atelier, « Pièces du jour »).
- **Boutique** : avec les points, on achète des enveloppes. Chaque enveloppe donne **un** sticker tiré au sort parmi ceux qu'elle contient (commun, rare ou très rare). Le bouton « ×5 » achète 5 fois la même enveloppe d'un coup (5 tirages, 5 tampons, tous les stickers montrés ensemble ; réglable avec `MULTI_BUY`). Toucher une enveloppe montre tout son contenu en petit avant d'acheter : chaque sticker, sa rareté, sa chance de sortir (en %) et ceux déjà obtenus (✓).
- **Exemplaires** : chaque sticker obtenu se pose **une seule fois**, toutes pièces confondues. Pour le poser plusieurs fois, il faut l'obtenir plusieurs fois. Le retirer d'une pièce le rend de nouveau disponible.
- **Atelier** (réservé au profil d'administration, réglable avec `ADMIN_PSEUDOS` dans `game.js`) : créer les enveloppes (nom, prix, couleur), y ajouter les stickers et choisir leur rareté. Un bouton « ＋100 🪙 » permet de tester la boutique.

**Lancer le jeu :** ouvre `stickers-iso/index.html` dans un navigateur
(ou sers le dossier, par ex. `python3 -m http.server` dans `stickers-iso/`).

- **Poser** : glisser un sticker de la bibliothèque dans la pièce, ou cliquer dessus pour le poser au centre. Le chiffre sur chaque sticker indique les exemplaires qu'il reste à poser.
- **Déplacer** : glisser le sticker n'importe où ; on peut les superposer librement.
- **Taille / rotation** : poignée en bas à droite (taille), poignée du haut (rotation, Maj = pas de 15°), ou molette sur le sticker. Sur téléphone : pincer à deux doigts pour agrandir et tourner.
- **Objets posés** : bouton ☰ en haut à gauche de la pièce. La liste des stickers de la pièce (du plus devant au plus derrière) permet de sélectionner un sticker même caché derrière d'autres (les autres s'estompent le temps de le déplacer), et de le verrouiller 🔒 : il ne réagit plus dans la pièce, les clics passent à travers. On le déverrouille dans cette même liste. Le bouton 🔒 de la barre d'outils verrouille aussi le sticker sélectionné.
- **Annuler / rétablir** : boutons ↶ ↷ en haut à gauche de la pièce (ou Ctrl+Z / Ctrl+Maj+Z) pour revenir sur un déplacement, une pose, une suppression, un changement de taille, d'ordre ou de couleur.
- **Zoom** : boutons ＋ / − à droite de la pièce, molette dans le vide, ou pincer à deux doigts dans le vide sur téléphone. Une fois zoomé, glisser dans le vide pour se déplacer ; ⤢ pour revoir toute la pièce.
- **Superposition** : barre d'outils ⏫ 🔼 🔽 ⏬ (ou PageUp / PageDown, Maj pour tout devant / tout derrière).
- **Autres** : ↔️ miroir (F), ⧉ dupliquer (Ctrl+D), 🗑️ supprimer (Suppr), flèches pour ajuster.
- Couleurs des murs, du sol et du fond autour de la pièce personnalisables, avec une pipette pour reprendre une couleur (n'importe où à l'écran sur Chrome/Edge ordinateur, sinon en appuyant dans la pièce : une loupe suit le doigt, on relâche sur la bonne couleur), export de la pièce en PNG (sur téléphone : menu « ⋯ »).

Tout est sauvegardé automatiquement. Par défaut, la sauvegarde reste dans le navigateur (IndexedDB).

**Retrouver ses stickers sur tous ses appareils :** colle la configuration de ton projet Firebase
dans `stickers-iso/firebase-config.js`. Les stickers sont alors enregistrés dans Firestore
(collection `ma-petite-piece-stickers` pour les stickers des enveloppes, `ma-petite-piece` pour les
pièces, les joueurs — points et exemplaires —, les enveloppes et les messages, distingués par le champ `type` ;
les propositions des joueurs sont dans la collection des stickers avec `proposal: true`).
- **Aménager** 🏗️ (menu ⋯ de la pièce) : options à débloquer avec des étoiles 🌟, valables pour toutes les pièces du joueur : **Jardin** (haies, pelouse, ciel), **Taille sur mesure** (largeur, profondeur, hauteur des murs) et **Étages** (jusqu'à 3 niveaux surélevés collés au coin du fond, chacun posé sur le précédent). Prix réglables par l'administratrice dans l'Atelier (« Options d'aménagement »).
- **Nouveautés** ✨ : menu qui liste les mises à jour du jeu. À la connexion, une fenêtre « Quoi de neuf ? » montre aux joueurs ce qui a changé depuis leur dernière visite. L'administratrice peut écrire ses propres nouveautés depuis cet écran (les mises à jour du code sont dans `BUILTIN_NEWS`, dans `game.js`).
- **Concours du jour** 🏆 : un thème par jour (liste réglable par l'administratrice dans l'Atelier, utilisée à tour de rôle). Jour J : chaque joueur publie une de ses pièces (image). Jour J+1 : vote jusqu'à 20 h (une voix par joueur, pas pour soi, modifiable jusque-là). À 20 h, le gagnant est dévoilé ; le ou les gagnants reçoivent la récompense (200 🪙 par défaut, réglable) dès qu'ils ouvrent le jeu. L'administratrice peut retirer une participation.
