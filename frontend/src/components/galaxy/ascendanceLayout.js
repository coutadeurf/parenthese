import { persons as globalPersons, unions as globalUnions, filiations as globalFiliations } from '../../data/mockData'
import { computeLayout, normalizeFiliationsForLayout, coupleBarMeta, componentOrderPerGen, chainGap } from './elkLayout'
import { RENVOI_MIN_DX } from './constants'

// ============================================================
// Mode Ascendance
//
// Vue centrée sur une personne racine choisie explicitement : ses
// ancêtres au-dessus, génération après génération, avec les
// fratries et les familles recomposées en branches secondaires.
//
// Stratégie de placement dédiée (pas une inversion verticale du
// placement descendant) :
//
//   1. buildAscendanceView construit le sous-graphe de la vue :
//      clôture ascendante directe depuis la racine, fratries des
//      personnes de la lignée directe (leurs conjoints et leurs
//      enfants), branches de remariage des ancêtres. Aucune
//      personne ni union n'est dupliquée ; les cycles de données
//      sont absorbés par des ensembles de visite.
//   2. computeLayout est appelé sur ce sous-graphe : il produit
//      les nœuds, les arêtes, les générations (Y), coupleBarMeta et
//      componentOrderPerGen — exactement ce que le renderer consomme.
//   3. Une passe X dédiée réorganise les blocs familiaux : comme
//      blockLayout, un bloc = une chaîne de couples + les blocs de
//      ses enfants, mais la chaîne est centrée sur l'enfant de la
//      LIGNÉE DIRECTE (l'axe), les branches collatérales étant
//      tassées à côté dans l'ordre displayOrder sans déplacer l'axe.
//      Les racines du bloc sont ordonnées par proximité avec la
//      lignée (parcours depuis la racine), pas par taille.
//   4. Les arêtes externes (personne revendiquée par deux branches :
//      collapse d'ascendance, filiations multiples) deviennent des
//      renvois ; les liens secondaires sont marqués _secondary
//      (pointillés au rendu) et la racine reçoit _ascendanceRoot.
// ============================================================

const NODE_SPACING = 30
const FAMILY_GAP = 60

const toOrder = (value) => (Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER)

// ============================================================
// Personne racine par défaut : la plus connectée (même critère que
// le « choix automatique » de la configuration de l'arbre), départage
// par identifiant pour rester déterministe.
// ============================================================
export function pickDefaultAscendanceRoot(persons = [], unions = [], filiations = []) {
  if (!Array.isArray(persons) || persons.length === 0) return null
  const degree = new Map()
  const bump = (id) => {
    if (id === null || id === undefined) return
    const key = String(id)
    degree.set(key, (degree.get(key) || 0) + 1)
  }
  const unionById = new Map((Array.isArray(unions) ? unions : []).map((u) => [String(u.id), u]))
  for (const f of (Array.isArray(filiations) ? filiations : [])) {
    if (!f) continue
    bump(f.childId)
    bump(f.parentId)
    if (f.unionId) {
      const union = unionById.get(String(f.unionId))
      if (union) {
        bump(union.partner1Id)
        bump(union.partner2Id)
      }
    }
  }
  let bestId = null
  let bestDegree = -1
  for (const person of persons) {
    const id = String(person.id)
    const d = degree.get(id) || 0
    if (d > bestDegree || (d === bestDegree && bestId !== null && id.localeCompare(bestId) < 0)) {
      bestId = id
      bestDegree = d
    }
  }
  return bestId
}

