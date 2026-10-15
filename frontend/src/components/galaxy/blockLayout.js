import { computeLayout, componentOrderPerGen, chainGap, coupleBarMeta } from './elkLayout'
import { RENVOI_MIN_DX } from './constants'

// ============================================================
// Layout par blocs familiaux (Reingold-Tilford adapté aux couples)
//
// S'appuie sur computeLayout pour tout ce qui n'est pas en cause
// (normalisation des filiations, générations, chaînes de couples,
// coupleBarMeta, componentOrderPerGen) et ne recalcule que le X.
//
//   Un bloc = une chaîne de couples (même génération) + les blocs de
//   ses enfants imbriqués en dessous (contours par génération), la
//   chaîne centrée au-dessus. Fratries contiguës et parents centrés
//   par construction.
//
//   Mariage entre deux familles de l'arbre : la chaîne du couple n'est
//   placée qu'une fois, sous la première lignée qui la revendique (les
//   grandes lignées d'abord). L'autre lignée garde une arête longue.
//
//   Un bloc racine dont la chaîne a un enfant déjà placé ailleurs
//   (beaux-parents) est ancré : centré sur cet enfant, puis décalé au
//   créneau libre le plus proche.
//
//   Mode « rooted » (options.rootPersonId, voir rootedLayout.js) :
//   générations relatives à la racine (elkLayout) et lignées ordonnées
//   par proximité avec elle : la chaîne d'un couple partagé est placée
//   sous la lignée la plus proche de la racine, les lignées alliées
//   sont rangées côte à côte, et une arête inter-lignées qui ne saute
//   qu'une génération est dessinée en connecteur orthogonal dans le
//   couloir entre deux rangées au lieu d'un renvoi.
//
// Benchmark et variantes écartées : tools/layout-bench/.
// ============================================================

const NODE_SPACING = 30
const FAMILY_GAP = 60

// Distance de parenté (nombre de sauts personne-personne) depuis la racine :
// conjoints et liens parent-enfant. Sert à ordonner les lignées : la lignée
// de la racine d'abord, puis les branches collatérales et les familles
// alliées par distance croissante. Une chaîne atteignable seulement depuis
// une autre composante (déconnectée) reste à l'infini.
function kinshipDistances(rootPersonId, edges) {
  const dist = new Map()
  if (rootPersonId == null) return dist
  const partnersOf = new Map()
  const familyOf = new Map()
  for (const { elkId, p1Key, p2Key } of coupleBarMeta) {
    familyOf.set(elkId, [p1Key, p2Key])
    if (!partnersOf.has(p1Key)) partnersOf.set(p1Key, [])
    partnersOf.get(p1Key).push(p2Key)
    if (!partnersOf.has(p2Key)) partnersOf.set(p2Key, [])
    partnersOf.get(p2Key).push(p1Key)
  }
  const adj = new Map()
  const link = (a, b) => {
    if (!adj.has(a)) adj.set(a, [])
    adj.get(a).push(b)
  }
  for (const [p, others] of partnersOf) for (const o of others) link(p, o)
  for (const e of edges) {
    for (const p of (familyOf.get(e.sources[0]) || [])) {
      link(p, e.targets[0])
      link(e.targets[0], p)
    }
  }

  const rootKey = `p-${rootPersonId}`
  dist.set(rootKey, 0)
  const queue = [rootKey]
  while (queue.length > 0) {
    const cur = queue.shift()
    for (const next of (adj.get(cur) || [])) {
      if (dist.has(next)) continue
      dist.set(next, dist.get(cur) + 1)
      queue.push(next)
    }
  }
  return dist
}

