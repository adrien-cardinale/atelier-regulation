# Atelier de régulation

Application web pédagogique et statique. Elle aide à comprendre un filtre de Kalman, un régulateur PID, puis un régulateur LQR (commande optimale par retour d'état). Elle contient un schéma bloc interactif, des paramètres réglables, des graphes et un éditeur Python. Le code Python s'exécute dans le navigateur avec Pyodide.

## Lancement

Il n'y a aucune étape de build. Deux options :

- Ouvrez `index.html` directement dans le navigateur (`file://`).
- Ou servez le dossier : `python3 -m http.server`, puis ouvrez <http://localhost:8000>.

Une connexion internet est nécessaire au premier chargement : Pyodide, numpy, CodeMirror et Plotly viennent de CDN.

## Mise en page

La page est verticale et centrée (1400 px au plus). De haut en bas :

1. La barre supérieure : titre, onglets des systèmes, état de Python, durée du calcul, thème, réinitialisation.
2. Le schéma bloc, en grand. Chaque bloc affiche ses équations, ses curseurs et ses valeurs à l'instant k. Les flèches portent aussi des valeurs.
3. La commande temporelle : pas précédent, lecture, pas suivant, curseur k, vitesse et « Cycle détaillé ».
4. Le bandeau d'explication du bloc sélectionné ou du bloc actif, puis les indicateurs globaux.
5. Le panneau « À propos », replié.
6. Les graphes, sur deux colonnes (une seule sous 900 px).
7. Deux sections repliées : « Paramètres de simulation » et « Code Python » (éditeur et console).

Sous 700 px de large, les blocs du schéma s'empilent. Des flèches ↓ remplacent alors les arêtes.

## Utilisation

- Réglez un paramètre directement dans son bloc. La simulation est relancée immédiatement.
- Cliquez un bloc : le bandeau affiche ses équations et son rôle. La section « Code Python » s'ouvre et surligne le code du bloc. « Suivre le cycle » ou Échap annule la sélection.
- Placez le curseur dans l'éditeur : le bloc correspondant est mis en évidence dans le schéma.
- Lancez la lecture : k avance et le bloc actif parcourt le cycle déclaré. L'arête sortante du bloc actif s'anime.
- Activez « Cycle détaillé » : chaque sous-étape du cycle dure un temps visible, et k avance à la fin du cycle. Les boutons de pas avancent alors d'une sous-étape.
- Sans « Cycle détaillé », un pas avance k de 1 et balaie rapidement les sous-étapes.
- Modifiez le code : il est relancé 500 ms après la dernière frappe (ou via « Exécuter », Ctrl+Entrée).
- Les paramètres, le code modifié, la vitesse et le mode de cycle sont mémorisés dans le `localStorage`. « Réinitialiser » restaure les valeurs par défaut.

## Structure

- `index.html` : squelette de la page et chargement des scripts (CDN puis `js/core`, puis `js/systems`).
- `css/style.css` : variables de thème (clair et sombre) et mise en page.
- `js/core/registry.js` : registre des systèmes et formatage des nombres.
- `js/core/python-runner.js` : chargement de Pyodide et exécution de `simulate(p)`.
- `js/core/diagram.js` : schéma bloc. Les blocs et les zones sont des `div`. La position horizontale suit la largeur. La position verticale est calculée par rangées, à partir de la hauteur réelle des blocs. Les arêtes sont tracées dans un SVG superposé.
- `js/core/params.js` : modèle des paramètres et contrôles (complet ou compact).
- `js/core/plots.js` : graphes Plotly.
- `js/core/editor.js` : éditeur CodeMirror et régions de code des blocs.
- `js/core/app.js` : assemblage, commande temporelle, bandeau d'explication.
- `js/systems/*.js` : un fichier par système.

## Ajouter un système

1. Créez `js/systems/mon-systeme.js` sur le modèle de `js/systems/pid.js`.
2. Appelez `App.registerSystem({...})` avec les champs suivants :
   - `id`, `name`, `subtitle`, `description` (HTML court) ;
   - `timeKey` : clé du vecteur temps dans le résultat Python (ex. `'t'`) ;
   - `code` : source Python qui définit `simulate(p) -> dict` ;
   - `params` : `{ id, label, symbol, unit, min, max, step, default, group, block?, log?, advanced? }` ;
   - `diagram` : `{ width, cycle?, zones?, blocks, edges }`. Un bloc a la forme `{ id, title, lines, x, row, w, h, kind, readouts, info? }`. Une zone a la forme `{ label, blocks: [ids] }`. Une arête a la forme `{ from, to, label?, readout?, fromSide?, toSide?, loop? }` ;
   - `plots` : `{ id, title, xKey, yLabel, hlines?, traces }`. Une trace a la forme `{ key, name, kind, color?, band? }` ;
   - `readouts` : `{ label, unit, format, compute: (result) => number, hint? }` ;
   - `references` (optionnel) : `{ authors, year, title, where, url?, note? }`, affichées sous « À propos ».
3. Dans le code Python, délimitez chaque bloc par `# >>> block: <id>` et `# <<< block: <id>`.
4. Ajoutez une balise `<script src="js/systems/mon-systeme.js"></script>` dans `index.html`, avant `App.start()`.

Précisions sur le contrat :

- `simulate(p)` reçoit un dict de nombres. Elle retourne des listes, des tableaux numpy ou des scalaires.
- `width` est la largeur de référence (ex. 1200). `x` et `w` des blocs sont exprimés dans cette unité et suivent la largeur réelle du schéma.
- `row` : numéro de rangée du bloc (0, 1, …). Les blocs d'une même rangée sont centrés verticalement. Chaque rangée commence sous la plus haute de la rangée précédente, après un espace pour les arêtes. Sans `row`, les blocs sont groupés par `y`.
- `h` est une hauteur minimale, dans l'unité de `width`. Un bloc grandit si son contenu l'exige. La hauteur du schéma suit son contenu.
- `zones[].blocks` : blocs encadrés par la zone. Le cadre est calculé à partir des blocs réels, avec une bande pour le titre. Sans `blocks`, une zone `{ x, y, w, h }` prend les blocs dont le centre est à l'intérieur.
- Une arête `loop` qui part par le bas (ou de droite à gauche) passe dans une marge réservée sous le schéma.
- `kind` vaut `process`, `measure`, `estimate` ou `io`.
- `cycle` : liste ordonnée d'identifiants de blocs, parcourue par l'animation (ex. `['truth', 'measure', 'predict', 'update']`). Par défaut, tous les blocs dans l'ordre déclaré.
- `edges[].readout` : `{ key, format }`. L'étiquette de l'arête affiche alors `label = valeur` à l'instant k.
- `params[].block` : bloc qui porte le paramètre. Le paramètre est rendu dans ce bloc sous forme de curseur compact.
- `params[].advanced: true` : le paramètre va dans la section « Paramètres de simulation », même s'il a un `block`. Un paramètre sans `block` y va aussi.
- `readouts[].key` (blocs et arêtes) accepte une clé de résultat ou une fonction `(result, k) => number`.
- `band` accepte `{ varianceKey, n, center?, name? }`, `{ sigmaKey, n }` ou `{ upperKey, lowerKey }`.
- `format` accepte un nombre de décimales, `'int'`, `'percent'` ou une fonction.
- `color` accepte `series-1`, `series-2`, `series-3`, `truth`, `muted` ou `reference`.

## Déploiement sur GitHub Pages

Le site est statique : le dépôt se publie tel quel, sans build.

1. Créez un dépôt sur GitHub, puis poussez la branche `main` :

   ```
   git remote add origin git@github.com:<utilisateur>/kalman.git
   git push -u origin main
   ```

2. Dans le dépôt GitHub, ouvrez **Settings → Pages**. Dans **Build and deployment**, choisissez **Source : GitHub Actions**.
3. Le workflow `.github/workflows/pages.yml` se lance à chaque push sur `main`. Le site est servi sur `https://<utilisateur>.github.io/kalman/`.

Le fichier `.nojekyll` désactive Jekyll. Tous les chemins sont relatifs, donc le site fonctionne dans un sous-dossier.