// ============================================================
// Construction de la vue d'ascendance (fonction pure, testée à part)
//
// Retourne { persons, unions, filiations, directPersonIds,
// directPersonOrder, secondaryUnionIds, rootPersonId }.
//
// Règles :
//   - Lignée directe : clôture ascendante depuis la racine en
//     remontant les filiations réelles (union → deux partenaires,
//     ou parent direct). Jamais de filiation déduite.
//   - Collatérales : pour chaque personne de la lignée (racine
//     comprise), les autres enfants de ses sources parentes
//     (fratries), leurs unions (conjoints) et les enfants de ces
//     unions (un niveau de descendants, sans réexpansion).
//   - Remariages : pour chaque ancêtre propre (pas la racine), les
//     unions qui ne sont pas une source parente de la lignée :
//     l'union, son conjoint et ses enfants (branche secondaire).
//   - La racine elle-même n'a ni conjoint ni enfant dans la vue :
//     ce mode ne montre que ses ancêtres.
// ============================================================
export function buildAscendanceView(graph, rootPersonId) {
  const persons = Array.isArray(graph?.persons) ? graph.persons : []
  const unions = Array.isArray(graph?.unions) ? graph.unions : []
  const filiations = Array.isArray(graph?.filiations) ? graph.filiations : []
  const personIdSet = new Set(persons.map((p) => String(p.id)))
  const empty = {
    persons: [], unions: [], filiations: [],
    directPersonIds: new Set(), directPersonOrder: [], secondaryUnionIds: new Set(),
    rootPersonId: null,
  }
  const rootId = rootPersonId != null && personIdSet.has(String(rootPersonId)) ? String(rootPersonId) : null
  if (!rootId) return empty

  // Filiation normalisées (mêmes règles que le placement descendant :
  // déduplication, filiations synthétiques quand deux parents directs
  // correspondent à une union enregistrée)
  const normalized = normalizeFiliationsForLayout(filiations, unions)
  const unionById = new Map(unions.map((u) => [String(u.id), u]))

  // Identifiant du nœud source d'une filiation (même convention qu'elkLayout)
  const sourceIdOf = (f) => (f.unionId ? `u-${f.unionId}` : `vu-${f.parentId}`)
  const otherPartner = (union, personId) => (
    String(union.partner1Id) === personId ? union.partner2Id : union.partner1Id
  )

  const sourcesByChild = new Map() // personId → [filiation]
  const childrenBySource = new Map() // sourceId → [{ childId, filiation }]
  const unionsByPerson = new Map() // personId → [unionId]
  for (const f of normalized) {
    const childId = String(f.childId)
    if (!personIdSet.has(childId)) continue
    if (!sourcesByChild.has(childId)) sourcesByChild.set(childId, [])
    sourcesByChild.get(childId).push(f)
    const sid = sourceIdOf(f)
    if (!childrenBySource.has(sid)) childrenBySource.set(sid, [])
    childrenBySource.get(sid).push({ childId, filiation: f })
  }
  // Fratries dans l'ordre choisi par la famille (displayOrder), à égalité ordre d'arrivée
  for (const list of childrenBySource.values()) {
    list.sort((a, b) => (
      toOrder(a.filiation.displayOrder) - toOrder(b.filiation.displayOrder)
      || String(a.filiation.id).localeCompare(String(b.filiation.id))
    ))
  }
  for (const u of unions) {
    for (const pid of [u.partner1Id, u.partner2Id]) {
      if (pid === null || pid === undefined) continue
      const key = String(pid)
      if (!unionsByPerson.has(key)) unionsByPerson.set(key, [])
      unionsByPerson.get(key).push(String(u.id))
    }
  }

  // --- 1. Clôture ascendante directe (parcours en largeur, résistant aux cycles) ---
  const directPersonIds = new Set([rootId])
  const directPersonOrder = [rootId]
  const viewPersonIds = new Set([rootId])
  const viewFiliationIds = new Set()
  const viewUnionIds = new Set()
  const directUnionIds = new Set()
  const queue = [rootId]
  while (queue.length > 0) {
    const pid = queue.shift()
    for (const f of (sourcesByChild.get(pid) || [])) {
      if (f.unionId) directUnionIds.add(String(f.unionId))
      viewFiliationIds.add(String(f.id))
      if (f.unionId) {
        const union = unionById.get(String(f.unionId))
        for (const parentId of union ? [union.partner1Id, union.partner2Id] : []) {
          if (parentId === null || parentId === undefined) continue
          const key = String(parentId)
          if (!personIdSet.has(key)) continue
          if (!directPersonIds.has(key)) {
            directPersonIds.add(key)
            directPersonOrder.push(key)
            viewPersonIds.add(key)
            queue.push(key)
          }
        }
      } else if (f.parentId !== null && f.parentId !== undefined) {
        const key = String(f.parentId)
        if (personIdSet.has(key) && !directPersonIds.has(key)) {
          directPersonIds.add(key)
          directPersonOrder.push(key)
          viewPersonIds.add(key)
          queue.push(key)
        }
      }
    }
  }

  // --- 2. Branches collatérales : fratrie de chaque personne de la lignée + foyer ---
  // Un frère/une sœur est ajouté avec son union (conjoints) et les enfants de cette
  // union (un niveau de descendants). Les enfants eux-mêmes ne sont pas réexpansés.
  const addCollateralHousehold = (personId, attachFiliation) => {
    if (viewPersonIds.has(personId)) return
    viewPersonIds.add(personId)
    viewFiliationIds.add(String(attachFiliation.id))
    for (const uId of (unionsByPerson.get(personId) || [])) {
      const union = unionById.get(uId)
      if (!union) continue
      viewUnionIds.add(uId)
      const spouseId = otherPartner(union, personId)
      if (spouseId !== null && spouseId !== undefined && personIdSet.has(String(spouseId))) {
        viewPersonIds.add(String(spouseId))
      }
      for (const { childId, filiation } of (childrenBySource.get(`u-${uId}`) || [])) {
        viewFiliationIds.add(String(filiation.id))
        viewPersonIds.add(childId)
      }
    }
  }
  for (const pid of directPersonOrder) {
    for (const f of (sourcesByChild.get(pid) || [])) {
      for (const { childId, filiation } of (childrenBySource.get(sourceIdOf(f)) || [])) {
        if (directPersonIds.has(childId)) continue
        addCollateralHousehold(childId, filiation)
      }
    }
  }

  // --- 3. Remariages des ancêtres propres : union + conjoint + enfants ---
  for (const pid of directPersonOrder) {
    if (pid === rootId) continue
    for (const uId of (unionsByPerson.get(pid) || [])) {
      if (directUnionIds.has(uId) || viewUnionIds.has(uId)) continue
      const union = unionById.get(uId)
      if (!union) continue
      viewUnionIds.add(uId)
      const spouseId = otherPartner(union, pid)
      if (spouseId !== null && spouseId !== undefined && personIdSet.has(String(spouseId))) {
        viewPersonIds.add(String(spouseId))
      }
      for (const { childId, filiation } of (childrenBySource.get(`u-${uId}`) || [])) {
        viewFiliationIds.add(String(filiation.id))
        viewPersonIds.add(childId)
      }
    }
  }

  // Toute union référencée par une filiation de la vue est dans la vue
  for (const f of normalized) {
    if (viewFiliationIds.has(String(f.id)) && f.unionId) viewUnionIds.add(String(f.unionId))
  }

  // Unions secondaires : présentes dans la vue mais pas sur la lignée directe
  const secondaryUnionIds = new Set([...viewUnionIds].filter((id) => !directUnionIds.has(id)))

  return {
    persons: persons.filter((p) => viewPersonIds.has(String(p.id))),
    unions: unions.filter((u) => viewUnionIds.has(String(u.id))),
    filiations: normalized.filter((f) => viewFiliationIds.has(String(f.id))),
    directPersonIds,
    directPersonOrder,
    secondaryUnionIds,
    rootPersonId: rootId,
  }
}