export function computeBlockLayout(graphData = null, options = {}) {
  const layoutOptions = options.rootPersonId != null ? { rootPersonId: options.rootPersonId } : {}
  const result = computeLayout(graphData, layoutOptions)
  const nodes = result.children
  const byId = new Map(nodes.map(n => [n.id, n]))

  // Ordre des lignées en mode « rooted » : proximité avec la racine
  const distOf = kinshipDistances(options.rootPersonId ?? null, result.edges)
  const chainDist = (chain) => chain.reduce((m, id) => {
    if (!id.startsWith('p-')) return m
    const d = distOf.get(id)
    return d === undefined ? m : Math.min(m, d)
  }, Infinity)
  // Comparateur : les chaînes hors de la composante de la racine passent après toutes les autres
  const distRank = (chain) => { const d = chainDist(chain); return Number.isFinite(d) ? d : 1e9 }

  // Chaînes de couples (composantes d'une génération) telles que computeLayout les a ordonnées
  const chainOf = new Map()
  const chains = []
  for (const gen of [...componentOrderPerGen.keys()].sort((a, b) => a - b)) {
    for (const ids of componentOrderPerGen.get(gen)) {
      const chain = [...ids]
      chains.push(chain)
      for (const id of chain) chainOf.set(id, chain)
    }
  }
  const genOf = (chain) => byId.get(chain[0])._generation

  const childrenOfUnion = new Map()
  const parentUnionOf = new Map()
  for (const e of result.edges) {
    const u = e.sources[0], c = e.targets[0]
    if (!childrenOfUnion.has(u)) childrenOfUnion.set(u, [])
    childrenOfUnion.get(u).push(c)
    if (!parentUnionOf.has(c)) parentUnionOf.set(c, u)
  }
  const hasParents = (chain) => chain.some(id => parentUnionOf.has(id))

  const descCount = new Map()
  function countDesc(chain, seen = new Set()) {
    if (descCount.has(chain)) return descCount.get(chain)
    if (seen.has(chain)) return 0
    seen.add(chain)
    let n = 0
    for (const id of chain) for (const k of (childrenOfUnion.get(id) || [])) n += 1 + countDesc(chainOf.get(k), seen)
    descCount.set(chain, n)
    return n
  }

  const gapAfter = (chain, i) => chainGap(byId.get(chain[i]), byId.get(chain[i + 1]), NODE_SPACING)
  const chainWidth = (chain) => chain.reduce((s, id, i) => s + byId.get(id).width + (i < chain.length - 1 ? gapAfter(chain, i) : 0), 0)
  const chainOffsets = (chain) => {
    const offsets = new Map()
    let x = 0
    chain.forEach((id, i) => { offsets.set(id, x); x += byId.get(id).width + (i < chain.length - 1 ? gapAfter(chain, i) : 0) })
    return offsets
  }

  const pos = new Map()
  const placed = new Set()
  const externalEdges = new Set() // `${union}>${enfant}` : enfant placé sous une autre lignée

  // Imbrique des blocs de gauche à droite, génération par génération
  function packBlocks(blocks, gap) {
    const acc = new Map()
    const xs = []
    for (const b of blocks) {
      let off = 0
      for (const [g, [l]] of b.rows) {
        const a = acc.get(g)
        if (a) off = Math.max(off, a[1] + gap - l)
      }
      xs.push(off)
      for (const [g, [l, r]] of b.rows) {
        const a = acc.get(g)
        acc.set(g, a ? [Math.min(a[0], l + off), Math.max(a[1], r + off)] : [l + off, r + off])
      }
    }
    return { xs, rows: acc }
  }

  function buildBlock(chain) {
    placed.add(chain)
    const gen = genOf(chain)
    const rowW = chainWidth(chain)
    const offsets = chainOffsets(chain)
    let childBlocks = []
    const external = []
    for (const id of chain) {
      if (byId.get(id)._type !== 'union') continue
      for (const k of (childrenOfUnion.get(id) || [])) {
        const kc = chainOf.get(k)
        if (!placed.has(kc)) childBlocks.push(buildBlock(kc))
        else { external.push({ kid: k, unionId: id }); externalEdges.add(`${id}>${k}`) }
      }
    }
    // Mode « rooted » : la lignée la plus proche de la racine se range à gauche du bloc,
    // la ligne directe contre le couple quand le bloc s'insère en flanc droit — oncles,
    // tantes et cousins sont repoussés vers l'extérieur. (L'ordre de construction, qui
    // décide quelle lignée revendique une chaîne partagée, reste inchangé.)
    if (options.rootPersonId != null && childBlocks.length > 1) {
      childBlocks = [...childBlocks].sort((a, b) => (
        distRank(a.chain) - distRank(b.chain) || countDesc(b.chain) - countDesc(a.chain)
      ))
    }
    const packed = packBlocks(childBlocks, FAMILY_GAP)

    // Chaîne centrée sur la rangée de ses enfants directs
    let rowX = 0
    if (childBlocks.length) {
      const kidRowL = Math.min(...childBlocks.map((b, i) => packed.xs[i] + b.rows.get(b.gen)[0]))
      const kidRowR = Math.max(...childBlocks.map((b, i) => packed.xs[i] + b.rows.get(b.gen)[1]))
      rowX = (kidRowL + kidRowR) / 2 - rowW / 2
    }

    const rows = new Map([[gen, [rowX, rowX + rowW]]])
    for (const [g, [l, r]] of packed.rows) {
      const a = rows.get(g)
      rows.set(g, a ? [Math.min(a[0], l), Math.max(a[1], r)] : [l, r])
    }
    const minL = Math.min(...[...rows.values()].map(v => v[0]))
    for (const [g, v] of rows) rows.set(g, [v[0] - minL, v[1] - minL])
    rowX -= minL
    const kidXs = packed.xs.map(x => x - minL)

    const members = new Set(chain)
    for (const b of childBlocks) { for (const m of b.members) members.add(m); external.push(...b.external) }
    const rel = (id) => {
      if (offsets.has(id)) return rowX + offsets.get(id)
      for (let i = 0; i < childBlocks.length; i++) if (childBlocks[i].members.has(id)) return kidXs[i] + childBlocks[i].rel(id)
      return null
    }
    return {
      rows, members, external, gen, rel, chain,
      get width() { return Math.max(...[...rows.values()].map(v => v[1])) },
      place(x0) {
        for (const id of chain) pos.set(id, x0 + rowX + offsets.get(id))
        childBlocks.forEach((b, i) => b.place(x0 + kidXs[i]))
      },
    }
  }

  // 1) Racines : chaînes sans parents. Par défaut les grandes lignées d'abord ; en mode
  // « rooted », la lignée de la racine d'abord puis par distance de parenté croissante
  // (l'ordre de construction décide quelle lignée place une chaîne partagée : la plus
  // proche de la racine gagne).
  const roots = chains.filter(c => !hasParents(c)).sort((a, b) => (
    distRank(a) - distRank(b) || countDesc(b) - countDesc(a) || genOf(a) - genOf(b)
  ))
  const free = [], anchored = []
  for (const r of roots) {
    if (placed.has(r)) continue
    const block = buildBlock(r)
    const ownExternal = block.external.some(({ unionId }) => r.includes(unionId))
    if (ownExternal) anchored.push(block)
    else free.push(block)
  }
  // Mode « rooted » : les blocs libres mariés dans une autre lignée (beaux-parents et
  // leurs ascendants) ne sont pas rangés dans la forêt — la lignée qui a revendiqué le
  // couple y étale ses familles collatérales et les en sépare — mais insérés en flanc
  // de la chaîne du couple après la pose de la forêt (voir placeFlank).
  const freeInLaw = []
  if (options.rootPersonId != null) {
    for (const b of free) {
      if (b.external.some(({ kid }) => free.some(o => o !== b && o.members.has(kid)))) freeInLaw.push(b)
    }
  }
  const forestBlocks = free.filter(b => !freeInLaw.includes(b))
  // Mode « rooted » : ranger les blocs de la forêt pour placer côte à côte les lignées
  // alliées restantes (une arête externe entre deux blocs est d'autant plus courte
  // qu'ils sont voisins). Parcours glouton : on part de la lignée de la racine, puis
  // chaque bloc lié par un mariage à un bloc déjà rangé vient juste après ; à égalité,
  // le plus proche de la racine d'abord. Les blocs sans lien suivent, par distance
  // croissante.
  if (options.rootPersonId != null && forestBlocks.length > 1) {
    const ownerOf = new Map()
    forestBlocks.forEach((b, i) => { for (const m of b.members) ownerOf.set(m, i) })
    const links = new Map()
    forestBlocks.forEach((b, i) => {
      for (const { kid, unionId } of b.external) {
        if (ownerOf.get(unionId) !== i) continue
        const j = ownerOf.get(kid)
        if (j === undefined || j === i) continue
        if (!links.has(i)) links.set(i, new Set())
        links.get(i).add(j)
      }
    })
    const ordered = []
    const taken = new Set()
    while (ordered.length < forestBlocks.length) {
      let pick = -1, pickLinked = false
      for (let i = 0; i < forestBlocks.length; i++) {
        if (taken.has(i)) continue
        const linked = [...(links.get(i) || [])].some(j => taken.has(j))
        if (pick === -1 || (linked && !pickLinked)
          || (linked === pickLinked && distRank(forestBlocks[i].chain) < distRank(forestBlocks[pick].chain))) {
          pick = i; pickLinked = linked
        }
      }
      taken.add(pick)
      ordered.push(forestBlocks[pick])
    }
    ordered.forEach((b, i) => { forestBlocks[i] = b })
  }
  const forest = packBlocks(forestBlocks, FAMILY_GAP * 2)
  forestBlocks.forEach((b, i) => b.place(forest.xs[i]))
  let cursor = Math.max(0, ...[...forest.rows.values()].map(v => v[1])) + FAMILY_GAP * 2

  // Insertion en flanc (mode « rooted ») : plutôt que le créneau libre le plus proche —
  // souvent après toutes les familles collatérales de la lignée qui a revendiqué le
  // couple, d'où des beaux-parents rejetés loin à droite — le bloc est inséré dans une
  // bande ouverte juste à droite de la chaîne de son enfant (le couple pour une lignée
  // alliée). Ses lignées étant rangées par proximité avec la racine (voir buildBlock),
  // la ligne directe (les parents de l'enfant) se retrouve contre le couple, et les
  // collatéraux — oncles, tantes, cousins — repoussés vers l'extérieur. Les contenus
  // au-delà de la bande sont translatés d'un bloc vers l'extérieur, jamais replacés un
  // par un : aucun chevauchement possible. Renvoie false si l'enfant n'est pas encore
  // placé (repli).
  const flankRightEnd = new Map() // chaîne enfant → borne droite du dernier flanc inséré
  const maxNodeWidth = Math.max(...nodes.map((n) => n.width))
  const placeFlank = (block) => {
    const placedKids = block.external.filter(({ kid }) => pos.has(kid))
    if (!placedKids.length) return false
    const kid = placedKids[0].kid
    const kidChain = chainOf.get(kid)
    let chainR = -Infinity
    if (kidChain) {
      for (const id of kidChain) {
        const x = pos.get(id)
        if (x == null) continue
        chainR = Math.max(chainR, x + byId.get(id).width)
      }
    }
    if (!Number.isFinite(chainR)) return false
    const shift = block.width + FAMILY_GAP * 2 + maxNodeWidth
    const start = Math.max(chainR, flankRightEnd.get(kidChain) ?? -Infinity) + FAMILY_GAP
    for (const [id, x] of pos) {
      if (x + byId.get(id).width > start - NODE_SPACING) pos.set(id, x + shift)
    }
    block.place(start)
    flankRightEnd.set(kidChain, Math.max(flankRightEnd.get(kidChain) ?? -Infinity, start + block.width))
    return true
  }
  if (options.rootPersonId != null) {
    for (const block of freeInLaw) {
      if (!placeFlank(block)) { block.place(cursor); cursor += block.width + FAMILY_GAP * 2 }
    }
  }

  // 2) Blocs ancrés : l'union concernée centrée sur son enfant déjà placé, générations
  // profondes d'abord, puis par proximité avec la racine. En mode « rooted », le bloc est
  // inséré en flanc de la chaîne de son enfant (placeFlank) ; le repli par créneau ne
  // concerne plus que le mode par défaut (et les cas sans enfant placé).
  const occupied = (exclude) => {
    const byGen = new Map()
    for (const n of nodes) {
      if (!pos.has(n.id) || exclude.has(n.id)) continue
      if (!byGen.has(n._generation)) byGen.set(n._generation, [])
      byGen.get(n._generation).push([pos.get(n.id), pos.get(n.id) + n.width])
    }
    return byGen
  }
  anchored.sort((a, b) => b.gen - a.gen || distRank(a.chain) - distRank(b.chain))
  for (const block of anchored) {
    if (options.rootPersonId != null && placeFlank(block)) continue
    const occ = occupied(block.members)
    const targets = block.external
      .filter(({ kid }) => pos.has(kid))
      .map(({ kid, unionId }) => pos.get(kid) + byId.get(kid).width / 2 - (block.rel(unionId) + byId.get(unionId).width / 2))
    if (!targets.length) { block.place(cursor); cursor += block.width + FAMILY_GAP * 2; continue }
    const ideal = targets.reduce((s, v) => s + v, 0) / targets.length
    const anchoredMargin = options.rootPersonId != null ? NODE_SPACING : FAMILY_GAP
    // Positions relatives des membres : le test de créneau ne replace pas tout le bloc
    // à chaque pas de recherche (place() coûte un parcours du sous-arbre).
    const membersRel = [...block.members].map(id => ({
      rx: block.rel(id), w: byId.get(id).width, gen: byId.get(id)._generation,
    }))
    const fits = (x0) => {
      for (const m of membersRel) {
        const x = x0 + m.rx
        for (const [s, e] of (occ.get(m.gen) || [])) {
          if (x < e + anchoredMargin && x + m.w > s - anchoredMargin) return false
        }
      }
      return true
    }
    let found = false
    let foundX = 0
    for (let d = 0; d < 40000 && !found; d += 20) {
      if (fits(ideal + d)) { found = true; foundX = ideal + d }
      else if (d > 0 && fits(ideal - d)) { found = true; foundX = ideal - d }
    }
    if (!found) {
      if (options.rootPersonId == null) {
        block.place(cursor); cursor += block.width + FAMILY_GAP * 2
        continue
      }
      let bestX = null, bestOverlap = Infinity
      for (let d = 0; d <= 40000 && bestOverlap > 0; d += 60) {
        for (const x0 of d === 0 ? [ideal] : [ideal + d, ideal - d]) {
          let overlap = 0
          for (const m of membersRel) {
            const x = x0 + m.rx
            for (const [s, e] of (occ.get(m.gen) || [])) {
              if (x < e && x + m.w > s) overlap += Math.min(e, x + m.w) - Math.max(s, x)
            }
          }
          if (overlap < bestOverlap) { bestOverlap = overlap; bestX = x0 }
        }
      }
      foundX = bestX ?? cursor
    }
    block.place(foundX)
  }

  // Réinjecter le X, normalisé à 0 ; Y inchangé (générations)
  let minX = Infinity
  for (const n of nodes) if (pos.has(n.id)) minX = Math.min(minX, pos.get(n.id))
  for (const n of nodes) if (pos.has(n.id)) n.x = pos.get(n.id) - minX

  // Arête longue vers un enfant placé sous l'autre lignée. Par défaut : renvoi cliquable
  // (voir drawFiliations). En mode « rooted », une arête qui ne saute qu'une génération
  // est dessinée en connecteur orthogonal dans le couloir vide entre deux rangées —
  // la relation reste un vrai trait lisible, le renvoi reste le repli des sauts
  // multiples (un couloir traverserait une rangée de portraits).
  // Plusieurs renvois sous la même union : pastilles empilées (_renvoiIndex)
  const centerX = (id) => byId.get(id).x + byId.get(id).width / 2
  const renvoisByUnion = new Map()
  for (const e of result.edges) {
    const u = e.sources[0], c = e.targets[0]
    if (!externalEdges.has(`${u}>${c}`) || Math.abs(centerX(u) - centerX(c)) <= RENVOI_MIN_DX) continue
    if (options.rootPersonId != null
      && byId.get(c)._generation - byId.get(u)._generation === 1) {
      e._corridor = true
      continue
    }
    e._renvoi = true
    e._renvoiIndex = renvoisByUnion.get(u) || 0
    renvoisByUnion.set(u, e._renvoiIndex + 1)
  }

  return result
}
