import { computeLayout, componentOrderPerGen, chainGap, coupleBarMeta } from './elkLayout'
import { RENVOI_MIN_DX } from './constants'

// ============================================================
// Layout « pedigree » (mode « rooted »)
//
// L'arbre généalogique classique : chaque chaîne de couple est ancrée
// AU-DESSUS de son enfant de la ligne directe (la barre d'union à la
// verticale de l'enfant), les ancêtres de chaque partenaire s'étendent
// de part et d'autre — lignée du père à gauche, de la mère à droite —
// et les collatéraux (fratries, oncles, cousins) se rangent à
// l'extérieur de leur lignée, jamais dans le couloir de la ligne
// directe.
//
// Deux passes :
//   1. Plans des unités familiales, feuille vers la racine (mémoïsés).
//      Une unité d'union = la chaîne de couple contenant l'union
//      d'ancrage + les boîtes d'ascendance des membres (l'unité des
//      parents de chaque membre, ancrée au-dessus de lui) + les packs
//      des enfants non pivots (fratrie du pivot), rangés au-delà de la
//      rangée du pivot, du côté du pivot. Une unité de personne (racine,
//      pack d'un collatéral) = sa chaîne + les boîtes des conjoints +
//      les lots de ses enfants centrés sous chaque union.
//   2. Pose descendante depuis la racine (la personne racine à x = 0,
//      l'unité de ses parents ancrée au-dessus d'elle), puis les
//      composantes déconnectées au fil d'un curseur à droite de tout.
//
// L'empreinte d'un plan est PAR RANGÉE (Map décalage de génération →
// [gauche, droite], voir mergeRows) : une boîte n'élargit la chaîne que
// sur les rangées qu'elle occupe vraiment. Des largeurs scalaires
// fusionneraient toutes les rangées et doubleraient à chaque génération
// dès que deux lignées partagent des ancêtres.
//
// Les chaînes de couples viennent d'elkLayout (componentOrderPerGen) :
// l'ordre linéaire personne-union-personne est déjà calculé là, sans
// doublon, et chainGap donne l'écart entre membres consécutifs.
//
// Les générations (Y) et les nœuds viennent de computeLayout ; seul X
// est recalculé. Les arêtes longues deviennent couloir (saut d'une
// génération) ou renvoi, comme dans blockLayout.
// ============================================================

const NODE_SPACING = 30
const FAMILY_GAP = 60