// ============================================================
// Placement Ascendance
// ============================================================
export function computeAscendanceLayout(graphData = null, rootPersonId = null) {
  const graph = graphData ?? { persons: globalPersons, unions: globalUnions, filiations: globalFiliations }
  const persons = Array.isArray(graph.persons) ? graph.persons : []
  const rootId = rootPersonId != null && persons.some((p) => String(p.id) === String(rootPersonId))
    ? String(rootPersonId)
    : pickDefaultAscendanceRoot(persons, graph.unions, graph.filiations)

  const view = buildAscendanceView(graph, rootId)
  // Nœuds, arêtes, générations (Y), coupleBarMeta, componentOrderPerGen :
  // produits par le moteur existant, garantissant la compatibilité renderer.
  const result = computeLayout({ persons: view.persons, unions: view.unions, filiations: view.filiations })
  const nodes = result.children
  const edges = result.edges
  const byId = new Map(nodes.map((n) => [n.id, n]))

  // --- Marquage des liens secondaires et de la racine (indépendant du placement X) ---
  const directElkIds = new Set([...view.directPersonIds].map((id) => `p-${id}`))
  for (const e of edges) {
    if (!directElkIds.has(e.targets[0])) e._secondary = true
  }
  for (const entry of coupleBarMeta) {
    if (entry.virtual || !entry.elkId.startsWith('u-')) continue
    if (view.secondaryUnionIds.has(entry.elkId.slice(2))) entry.secondary = true
  }
  const rootNode = view.rootPersonId ? byId.get(`p-${view.rootPersonId}`) : null
  if (rootNode) rootNode._ascendanceRoot = true

  // --- Chaînes de couples par génération (peuplées par computeLayout) ---
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

  const rootChain = rootNode ? chainOf.get(rootNode.id) : null
  if (!rootChain || chains.length === 0) {
    return { children: nodes, edges, ascendanceRootId: view.rootPersonId }
  }

  // --- Arêtes : union → enfant, et sources parentes de chaque personne ---
  const childrenOfUnion = new Map()
  const parentSourcesByChild = new Map()
  for (const e of edges) {
    const u = e.sources[0]
    const c = e.targets[0]
    if (!childrenOfUnion.has(u)) childrenOfUnion.set(u, [])
    childrenOfUnion.get(u).push(c)
    if (!parentSourcesByChild.has(c)) parentSourcesByChild.set(c, [])
    parentSourcesByChild.get(c).push(u)
  }
  // Fratrie dans l'ordre choisi par la famille (displayOrder) ; à ordre égal, ordre d'arrivée
  const edgeOrder = new Map(edges.map((e) => [`${e.sources[0]}>${e.targets[0]}`, toOrder(e._displayOrder)]))
  for (const [u, kids] of childrenOfUnion) {
    kids.sort((a, b) => edgeOrder.get(`${u}>${a}`) - edgeOrder.get(`${u}>${b}`))
  }

  const parentChainsOf = (chain) => {
    const seen = new Set()
    const out = []
    for (const id of chain) {
      if (!id.startsWith('p-')) continue
      for (const src of (parentSourcesByChild.get(id) || [])) {
        const pc = chainOf.get(src)
        if (pc && pc !== chain && !seen.has(pc)) {
          seen.add(pc)
          out.push(pc)
        }
      }
    }
    return out
  }

  // --- Axe de la lignée directe : pour chaque chaîne parente, l'enfant de la lignée ---
  // Premier revendiqué (parcours depuis la racine, filiations dans l'ordre displayOrder).
  const trunkChildOf = new Map()
  for (const pid of view.directPersonOrder) {
    const childChain = chainOf.get(`p-${pid}`)
    if (!childChain) continue
    for (const src of (parentSourcesByChild.get(`p-${pid}`) || [])) {
      const pc = chainOf.get(src)
      if (pc && !trunkChildOf.has(pc)) trunkChildOf.set(pc, childChain)
    }
  }
  // Ordre de revendication = ordre du parcours depuis la racine (insertion Map)
  const claimIndex = new Map([...trunkChildOf.keys()].map((chain, i) => [chain, i]))

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

  // Imbrique des blocs de gauche à droite, génération par génération (même principe que blockLayout)
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
        if (!kc || kc === chain) continue
        if (!placed.has(kc)) childBlocks.push(buildBlock(kc))
        else { external.push({ kid: k, unionId: id }); externalEdges.add(`${id}>${k}`) }
      }
    }
    const packed = packBlocks(childBlocks, FAMILY_GAP)

    // Centrage sur l'axe : la chaîne est centrée sur son enfant de la lignée directe ;
    // les branches collatérales restent tassées à côté sans déplacer l'axe. Sans enfant
    // de la lignée (branche collatérale, ou racine sans descendance dans la vue), la
    // chaîne est centrée sur la rangée de ses enfants, comme le placement descendant.
    const trunkChain = trunkChildOf.get(chain)
    const trunkIndex = trunkChain ? childBlocks.findIndex((b) => b.chain === trunkChain) : -1
    let rowX = 0
    if (trunkIndex >= 0) {
      const b = childBlocks[trunkIndex]
      const [l, r] = b.rows.get(b.gen)
      rowX = packed.xs[trunkIndex] + (l + r) / 2 - rowW / 2
    } else if (childBlocks.length) {
      const kidRowL = Math.min(...childBlocks.map((b, i) => packed.xs[i] + b.rows.get(b.gen)[0]))
      const kidRowR = Math.max(...childBlocks.map((b, i) => packed.xs[i] + b.rows.get(b.gen)[1]))
      rowX = (kidRowL + kidRowR) / 2 - rowW / 2
    }

    const rows = new Map([[gen, [rowX, rowX + rowW]]])
    for (const [g, [l, r]] of packed.rows) {
      const a = rows.get(g)
      rows.set(g, a ? [Math.min(a[0], l), Math.max(a[1], r)] : [l, r])
    }
    const minL = Math.min(...[...rows.values()].map((v) => v[0]))
    for (const [g, v] of rows) rows.set(g, [v[0] - minL, v[1] - minL])
    rowX -= minL
    const kidXs = packed.xs.map((x) => x - minL)

    const members = new Set(chain)
    for (const b of childBlocks) { for (const m of b.members) members.add(m); external.push(...b.external) }
    const rel = (id) => {
      if (offsets.has(id)) return rowX + offsets.get(id)
      for (let i = 0; i < childBlocks.length; i++) if (childBlocks[i].members.has(id)) return kidXs[i] + childBlocks[i].rel(id)
      return null
    }
    return {
      chain, rows, members, external, gen, rel,
      get width() { return Math.max(...[...rows.values()].map((v) => v[1])) },
      place(x0) {
        for (const id of chain) pos.set(id, x0 + rowX + offsets.get(id))
        childBlocks.forEach((b, i) => b.place(x0 + kidXs[i]))
      },
    }
  }

  // 1) Racines : chaînes sans source parente dans la vue, lignée directe d'abord
  //    (ordre du parcours depuis la racine), puis les autres par génération
  const roots = chains.filter((c) => parentChainsOf(c).length === 0)
  roots.sort((a, b) => {
    const ia = claimIndex.get(a)
    const ib = claimIndex.get(b)
    if (ia !== undefined && ib !== undefined) return ia - ib
    if (ia !== undefined) return -1
    if (ib !== undefined) return 1
    return genOf(a) - genOf(b) || String(a[0]).localeCompare(String(b[0]))
  })
  const free = []
  const anchored = []
  for (const r of roots) {
    if (placed.has(r)) continue
    const block = buildBlock(r)
    const ownExternal = block.external.some(({ unionId }) => r.includes(unionId))
    if (ownExternal) anchored.push(block)
    else free.push(block)
  }
  const forest = packBlocks(free, FAMILY_GAP * 2)
  free.forEach((b, i) => b.place(forest.xs[i]))
  let cursor = Math.max(0, ...[...forest.rows.values()].map((v) => v[1])) + FAMILY_GAP * 2

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
        const n = byId.get(id)
        const x = pos.get(id)
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
  if (Number.isFinite(minX)) {
    for (const n of nodes) if (pos.has(n.id)) n.x = pos.get(n.id) - minX
  }

  // Arête longue vers un enfant placé sous l'autre lignée : dessinée en renvoi (voir drawFiliations)
  // Plusieurs renvois sous la même union : pastilles empilées (_renvoiIndex)
  const centerX = (id) => byId.get(id).x + byId.get(id).width / 2
  const renvoisByUnion = new Map()
  for (const e of edges) {
    const u = e.sources[0]
    const c = e.targets[0]
    if (!externalEdges.has(`${u}>${c}`) || Math.abs(centerX(u) - centerX(c)) <= RENVOI_MIN_DX) continue
    e._renvoi = true
    e._renvoiIndex = renvoisByUnion.get(u) || 0
    renvoisByUnion.set(u, e._renvoiIndex + 1)
  }

  return { children: nodes, edges, ascendanceRootId: view.rootPersonId }
}
