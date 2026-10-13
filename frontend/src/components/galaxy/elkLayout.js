import { persons as globalPersons, unions as globalUnions, filiations as globalFiliations } from '../../data/mockData'
import {
  PERSON_W, PERSON_H, UNION_W, UNION_H,
  UNKNOWN_W, UNKNOWN_H, COMPACT_W, COMPACT_JOIN_GAP,
  JITTER_RADIUS, FLOAT_AMPLITUDE, FLOAT_SPEED,
  ANGLE_VARIATION, MAX_ORBIT_MEDIAS, ORBIT_RADIUS,
} from './constants'

// ============================================================
// État partagé — peuplé par computeLayout, lu par renderers
// ============================================================
export let coupleBarMeta = []
export let componentOrderPerGen = new Map()

// ============================================================
// Helpers
// ============================================================
function toOrder(value) {
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER
}

function compareByOrderThenId(a, b) {
  const orderDiff = toOrder(a.displayOrder) - toOrder(b.displayOrder)
  if (orderDiff !== 0) return orderDiff
  return String(a.id || '').localeCompare(String(b.id || ''))
}

// Écart entre deux nœuds voisins d'une chaîne de couples. Autour d'une union de conjoint isolé :
// rien côté conjoint, un écart négatif côté partenaire, pour que le petit portrait se colle à lui.
export function chainGap(a, b, spacing) {
  const compactUnion = a?._compact && a._type === 'union' ? a : b?._compact && b._type === 'union' ? b : null
  if (!compactUnion) return spacing
  const other = compactUnion === a ? b : a
  return other?._compact ? 0 : COMPACT_JOIN_GAP
}

function makePairKey(a, b) {
  const left = String(a)
  const right = String(b)
  return left < right ? `${left}|${right}` : `${right}|${left}`
}

// ============================================================
// Normalisation des filiations
// ============================================================
export function normalizeFiliationsForLayout(filiations = [], unions = []) {
  const unionsById = new Map(unions.map((union) => [union.id, union]))
  const bestUnionByPair = new Map()

  unions.forEach((union) => {
    if (!union.partner1Id || !union.partner2Id) return
    const key = makePairKey(union.partner1Id, union.partner2Id)
    const current = bestUnionByPair.get(key)
    if (!current || compareByOrderThenId(union, current) < 0) {
      bestUnionByPair.set(key, union)
    }
  })

  const byChild = new Map()
  filiations.forEach((filiation) => {
    const childId = filiation.childId
    if (!childId) return
    if (!byChild.has(childId)) byChild.set(childId, [])
    byChild.get(childId).push(filiation)
  })

  const normalized = []

  byChild.forEach((childFiliations) => {
    const ordered = [...childFiliations].sort(compareByOrderThenId)
    const unionFiliations = []
    const directByParent = new Map()
    const seenUnionIds = new Set()

    ordered.forEach((filiation) => {
      if (filiation.unionId) {
        if (!seenUnionIds.has(filiation.unionId)) {
          seenUnionIds.add(filiation.unionId)
          unionFiliations.push(filiation)
        }
        return
      }

      if (!filiation.parentId) return
      if (!directByParent.has(filiation.parentId)) {
        directByParent.set(filiation.parentId, filiation)
      }
    })

    const usedDirectParents = new Set()
    const directParents = [...directByParent.keys()].sort((left, right) => (
      compareByOrderThenId(directByParent.get(left), directByParent.get(right))
    ))

    unionFiliations.forEach((filiation) => {
      const union = unionsById.get(filiation.unionId)
      if (!union || !union.partner1Id || !union.partner2Id) return
      usedDirectParents.add(union.partner1Id)
      usedDirectParents.add(union.partner2Id)
    })

    const syntheticUnionFiliations = []
    for (let i = 0; i < directParents.length; i += 1) {
      const parentA = directParents[i]
      if (usedDirectParents.has(parentA)) continue

      for (let j = i + 1; j < directParents.length; j += 1) {
        const parentB = directParents[j]
        if (usedDirectParents.has(parentB)) continue

        const filiationA = directByParent.get(parentA)
        const matchingUnion = bestUnionByPair.get(makePairKey(parentA, parentB))
        if (!matchingUnion || seenUnionIds.has(matchingUnion.id)) continue

        syntheticUnionFiliations.push({
          id: `synthetic-${filiationA.childId}-${matchingUnion.id}`,
          childId: filiationA.childId,
          unionId: matchingUnion.id,
          parentId: null,
          parentageType: 'biologique',
          displayOrder: Math.min(toOrder(filiationA.displayOrder), toOrder(directByParent.get(parentB)?.displayOrder)),
        })

        seenUnionIds.add(matchingUnion.id)
        usedDirectParents.add(parentA)
        usedDirectParents.add(parentB)
        break
      }
    }

    const directFiliations = directParents
      .filter((parentId) => !usedDirectParents.has(parentId))
      .map((parentId) => directByParent.get(parentId))

    normalized.push(...unionFiliations, ...syntheticUnionFiliations, ...directFiliations)
  })

  return normalized.sort((left, right) => {
    const childDiff = String(left.childId).localeCompare(String(right.childId))
    if (childDiff !== 0) return childDiff
    return compareByOrderThenId(left, right)
  })
}

