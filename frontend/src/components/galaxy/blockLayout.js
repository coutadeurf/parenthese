import { computeLayout, componentOrderPerGen, chainGap } from './elkLayout'
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
// Benchmark et variantes écartées : tools/layout-bench/.
// ============================================================

const NODE_SPACING = 30
const FAMILY_GAP = 60

export function computeBlockLayout(graphData = null) {
  const result = computeLayout(graphData)
  const nodes = result.children
  const byId = new Map(nodes.map(n => [n.id, n]))

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
    const childBlocks = []
    const external = []
    for (const id of chain) {
      if (byId.get(id)._type !== 'union') continue
      for (const k of (childrenOfUnion.get(id) || [])) {
        const kc = chainOf.get(k)
        if (!placed.has(kc)) childBlocks.push(buildBlock(kc))
        else { external.push({ kid: k, unionId: id }); externalEdges.add(`${id}>${k}`) }
      }
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
      rows, members, external, gen, rel,
      get width() { return Math.max(...[...rows.values()].map(v => v[1])) },
      place(x0) {
        for (const id of chain) pos.set(id, x0 + rowX + offsets.get(id))
        childBlocks.forEach((b, i) => b.place(x0 + kidXs[i]))
      },
    }
  }

  // 1) Racines : chaînes sans parents, grandes lignées d'abord
  const roots = chains.filter(c => !hasParents(c)).sort((a, b) => countDesc(b) - countDesc(a) || genOf(a) - genOf(b))
  const free = [], anchored = []
  for (const r of roots) {
    if (placed.has(r)) continue
    const block = buildBlock(r)
    const ownExternal = block.external.some(({ unionId }) => r.includes(unionId))
    if (ownExternal) anchored.push(block)
    else free.push(block)
  }
  const forest = packBlocks(free, FAMILY_GAP * 2)
  free.forEach((b, i) => b.place(forest.xs[i]))
  let cursor = Math.max(0, ...[...forest.rows.values()].map(v => v[1])) + FAMILY_GAP * 2

  // 2) Blocs ancrés : l'union concernée centrée sur son enfant déjà placé, générations profondes d'abord
  const occupied = (exclude) => {
    const byGen = new Map()
    for (const n of nodes) {
      if (!pos.has(n.id) || exclude.has(n.id)) continue
      if (!byGen.has(n._generation)) byGen.set(n._generation, [])
      byGen.get(n._generation).push([pos.get(n.id), pos.get(n.id) + n.width])
    }
    return byGen
  }
  anchored.sort((a, b) => b.gen - a.gen)
  for (const block of anchored) {
    const occ = occupied(block.members)
    const targets = block.external
      .filter(({ kid }) => pos.has(kid))
      .map(({ kid, unionId }) => pos.get(kid) + byId.get(kid).width / 2 - (block.rel(unionId) + byId.get(unionId).width / 2))
    if (!targets.length) { block.place(cursor); cursor += block.width + FAMILY_GAP * 2; continue }
    const ideal = targets.reduce((s, v) => s + v, 0) / targets.length
    const fits = (x0) => {
      block.place(x0)
      for (const id of block.members) {
        const n = byId.get(id); const x = pos.get(id)
        for (const [s, e] of (occ.get(n._generation) || [])) {
          if (x < e + FAMILY_GAP && x + n.width > s - FAMILY_GAP) return false
        }
      }
      return true
    }
    let found = false
    for (let d = 0; d < 40000 && !found; d += 20) {
      if (fits(ideal + d)) found = true
      else if (d > 0 && fits(ideal - d)) found = true
    }
    if (!found) { block.place(cursor); cursor += block.width + FAMILY_GAP * 2 }
  }

  // Réinjecter le X, normalisé à 0 ; Y inchangé (générations)
  let minX = Infinity
  for (const n of nodes) if (pos.has(n.id)) minX = Math.min(minX, pos.get(n.id))
  for (const n of nodes) if (pos.has(n.id)) n.x = pos.get(n.id) - minX

  // Arête longue vers un enfant placé sous l'autre lignée : dessinée en renvoi (voir drawFiliations)
  // Plusieurs renvois sous la même union : pastilles empilées (_renvoiIndex)
  const centerX = (id) => byId.get(id).x + byId.get(id).width / 2
  const renvoisByUnion = new Map()
  for (const e of result.edges) {
    const u = e.sources[0], c = e.targets[0]
    if (!externalEdges.has(`${u}>${c}`) || Math.abs(centerX(u) - centerX(c)) <= RENVOI_MIN_DX) continue
    e._renvoi = true
    e._renvoiIndex = renvoisByUnion.get(u) || 0
    renvoisByUnion.set(u, e._renvoiIndex + 1)
  }

  return result
}
