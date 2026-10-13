// Métriques de qualité d'un layout { children, edges, coupleBarMeta }
// Toutes les positions sont en coordonnées layout (x,y = coin haut-gauche).
import { constants } from './load.mjs'
const { PERSON_W, UNION_W } = constants

function center(n) { return { x: n.x + n.width / 2, y: n.y + n.height / 2 } }

function segIntersect(a1, a2, b1, b2) {
  const d = (a2.x - a1.x) * (b2.y - b1.y) - (a2.y - a1.y) * (b2.x - b1.x)
  if (Math.abs(d) < 1e-9) return false
  const t = ((b1.x - a1.x) * (b2.y - b1.y) - (b1.y - a1.y) * (b2.x - b1.x)) / d
  const u = ((b1.x - a1.x) * (a2.y - a1.y) - (b1.y - a1.y) * (a2.x - a1.x)) / d
  return t > 1e-6 && t < 1 - 1e-6 && u > 1e-6 && u < 1 - 1e-6
}

export function computeMetrics(result, coupleBarMeta, tMs) {
  const nodes = result.children
  const byId = new Map(nodes.map(n => [n.id, n]))
  const byGen = new Map()
  for (const n of nodes) {
    if (!byGen.has(n._generation)) byGen.set(n._generation, [])
    byGen.get(n._generation).push(n)
  }

  // Chevauchements (même génération, intervalles X qui se coupent)
  let overlaps = 0
  for (const list of byGen.values()) {
    const sorted = [...list].sort((a, b) => a.x - b.x)
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        if (sorted[j].x >= sorted[i].x + sorted[i].width - 0.5) break
        overlaps++
      }
    }
  }

  // Arêtes de filiation : segment centre-bas de l'union → centre-haut de l'enfant
  const segs = []
  let longEdges = 0
  let sumDx = 0
  for (const e of result.edges) {
    const s = byId.get(e.sources[0]); const t = byId.get(e.targets[0])
    if (!s || !t) continue
    const a = { x: s.x + s.width / 2, y: s.y + s.height }
    const b = { x: t.x + t.width / 2, y: t.y }
    segs.push({ a, b, id: e.id })
    sumDx += Math.abs(b.x - a.x)
    if ((t._generation - s._generation) > 1) longEdges++
  }
  let crossings = 0
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      // même source = pas un vrai croisement (fratrie)
      if (segs[i].a.x === segs[j].a.x && segs[i].a.y === segs[j].a.y) continue
      if (segIntersect(segs[i].a, segs[i].b, segs[j].a, segs[j].b)) crossings++
    }
  }

  // Couples : partenaires adjacents ? même Y ?
  let couplesSplit = 0, couplesDiffY = 0
  const maxAdj = PERSON_W + UNION_W + 2 * 40 + 1 // largeur perso + union + 2 espacements larges
  for (const c of coupleBarMeta) {
    const p1 = byId.get(c.p1Key); const p2 = byId.get(c.p2Key)
    if (!p1 || !p2) continue
    if (Math.abs(p1.x - p2.x) > maxAdj) couplesSplit++
    if (p1.y !== p2.y) couplesDiffY++
  }

  // Parents centrés au-dessus des enfants + fratries contiguës
  const childrenByUnion = new Map()
  for (const e of result.edges) {
    if (!childrenByUnion.has(e.sources[0])) childrenByUnion.set(e.sources[0], [])
    childrenByUnion.get(e.sources[0]).push(e.targets[0])
  }
  let parentOffsetSum = 0, parentOffsetN = 0, siblingSplits = 0
  for (const [uid, kids] of childrenByUnion) {
    const u = byId.get(uid); if (!u) continue
    const kn = kids.map(k => byId.get(k)).filter(Boolean)
    if (kn.length === 0) continue
    const kc = kn.reduce((s, k) => s + center(k).x, 0) / kn.length
    parentOffsetSum += Math.abs(center(u).x - kc); parentOffsetN++
    if (kn.length >= 2) {
      const minX = Math.min(...kn.map(k => k.x)), maxX = Math.max(...kn.map(k => k.x))
      const kidSet = new Set(kids)
      const gen = kn[0]._generation
      const intruders = (byGen.get(gen) || []).filter(n => n._type === 'person' && !kidSet.has(n.id) && n.x > minX && n.x < maxX)
      // un conjoint d'un des enfants n'est pas un intrus
      const spouses = new Set()
      for (const c of coupleBarMeta) {
        if (kidSet.has(c.p1Key)) spouses.add(c.p2Key)
        if (kidSet.has(c.p2Key)) spouses.add(c.p1Key)
      }
      if (intruders.some(n => !spouses.has(n.id))) siblingSplits++
    }
  }

  const dxs = segs.map(s => Math.abs(s.b.x - s.a.x)).sort((a, b) => a - b)
  const q = (p) => Math.round(dxs.length ? dxs[Math.min(dxs.length - 1, Math.floor(p * dxs.length))] : 0)

  const minX = Math.min(...nodes.map(n => n.x)), maxX = Math.max(...nodes.map(n => n.x + n.width))
  const minY = Math.min(...nodes.map(n => n.y)), maxY = Math.max(...nodes.map(n => n.y + n.height))

  return {
    t_ms: Math.round(tMs * 10) / 10,
    nodes: nodes.length,
    edges: result.edges.length,
    renvois: result.edges.filter(e => e._renvoi).length,
    couloirs: result.edges.filter(e => e._corridor).length,
    overlaps,
    crossings,
    couples_split: couplesSplit,
    couples_diffY: couplesDiffY,
    sibling_splits: siblingSplits,
    parent_offset_avg: Math.round(parentOffsetN ? parentOffsetSum / parentOffsetN : 0),
    edge_dx_avg: Math.round(segs.length ? sumDx / segs.length : 0),
    edge_dx_med: q(0.5),
    edge_dx_p90: q(0.9),
    long_edges: longEdges,
    edges_far: dxs.filter(d => d > 800).length,
    width: Math.round(maxX - minX),
    height: Math.round(maxY - minY),
  }
}