// ============================================================
// Génations ancrées sur une personne racine (layout « rooted »)
//
// gen(racine) = 0 : les ancêtres montent en générations négatives,
// les descendants descendent, les frères et sœurs restent au niveau
// de la racine, comme dans l'arbre graphique de Geneanet.
//
// Propagation par file de travail, en trois règles monotones
// (une génération assignée ne redescend jamais) :
//   - conjoint : aligné sur le plus profond des deux partenaires ;
//   - enfant   : toujours sous ses parents (≥ max des parents + 1) ;
//   - parents  : s'ils ne sont pas encore placés, une génération
//                AU-DESSUS de leur enfant. Les ancêtres de la racine
//                sont ainsi réclamés en premier (distance BFS 1).
// Un graphe mal formé (cycle de filiations) ne boucle pas
// indéfiniment : le nombre de traitements est plafonné.
// ============================================================
function computeRootedGenerations(persons, unions, normalizedFiliations, rootPersonId) {
  const gen = new Map()
  const queue = []
  let processed = 0
  const budget = persons.length * 30 + 256

  const unionsById = new Map(unions.map(u => [u.id, u]))
  const unionPartners = (u) => {
    const partners = []
    if (u.partner1Id) partners.push(u.partner1Id)
    if (u.partner2Id) partners.push(u.partner2Id)
    return partners
  }
  const unionsOf = new Map()
  unions.forEach(u => {
    for (const pid of unionPartners(u)) {
      if (!unionsOf.has(pid)) unionsOf.set(pid, [])
      unionsOf.get(pid).push(u)
    }
  })
  const filiationsByChild = new Map()
  const filiationsAsParent = new Map()
  normalizedFiliations.forEach(f => {
    if (!filiationsByChild.has(f.childId)) filiationsByChild.set(f.childId, [])
    filiationsByChild.get(f.childId).push(f)
    const parentIds = f.unionId
      ? unionPartners(unionsById.get(f.unionId) || {})
      : f.parentId ? [f.parentId] : []
    for (const pid of parentIds) {
      if (!filiationsAsParent.has(pid)) filiationsAsParent.set(pid, [])
      filiationsAsParent.get(pid).push(f)
    }
  })

  const assign = (pid, g) => {
    if (pid == null) return
    const cur = gen.get(pid)
    if (cur !== undefined && cur >= g) return
    gen.set(pid, g)
    queue.push(pid)
  }

  gen.set(rootPersonId, 0)
  queue.push(rootPersonId)
  while (queue.length > 0 && processed < budget) {
    const pid = queue.shift()
    processed += 1
    const g = gen.get(pid)
    for (const u of (unionsOf.get(pid) || [])) {
      assign(u.partner1Id === pid ? u.partner2Id : u.partner1Id, g)
    }
    for (const f of (filiationsAsParent.get(pid) || [])) {
      assign(f.childId, g + 1)
    }
    for (const f of (filiationsByChild.get(pid) || [])) {
      if (f.unionId) {
        for (const partnerId of unionPartners(unionsById.get(f.unionId) || {})) {
          if (!gen.has(partnerId)) assign(partnerId, g - 1)
        }
      } else if (f.parentId && !gen.has(f.parentId)) {
        assign(f.parentId, g - 1)
      }
    }
  }
  return gen
}

// ============================================================
// Layout complet
//
// Algorithme Sugiyama adapté aux couples :
//   Phase 1 : Assignation des générations (Y) par parcours parental
//   Phase 2 : Création des nœuds (personne, union, inconnu)
//   Phase 3 : Chaînes par génération + tri barycentrique
//   Phase 4 : Positionnement X — placement symétrique bidirectionnel
//     Pass A : Ordonnancement top-down par position parentale
//     Pass B : Placement initial bottom-up (centrage sur enfants)
//     Pass C : Convergence itérative (top-down + bottom-up, 4 itérations)
//     Normalisation X ≥ 0
//   Phase 5 : Positionnement Y
//
// Le placement symétrique (balayage LR + RL, moyenne) élimine
// la dérive vers la droite et centre les sous-arbres naturellement.
// ============================================================

const LAYER_SPACING = 60
const BASE_NODE_SPACING = 30
const BASE_FAMILY_GAP = 60
const LARGE_FAMILY_NODE_SPACING = 40
const LARGE_FAMILY_GAP = 80
const LARGE_FAMILY_THRESHOLD = 3
const CLUSTER_SPREAD_FACTOR = 6

