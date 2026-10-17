import { persons as globalPersons, unions as globalUnions, filiations as globalFiliations } from '../../data/mockData'
import { computeLayout, normalizeFiliationsForLayout, coupleBarMeta, componentOrderPerGen, chainGap } from './elkLayout'
import { PERSON_H, RENVOI_MIN_DX } from './constants'

// ============================================================
// Mode Ascendance
//
// Vue centrée sur une personne racine choisie explicitement, dans
// une hiérarchie généalogique classique orientée de bas en haut :
// la racine en bas, ses parents immédiatement au-dessus, les
// grands-parents au-dessus des parents, les frères et sœurs à côté
// de la racine.
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
//      les nœuds, les arêtes et coupleBarMeta — exactement ce que
//      le renderer consomme.
//   3. Les générations (Y) sont recalculées explicitement pour ce
//      mode : la racine est ancrée en bas, chaque parent est
//      exactement une génération au-dessus de son enfant, les
//      conjoints sont alignés, les frères et sœurs sont à la même
//      génération que la personne de la lignée. La génération (Y)
//      est indépendante de la position horizontale (X).
//   4. Les côtés paternel et maternel sont affectés structurellement
//      (assignBranchSides) avant tout placement : la branche paternelle
//      est à gauche, la branche maternelle à droite, et cette séparation
//      est une contrainte du placement, pas une préférence. Une personne
//      atteinte par les deux côtés est marquée partagée (_shared).
//   5. Les chaînes de couples sont reconstruites sur ces générations,
//      orientées (partenaire paternel à gauche de l'union source), puis
//      placées en deux phases contraintes par les côtés :
//      - Phase 1, cascade de la lignée : de la racine vers le haut,
//        les chaînes sont groupées par côté, balayées indépendamment,
//        puis écartées symétriquement d'au moins SIDES_GAP entre les
//        branches paternelle et maternelle.
//      - Phase 2, branches collatérales : fratries et remariages sont
//        ancrés sur la personne de la lignée (fratrie d'un ancêtre,
//        selon son côté) ou sur la racine (fratrie de la racine, selon
//        le displayOrder), ou centrés sous leur union (remariage), en
//        restant dans leur branche.
//   6. Les liens de la lignée directe sont toujours dessinés. Un
//      renvoi n'est utilisé que pour une seconde revendication d'une
//      chaîne parente éloignée (ancêtre commun à deux branches).
//      Les liens secondaires sont marqués _secondary (pointillés au
//      rendu), la racine reçoit _ascendanceRoot, et chaque personne
//      reçoit _side ('paternal' | 'maternal' | null).
// ============================================================

const NODE_SPACING = 30
export const FAMILY_GAP = 60
// Écart structurel entre la branche paternelle et la branche maternelle
export const SIDES_GAP = FAMILY_GAP * 2
// Même écart inter-générations que elkLayout (LAYER_SPACING n'y est pas exporté)
const LAYER_SPACING = 60
// Borne du point fixe des générations (données cycliques)
const MAX_GEN_ITERATIONS = 100

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
// Générations explicites du mode Ascendance (fonction pure, testée à part)
//
// Profondeur interne : racine = 0, chaque parent = profondeur de
// son enfant − 1 (parcours en largeur depuis la racine, donc la
// distance la plus courte), frères et sœurs = même profondeur que
// la personne de la lignée, conjoints = même profondeur que le
// partenaire, enfants = profondeur max de leurs sources + 1 (point
// fixe itéré, borné pour les données cycliques). Le repli vaut 0
// (niveau de la racine) pour les personnes non atteintes.
//
// Retourne une Map personId (String) → profondeur (peut être négative).
// ============================================================
export function assignAscendanceGenerations(view) {
  const persons = Array.isArray(view?.persons) ? view.persons : []
  const unions = Array.isArray(view?.unions) ? view.unions : []
  const filiations = normalizeFiliationsForLayout(view?.filiations, unions)
  const personIdSet = new Set(persons.map((p) => String(p.id)))
  const unionById = new Map(unions.map((u) => [String(u.id), u]))
  const sourceIdOf = (f) => (f.unionId ? `u-${f.unionId}` : `vu-${f.parentId}`)

  const sourcesByChild = new Map()
  const childrenBySource = new Map()
  for (const f of filiations) {
    const childId = String(f.childId)
    if (!personIdSet.has(childId)) continue
    if (!sourcesByChild.has(childId)) sourcesByChild.set(childId, [])
    sourcesByChild.get(childId).push(f)
    const sid = sourceIdOf(f)
    if (!childrenBySource.has(sid)) childrenBySource.set(sid, [])
    childrenBySource.get(sid).push(childId)
  }

  const gen = new Map()
  const rootId = view?.rootPersonId != null ? String(view.rootPersonId) : null
  if (!rootId || !personIdSet.has(rootId)) return gen
  gen.set(rootId, 0)

  // Parcours en largeur vers le haut depuis la racine (+ fratries à chaque source)
  const queue = [rootId]
  while (queue.length > 0) {
    const pid = queue.shift()
    const g = gen.get(pid)
    for (const f of (sourcesByChild.get(pid) || [])) {
      const sid = sourceIdOf(f)
      const parents = []
      if (f.unionId) {
        const union = unionById.get(String(f.unionId))
        if (union) parents.push(union.partner1Id, union.partner2Id)
      } else if (f.parentId != null) {
        parents.push(f.parentId)
      }
      for (const parentId of parents) {
        if (parentId == null) continue
        const key = String(parentId)
        if (!personIdSet.has(key) || gen.has(key)) continue
        gen.set(key, g - 1)
        queue.push(key)
      }
      // Fratrie : les autres enfants de la même source sont à la même génération
      for (const siblingId of (childrenBySource.get(sid) || [])) {
        if (!gen.has(siblingId)) {
          gen.set(siblingId, g)
          queue.push(siblingId)
        }
      }
    }
  }

  // Profondeur d'une source (union réelle ou parent unique) ; null si aucune extrémité connue
  const genOfSource = (sid) => {
    if (sid.startsWith('vu-')) {
      const pid = sid.slice(3)
      return gen.has(pid) ? gen.get(pid) : null
    }
    const union = unionById.get(sid.slice(2))
    if (!union) return null
    const vals = [gen.get(String(union.partner1Id)), gen.get(String(union.partner2Id))]
      .filter((g) => g !== undefined)
    return vals.length ? Math.max(...vals) : null
  }

  // Point fixe : conjoints alignés sur le partenaire, enfants = max(sources) + 1
  for (let iter = 0; iter < MAX_GEN_ITERATIONS; iter++) {
    let changed = false
    for (const u of unions) {
      const p1 = String(u.partner1Id)
      const p2 = String(u.partner2Id)
      const g1 = gen.get(p1)
      const g2 = gen.get(p2)
      if (g1 !== undefined && g2 === undefined && personIdSet.has(p2)) { gen.set(p2, g1); changed = true }
      else if (g2 !== undefined && g1 === undefined && personIdSet.has(p1)) { gen.set(p1, g2); changed = true }
      else if (g1 !== undefined && g2 !== undefined && g1 !== g2) {
        // Mariage entre branches de profondeurs différentes : aligner sur le plus proche de la racine
        const aligned = Math.max(g1, g2)
        gen.set(p1, aligned)
        gen.set(p2, aligned)
        changed = true
      }
    }
    for (const f of filiations) {
      const childId = String(f.childId)
      if (!personIdSet.has(childId)) continue
      const gs = genOfSource(sourceIdOf(f))
      if (gs === null) continue
      const want = gs + 1
      const cur = gen.get(childId)
      if (cur === undefined || cur < want) { gen.set(childId, want); changed = true }
    }
    if (!changed) break
  }

  // Repli : personnes non atteintes (données incohérentes) au niveau de la racine
  for (const pid of personIdSet) {
    if (!gen.has(pid)) gen.set(pid, 0)
  }
  return gen
}

