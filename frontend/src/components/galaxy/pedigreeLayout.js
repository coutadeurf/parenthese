import { computeLayout, chainGap, coupleBarMeta } from './elkLayout'
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
//      des enfants non pivots (fratrie du pivot), rangés au-delà des
//      boîtes, du côté du pivot. Une unité de personne (racine, pack
//      d'un collatéral) = sa chaîne + les boîtes des conjoints + les
//      packs de ses enfants centrés sous chaque union.
//      Les écarts entre membres d'une chaîne s'élargissent pour que
//      les boîtes d'ascendance voisines ne se chevauchent jamais :
//      le tiling est exact, aucun chevauchement possible.
//   2. Pose descendante depuis la racine (la personne racine à x = 0,
//      ses parents ancrés au-dessus), puis les composantes déconnectées
//      au fil d'un curseur à droite de tout.
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
  const unionEntry = new Map(coupleBarMeta.map((e) => [e.elkId, e]))
  const orderOfUnion = new Map()
  for (const u of graphData?.unions || []) orderOfUnion.set(`u-${u.id}`, { displayOrder: u.displayOrder, id: u.id })

  const otherPartner = (unionId, personId) => {
    const e = unionEntry.get(unionId)
    if (!e) return null
    return e.p1Key === personId ? e.p2Key : e.p1Key
  }
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

  // --- Chaîne de couple contenant une ancre (union ou personne), ancre en tête
  // des identifiants : [... à gauche ...] puis [... à droite ...]
  const chainMemo = new Map()
  const chainOfUnion = (anchorId) => {
    if (chainMemo.has(anchorId)) return chainMemo.get(anchorId)
    const e = unionEntry.get(anchorId)
    const seenU = new Set([anchorId])
    const seenP = new Set()
    const left = []
    const right = []
    const walkPerson = (pid, list, reverse) => {
      if (!pid || seenP.has(pid)) return
      seenP.add(pid)
      const next = []
      for (const u of (unionsOf.get(pid) || [])) {
        if (seenU.has(u)) continue
        seenU.add(u)
        const op = otherPartner(u, pid)
        next.push(u)
        if (op) next.push(op)
      }
      if (reverse) {
        // à gauche : les unions du partenaire s'éloignent de l'ancre
        for (let i = next.length - 1; i >= 0; i -= 1) list.push(next[i])
        list.push(pid)
      } else {
        list.push(pid)
        for (const id of next) list.push(id)
      }
      for (let i = 0; i < next.length; i += 2) {
        walkPerson(next[i + 1], list, reverse)
      }
    }
    if (e?.p2Key) walkPerson(e.p2Key, right, false)
    if (e?.p1Key) walkPerson(e.p1Key, left, true)
    const chain = [...left.slice().reverse(), anchorId, ...right]
    chainMemo.set(anchorId, chain)
    return chain
  }
  const chainOfPerson = (personId) => {
    if (chainMemo.has(personId)) return chainMemo.get(personId)
    const seenU = new Set()
    const seenP = new Set([personId])
    const chain = [personId]
    const walkPerson = (pid) => {
      for (const u of (unionsOf.get(pid) || [])) {
        if (seenU.has(u)) continue
        seenU.add(u)
        const op = otherPartner(u, pid)
        chain.push(u)
        if (op) {
          chain.push(op)
          if (!seenP.has(op)) { seenP.add(op); walkPerson(op) }
        }
      }
    }
    walkPerson(personId)
    chainMemo.set(personId, chain)
    return chain
  }

  // --- Plans des unités (mémoïsés, gardés contre les cycles)
  const planUnion = new Map() // unionId -> plan ancré sur l'union (pivot inclus)
  const planPerson = new Map() // personId -> plan ancré sur la personne
  const visiting = new Set()

  const sideOfIndex = (index, anchorIndex) => (index > anchorIndex || (index === anchorIndex) ? 'right' : 'left')

  // Positionne les membres d'une chaîne autour de son ancre ; les écarts
  // s'élargissent pour que les boîtes d'ascendance centrées sur les membres
  // ne se chevauchent pas (balayage gauche-droite).
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
    let prevBoxRight = -Infinity
    for (let i = 0; i < chain.length; i += 1) {
      const box = boxes[i]
      if (!box) continue
      const needLeft = pos[i] - box.left
      if (needLeft < prevBoxRight + NODE_SPACING) {
        const shift = prevBoxRight + NODE_SPACING - needLeft
        for (let j = i; j < chain.length; j += 1) pos[j] += shift
      }
      if (chain.includes("u-u_parents_pere")) console.log(`sweep ${chain[i]} pos=${Math.round(pos[i])} box=${box ? Math.round(box.left)+"/"+Math.round(box.right) : "null"} prev=${Math.round(prevBoxRight)}`)
      prevBoxRight = Math.max(prevBoxRight, pos[i] + box.right)
    }
    const anchorX = pos[anchorIndex]
    for (let i = 0; i < chain.length; i += 1) pos[i] -= anchorX
    return pos
  }

  const chainExtents = (chain, pos, boxes) => {
    let left = Infinity
    let right = -Infinity
    for (let i = 0; i < chain.length; i += 1) {
      const half = byId.get(chain[i]).width / 2
      left = Math.min(left, pos[i] - half, boxes[i] ? pos[i] - boxes[i].left : Infinity)
      right = Math.max(right, pos[i] + half, boxes[i] ? pos[i] + boxes[i].right : -Infinity)
    }
    return { left, right }
  }

  // Plan d'une unité de personne (la racine ou un pack de collatéral) :
  // sa chaîne, les boîtes des conjoints, les packs des enfants centrés
  // sous chaque union de la chaîne.
  const buildPersonUnit = (personId) => {
    if (planPerson.has(personId)) return planPerson.get(personId)
    if (visiting.has(personId)) return { chain: [personId], pos: [0], boxes: [null], kidPacks: [], left: 0, right: 0 }
    visiting.add(personId)
    const chain = chainOfPerson(personId)
    const boxes = chain.map((id, i) => {
      if (i === 0 || isUnionNode(id)) return null
      const link = parentLinkOf.get(id)
      if (!link) return null
      return buildUnionUnit(link, id, sideOfIndex(i, 0))
    })
    const pos = layoutChain(chain, 0, boxes)
    const { left: chainLeft, right: chainRight } = chainExtents(chain, pos, boxes)
    const kidPacks = [] // { kid, x0 } : cible relative à l'ancre (la personne)
    let minLeft = chainLeft
    let maxRight = chainRight
    for (let i = 0; i < chain.length; i += 1) {
      if (!isUnionNode(chain[i])) continue
      const kids = (childrenOf.get(chain[i]) || []).slice().sort(kidOrder)
      const exts = kids.map((k) => buildPersonUnit(k))
      const total = exts.reduce((s, p) => s + p.left + p.right, 0) + Math.max(0, kids.length - 1) * FAMILY_GAP
      let x = pos[i] - total / 2
      for (let j = 0; j < kids.length; j += 1) {
        const p = exts[j]
        kidPacks.push({ kid: kids[j], x0: x + p.left })
        x += p.left + p.right + FAMILY_GAP
      }
      if (kids.length) {
        minLeft = Math.min(minLeft, pos[i] - total / 2)
        maxRight = Math.max(maxRight, pos[i] + total / 2)
      }
    }
    const plan = { chain, pos, boxes, kidPacks, left: minLeft, right: maxRight }
    visiting.delete(personId)
    planPerson.set(personId, plan)
    return plan
  }

  // Plan d'une unité d'union (les parents du pivot) : la chaîne contenant
  // l'union d'ancrage, les boîtes d'ascendance des membres, et les packs des
  // enfants non pivots rangés au-delà des boîtes, du côté du pivot.
  const buildUnionUnit = (unionId, pivotKid, packSide) => {
    if (planUnion.has(unionId)) return planUnion.get(unionId)
    if (visiting.has(unionId)) {
      return { chain: [unionId], pos: [0], boxes: [null], kidPacks: [], left: 0, right: 0 }
    }
    visiting.add(unionId)
    const chain = chainOfUnion(unionId)
    const anchorIndex = chain.indexOf(unionId)
    const boxes = chain.map((id) => {
      if (isUnionNode(id)) return null
      const link = parentLinkOf.get(id)
      if (!link) return null
      return buildUnionUnit(link, id, sideOfIndex(chain.indexOf(id), anchorIndex))
    })
    const pos = layoutChain(chain, anchorIndex, boxes)
    const { left, right } = chainExtents(chain, pos, boxes)
    // Enfants non pivots des unions de la chaîne, du côté du pivot (ou du
    // côté de leur union dans la chaîne), au-delà des boîtes.
    const kidPacks = []
    let leftCursor = left
    let rightCursor = right
    const sideLists = { left: [], right: [] }
    for (let i = 0; i < chain.length; i += 1) {
      if (!isUnionNode(chain[i])) continue
      const side = i === anchorIndex ? packSide : sideOfIndex(i, anchorIndex)
      for (const kid of (childrenOf.get(chain[i]) || []).slice().sort(kidOrder)) {
        if (kid === pivotKid) continue
        sideLists[side].push(kid)
      }
    }
    for (const kid of sideLists.right) {
      const p = buildPersonUnit(kid)
      rightCursor += FAMILY_GAP + p.left
      kidPacks.push({ kid, x0: rightCursor })
      rightCursor += p.right
    }
    for (const kid of [...sideLists.left].reverse()) {
      const p = buildPersonUnit(kid)
      leftCursor -= FAMILY_GAP + p.left
      kidPacks.push({ kid, x0: leftCursor })
      leftCursor -= p.right
    }
    const plan = { chain, pos, boxes, kidPacks, left: leftCursor, right: rightCursor, membersSide: chain.map((id, i) => sideOfIndex(i, anchorIndex)) }
    visiting.delete(unionId)
    planUnion.set(unionId, plan)
    return plan
  }

  // --- Pose descendante
  const xOf = new Map()
  const placedUnits = new Set()

  const placeUnionUnit = (unionId, x, pivotKid, packSide) => {
    const plan = buildUnionUnit(unionId, pivotKid, packSide)
    if (placedUnits.has(unionId)) return
    placedUnits.add(unionId)
    const anchorIndex = plan.chain.indexOf(unionId)
    for (let i = 0; i < plan.chain.length; i += 1) {
      xOf.set(plan.chain[i], x + plan.pos[i])
      const id = plan.chain[i]
      if (!isUnionNode(id)) {
        const link = parentLinkOf.get(id)
        if (link) placeUnionUnit(link, x + plan.pos[i], id, sideOfIndex(i, anchorIndex))
      }
    }
    for (const { kid, x0 } of plan.kidPacks) placePersonUnit(kid, x + x0)
  }

  const placePersonUnit = (personId, x) => {
    const plan = buildPersonUnit(personId)
    if (placedUnits.has(personId)) return
    placedUnits.add(personId)
    for (let i = 0; i < plan.chain.length; i += 1) {
      xOf.set(plan.chain[i], x + plan.pos[i])
      const id = plan.chain[i]
      // Le parent de l'ancre est posé par l'appelant (l'unité qui a engendré
      // ce pack) — jamais ici ; celui des conjoints, si.
      if (i !== 0 && !isUnionNode(id)) {
        const link = parentLinkOf.get(id)
        if (link) placeUnionUnit(link, x + plan.pos[i], id, sideOfIndex(i, 0))
      }
    }
    for (const { kid, x0 } of plan.kidPacks) placePersonUnit(kid, x + x0)
  }

  // Racine : sa chaîne à x = 0, ses parents ancrés au-dessus d'elle.
  const rootKey = `p-${rootPersonId}`
  placePersonUnit(rootKey, 0)
  const rootParentLink = parentLinkOf.get(rootKey)
  if (rootParentLink) placeUnionUnit(rootParentLink, 0, rootKey, 'right')

  // --- Restes : composantes déconnectées, au fil d'un curseur à droite de tout
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
    const plan = buildPersonUnit(id)
    if (xOf.has(id)) continue
    placePersonUnit(id, cursor + Math.max(0, -plan.left))
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