export function computeLayout(graphData = null, options = {}) {
  const persons = graphData?.persons || globalPersons
  const unions = graphData?.unions || globalUnions
  const filiations = graphData?.filiations || globalFiliations

  const normalizedFiliations = normalizeFiliationsForLayout(filiations, unions)

  const unionsById = new Map(unions.map(u => [u.id, u]))
  const filiationsByChild = new Map()
  normalizedFiliations.forEach(f => {
    if (!filiationsByChild.has(f.childId)) filiationsByChild.set(f.childId, [])
    filiationsByChild.get(f.childId).push(f)
  })

  // ----------------------------------------------------------
  // PHASE 1 : Assigner les générations (Y)
  // ----------------------------------------------------------
  const genMap = new Map()

  function calcGen(pid, visited = new Set()) {
    if (genMap.has(pid)) return genMap.get(pid)
    if (visited.has(pid)) return 0
    visited.add(pid)
    const parentFils = filiationsByChild.get(pid) || []
    if (parentFils.length === 0) { genMap.set(pid, 0); return 0 }

    let best = Number.MAX_SAFE_INTEGER
    for (const f of parentFils) {
      if (f.unionId) {
        const u = unionsById.get(f.unionId)
        if (!u) continue
        const g = Math.max(
          calcGen(u.partner1Id, new Set(visited)),
          calcGen(u.partner2Id, new Set(visited)),
        ) + 1
        if (g < best) best = g
      } else if (f.parentId) {
        const g = calcGen(f.parentId, new Set(visited)) + 1
        if (g < best) best = g
      }
    }
    const gen = best === Number.MAX_SAFE_INTEGER ? 0 : best
    genMap.set(pid, gen)
    return gen
  }

  persons.forEach(p => calcGen(p.id))

  // Aligner les partenaires sur la même génération
  unions.forEach(u => {
    const maxG = Math.max(genMap.get(u.partner1Id) ?? 0, genMap.get(u.partner2Id) ?? 0)
    genMap.set(u.partner1Id, maxG)
    genMap.set(u.partner2Id, maxG)
  })

  // Mode « rooted » : générations relatives à une personne racine (voir computeRootedGenerations).
  // Les personnes non atteintes depuis la racine (composantes déconnectées) gardent la génération
  // minimale calculée ci-dessus, puis tout est décalé pour partir de 0.
  if (options.rootPersonId != null) {
    const rootedGen = computeRootedGenerations(persons, unions, normalizedFiliations, options.rootPersonId)
    rootedGen.forEach((g, pid) => genMap.set(pid, g))
    let minGen = Infinity
    genMap.forEach(g => { if (g < minGen) minGen = g })
    if (Number.isFinite(minGen) && minGen !== 0) {
      genMap.forEach((g, pid) => genMap.set(pid, g - minGen))
    }
    persons.forEach(p => { if (!genMap.has(p.id)) genMap.set(p.id, 0) })
  } else {
    // Ajuster les racines orphelines : si un ancêtre sans parents connus
    // a des enfants à gen N, il doit être à gen N-1 (pas gen 0).
    const rootIds = new Set(persons.filter(p => !filiationsByChild.has(p.id)).map(p => p.id))
    const maxChildGenByRoot = new Map()
    normalizedFiliations.forEach(f => {
      const childGen = genMap.get(f.childId)
      if (childGen === undefined) return
      const parentIds = []
      if (f.unionId) {
        const u = unionsById.get(f.unionId)
        if (u?.partner1Id) parentIds.push(u.partner1Id)
        if (u?.partner2Id) parentIds.push(u.partner2Id)
      } else if (f.parentId) {
        parentIds.push(f.parentId)
      }
      for (const pid of parentIds) {
        if (!rootIds.has(pid)) continue
        if ((maxChildGenByRoot.get(pid) ?? -1) < childGen) maxChildGenByRoot.set(pid, childGen)
      }
    })

    let anyAdjusted = false
    for (const [pid, maxChildGen] of maxChildGenByRoot) {
      const idealGen = maxChildGen - 1
      if (idealGen > 0) { genMap.set(pid, idealGen); anyAdjusted = true }
    }

    if (anyAdjusted) {
      unions.forEach(u => {
        const maxG = Math.max(genMap.get(u.partner1Id) ?? 0, genMap.get(u.partner2Id) ?? 0)
        genMap.set(u.partner1Id, maxG)
        genMap.set(u.partner2Id, maxG)
      })
      persons.forEach(p => { if (!rootIds.has(p.id)) genMap.delete(p.id) })
      persons.forEach(p => calcGen(p.id))
      unions.forEach(u => {
        const maxG = Math.max(genMap.get(u.partner1Id) ?? 0, genMap.get(u.partner2Id) ?? 0)
        genMap.set(u.partner1Id, maxG)
        genMap.set(u.partner2Id, maxG)
      })
    }
  }

  // ----------------------------------------------------------
  // Conjoints isolés : mariés une seule fois, sans parent ni enfant dans l'arbre.
  // Dessinés en petit à côté du partenaire (voir COMPACT_* dans constants.js).
  // Si les deux partenaires sont isolés, seul le second passe en petit.
  // ----------------------------------------------------------
  const linkedByFiliation = new Set()
  normalizedFiliations.forEach(f => {
    linkedByFiliation.add(f.childId)
    if (f.parentId) linkedByFiliation.add(f.parentId)
    const u = f.unionId ? unionsById.get(f.unionId) : null
    if (u) { linkedByFiliation.add(u.partner1Id); linkedByFiliation.add(u.partner2Id) }
  })
  const unionCount = new Map()
  unions.forEach(u => {
    for (const pid of [u.partner1Id, u.partner2Id]) unionCount.set(pid, (unionCount.get(pid) || 0) + 1)
  })
  const isLoneSpouse = (pid) => !linkedByFiliation.has(pid) && unionCount.get(pid) === 1
  const compactPartnerOf = new Map() // conjoint isolé → partenaire
  const compactUnionIds = new Map() // union de conjoint isolé → partenaire
  unions.forEach(u => {
    if (!u.partner1Id || !u.partner2Id) return
    let lone = null, partner = null
    if (isLoneSpouse(u.partner2Id)) { lone = u.partner2Id; partner = u.partner1Id }
    else if (isLoneSpouse(u.partner1Id) && !isLoneSpouse(u.partner2Id)) { lone = u.partner1Id; partner = u.partner2Id }
    if (!lone) return
    compactPartnerOf.set(lone, partner)
    compactUnionIds.set(`u-${u.id}`, `p-${partner}`)
  })

  // ----------------------------------------------------------
  // PHASE 2 : Créer les nœuds du graphe
  // ----------------------------------------------------------
  const allNodes = []
  const allEdges = []
  const pushedNodeIds = new Set()
  const personByElkId = new Map(persons.map(p => [`p-${p.id}`, p]))
  const unionEntryByElkId = new Map()

  function pushNode(node) {
    if (pushedNodeIds.has(node.id)) return
    pushedNodeIds.add(node.id)
    allNodes.push(node)
  }

  // Unions virtuelles (parent unique → inconnu) : une par parent, ses enfants sans autre parent connu
  // partagent le même « Inconnu » (frères et sœurs d'un GEDCOM où un seul parent est renseigné)
  const virtualUnions = []
  const virtualByParent = new Set()
  normalizedFiliations.forEach(f => {
    if (!f.unionId && f.parentId && !virtualByParent.has(f.parentId)) {
      virtualByParent.add(f.parentId)
      virtualUnions.push({
        elkId: `vu-${f.parentId}`,
        unknownElkId: `unknown-${f.parentId}`,
        parentId: f.parentId,
        filiation: f,
      })
    }
  })

  // Entrées d'union unifiées (réelles + virtuelles)
  const allUnionEntries = [
    ...unions.map(u => ({
      elkId: `u-${u.id}`, p1Key: `p-${u.partner1Id}`, p2Key: `p-${u.partner2Id}`, virtual: false,
    })),
    ...virtualUnions.map(vu => ({
      elkId: vu.elkId, p1Key: `p-${vu.parentId}`, p2Key: vu.unknownElkId, virtual: true,
    })),
  ]
  allUnionEntries.forEach(e => unionEntryByElkId.set(e.elkId, e))

  // Adjacence partenaire (personne ↔ personne via union, même génération)
  const adj = new Map()
  function ensureAdj(key) { if (!adj.has(key)) adj.set(key, []) }
  persons.forEach(p => ensureAdj(`p-${p.id}`))
  virtualUnions.forEach(vu => ensureAdj(vu.unknownElkId))
  allUnionEntries.forEach(ue => {
    ensureAdj(ue.p1Key)
    ensureAdj(ue.p2Key)
    adj.get(ue.p1Key).push({ unionElkId: ue.elkId, otherKey: ue.p2Key })
    adj.get(ue.p2Key).push({ unionElkId: ue.elkId, otherKey: ue.p1Key })
  })

  // Grouper les clés personne/inconnu par génération
  const genNodeKeys = new Map()
  persons.forEach(p => {
    const g = genMap.get(p.id) ?? 0
    if (!genNodeKeys.has(g)) genNodeKeys.set(g, new Set())
    genNodeKeys.get(g).add(`p-${p.id}`)
  })
  virtualUnions.forEach(vu => {
    const g = genMap.get(vu.parentId) ?? 0
    if (!genNodeKeys.has(g)) genNodeKeys.set(g, new Set())
    genNodeKeys.get(g).add(vu.unknownElkId)
  })

  // Enfants par clé parente (pour heuristiques de tri)
  const childrenByParentKey = new Map()
  normalizedFiliations.forEach(f => {
    const childKey = `p-${f.childId}`
    if (f.unionId) {
      const union = unionsById.get(f.unionId)
      if (!union) return
      for (const partnerId of [union.partner1Id, union.partner2Id]) {
        const pKey = `p-${partnerId}`
        if (!childrenByParentKey.has(pKey)) childrenByParentKey.set(pKey, [])
        childrenByParentKey.get(pKey).push(childKey)
      }
    } else if (f.parentId) {
      const pKey = `p-${f.parentId}`
      if (!childrenByParentKey.has(pKey)) childrenByParentKey.set(pKey, [])
      childrenByParentKey.get(pKey).push(childKey)
    }
  })

  // union/vu elkId → [child elkId]
  const childrenBySourceId = new Map()
  normalizedFiliations.forEach(f => {
    const sourceId = f.unionId ? `u-${f.unionId}` : `vu-${f.parentId}`
    const targetId = `p-${f.childId}`
    if (!childrenBySourceId.has(sourceId)) childrenBySourceId.set(sourceId, [])
    childrenBySourceId.get(sourceId).push(targetId)
  })

  // child nodeId → [parent union/vu nodeIds]
  const parentUnionsByChild = new Map()
  for (const [sourceId, children] of childrenBySourceId) {
    for (const childId of children) {
      if (!parentUnionsByChild.has(childId)) parentUnionsByChild.set(childId, [])
      parentUnionsByChild.get(childId).push(sourceId)
    }
  }

  // ----------------------------------------------------------
  // PHASE 3 : Chaînes par génération + linéarisation
  // ----------------------------------------------------------
  const sortedGens = [...genNodeKeys.keys()].sort((a, b) => a - b)
  componentOrderPerGen = new Map()

  function traverseChain(component, gen, chainVisited) {
    // Choisir le point de départ (extrémité de la chaîne)
    const leaves = [...component].filter(key =>
      (adj.get(key) || []).filter(n => component.has(n.otherKey)).length <= 1
    )
    let leaf = leaves[0] || [...component][0]

    // Si plusieurs extrémités, choisir celle dont les enfants sont le plus à gauche
    if (leaves.length > 1) {
      const nodeIdx = new Map(allNodes.map((n, i) => [n.id, i]))
      let bestIdx = Number.MAX_SAFE_INTEGER
      for (const leafKey of leaves) {
        const children = childrenByParentKey.get(leafKey) || []
        const minIdx = children.reduce((m, c) => Math.min(m, nodeIdx.get(c) ?? Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER)
        if (minIdx < bestIdx) { bestIdx = minIdx; leaf = leafKey }
      }
    }

    function traverse(key) {
      if (chainVisited.has(key)) return
      chainVisited.add(key)

      if (key.startsWith('p-')) {
        const person = personByElkId.get(key)
        if (person) {
          const compactPartner = compactPartnerOf.get(person.id)
          pushNode({
            id: key, width: compactPartner ? COMPACT_W : PERSON_W, height: PERSON_H,
            _type: 'person', _data: person, _generation: gen,
            ...(compactPartner ? { _compact: true, _compactPartner: `p-${compactPartner}` } : {}),
          })
        }
      } else if (key.startsWith('unknown-')) {
        pushNode({
          id: key, width: UNKNOWN_W, height: UNKNOWN_H,
          _type: 'unknown', _data: { label: 'Inconnu' }, _generation: gen,
        })
      }

      const neighbors = (adj.get(key) || [])
        .filter(n => component.has(n.otherKey) && !chainVisited.has(n.otherKey))

      for (const { unionElkId, otherKey } of neighbors) {
        pushNode({
          id: unionElkId, width: compactUnionIds.has(unionElkId) ? 0 : UNION_W, height: UNION_H,
          ...(compactUnionIds.has(unionElkId) ? { _compact: true, _compactPartner: compactUnionIds.get(unionElkId) } : {}),
          _type: 'union',
          _data: unionEntryByElkId.get(unionElkId) || { id: unionElkId },
          _generation: gen,
        })
        traverse(otherKey)
      }
    }

    traverse(leaf)
  }

  for (const gen of sortedGens) {
    const keysInGen = genNodeKeys.get(gen)
    const visited = new Set()
    const components = []

    for (const startKey of keysInGen) {
      if (visited.has(startKey)) continue
      const component = new Set()
      const queue = [startKey]
      component.add(startKey)
      while (queue.length > 0) {
        const cur = queue.shift()
        for (const { otherKey } of (adj.get(cur) || [])) {
          if (!component.has(otherKey) && keysInGen.has(otherKey)) {
            component.add(otherKey)
            queue.push(otherKey)
          }
        }
      }
      component.forEach(k => visited.add(k))
      components.push(component)
    }

    // Heuristique barycentrique : trier par position des parents déjà placés
    if (gen > 0) {
      const nodeIdx = new Map(allNodes.map((n, i) => [n.id, i]))
      const getAvgParentPos = (comp) => {
        let sum = 0, count = 0
        for (const key of comp) {
          for (const unionId of (parentUnionsByChild.get(key) || [])) {
            const idx = nodeIdx.get(unionId)
            if (idx !== undefined) { sum += idx; count++ }
          }
        }
        return count > 0 ? sum / count : Number.MAX_SAFE_INTEGER
      }
      sortWithSiblingGrouping(components, getAvgParentPos)
    }

    if (!componentOrderPerGen.has(gen)) componentOrderPerGen.set(gen, [])
    for (const component of components) {
      const countBefore = allNodes.length
      traverseChain(component, gen, new Set())
      const addedIds = allNodes.slice(countBefore).map(n => n.id)
      componentOrderPerGen.get(gen).push(addedIds)
    }
  }

  // Construire coupleBarMeta et edges
  const validNodeIds = new Set(allNodes.map(n => n.id))
  coupleBarMeta = allUnionEntries
    .filter(e => validNodeIds.has(e.elkId) && validNodeIds.has(e.p1Key) && validNodeIds.has(e.p2Key))
    .map(e => ({ ...e }))

  normalizedFiliations.forEach(f => {
    const sourceId = f.unionId ? `u-${f.unionId}` : `vu-${f.parentId}`
    const targetId = `p-${f.childId}`
    if (!validNodeIds.has(sourceId) || !validNodeIds.has(targetId)) return
    allEdges.push({
      id: `e-${f.id}`, sources: [sourceId], targets: [targetId],
      _parentageType: f.parentageType,
    })
  })

  // ----------------------------------------------------------
  // PHASE 4 : Positionnement X (3 passes)
  // ----------------------------------------------------------
  const nodeById = new Map(allNodes.map(n => [n.id, n]))

  function isLargeFamilyUnion(unionId) {
    return (childrenBySourceId.get(unionId) || []).length >= LARGE_FAMILY_THRESHOLD
  }

  function hasLargeFamilyContext(compNodeIds) {
    for (const nodeId of compNodeIds) {
      const node = nodeById.get(nodeId)
      if (node?._type === 'union' && isLargeFamilyUnion(nodeId)) return true
      for (const uid of (parentUnionsByChild.get(nodeId) || [])) {
        if (isLargeFamilyUnion(uid)) return true
      }
    }
    return false
  }

  function getSpacing(compNodeIds) {
    const isLarge = hasLargeFamilyContext(compNodeIds)
    const nodeSpacing = isLarge ? LARGE_FAMILY_NODE_SPACING : BASE_NODE_SPACING
    const baseGap = isLarge ? LARGE_FAMILY_GAP : BASE_FAMILY_GAP
    const extraGap = Math.min(Math.max(0, compNodeIds.length - 2), 15) * CLUSTER_SPREAD_FACTOR
    return { nodeSpacing, familyGap: baseGap + extraGap }
  }

  function getComponentWidth(compNodeIds, nodeSpacing) {
    const nodes = compNodeIds.map(id => nodeById.get(id)).filter(Boolean)
    return nodes.reduce((sum, n, i) => sum + n.width + (i ? chainGap(nodes[i - 1], n, nodeSpacing) : 0), 0)
  }

  function placeComponentAt(compNodeIds, left, nodeSpacing) {
    const nodes = compNodeIds.map(id => nodeById.get(id)).filter(Boolean)
    let x = left
    nodes.forEach((node, i) => {
      node.x = x
      x += node.width + chainGap(node, nodes[i + 1], nodeSpacing)
    })
  }

  // Helper : trier avec regroupement des fratries (union-find)
  // Garantit que les composantes partageant une union parente restent contiguës.
  function sortWithSiblingGrouping(components, getKey) {
    if (components.length <= 1) return

    const uf = Array.from({ length: components.length }, (_, i) => i)
    function find(x) {
      while (uf[x] !== x) { uf[x] = uf[uf[x]]; x = uf[x] }
      return x
    }
    function unite(a, b) { uf[find(a)] = find(b) }

    const unionToComp = new Map()
    components.forEach((comp, idx) => {
      for (const nodeId of comp) {
        for (const unionId of (parentUnionsByChild.get(nodeId) || [])) {
          if (unionToComp.has(unionId)) unite(idx, unionToComp.get(unionId))
          else unionToComp.set(unionId, idx)
        }
      }
    })

    const individualKeys = components.map(comp => getKey(comp))
    const groupMinKey = new Map()
    individualKeys.forEach((key, idx) => {
      const root = find(idx)
      const cur = groupMinKey.get(root)
      if (cur === undefined || key < cur) groupMinKey.set(root, key)
    })

    const entries = components.map((comp, idx) => ({
      comp, groupKey: groupMinKey.get(find(idx)), key: individualKeys[idx],
    }))
    entries.sort((a, b) => {
      const gd = a.groupKey - b.groupKey
      return gd !== 0 ? gd : a.key - b.key
    })

    for (let i = 0; i < components.length; i++) components[i] = entries[i].comp
  }

  // --- PASS A (top-down) : ordonner les chaînes par position parente ---
  const sortedGensAsc = [...componentOrderPerGen.keys()].sort((a, b) => a - b)
  for (const gen of sortedGensAsc) {
    const parentGen = gen - 1
    if (parentGen < 0 || !componentOrderPerGen.has(parentGen)) continue

    const nodeToParentFlatIdx = new Map()
    let flatIdx = 0
    componentOrderPerGen.get(parentGen).forEach(compIds => compIds.forEach(id => nodeToParentFlatIdx.set(id, flatIdx++)))

    const avgIdx = (compIds) => {
      let sum = 0, count = 0
      for (const nodeId of compIds) {
        for (const unionId of (parentUnionsByChild.get(nodeId) || [])) {
          const idx = nodeToParentFlatIdx.get(unionId)
          if (idx !== undefined) { sum += idx; count++ }
        }
      }
      return count > 0 ? sum / count : Number.MAX_SAFE_INTEGER
    }
    sortWithSiblingGrouping(componentOrderPerGen.get(gen), avgIdx)
  }

  // ----------------------------------------------------------
  // Helpers : calcul du centre idéal d'une composante
  // ----------------------------------------------------------
  function childrenCenterOf(compIds) {
    let sum = 0, count = 0
    for (const nodeId of compIds) {
      const node = nodeById.get(nodeId)
      if (!node || node._type !== 'union') continue
      for (const childId of (childrenBySourceId.get(nodeId) || [])) {
        const child = nodeById.get(childId)
        if (child?.x !== undefined) { sum += child.x + child.width / 2; count++ }
      }
    }
    return count > 0 ? sum / count : null
  }

  function parentCenterOf(compIds) {
    let sum = 0, count = 0
    for (const nodeId of compIds) {
      for (const unionId of (parentUnionsByChild.get(nodeId) || [])) {
        const pn = nodeById.get(unionId)
        if (pn?.x !== undefined) { sum += pn.x + pn.width / 2; count++ }
      }
    }
    return count > 0 ? sum / count : null
  }

  function currentCenterOf(compIds) {
    const fn = nodeById.get(compIds[0])
    if (fn?.x !== undefined) {
      const { nodeSpacing } = getSpacing(compIds)
      return fn.x + getComponentWidth(compIds, nodeSpacing) / 2
    }
    return 0
  }

  // ----------------------------------------------------------
  // Placement symétrique d'une génération (Sugiyama-style)
  //
  // Cette fonction résout les chevauchements dans les DEUX sens :
  //   1. Balayage gauche→droite (pousse à droite si chevauchement)
  //   2. Balayage droite→gauche (pousse à gauche si chevauchement)
  //   3. Position finale = moyenne des deux
  //
  // Le résultat centre naturellement chaque composante entre
  // ses contraintes gauche et droite.
  // ----------------------------------------------------------
  function placeGenSymmetric(gen, idealCenterFn) {
    const components = componentOrderPerGen.get(gen)
    if (!components || components.length === 0) return

    sortWithSiblingGrouping(components, idealCenterFn)

    const n = components.length
    const meta = components.map(comp => {
      const { nodeSpacing, familyGap } = getSpacing(comp)
      const width = getComponentWidth(comp, nodeSpacing)
      const ic = idealCenterFn(comp)
      const idealLeft = (ic !== null && Number.isFinite(ic)) ? ic - width / 2 : null
      return { comp, nodeSpacing, familyGap, width, idealLeft }
    })

    // Balayage gauche→droite : la première composante va à sa position
    // idéale, les suivantes sont poussées à droite si chevauchement.
    const leftLR = new Array(n)
    let cursor = -Infinity
    for (let i = 0; i < n; i++) {
      if (meta[i].idealLeft !== null) {
        leftLR[i] = Math.max(meta[i].idealLeft, cursor)
      } else {
        leftLR[i] = Number.isFinite(cursor) ? cursor : 0
      }
      cursor = leftLR[i] + meta[i].width + meta[i].familyGap
    }

    // Balayage droite→gauche : borné par l'étendue totale du balayage LR,
    // chaque composante est poussée à gauche si elle dépasse à droite.
    const leftRL = new Array(n)
    let rightBound = leftLR[n - 1] + meta[n - 1].width
    for (let i = n - 1; i >= 0; i--) {
      const maxLeft = rightBound - meta[i].width
      if (meta[i].idealLeft !== null) {
        leftRL[i] = Math.min(meta[i].idealLeft, maxLeft)
      } else {
        leftRL[i] = maxLeft
      }
      if (i > 0) rightBound = leftRL[i] - meta[i - 1].familyGap
    }

    // Position finale = moyenne des deux balayages
    for (let i = 0; i < n; i++) {
      const finalLeft = (leftLR[i] + leftRL[i]) / 2
      placeComponentAt(meta[i].comp, finalLeft, meta[i].nodeSpacing)
    }
  }

  // --- PASS B (bottom-up) : placement initial centré sur les enfants ---
  const sortedGensDesc = [...componentOrderPerGen.keys()].sort((a, b) => b - a)
  if (sortedGensDesc.length === 0) {
    return { children: allNodes, edges: allEdges }
  }
  const genMax = sortedGensDesc[0]
  const genMin = sortedGensDesc[sortedGensDesc.length - 1]

  for (const gen of sortedGensDesc) {
    placeGenSymmetric(gen, (comp) => childrenCenterOf(comp) ?? currentCenterOf(comp))
  }

  // --- PASS C (convergence itérative) ---
  // Alternance top-down (centrage sous parents) / bottom-up (centrage sur enfants).
  // La dernière sous-passe est bottom-up pour que les parents finissent
  // centrés au-dessus de leurs enfants.
  for (let iter = 0; iter < 4; iter++) {
    for (let g = genMin + 1; g <= genMax; g++) {
      placeGenSymmetric(g, (comp) => parentCenterOf(comp) ?? currentCenterOf(comp))
    }
    for (let g = genMax; g >= genMin; g--) {
      placeGenSymmetric(g, (comp) => childrenCenterOf(comp) ?? currentCenterOf(comp))
    }
  }

  // Normaliser : décaler pour que le nœud le plus à gauche soit à x ≥ 0
  let globalMinX = Infinity
  for (const node of allNodes) {
    if (node.x !== undefined && node.x < globalMinX) globalMinX = node.x
  }
  if (Number.isFinite(globalMinX) && globalMinX < 0) {
    for (const node of allNodes) {
      if (node.x !== undefined) node.x -= globalMinX
    }
  }

  // ----------------------------------------------------------
  // PHASE 5 : Positionnement Y
  // ----------------------------------------------------------
  for (const node of allNodes) {
    node.y = node._generation * (PERSON_H + LAYER_SPACING)
  }

  return { children: allNodes, edges: allEdges }
}

// ============================================================
// Données aléatoires par nœud (offset, flottement, angle)
// ============================================================
export function generateNodeRandomData(children, edges = []) {
  const data = new Map()
  // Enfant d'un renvoi : la pastille « Voir les parents » occupe le haut du portrait, l'orbite reste sur les côtés
  const renvoiChildren = new Set(edges.filter(e => e._renvoi).map(e => e.targets[0]))
  const deg = (d) => d * Math.PI / 180
  // Partenaire d'un conjoint isolé : ses souvenirs en orbite passent du côté opposé au petit portrait
  const compactSide = new Map()
  const byId = new Map(children.map(n => [n.id, n]))
  children.forEach(node => {
    const partner = node._compact && node._type === 'person' ? byId.get(node._compactPartner) : null
    if (partner) compactSide.set(partner.id, node.x > partner.x ? 1 : -1)
  })
  const orbitAngle = (nodeId, i) => {
    const side = compactSide.get(nodeId)
    if (renvoiChildren.has(nodeId)) {
      const angles = side ? [180, 152, 208] : [175, 5, 150]
      return deg(side < 0 ? 180 - angles[i] : angles[i])
    }
    if (!side) return (3 * Math.PI / 4) + (Math.PI * 1.5 * (i + 0.5) / MAX_ORBIT_MEDIAS)
    const a = (3 * Math.PI / 4) + (Math.PI * (i + 0.5) / MAX_ORBIT_MEDIAS)
    return side > 0 ? a : Math.PI - a
  }

  children.forEach(node => {
    const angle = Math.random() * Math.PI * 2
    const radius = Math.random() * JITTER_RADIUS
    data.set(node.id, {
      offsetX: Math.cos(angle) * radius,
      offsetY: Math.sin(angle) * radius,
      floatPhaseX: Math.random() * Math.PI * 2,
      floatPhaseY: Math.random() * Math.PI * 2,
      floatAmpX: FLOAT_AMPLITUDE * (0.5 + Math.random() * 0.5),
      floatAmpY: FLOAT_AMPLITUDE * (0.5 + Math.random() * 0.5),
      floatSpeedX: FLOAT_SPEED * (0.7 + Math.random() * 0.6),
      floatSpeedY: FLOAT_SPEED * (0.7 + Math.random() * 0.6),
      anchorAngleOffset: (Math.random() - 0.5) * ANGLE_VARIATION * 2,
      labelRotation: (Math.random() - 0.5) * 0.12,
      frameRotation: (Math.random() - 0.5) * 0.15,
      // Conjoint isolé : pas d'orbite (ses souvenirs restent dans sa fiche)
      orbitSlots: node._compact ? [] : Array.from({ length: MAX_ORBIT_MEDIAS }, (_, i) => ({
        angle: orbitAngle(node.id, i) + (Math.random() - 0.5) * (renvoiChildren.has(node.id) ? 0.2 : 0.5),
        dist: ORBIT_RADIUS + (Math.random() - 0.5) * 12,
        rot: (Math.random() - 0.5) * 0.3,
      })),
    })
  })
  // Le petit portrait suit le décalage de son partenaire, sinon l'écart entre eux varie du simple au triple
  children.forEach(node => {
    if (!node._compact) return
    const rdPartner = data.get(node._compactPartner)
    if (!rdPartner) return
    const rd = data.get(node.id)
    rd.offsetX = rdPartner.offsetX
    rd.offsetY = rdPartner.offsetY
    rd.anchorAngleOffset = 0
  })
  return data
}