// ============================================================
// Sexe → côté de branche (male → paternel, female → maternel)
// ============================================================
const sexToSide = (sex) => {
  if (sex === null || sex === undefined) return null
  const s = String(sex).toLowerCase()
  if (s === 'male' || s === 'm') return 'paternal'
  if (s === 'female' || s === 'f') return 'maternal'
  return null
}

// ============================================================
// Affectation des côtés paternel / maternel (fonction pure, testée à part)
//
// La séparation des deux branches est une contrainte structurelle du
// placement, pas une préférence de positionnement : chaque personne de la
// vue reçoit un côté ('paternal' | 'maternal' | null) à la construction,
// avant tout calcul de coordonnées.
//
// Règles :
//   - La racine est neutre (null) : elle ancre le graphe en bas.
//   - Les parents de la racine sont répartis par sexe (male → paternel,
//     female → maternel) ; à défaut, le partenaire 1 est paternel et le
//     partenaire 2 maternel (convention d'export GEDCOM : HUSB en premier).
//     Pour une filiation directe (parent unique), le côté vient du sexe ;
//     un parent de sexe inconnu prend un côté libre (paternel d'abord).
//   - Ascendance : les parents d'une personne de la lignée prennent le
//     côté de cette personne, de génération en génération.
//   - Collatérales : la fratrie d'une personne de la lignée, son foyer
//     (conjoint et enfants de ses unions) et les remariages d'un ancêtre
//     prennent le côté de cette personne. La fratrie de la racine et son
//     foyer restent neutres.
//   - Une personne atteinte par les deux côtés garde le premier côté
//     attribué et est marquée partagée (sharedPersonIds).
//
// Retourne { sideByPerson: Map<personId, 'paternal'|'maternal'|null>,
//            sharedPersonIds: Set<personId> }.
// ============================================================
export function assignBranchSides(view) {
  const persons = Array.isArray(view?.persons) ? view.persons : []
  const unions = Array.isArray(view?.unions) ? view.unions : []
  const filiations = normalizeFiliationsForLayout(view?.filiations, unions)
  const personIdSet = new Set(persons.map((p) => String(p.id)))
  const personById = new Map(persons.map((p) => [String(p.id), p]))
  const unionById = new Map(unions.map((u) => [String(u.id), u]))
  const rootId = view?.rootPersonId != null ? String(view.rootPersonId) : null

  const sideByPerson = new Map()
  const sharedPersonIds = new Set()
  if (!rootId || !personIdSet.has(rootId)) {
    return { sideByPerson, sharedPersonIds }
  }
  const otherSide = (s) => (s === 'paternal' ? 'maternal' : 'paternal')
  const sexSide = (personId) => sexToSide(personById.get(personId)?.sex)
  const assign = (personId, side) => {
    const key = String(personId)
    if (!personIdSet.has(key)) return
    const cur = sideByPerson.get(key)
    if (side === null || side === undefined) {
      if (cur === undefined) sideByPerson.set(key, null)
      return
    }
    if (cur === undefined || cur === null) sideByPerson.set(key, side)
    else if (cur !== side) sharedPersonIds.add(key) // premier côté conservé
  }

  const sourcesByChild = new Map()
  const childrenBySource = new Map()
  const unionsByPerson = new Map()
  const sourceIdOf = (f) => (f.unionId ? `u-${f.unionId}` : `vu-${f.parentId}`)
  for (const f of filiations) {
    const childId = String(f.childId)
    if (!personIdSet.has(childId)) continue
    if (!sourcesByChild.has(childId)) sourcesByChild.set(childId, [])
    sourcesByChild.get(childId).push(f)
    const sid = sourceIdOf(f)
    if (!childrenBySource.has(sid)) childrenBySource.set(sid, [])
    childrenBySource.get(sid).push(childId)
  }
  for (const u of unions) {
    for (const pid of [u.partner1Id, u.partner2Id]) {
      if (pid === null || pid === undefined) continue
      const key = String(pid)
      if (!unionsByPerson.has(key)) unionsByPerson.set(key, [])
      unionsByPerson.get(key).push(String(u.id))
    }
  }
  // Extrémités connues d'une source parente (union réelle ou parent unique)
  const sourcePartners = (sid) => {
    if (sid.startsWith('vu-')) {
      const pid = sid.slice(3)
      return personIdSet.has(pid) ? [pid] : []
    }
    const union = unionById.get(sid.slice(2))
    if (!union) return []
    return [union.partner1Id, union.partner2Id]
      .filter((p) => p !== null && p !== undefined && personIdSet.has(String(p)))
      .map(String)
  }

  sideByPerson.set(rootId, null)

  // --- Parents de la racine : répartition paternel / maternel ---
  const rootSources = sourcesByChild.get(rootId) || []
  const directParents = [] // filiations directes (parent unique) de la racine
  for (const f of rootSources) {
    const sid = sourceIdOf(f)
    const partners = sourcePartners(sid)
    if (f.unionId) {
      if (partners.length === 2) {
        const s1 = sexSide(partners[0])
        const s2 = sexSide(partners[1])
        if (s1 && s2 && s1 !== s2) {
          assign(partners[0], s1)
          assign(partners[1], s2)
        } else if (s1 && !s2) {
          assign(partners[0], s1)
          assign(partners[1], otherSide(s1))
        } else if (s2 && !s1) {
          assign(partners[1], s2)
          assign(partners[0], otherSide(s2))
        } else {
          // Sexes inconnus ou identiques : partenaire 1 à gauche (paternel)
          assign(partners[0], 'paternal')
          assign(partners[1], 'maternal')
        }
      } else {
        for (const p of partners) assign(p, sexSide(p))
      }
    } else if (f.parentId != null) {
      directParents.push(String(f.parentId))
    }
  }
  // Filiations directes : côté par sexe ; un sexe inconnu prend un côté libre
  for (const pid of directParents) assign(pid, sexSide(pid))
  if (directParents.length > 0) {
    const used = new Set(directParents.map((p) => sideByPerson.get(p)).filter(Boolean))
    for (const pid of directParents) {
      if (sideByPerson.get(pid) != null) continue
      const free = !used.has('paternal') ? 'paternal' : (!used.has('maternal') ? 'maternal' : null)
      assign(pid, free)
      if (free) used.add(free)
    }
  }

  // --- Propagation à point fixe (bornée : chaque personne ne change de
  //     côté qu'une fois, les cycles de données ne bouclent pas) ---
  const directIds = view?.directPersonIds instanceof Set ? view.directPersonIds : new Set()
  const directUnionIds = new Set()
  for (const pid of directIds) {
    for (const f of (sourcesByChild.get(pid) || [])) {
      if (f.unionId) directUnionIds.add(String(f.unionId))
    }
  }
  const householdOf = (personId, side, apply) => {
    for (const uId of (unionsByPerson.get(personId) || [])) {
      const union = unionById.get(uId)
      if (!union) continue
      const spouseId = String(union.partner1Id) === personId ? union.partner2Id : union.partner1Id
      if (spouseId != null) apply(String(spouseId), side)
      for (const childId of (childrenBySource.get(`u-${uId}`) || [])) apply(childId, side)
    }
  }
  for (let iter = 0; iter <= persons.length; iter++) {
    let changed = false
    const apply = (personId, side) => {
      const key = String(personId)
      const before = sideByPerson.get(key)
      assign(key, side)
      if (sideByPerson.get(key) !== before) changed = true
    }
    for (const pid of directIds) {
      if (pid === rootId) continue
      const side = sideByPerson.get(pid)
      if (side === null || side === undefined) continue
      // Ascendance : les parents prennent le côté de la personne
      for (const f of (sourcesByChild.get(pid) || [])) {
        for (const parentId of sourcePartners(sourceIdOf(f))) apply(parentId, side)
      }
      // Fratrie + foyer : même côté que la personne de la lignée
      for (const f of (sourcesByChild.get(pid) || [])) {
        const sid = sourceIdOf(f)
        for (const sibId of (childrenBySource.get(sid) || [])) {
          if (sibId === pid) continue
          apply(sibId, side)
          householdOf(sibId, side, apply)
        }
      }
      // Remariages de l'ancêtre : conjoint et enfants prennent son côté
      for (const uId of (unionsByPerson.get(pid) || [])) {
        if (directUnionIds.has(uId)) continue
        const union = unionById.get(uId)
        if (!union) continue
        const spouseId = String(union.partner1Id) === pid ? union.partner2Id : union.partner1Id
        if (spouseId != null) apply(String(spouseId), side)
        for (const childId of (childrenBySource.get(`u-${uId}`) || [])) apply(childId, side)
      }
    }
    // Fratrie de la racine et son foyer : neutres
    for (const f of rootSources) {
      const sid = sourceIdOf(f)
      for (const sibId of (childrenBySource.get(sid) || [])) {
        if (sibId === rootId) continue
        apply(sibId, null)
        householdOf(sibId, null, apply)
      }
    }
    if (!changed) break
  }

  return { sideByPerson, sharedPersonIds }
}

