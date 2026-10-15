# layout-bench

Outils de mesure de la galaxie, sur un arbre réel : comparaison des algorithmes de placement, sonde de performance, scénario de bout en bout du parcours compte, audit de la landing.

## Installation

`npm i`

## Récupérer un arbre de test

`TREE_PASSWORD='...' npm run fixture -- <slug> [nom]` récupère un arbre par le chemin visiteur (slug, mot de passe, graphe) dans `fixtures/<nom>-graph.json`. Le dossier `fixtures/` est ignoré par git : ce sont les données d'une famille, elles ne quittent pas votre machine.

Sans arbre réel sous la main : `node gen-synth.mjs [cible]` (défaut 1300) génère `fixtures/synth1300-graph.json`, un arbre synthétique déterministe (~1300 personnes : lignée profonde, familles alliées, mariages entre branches, parents uniques) pour mesurer à l'échelle d'un grand arbre.

## Placement

- `npm run bench` : tous les modèles (attention : M1-M4 utilisent ELK, gourmands en mémoire sur un grand arbre — filtrer), `npm run bench -- M0 M5` pour filtrer par nom. `FIXTURE=<nom>` choisit l'arbre (défaut `famille`).
- `node crop.mjs m5a <prénom> 3000 1100 0.8` : recadrage autour d'une personne (largeur, hauteur, échelle).
- Sorties dans `out/` : `<modèle>.svg/.png/.json` et `metrics.json`.

Modèles :

- `M0` Sugiyama custom du repo (`?layout=sugiyama` dans l'app), `M5a-d` variantes de prototypes de blocs familiaux, `M7` blocs familiaux par défaut du repo, `M6` layout « rooted » du repo (`?layout=rooted&root=<id>` dans l'app) — la racine vient de `ROOT=<id>` ou du champ `rootPersonId` de la fixture, sinon du repli déterministe du layout.
- Métriques `renvois` (pastilles « Voir les parents ») et `couloirs` (connecteurs orthogonaux dessinés entre les rangées par le layout « rooted ») : comptent les arêtes de filiation remplacées ou non par un vrai trait.

Chaque modèle de `models/` exporte `variants: [{ name, layout(graphData) }]` et renvoie le format de `computeLayout` (`{ result: { children, edges }, coupleBarMeta }`) : un modèle se branche dans `Galaxy.jsx` sans toucher aux renderers. `load.mjs` importe le code du dépôt tel quel ; `register.mjs` ajoute le resolver des imports sans extension (style Vite).

Exemple de comparaison à l'échelle (fixture synth1300, même jeu de données) :

```sh
node gen-synth.mjs
FIXTURE=synth1300 npm run bench -- M7 M6        # défaut vs layout « rooted »
ROOT=<id> FIXTURE=synth1300 npm run bench -- M6 # changer de racine réorganise le placement
```

## Comparer les layouts dans l'app

`cd frontend && npm run dev`, puis ouvrir l'arbre avec :

- sans paramètre : blocs familiaux par défaut (comportement inchangé) ;
- `?layout=sugiyama` : Sugiyama ;
- `?layout=rooted&root=<id>` : arbre pedigree organisé autour de la personne racine (générations relatives à la racine, couples ancrés au-dessus de leur enfant de la ligne directe, connecteurs de couloir). Sans `root`, la personne de départ de l'arbre sert de racine ; id invalide → repli déterministe (avertissement console).

## Performance, parcours compte, landing

- `TREE_PASSWORD='...' node perf-probe.mjs <url d'un arbre>` : temps main thread par frame au repos, en drag et en zoom, appels canvas par frame, profil CPU. Brave ou Chrome headless piloté en CDP.
- `node e2e-account.mjs <front> <api>` : scénario complet sur un backend local (lien partagé, compte créé, rattachement, contributions). `CLEANUP=1` supprime l'arbre de test.
- `node landing-check.mjs <url>` : titres, liens, formulaires et erreurs JS d'une page, avec capture.