export function computePedigreeLayout(graphData, rootPersonId) {
  const result = computeLayout(graphData, { rootPersonId })
  const nodes = result.children
  const byId = new Map(nodes.map((n) => [n.id, n]))

  // --- Structure : partenaires, enfants par union, union parentale par enfant
  const orderOfUnion = new Map()
  for (const u of graphData?.unions || []) orderOfUnion.set(`u-${u.id}`, { displayOrder: u.displayOrder, id: u.id })

  const unionsOf = new Map() // personne -> unions réelles triées
  for (const { elkId, p1Key, p2Key, virtual } of coupleBarMeta) {
    if (virtual) continue
    for (const p of [p1Key, p2Key]) {
      if (!p) continue
      if (!unionsOf.has(p)) unionsOf.set(p, [])
      unionsOf.get(p).push(elkId)
    }
  }
  for (const [, list] of unionsOf) {
    list.sort((a, b) => {
      const oa = orderOfUnion.get(a) ?? {}
      const ob = orderOfUnion.get(b) ?? {}
      return (oa.displayOrder ?? 0) - (ob.displayOrder ?? 0) || String(oa.id ?? a).localeCompare(String(ob.id ?? b))
    })
  }

  const childrenOf = new Map() // union -> enfants (ordre des filiations)
  const parentLinkOf = new Map() // enfant -> union parentale (la première)
  for (const e of result.edges) {
    const u = e.sources[0]
    const c = e.targets[0]
    if (!childrenOf.has(u)) childrenOf.set(u, [])
    childrenOf.get(u).push(c)
    if (!parentLinkOf.has(c)) parentLinkOf.set(c, u)
  }

  const personData = (id) => byId.get(id)?._data ?? null
  const kidOrder = (a, b) => {
    const da = personData(a) ?? {}
    const db = personData(b) ?? {}
    return (da.displayOrder ?? 0) - (db.displayOrder ?? 0) || String(da.id ?? a).localeCompare(String(db.id ?? b))
  }
  const isUnionNode = (id) => id.startsWith('u-') || id.startsWith('vu-')

  // --- Chaînes de couples : composantes d'une génération telles qu'elkLayout
  // les a ordonnées (traverseChain : chaque nœud une fois, alternance
  // personne-union). Un nœud sans union forme une chaîne seule.
  const chainOf = new Map() // nœud -> chaîne qui le contient
  for (const gen of [...componentOrderPerGen.keys()].sort((a, b) => a - b)) {
    for (const ids of componentOrderPerGen.get(gen)) {
      for (const id of ids) if (!chainOf.has(id)) chainOf.set(id, ids)
    }
  }
  const chainOfNode = (id) => chainOf.get(id) || [id]

  // --- Empreintes par rangée : décalage de génération (relatif à la rangée de
  // l'ancre du plan) -> [gauche, droite], en coordonnées relatives à l'ancre.
  const rowUnion = (rows, off, l, r) => {
    const cur = rows.get(off)
    rows.set(off, cur ? [Math.min(cur[0], l), Math.max(cur[1], r)] : [l, r])
  }
  const mergeRows = (rows, subRows, off, x) => {
    for (const [o, [l, r]] of subRows) rowUnion(rows, o + off, l + x, r + x)
  }
  const rowsExtents = (rows) => {
    let left = Infinity
    let right = -Infinity
    for (const [, [l, r]] of rows) {
      left = Math.min(left, l)
      right = Math.max(right, r)
    }
    return { left, right }
  }
  const rowOf = (rows, off) => rows.get(off) ?? [Infinity, -Infinity]

  // --- Plans des unités (mémoïsés, gardés contre les cycles)
  const planUnion = new Map() // `${unionId}|${pivotKid}` -> plan ancré sur l'union
  const planPerson = new Map() // `${personId}` ou `${personId}|own` -> plan ancré sur la personne
  const visiting = new Set()

  const degeneratePlan = (id) => {
    const half = (byId.get(id)?.width ?? 0) / 2
    return { chain: [id], pos: [0], boxes: [null], kidPacks: [], anchorIndex: 0, left: -half, right: half, chainLeft: -half, chainRight: half, rows: new Map([[0, [-half, half]]]) }
  }

  const sideOfIndex = (index, anchorIndex) => (index >= anchorIndex ? 'right' : 'left')
  // Côté intrinsèque d'un membre dans sa chaîne : au-delà du bout où il se
  // trouve. Indépendant de l'ancre du plan — deux plans de la même chaîne
  // (la racine et son conjoint) doivent largeur pour largeur poser les
  // mêmes packs au même endroit.
  const intrinsicSide = (index, length) => (2 * index >= length - 1 ? 'right' : 'left')

  // Positionne les membres d'une chaîne autour de son ancre ; les écarts
  // s'élargissent pour que les boîtes d'ascendance ne se chevauchent pas,
  // mais seulement sur les rangées qu'elles occupent réellement (les
  // rangées d'une boîte sont décalées de -1 : la barre d'union des
  // parents se pose à la verticale du membre, une rangée au-dessus).
  const layoutChain = (chain, anchorIndex, boxes) => {
    const pos = []
    for (let i = 0; i < chain.length; i += 1) {
      const w = byId.get(chain[i]).width
      if (i === 0) {
        pos[i] = w / 2
      } else {
        const gap = chainGap(byId.get(chain[i - 1]), byId.get(chain[i]), NODE_SPACING)
        pos[i] = pos[i - 1] + byId.get(chain[i - 1]).width / 2 + gap + w / 2
      }
    }
    const prevRight = new Map() // décalage rangée -> bord droit déjà posé
    for (let i = 0; i < chain.length; i += 1) {
      const half = byId.get(chain[i]).width / 2
      // le membre borne sa propre rangée : les packs d'une boîte (rangée du
      // pivot, décalée en 0 ici) ne passent pas sur les membres posés avant
      prevRight.set(0, Math.max(prevRight.get(0) ?? -Infinity, pos[i] + half))
      const box = boxes[i]
      if (!box) continue
      let shift = 0
      for (const [off, [l]] of box.rows) {
        const needLeft = pos[i] + l
        const prev = prevRight.get(off - 1) ?? -Infinity
        if (needLeft < prev + NODE_SPACING) shift = Math.max(shift, prev + NODE_SPACING - needLeft)
      }
      if (shift > 0) for (let j = i; j < chain.length; j += 1) pos[j] += shift
      for (const [off, [, r]] of box.rows) {
        prevRight.set(off - 1, Math.max(prevRight.get(off - 1) ?? -Infinity, pos[i] + r))
      }
    }
    const anchorX = pos[anchorIndex]
    for (let i = 0; i < chain.length; i += 1) pos[i] -= anchorX
    return pos
  }

  // Plan d'une unité de personne (la racine ou un pack de collatéral) :
  // sa chaîne, les boîtes des conjoints, les lots de ses enfants centrés
  // sous chaque union de la chaîne. Avec « own », la boîte des parents de
  // l'ancre (l'unité posée au-dessus d'elle) fait partie du plan : c'est le
  // cas de la racine et des têtes de composantes déconnectées, qui n'ont pas
  // d'unité appelante pour la réserver.
  const buildPersonUnit = (personId, own = false) => {
    const memoKey = own ? `${personId}|own` : personId
    if (planPerson.has(memoKey)) return planPerson.get(memoKey)
    if (visiting.has(personId)) return degeneratePlan(personId)
    visiting.add(personId)
    const chain = chainOfNode(personId)
    const anchorIndex = chain.indexOf(personId)
    // Une même union parentale n'est revendiquée qu'une fois : deux membres
    // de la chaîne frères ou sœurs partagent leurs ancêtres, posés une fois.
    const boxUnionSeen = new Set()
    const boxes = chain.map((id, i) => {
      if (i === anchorIndex && !own) return null
      if (isUnionNode(id)) return null
      const link = parentLinkOf.get(id)
      if (!link || boxUnionSeen.has(link)) return null
      boxUnionSeen.add(link)
      return buildUnionUnit(link, id, intrinsicSide(i, chain.length))
    })
    const pos = layoutChain(chain, anchorIndex, boxes)
    const rows = new Map()
    for (let i = 0; i < chain.length; i += 1) {
      const half = byId.get(chain[i]).width / 2
      rowUnion(rows, 0, pos[i] - half, pos[i] + half)
      if (boxes[i]) mergeRows(rows, boxes[i].rows, -1, pos[i])
    }
    const [chainLeft, chainRight] = rowOf(rows, 0)
    // Lots d'enfants : centrés sous chaque union de la chaîne, côte à côte
    // sans se chevaucher (les lots sont des sous-arbres disjoints : leur
    // largeur pleine suffit pour les ranger).
    const kidPacks = [] // { kid, x0 } : ancre du lot, relative à l'ancre (la personne)
    let prevLotRight = -Infinity
    for (let i = 0; i < chain.length; i += 1) {
      if (!isUnionNode(chain[i])) continue
      const kids = (childrenOf.get(chain[i]) || []).slice().sort(kidOrder)
      if (!kids.length) continue
      const exts = kids.map((k) => buildPersonUnit(k))
      const packsW = exts.reduce((s, p) => s + p.right - p.left, 0) + Math.max(0, kids.length - 1) * FAMILY_GAP
      let x = Math.max(pos[i] - packsW / 2, prevLotRight + FAMILY_GAP)
      for (let j = 0; j < kids.length; j += 1) {
        const p = exts[j]
        kidPacks.push({ kid: kids[j], x0: x - p.left })
        mergeRows(rows, p.rows, 1, x - p.left)
        x += p.right - p.left + FAMILY_GAP
      }
      prevLotRight = x - FAMILY_GAP
    }
    const { left, right } = rowsExtents(rows)
    const plan = { chain, pos, boxes, kidPacks, anchorIndex, left, right, chainLeft, chainRight, rows }
    visiting.delete(personId)
    planPerson.set(memoKey, plan)
    return plan
  }

  // Plan d'une unité d'union (les parents du pivot) : la chaîne contenant
  // l'union d'ancrage, les boîtes d'ascendance des membres, et les packs des
  // enfants non pivots rangés au-delà de la rangée du pivot, du côté du
  // pivot. Le plan dépend du pivot (les packs évitent la rangée du pivot) :
  // la clé de mémo inclut le pivot.
  const buildUnionUnit = (unionId, pivotKid, packSide) => {
    const memoKey = `${unionId}|${pivotKid ?? ''}`
    if (planUnion.has(memoKey)) return planUnion.get(memoKey)
    if (visiting.has(unionId)) return degeneratePlan(unionId)
    visiting.add(unionId)
    const chain = chainOfNode(unionId)
    const anchorIndex = chain.indexOf(unionId)
    const chainSet = new Set(chain)
    const boxUnionSeen = new Set()
    const boxes = chain.map((id, i) => {
      if (isUnionNode(id)) return null
      const link = parentLinkOf.get(id)
      if (!link || boxUnionSeen.has(link)) return null
      boxUnionSeen.add(link)
      return buildUnionUnit(link, id, intrinsicSide(i, chain.length))
    })
    const pos = layoutChain(chain, anchorIndex, boxes)
    const rows = new Map()
    for (let i = 0; i < chain.length; i += 1) {
      const half = byId.get(chain[i]).width / 2
      rowUnion(rows, 0, pos[i] - half, pos[i] + half)
      if (boxes[i]) mergeRows(rows, boxes[i].rows, -1, pos[i])
    }
    const [chainLeft, chainRight] = rowOf(rows, 0)
    // Les packs latéraux se rangent au rang du pivot : ils partent au-delà
    // de la rangée du pivot (sa chaîne), pas au-delà de tout son plan —
    // les descendants du pivot vivent sur d'autres rangées, réservées par
    // les plans qui les contiennent.
    const pivotPlan = pivotKid != null ? buildPersonUnit(pivotKid) : null
    let leftCursor = pivotPlan ? Math.min(chainLeft, pivotPlan.chainLeft) : chainLeft
    let rightCursor = pivotPlan ? Math.max(chainRight, pivotPlan.chainRight) : chainRight
    const kidPacks = []
    const sideLists = { left: [], right: [] }
    for (let i = 0; i < chain.length; i += 1) {
      if (!isUnionNode(chain[i])) continue
      const side = i === anchorIndex ? packSide : sideOfIndex(i, anchorIndex)
      for (const kid of (childrenOf.get(chain[i]) || []).slice().sort(kidOrder)) {
        // le pivot est ancré par l'appelant ; un enfant déjà membre de la
        // chaîne (deux sœurs mariées dans la même chaîne) est posé par elle
        if (kid === pivotKid || chainSet.has(kid)) continue
        sideLists[side].push(kid)
      }
    }
    for (const kid of sideLists.right) {
      const p = buildPersonUnit(kid)
      kidPacks.push({ kid, x0: rightCursor + FAMILY_GAP - p.left })
      mergeRows(rows, p.rows, 1, rightCursor + FAMILY_GAP - p.left)
      rightCursor += FAMILY_GAP + (p.right - p.left)
    }
    for (const kid of [...sideLists.left].reverse()) {
      const p = buildPersonUnit(kid)
      leftCursor -= FAMILY_GAP + (p.right - p.left)
      kidPacks.push({ kid, x0: leftCursor - p.left })
      mergeRows(rows, p.rows, 1, leftCursor - p.left)
    }
    const { left, right } = rowsExtents(rows)
    const plan = { chain, pos, boxes, kidPacks, anchorIndex, left, right, chainLeft, chainRight, rows }
    visiting.delete(unionId)
    planUnion.set(memoKey, plan)
    return plan
  }

  // --- Pose descendante
  const xOf = new Map()
  const placedUnits = new Set()

  const placeUnionUnit = (unionId, x, pivotKid, packSide) => {
    const plan = buildUnionUnit(unionId, pivotKid, packSide)
    if (placedUnits.has(unionId)) return
    placedUnits.add(unionId)
    for (let i = 0; i < plan.chain.length; i += 1) {
      xOf.set(plan.chain[i], x + plan.pos[i])
      const id = plan.chain[i]
      if (!isUnionNode(id)) {
        const link = parentLinkOf.get(id)
        if (link) placeUnionUnit(link, x + plan.pos[i], id, intrinsicSide(i, plan.chain.length))
      }
    }
    for (const { kid, x0 } of plan.kidPacks) placePersonUnit(kid, x + x0)
  }

  const placePersonUnit = (personId, x, own = false) => {
    const plan = buildPersonUnit(personId, own)
    if (placedUnits.has(personId)) return
    placedUnits.add(personId)
    for (let i = 0; i < plan.chain.length; i += 1) {
      xOf.set(plan.chain[i], x + plan.pos[i])
      const id = plan.chain[i]
      // Le parent de l'ancre est posé par l'unité qui a engendré ce pack —
      // ou par le bloc « own » ci-dessous ; celui des conjoints, ici.
      if (!isUnionNode(id) && i !== plan.anchorIndex) {
        const link = parentLinkOf.get(id)
        if (link) placeUnionUnit(link, x + plan.pos[i], id, intrinsicSide(i, plan.chain.length))
      }
    }
    if (own) {
      const link = parentLinkOf.get(personId)
      if (link) placeUnionUnit(link, x, personId, intrinsicSide(plan.anchorIndex, plan.chain.length))
    }
    for (const { kid, x0 } of plan.kidPacks) placePersonUnit(kid, x + x0)
  }

  // Racine : sa chaîne à x = 0, l'unité de ses parents ancrée au-dessus d'elle.
  const rootKey = `p-${rootPersonId}`
  placePersonUnit(rootKey, 0, true)

  // --- Restes : composantes déconnectées, au fil d'un curseur à droite de tout.
  // La tête de composante est posée avec sa boîte de parents (« own ») pour que
  // le curseur tienne compte de ses bornes réelles, et son bord gauche tombe
  // exactement sur le curseur (ancre = curseur - plan.left).
  let maxX = 0
  for (const x of xOf.values()) maxX = Math.max(maxX, x)
  let cursor = maxX + FAMILY_GAP * 2
  const personIds = nodes
    .filter((n) => n._type === 'person')
    .map((n) => n.id)
    .sort((a, b) => {
      const na = byId.get(a)
      const nb = byId.get(b)
      return na._generation - nb._generation || String(a).localeCompare(String(b))
    })
  for (const id of personIds) {
    if (xOf.has(id)) continue
    const plan = buildPersonUnit(id, true)
    if (xOf.has(id)) continue
    placePersonUnit(id, cursor - plan.left, true)
    for (const x of xOf.values()) cursor = Math.max(cursor, x)
    cursor += FAMILY_GAP * 2
  }
  for (const n of nodes) {
    if (!xOf.has(n.id)) {
      xOf.set(n.id, cursor)
      cursor += n.width + NODE_SPACING
    }
  }

  // --- Injection de X, normalisée à 0 (xOf tient des centres de nœuds)
  let minX = Infinity
  for (const n of nodes) minX = Math.min(minX, xOf.get(n.id) - n.width / 2)
  for (const n of nodes) n.x = xOf.get(n.id) - n.width / 2 - minX

  // --- Arêtes longues : couloir (saut d'une génération) ou renvoi
  const centerX = (id) => byId.get(id).x + byId.get(id).width / 2
  const renvoisByUnion = new Map()
  for (const e of result.edges) {
    const u = e.sources[0]
    const c = e.targets[0]
    if (Math.abs(centerX(u) - centerX(c)) <= RENVOI_MIN_DX) continue
    if (byId.get(c)._generation - byId.get(u)._generation === 1) {
      e._corridor = true
      continue
    }
    e._renvoi = true
    e._renvoiIndex = renvoisByUnion.get(u) || 0
    renvoisByUnion.set(u, e._renvoiIndex + 1)
  }

  return result
}