// ============================================================
// Chaînes de couples reconstruites sur les générations du mode
//
// Adjacence partenaire via coupleBarMeta (union entre deux nœuds
// existants), composantes connexes groupées par génération, chaque
// composante ordonnée en chaîne depuis une extrémité.
// ============================================================
function buildChains(nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const adj = new Map()
  const ensure = (key) => {
    if (!adj.has(key)) adj.set(key, [])
    return adj.get(key)
  }
  for (const n of nodes) ensure(n.id)
  for (const entry of coupleBarMeta) {
    if (!byId.has(entry.elkId) || !byId.has(entry.p1Key) || !byId.has(entry.p2Key)) continue
    ensure(entry.p1Key).push({ unionElkId: entry.elkId, otherKey: entry.p2Key })
    ensure(entry.p2Key).push({ unionElkId: entry.elkId, otherKey: entry.p1Key })
  }

  const byGen = new Map()
  for (const n of nodes) {
    if (!byGen.has(n._generation)) byGen.set(n._generation, [])
    byGen.get(n._generation).push(n.id)
  }

  const chains = []
  const chainOf = new Map()
  for (const gen of [...byGen.keys()].sort((a, b) => a - b)) {
    const idSet = new Set(byGen.get(gen))
    const visited = new Set()
    for (const start of byGen.get(gen)) {
      if (visited.has(start)) continue
      const component = []
      const queue = [start]
      visited.add(start)
      while (queue.length > 0) {
        const cur = queue.shift()
        component.push(cur)
        for (const { unionElkId, otherKey } of (adj.get(cur) || [])) {
          if (idSet.has(otherKey) && !visited.has(otherKey)) {
            visited.add(otherKey)
            queue.push(otherKey)
          }
          // Les nœuds union sont embarqués dans la chaîne par walk : les marquer
          // visités ici évite qu’ils ne démarrent une composante singleton
          if (idSet.has(unionElkId)) visited.add(unionElkId)
        }
      }
      // Ordonner la composante en chaîne depuis une extrémité (degré ≤ 1)
      const compSet = new Set(component)
      const degree = (key) => (adj.get(key) || []).filter(({ otherKey }) => compSet.has(otherKey)).length
      const leaves = component.filter((key) => degree(key) <= 1)
      const chainStart = leaves.length > 0 ? leaves[0] : component[0]
      const chain = []
      const seen = new Set()
      const walk = (key) => {
        if (seen.has(key)) return
        seen.add(key)
        chain.push(key)
        for (const { unionElkId, otherKey } of (adj.get(key) || [])) {
          if (!compSet.has(otherKey) || seen.has(otherKey)) continue
          if (!seen.has(unionElkId)) {
            seen.add(unionElkId)
            chain.push(unionElkId)
          }
          walk(otherKey)
        }
      }
      walk(chainStart)
      chains.push(chain)
      for (const id of chain) chainOf.set(id, chain)
    }
  }
  return { chains, chainOf }
}

// Imbrique des blocs de gauche à droite (même principe que blockLayout)
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
  // Nœuds, arêtes, coupleBarMeta : produits par le moteur existant,
  // garantissant la compatibilité renderer.
  const result = computeLayout({ persons: view.persons, unions: view.unions, filiations: view.filiations })
  const nodes = result.children
  const edges = result.edges
  const byId = new Map(nodes.map((n) => [n.id, n]))

  // --- Marquage des liens secondaires et de la racine (indépendant du placement) ---
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

  // --- Côtés paternel / maternel : contrainte structurelle du placement ---
  // Affectés avant tout calcul de coordonnées ; la branche paternelle ira à
  // gauche, la maternelle à droite. Marquage additif (le renderer est inchangé).
  const { sideByPerson, sharedPersonIds } = assignBranchSides(view)
  for (const n of nodes) {
    if (n._type !== 'person') continue
    n._side = sideByPerson.get(String(n._data.id)) ?? null
    if (sharedPersonIds.has(String(n._data.id))) n._shared = true
  }

  // --- Générations explicites : racine ancrée en bas, ancêtres au-dessus ---
  // Profondeurs internes (racine = 0, parents négatifs), normalisées pour que
  // l'ancêtre le plus haut soit à 0 et la racine à la génération la plus basse.
  const personGen = assignAscendanceGenerations(view)
  let minGen = Infinity
  for (const g of personGen.values()) minGen = Math.min(minGen, g)
  if (!Number.isFinite(minGen)) minGen = 0
  const normGen = new Map([...personGen].map(([id, g]) => [id, g - minGen]))

  const unionById = new Map(view.unions.map((u) => [String(u.id), u]))
  const genOfNode = (node) => {
    if (node._type === 'person') return normGen.get(String(node._data.id)) ?? 0
    if (node._type === 'unknown') return normGen.get(node.id.slice(8)) ?? 0 // unknown-<parentId>
    if (node.id.startsWith('vu-')) return normGen.get(node.id.slice(3)) ?? 0
    const union = unionById.get(node.id.slice(2))
    if (!union) return 0
    const vals = [normGen.get(String(union.partner1Id)), normGen.get(String(union.partner2Id))]
      .filter((g) => g !== undefined)
    return vals.length ? Math.max(...vals) : 0
  }
  for (const n of nodes) {
    n._generation = genOfNode(n)
    n.y = n._generation * (PERSON_H + LAYER_SPACING)
  }

  // --- Chaînes de couples reconstruites sur ces générations ---
  const { chains, chainOf } = buildChains(nodes)
  componentOrderPerGen.clear()

  if (!rootNode || chains.length === 0) {
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

  // --- Axe de la lignée : enfant principal de chaque chaîne parente ---
  // Premier revendiqué (parcours depuis la racine, filiations dans l'ordre d'arrivée).
  const trunkChildOf = new Map()
  for (const pid of view.directPersonOrder) {
    const childNodeId = `p-${pid}`
    for (const src of (parentSourcesByChild.get(childNodeId) || [])) {
      const pc = chainOf.get(src)
      if (pc && !trunkChildOf.has(pc)) {
        trunkChildOf.set(pc, { personNodeId: childNodeId, sourceUnionId: src })
      }
    }
  }

  const spineChains = chains.filter((c) => c.some((id) => directElkIds.has(id)))
  const spineSet = new Set(spineChains)

  // --- Orientation déterministe des chaînes : partenaire paternel à gauche ---
  // L'union source de la lignée oriente la chaîne (partenaire paternel à
  // gauche, maternel à droite ; à défaut sexe masculin à gauche, puis
  // partenaire 1). Les remariages pendent alors vers l'extérieur. Les chaînes
  // collatérales sans union source s'orientent sur leur première union.
  const personById = new Map(view.persons.map((p) => [String(p.id), p]))
  const partnerLeftOf = (unionElkId) => {
    if (unionElkId.startsWith('vu-')) {
      // Parent unique : le parent réel à gauche, sauf branche maternelle (à droite)
      const pid = unionElkId.slice(3)
      return sideByPerson.get(pid) === 'maternal' ? `unknown-${pid}` : `p-${pid}`
    }
    const union = unionById.get(unionElkId.slice(2))
    if (!union) return null
    const p1 = String(union.partner1Id)
    const p2 = String(union.partner2Id)
    const s1 = sideByPerson.get(p1)
    const s2 = sideByPerson.get(p2)
    if (s1 === 'paternal' && s2 === 'maternal') return `p-${p1}`
    if (s2 === 'paternal' && s1 === 'maternal') return `p-${p2}`
    const x1 = sexToSide(personById.get(p1)?.sex)
    const x2 = sexToSide(personById.get(p2)?.sex)
    if (x1 === 'paternal' && x2 !== 'paternal') return `p-${p1}`
    if (x2 === 'paternal' && x1 !== 'paternal') return `p-${p2}`
    return `p-${p1}`
  }
  const orientChain = (chain) => {
    let anchorUnion = null
    const trunk = trunkChildOf.get(chain)
    if (trunk && chain.includes(trunk.sourceUnionId)) anchorUnion = trunk.sourceUnionId
    if (!anchorUnion) {
      anchorUnion = chain.find((id) => id.startsWith('u-') || id.startsWith('vu-')) || null
    }
    if (!anchorUnion) return // chaîne sans union (personne seule) : rien à orienter
    const leftKey = partnerLeftOf(anchorUnion)
    if (!leftKey) return
    const iLeft = chain.indexOf(leftKey)
    const iUnion = chain.indexOf(anchorUnion)
    if (iLeft === -1 || iUnion === -1) return
    if (iLeft > iUnion) chain.reverse()
  }
  for (const chain of chains) orientChain(chain)

  // componentOrderPerGen reflète les chaînes orientées (consommé par le
  // réordonnancement des fratries et les tests)
  {
    const perGen = new Map()
    for (const chain of chains) {
      const g = byId.get(chain[0])._generation
      if (!perGen.has(g)) perGen.set(g, [])
      perGen.get(g).push([...chain])
    }
    for (const g of [...perGen.keys()].sort((a, b) => a - b)) {
      componentOrderPerGen.set(g, perGen.get(g))
    }
  }

  const chainWidth = (chain) => chain.reduce(
    (s, id, i) => s + byId.get(id).width + (i < chain.length - 1 ? chainGap(byId.get(chain[i]), byId.get(chain[i + 1]), NODE_SPACING) : 0),
    0,
  )
  const chainOffsets = (chain) => {
    const offsets = new Map()
    let x = 0
    chain.forEach((id, i) => {
      offsets.set(id, x)
      x += byId.get(id).width + (i < chain.length - 1 ? chainGap(byId.get(chain[i]), byId.get(chain[i + 1]), NODE_SPACING) : 0)
    })
    return offsets
  }

  const pos = new Map()

  // --- Phase 1 : cascade de la lignée, de la racine vers le haut ---
  // Chaque chaîne de couple est centrée sur l'union source au-dessus de son
  // enfant de la lignée directe. Les chaînes sont groupées par côté (côté de
  // l'enfant principal : paternel / neutre / maternel), balayées
  // indépendamment, puis les branches paternelle et maternelle sont écartées
  // symétriquement d'au moins SIDES_GAP : une famille ne change jamais de
  // branche au fil du placement.
  const chainSideOf = (chain) => {
    const trunk = trunkChildOf.get(chain)
    if (!trunk) return null
    return sideByPerson.get(String(byId.get(trunk.personNodeId)._data.id)) ?? null
  }
  const chainBounds = (chain) => {
    let l = Infinity
    let r = -Infinity
    for (const id of chain) {
      l = Math.min(l, pos.get(id))
      r = Math.max(r, pos.get(id) + byId.get(id).width)
    }
    return [l, r]
  }
  const placeChainLR = (orderedChains, preferred) => {
    let cursor = -Infinity
    for (const chain of orderedChains) {
      const left = Math.max(preferred.get(chain), cursor)
      const offsets = chainOffsets(chain)
      for (const id of chain) pos.set(id, left + offsets.get(id))
      cursor = left + chainWidth(chain) + FAMILY_GAP
    }
  }
  const spineOverlapAtGen = (genChains) => {
    const boxes = genChains.map(chainBounds)
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        if (boxes[i][0] < boxes[j][1] + FAMILY_GAP && boxes[j][0] < boxes[i][1] + FAMILY_GAP) return true
      }
    }
    return false
  }
  const spineGens = [...new Set(spineChains.map((c) => byId.get(c[0])._generation))].sort((a, b) => b - a)
  for (const g of spineGens) {
    const genChains = spineChains.filter((c) => byId.get(c[0])._generation === g)
    const preferred = new Map()
    for (const chain of genChains) {
      const trunk = trunkChildOf.get(chain)
      if (!trunk) { preferred.set(chain, 0); continue }
      const childNode = byId.get(trunk.personNodeId)
      const srcNode = byId.get(trunk.sourceUnionId)
      const offsets = chainOffsets(chain)
      preferred.set(
        chain,
        pos.get(trunk.personNodeId) + childNode.width / 2 - (offsets.get(trunk.sourceUnionId) + srcNode.width / 2),
      )
    }
    const groups = { paternal: [], neutral: [], maternal: [] }
    for (const chain of genChains) {
      groups[chainSideOf(chain) ?? 'neutral'].push(chain)
    }
    for (const key of ['paternal', 'neutral', 'maternal']) {
      groups[key].sort((a, b) => (preferred.get(a) - preferred.get(b)) || String(a[0]).localeCompare(String(b[0])))
    }
    // Balayage LR indépendant par groupe
    for (const key of ['paternal', 'neutral', 'maternal']) {
      placeChainLR(groups[key], preferred)
    }
    // Séparation structurelle symétrique entre les branches paternelle et maternelle
    if (groups.paternal.length > 0 && groups.maternal.length > 0) {
      const pRight = Math.max(...groups.paternal.map((c) => chainBounds(c)[1]))
      const mLeft = Math.min(...groups.maternal.map((c) => chainBounds(c)[0]))
      const deficit = pRight + SIDES_GAP - mLeft
      if (deficit > 0) {
        const saved = new Map()
        for (const chain of genChains) for (const id of chain) saved.set(id, pos.get(id))
        let shiftP = -deficit / 2
        let shiftM = deficit / 2
        // Garde-fou : ne pas pousser une branche dans une chaîne neutre
        const pLeft = Math.min(...groups.paternal.map((c) => chainBounds(c)[0]))
        const mRight = Math.max(...groups.maternal.map((c) => chainBounds(c)[1]))
        for (const c of groups.neutral) {
          const [l, r] = chainBounds(c)
          if (r + FAMILY_GAP <= pLeft) shiftP = Math.max(shiftP, r + FAMILY_GAP - pLeft)
          if (l - FAMILY_GAP >= mRight) shiftM = Math.min(shiftM, l - FAMILY_GAP - mRight)
        }
        const shift = (chainsToShift, dx) => {
          for (const c of chainsToShift) for (const id of c) pos.set(id, pos.get(id) + dx)
        }
        shift(groups.paternal, shiftP)
        shift(groups.maternal, shiftM)
        // Repli : si le décalage crée une superposition, balayage LR global
        // ordonné par côté (paternel, neutre, maternel) — toujours sans chevauchement
        if (spineOverlapAtGen(genChains)) {
          for (const [id, x] of saved) pos.set(id, x)
          const rank = { paternal: 0, neutral: 1, maternal: 2 }
          const ordered = [...genChains].sort((a, b) => {
            const d = rank[chainSideOf(a) ?? 'neutral'] - rank[chainSideOf(b) ?? 'neutral']
            if (d !== 0) return d
            return (preferred.get(a) - preferred.get(b)) || String(a[0]).localeCompare(String(b[0]))
          })
          placeChainLR(ordered, preferred)
        }
      }
    }
  }

  // --- Phase 2 : branches collatérales (fratries, remariages, descendants) ---
  // Un bloc = une chaîne de couple + les blocs de ses enfants (récursif, un
  // niveau de descendants par branche collatérale), la chaîne centrée sur la
  // rangée de ses enfants.
  const inBlock = new Set()
  function buildCollateralBlock(chain) {
    const gen = byId.get(chain[0])._generation
    const rowW = chainWidth(chain)
    const offsets = chainOffsets(chain)
    const childBlocks = []
    for (const id of chain) {
      if (byId.get(id)._type !== 'union') continue
      for (const k of (childrenOfUnion.get(id) || [])) {
        const kc = chainOf.get(k)
        if (!kc || kc === chain || spineSet.has(kc) || inBlock.has(kc)) continue
        inBlock.add(kc)
        childBlocks.push(buildCollateralBlock(kc))
      }
    }
    const packed = packBlocks(childBlocks, FAMILY_GAP)
    // Chaîne centrée sur la rangée de ses enfants (comme le placement descendant)
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
    const minL = Math.min(...[...rows.values()].map((v) => v[0]))
    for (const [g, v] of rows) rows.set(g, [v[0] - minL, v[1] - minL])
    rowX -= minL
    const kidXs = packed.xs.map((x) => x - minL)
    const members = new Set(chain)
    for (const b of childBlocks) { for (const m of b.members) members.add(m) }
    const rel = (id) => {
      if (offsets.has(id)) return rowX + offsets.get(id)
      for (let i = 0; i < childBlocks.length; i++) {
        if (childBlocks[i].members.has(id)) return kidXs[i] + childBlocks[i].rel(id)
      }
      return null
    }
    return {
      chain, rows, members, gen, rel,
      get width() { return Math.max(...[...rows.values()].map((v) => v[1])) },
      place(x0) {
        for (const id of chain) pos.set(id, x0 + rowX + offsets.get(id))
        childBlocks.forEach((b, i) => b.place(x0 + kidXs[i]))
      },
    }
  }

  // Sources parentes d'une chaîne dont la chaîne source est dans la lignée
  const linksToSpine = (chain) => {
    const out = []
    const seen = new Set()
    for (const id of chain) {
      if (!id.startsWith('p-')) continue
      for (const src of (parentSourcesByChild.get(id) || [])) {
        const pc = chainOf.get(src)
        if (pc && pc !== chain && spineSet.has(pc) && !seen.has(src)) {
          seen.add(src)
          out.push({ src, srcChain: pc })
        }
      }
    }
    return out
  }

  // Sources parentes des personnes de la lignée directe (unions des filiations directes)
  const directSourceIds = new Set()
  for (const pid of view.directPersonIds) {
    for (const src of (parentSourcesByChild.get(`p-${pid}`) || [])) directSourceIds.add(src)
  }

  // Racines collatérales : rattachées à la lignée par une source parente
  const collateralChains = chains.filter((c) => !spineSet.has(c))
  const collateralRoots = collateralChains.filter((c) => linksToSpine(c).length > 0)
  for (const c of collateralRoots) inBlock.add(c)
  const blocks = collateralRoots.map((c) => buildCollateralBlock(c))

  // Ancrage d'un bloc collatéral :
  //   - fratrie de la racine : ancrée sur la racine, côté selon le
  //     displayOrder (straddle), neutre ;
  //   - fratrie d'un ancêtre : ancrée sur la personne de la lignée, côté de
  //     la branche (paternel → gauche de la personne, maternel → droite) ;
  //   - remariage d'un ancêtre : centré sous l'union source, côté du
  //     partenaire de la lignée dans cette union.
  const anchorOf = (block) => {
    let best = null
    for (const { src, srcChain } of linksToSpine(block.chain)) {
      const trunk = trunkChildOf.get(srcChain)
      if (!trunk) continue
      const isSibling = directSourceIds.has(src)
      if (!best || (isSibling && !best.isSibling)) best = { src, srcChain, trunk, isSibling }
    }
    if (!best) return null
    const { src, srcChain, trunk, isSibling } = best
    if (isSibling) {
      const childNodeId = block.chain.find((id) => (
        id.startsWith('p-') && (parentSourcesByChild.get(id) || []).includes(src)
      ))
      if (!childNodeId) return null
      const myOrder = edgeOrder.get(`${src}>${childNodeId}`)
      const trunkOrder = edgeOrder.get(`${src}>${trunk.personNodeId}`)
      const gap = Math.abs((myOrder ?? 0) - (trunkOrder ?? 0))
      const anchorPerson = byId.get(trunk.personNodeId)
      const anchorX = pos.get(trunk.personNodeId)
      if (trunk.personNodeId === `p-${view.rootPersonId}`) {
        // Fratrie de la racine : neutre, straddle selon le displayOrder
        const left = myOrder < trunkOrder
        return {
          isSibling: true,
          isRootSibling: true,
          side: left ? 'left' : 'right',
          sideKey: null,
          anchorGen: anchorPerson._generation,
          order: gap,
          preferredLeft: left
            ? anchorX - FAMILY_GAP - block.width
            : anchorX + anchorPerson.width + FAMILY_GAP,
        }
      }
      // Fratrie d'un ancêtre : côté de la branche, ancrée sur la personne
      const sideKey = sideByPerson.get(String(anchorPerson._data.id)) ?? null
      const maternal = sideKey === 'maternal'
      return {
        isSibling: true,
        isRootSibling: false,
        side: maternal ? 'right' : 'left',
        sideKey,
        anchorGen: anchorPerson._generation,
        order: gap,
        preferredLeft: maternal
          ? anchorX + anchorPerson.width + FAMILY_GAP
          : anchorX - FAMILY_GAP - block.width,
      }
    }
    // Remariage : centré sous l'union source, côté du partenaire de la lignée
    const srcNode = byId.get(src)
    const union = unionById.get(src.replace(/^u-/, ''))
    let sideKey = null
    if (union) {
      for (const pid of [union.partner1Id, union.partner2Id]) {
        if (pid != null && view.directPersonIds.has(String(pid))) {
          sideKey = sideByPerson.get(String(pid)) ?? null
          break
        }
      }
    }
    return {
      isSibling: false,
      isRootSibling: false,
      side: null,
      sideKey,
      anchorGen: byId.get(srcChain[0])._generation,
      order: 0,
      preferredLeft: pos.get(src) + srcNode.width / 2 - block.width / 2,
    }
  }

  // Ordre de traitement : de la racine vers le haut, fratries avant
  // remariages, branche paternelle avant branche maternelle, puis fratrie
  // la plus proche du trunk d'abord (les autres s'empilent vers l'extérieur).
  const decorated = blocks.map((block) => ({ block, anchor: anchorOf(block) }))
  decorated.sort((a, b) => {
    const ga = a.anchor ? a.anchor.anchorGen : -1
    const gb = b.anchor ? b.anchor.anchorGen : -1
    if (ga !== gb) return gb - ga
    const sa = a.anchor ? (a.anchor.isSibling ? 0 : 1) : 2
    const sb = b.anchor ? (b.anchor.isSibling ? 0 : 1) : 2
    if (sa !== sb) return sa - sb
    const rank = { paternal: 0, maternal: 2 }
    const ra = a.anchor ? (rank[a.anchor.sideKey] ?? 1) : 1
    const rb = b.anchor ? (rank[b.anchor.sideKey] ?? 1) : 1
    if (ra !== rb) return ra - rb
    if (a.anchor?.isSibling && b.anchor?.isSibling) {
      const d = a.anchor.order - b.anchor.order
      if (d !== 0) return d
    }
    return String(a.block.chain[0]).localeCompare(String(b.block.chain[0]))
  })

  // Occupation horizontale courante, par génération (marge FAMILY_GAP au test),
  // et bornes de côté incrémentales : max à droite des personnes paternelles
  // placées, min à gauche des personnes maternelles placées.
  const occ = new Map()
  const paternalRightByGen = new Map()
  const maternalLeftByGen = new Map()
  const addToOcc = (ids) => {
    for (const id of ids) {
      const n = byId.get(id)
      const x = pos.get(id)
      if (!occ.has(n._generation)) occ.set(n._generation, [])
      occ.get(n._generation).push([x, x + n.width])
      if (n._type !== 'person' || !n._side) continue
      if (n._side === 'paternal') {
        paternalRightByGen.set(n._generation, Math.max(paternalRightByGen.get(n._generation) ?? -Infinity, x + n.width))
      } else {
        maternalLeftByGen.set(n._generation, Math.min(maternalLeftByGen.get(n._generation) ?? Infinity, x))
      }
    }
  }
  addToOcc(nodes.filter((n) => pos.has(n.id)).map((n) => n.id))
  const fitsBlock = (block, x0) => {
    for (const id of block.members) {
      const n = byId.get(id)
      const rel = block.rel(id)
      if (rel === null || rel === undefined) continue
      const x = x0 + rel
      for (const [s, e] of (occ.get(n._generation) || [])) {
        if (x < e + FAMILY_GAP && x + n.width > s - FAMILY_GAP) return false
      }
    }
    return true
  }
  const placeBlock = (block, x0) => {
    block.place(x0)
    addToOcc([...block.members])
  }

  // Contrainte de branche : un bloc paternel reste à gauche de la borne
  // maternelle (et un bloc maternel à droite de la borne paternelle), à
  // chaque génération de ses rangées. Retourne les bornes [minX0, maxX0] de
  // la position d'ancrage du bloc.
  const sideConstraint = (block, sideKey) => {
    if (sideKey !== 'paternal' && sideKey !== 'maternal') return { minX0: -Infinity, maxX0: Infinity }
    let minX0 = -Infinity
    let maxX0 = Infinity
    for (const [g, [l, r]] of block.rows) {
      if (sideKey === 'paternal') {
        const bound = maternalLeftByGen.get(g)
        if (bound !== undefined) maxX0 = Math.min(maxX0, bound - FAMILY_GAP - r)
      } else {
        const bound = paternalRightByGen.get(g)
        if (bound !== undefined) minX0 = Math.max(minX0, bound + FAMILY_GAP - l)
      }
    }
    return { minX0, maxX0 }
  }

  // Position la plus proche de la préférence où le bloc tient sans chevauchement :
  // candidats = préférence + bords des intervalles occupés (le bloc y colle à gauche
  // ou à droite d'un voisin), testés par proximité croissante et filtrés par la
  // contrainte de branche. À l'optimal, chaque rangée du bloc est serrée contre un
  // voisin : un candidat couvre donc la solution.
  const findBlockX = (block, preferredLeft, minX0 = -Infinity, maxX0 = Infinity) => {
    const cands = new Set([preferredLeft])
    for (const [g, [l, r]] of block.rows) {
      for (const [s, e] of (occ.get(g) || [])) {
        cands.add(e + FAMILY_GAP - l)
        cands.add(s - FAMILY_GAP - r)
      }
    }
    const sorted = [...cands]
      .filter((x0) => x0 >= minX0 && x0 <= maxX0)
      .sort((a, b) => (
        Math.abs(a - preferredLeft) - Math.abs(b - preferredLeft) || a - b
      ))
    for (const x0 of sorted) {
      if (fitsBlock(block, x0)) return x0
    }
    return null
  }

  let fallbackLeft = 0
  for (const n of nodes) if (pos.has(n.id)) fallbackLeft = Math.max(fallbackLeft, pos.get(n.id) + n.width)
  fallbackLeft += FAMILY_GAP * 2

  for (const { block, anchor } of decorated) {
    const { minX0, maxX0 } = sideConstraint(block, anchor?.sideKey ?? null)
    let preferredLeft = anchor ? anchor.preferredLeft : fallbackLeft
    if (preferredLeft < minX0) preferredLeft = minX0
    if (preferredLeft > maxX0) preferredLeft = maxX0
    const x0 = findBlockX(block, preferredLeft, minX0, maxX0)
    placeBlock(block, x0 ?? preferredLeft) // repli : chevauchement accepté en dernier recours
  }

  // Garde-fou : chaînes non rattachées (données incohérentes) — même recherche de place
  const remaining = chains.filter((c) => !c.every((id) => pos.has(id)))
  for (const chain of remaining) {
    const block = buildCollateralBlock(chain)
    const x0 = findBlockX(block, fallbackLeft)
    placeBlock(block, x0 ?? fallbackLeft)
  }

  // --- Normalisation X : le nœud le plus à gauche passe à 0 ---
  let minX = Infinity
  for (const n of nodes) if (pos.has(n.id)) minX = Math.min(minX, pos.get(n.id))
  if (!Number.isFinite(minX)) minX = 0
  for (const n of nodes) n.x = (pos.get(n.id) ?? 0) - minX

  // --- Renvois : seconde revendication d'une chaîne parente, trop éloignée ---
  // Le lien vers l'enfant principal de la chaîne (l'axe) est toujours dessiné ;
  // les arêtes collatérales le sont aussi. Seule une autre personne de la
  // lignée rattachée à la même chaîne, placée trop loin, part en renvoi.
  const centerX = (id) => byId.get(id).x + byId.get(id).width / 2
  const renvoisByUnion = new Map()
  for (const e of edges) {
    const target = e.targets[0]
    if (!directElkIds.has(target)) continue
    const srcChain = chainOf.get(e.sources[0])
    const trunk = srcChain ? trunkChildOf.get(srcChain) : null
    if (!trunk || trunk.personNodeId === target) continue
    if (Math.abs(centerX(e.sources[0]) - centerX(target)) <= RENVOI_MIN_DX) continue
    e._renvoi = true
    e._renvoiIndex = renvoisByUnion.get(e.sources[0]) || 0
    renvoisByUnion.set(e.sources[0], e._renvoiIndex + 1)
  }

  return { children: nodes, edges, ascendanceRootId: view.rootPersonId }
}
