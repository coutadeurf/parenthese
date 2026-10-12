// ============================================================
// Data model: Person / Union / Filiation / Media / Annotation
// Compatible with the current Galaxy frontend.
// ============================================================

import { t } from '../i18n/index.js'
import { buildMediaUrl } from '../utils/mediaToken.js'

// Démo : noms et lieux restent français, les textes descriptifs sont traduits.
export let persons = [
  { id: 1, firstName: 'Jean', lastName: 'Dupont', birthYear: 1890, deathYear: 1965, isAlive: false, photo: '/demo/jean.webp', frameType: 'polaroid', birthPlace: 'Limoges', region: 'Haute-Vienne', profession: t('Menuisier'), nationality: t('Française'), note: t('Patriarche de la famille') },
  { id: 2, firstName: 'Marie', lastName: 'Martin', birthYear: 1895, deathYear: 1970, isAlive: false, photo: '/demo/marie.webp', frameType: 'round', birthPlace: 'Brive-la-Gaillarde', region: 'Corrèze', profession: t('Couturière'), note: t('Atelier de couture rue du Commerce') },
  { id: 3, firstName: 'Robert', lastName: 'Dupont', birthYear: 1920, deathYear: 1995, isAlive: false, photo: '/demo/robert.webp', frameType: 'rect', birthPlace: 'Limoges', region: 'Haute-Vienne', profession: t('Instituteur'), note: t("A enseigné 35 ans à l'école communale") },
  { id: 4, firstName: 'André', lastName: 'Dupont', birthYear: 1923, deathYear: 2000, isAlive: false, photo: '/demo/andre.webp', frameType: 'polaroid', birthPlace: 'Limoges', region: 'Haute-Vienne', profession: t('Charpentier') },
  { id: 5, firstName: 'Simone', lastName: 'Petit', birthYear: 1925, deathYear: 2010, isAlive: false, photo: '/demo/simone.webp', frameType: 'round', birthPlace: 'Guéret', region: 'Creuse', profession: t('Infirmière') },
  { id: 9, firstName: 'Isabelle', lastName: 'Bernard', birthYear: 1928, isAlive: true, photo: '/demo/isabelle.webp', frameType: 'rect', birthPlace: 'Fort-de-France', region: 'Martinique', profession: t('Sage-femme'), note: t('Doyenne de la famille, vit à Brive') },
  { id: 6, firstName: 'Jacques', lastName: 'Dupont', birthYear: 1945, deathYear: 2015, isAlive: false, photo: '/demo/jacques.webp', frameType: 'polaroid', birthPlace: 'Limoges', region: 'Haute-Vienne', profession: t('Journaliste'), note: t('Reporter au Populaire du Centre') },
  { id: 7, firstName: 'Philippe', lastName: 'Dupont', birthYear: 1948, isAlive: true, photo: '/demo/philippe.webp', frameType: 'round', birthPlace: 'Limoges', region: 'Haute-Vienne', profession: t('Pharmacien') },
  { id: 8, firstName: 'Sophie', lastName: 'Dupont', birthYear: 1960, isAlive: true, photo: '/demo/sophie.webp', frameType: 'rect', birthPlace: 'Brive-la-Gaillarde', region: 'Corrèze', profession: t('Architecte'), note: t('Cabinet d’architecture à Bordeaux') },
  { id: 10, firstName: 'Thomas', lastName: 'Dupont', birthYear: 1962, isAlive: true, photo: '/demo/thomas.webp', frameType: 'polaroid', birthPlace: 'Brive-la-Gaillarde', region: 'Corrèze', profession: t('Vétérinaire') },
  { id: 11, firstName: 'Claire', lastName: 'Dupont', birthYear: 1955, isAlive: true, photo: '/demo/claire.webp', birthPlace: 'Paris', region: 'Ile-de-France', profession: t('Enseignante') },
]

export let medias = [
  { id: 'm1', personId: 1, type: 'photo', url: '/demo/souvenir-mariage-1918-thumb.webp', urlHd: '/demo/souvenir-mariage-1918.webp', label: t('Mariage 1918') },
  { id: 'm2', personId: 1, type: 'photo', url: '/demo/souvenir-atelier-thumb.webp', urlHd: '/demo/souvenir-atelier.webp', label: t('Atelier de menuiserie') },
  { id: 'm4', personId: 2, type: 'photo', url: '/demo/souvenir-jeunesse-thumb.webp', urlHd: '/demo/souvenir-jeunesse.webp', label: t('Jeunesse') },
  { id: 'm5', personId: 2, type: 'photo', url: '/demo/souvenir-portrait-famille-thumb.webp', urlHd: '/demo/souvenir-portrait-famille.webp', label: t('Portrait de famille') },
  { id: 'm6', personId: 3, type: 'photo', url: '/demo/souvenir-service-militaire-thumb.webp', urlHd: '/demo/souvenir-service-militaire.webp', label: t('Service militaire') },
  // Actualités Polygoon 1947, CC BY-SA 3.0 NL, voir public/demo/CREDITS.md
  { id: 'm7', personId: 3, type: 'video', url: '/demo/souvenir-mariage-1947.mp4', mimeType: 'video/mp4', label: t('Mariage Simone 1943') },
  { id: 'm8', personId: 3, type: 'photo', url: '/demo/souvenir-annees-70-thumb.webp', urlHd: '/demo/souvenir-annees-70.webp', label: t('Années 70') },
  { id: 'm9', personId: 8, type: 'photo', url: '/demo/souvenir-diplome-thumb.webp', urlHd: '/demo/souvenir-diplome.webp', label: t('Diplôme') },
  { id: 'm10', personId: 8, type: 'photo', url: '/demo/souvenir-plan-cabinet-thumb.webp', urlHd: '/demo/souvenir-plan-cabinet.webp', label: t('Plan du cabinet 1985') },
  { id: 'm12', personId: 6, type: 'photo', url: '/demo/souvenir-redaction-thumb.webp', urlHd: '/demo/souvenir-redaction.webp', label: t('En rédaction') },
]

export let unions = [
  { id: 'u1', partner1Id: 1, partner2Id: 2, unionType: 'mariage', startYear: 1918, endYear: null, displayOrder: 1 },
  { id: 'u2', partner1Id: 3, partner2Id: 5, unionType: 'mariage', startYear: 1943, endYear: 1958, displayOrder: 1 },
  { id: 'u3', partner1Id: 3, partner2Id: 9, unionType: 'mariage', startYear: 1959, endYear: null, displayOrder: 2 },
]

export let filiations = [
  { id: 'f1', childId: 3, unionId: 'u1', parentId: null, parentageType: 'biologique', displayOrder: 1 },
  { id: 'f2', childId: 4, unionId: 'u1', parentId: null, parentageType: 'biologique', displayOrder: 2 },
  { id: 'f3', childId: 6, unionId: 'u2', parentId: null, parentageType: 'biologique', displayOrder: 1 },
  { id: 'f4', childId: 7, unionId: 'u2', parentId: null, parentageType: 'biologique', displayOrder: 2 },
  { id: 'f5', childId: 8, unionId: 'u3', parentId: null, parentageType: 'biologique', displayOrder: 1 },
  { id: 'f6', childId: 10, unionId: 'u3', parentId: null, parentageType: 'biologique', displayOrder: 2 },
  { id: 'f7', childId: 11, unionId: null, parentId: 4, parentageType: 'inconnu', displayOrder: 1 },
]

export let annotations = []

const INITIAL_PERSONS = JSON.parse(JSON.stringify(persons))
const INITIAL_MEDIAS = JSON.parse(JSON.stringify(medias))
const INITIAL_UNIONS = JSON.parse(JSON.stringify(unions))
const INITIAL_FILIATIONS = JSON.parse(JSON.stringify(filiations))

function parseYearFromDate(value) {
  if (!value || typeof value !== 'string') {
    return null
  }

  const year = Number.parseInt(value.slice(0, 4), 10)
  return Number.isFinite(year) ? year : null
}

function pickFrameType(id) {
  const frameTypes = ['round', 'rect', 'polaroid']
  const text = String(id)
  let hash = 0

  for (let i = 0; i < text.length; i += 1) {
    hash += text.charCodeAt(i)
  }

  return frameTypes[hash % frameTypes.length]
}

// Adresse d'un fichier de l'arbre avec le jeton médias (voir utils/mediaToken.js)
function buildProtectedAssetUrl(pathOrUrl, apiBaseUrl, mediaToken, cacheBust = null) {
  let protectedUrl = buildMediaUrl(pathOrUrl, apiBaseUrl, mediaToken)
  if (!protectedUrl) {
    return null
  }

  if (cacheBust !== null && cacheBust !== undefined) {
    const separator = protectedUrl.includes('?') ? '&' : '?'
    protectedUrl = `${protectedUrl}${separator}v=${encodeURIComponent(String(cacheBust))}`
  }

  return protectedUrl
}

function mapRemotePersonToLocal(person, current = null) {
  const birthYear = parseYearFromDate(person?.birthDate)
  const deathYear = parseYearFromDate(person?.deathDate)

  return {
    id: person?.id ?? current?.id,
    firstName: person?.firstName || current?.firstName || t('Inconnu'),
    lastName: person?.lastName || current?.lastName || '',
    birthName: person?.birthName ?? current?.birthName ?? null,
    birthYear,
    birthDate: person?.birthDate || current?.birthDate || null,
    deathDate: person?.deathDate || current?.deathDate || null,
    deathYear,
    isAlive: !deathYear,
    frameType: current?.frameType || pickFrameType(person?.id),
    note: person?.notes || null,
    birthPlace: person?.birthPlace || null,
    region: person?.region || null,
    profession: person?.profession || null,
    nationality: person?.nationality || null,
    photo: current?.photo || null,
    immichPersonId: person?.immichPersonId ?? null,
  }
}

export function resetToDemoData() {
  persons = JSON.parse(JSON.stringify(INITIAL_PERSONS))
  medias = JSON.parse(JSON.stringify(INITIAL_MEDIAS))
  unions = JSON.parse(JSON.stringify(INITIAL_UNIONS))
  filiations = JSON.parse(JSON.stringify(INITIAL_FILIATIONS))
}

export function loadGraphData(graph, options = {}) {
  const mediaToken = options.mediaToken || ''
  const apiBaseUrl = (options.apiBaseUrl || '').replace(/\/$/, '')
  const avatarCacheBust = options.avatarCacheBust ?? null

  const remotePersons = Array.isArray(graph?.persons) ? graph.persons : []
  const remoteUnions = Array.isArray(graph?.unions) ? graph.unions : []
  const remoteFiliations = Array.isArray(graph?.filiations) ? graph.filiations : []
  const remoteMedias = Array.isArray(graph?.medias) ? graph.medias : []
  const remoteAnnotations = Array.isArray(graph?.annotations) ? graph.annotations : []

  persons = remotePersons.map((person) => {
    const localPerson = mapRemotePersonToLocal(person)
    localPerson.photo = buildProtectedAssetUrl(person.avatarUrlPath || null, apiBaseUrl, mediaToken, avatarCacheBust)
    return localPerson
  })

  const personIdSet = new Set(persons.map((person) => person.id))

  unions = remoteUnions
    .map((union, index) => ({
      id: union.id,
      partner1Id: union.partner1PersonId,
      partner2Id: union.partner2PersonId,
      unionType: union.unionType || null,
      startYear: parseYearFromDate(union.startDate),
      endYear: parseYearFromDate(union.endDate),
      displayOrder: Number.isFinite(union.displayOrder) ? union.displayOrder : index + 1,
    }))
    .filter((union) => (
      personIdSet.has(union.partner1Id) &&
      personIdSet.has(union.partner2Id)
    ))

  const unionIdSet = new Set(unions.map((union) => union.id))

  const seenUnionChildKey = new Set()
  const seenDirectKey = new Set()
  filiations = remoteFiliations
    .map((filiation, index) => {
      // Union à un seul parent connu (fréquente dans un GEDCOM) : l'union est écartée plus haut, l'enfant
      // est relié directement à ce parent, sinon il flotterait dans l'arbre sans aucun lien
      const viaKeptUnion = filiation.viaUnionId && unionIdSet.has(filiation.viaUnionId)
      return {
        id: filiation.id,
        childId: filiation.childPersonId,
        unionId: viaKeptUnion ? filiation.viaUnionId : null,
        parentId: viaKeptUnion ? null : filiation.parentPersonId,
        parentageType: filiation.parentageType || 'biologique',
        displayOrder: Number.isFinite(filiation.displayOrder) ? filiation.displayOrder : index + 1,
      }
    })
    .filter((filiation) => {
      if (!personIdSet.has(filiation.childId)) {
        return false
      }

      if (!filiation.unionId) {
        if (!filiation.parentId || !personIdSet.has(filiation.parentId)) return false
        const key = `${filiation.parentId}:${filiation.childId}`
        if (seenDirectKey.has(key)) return false
        seenDirectKey.add(key)
        return true
      }

      if (!unionIdSet.has(filiation.unionId)) {
        return false
      }

      const key = `${filiation.unionId}:${filiation.childId}`
      if (seenUnionChildKey.has(key)) {
        return false
      }

      seenUnionChildKey.add(key)
      return true
    })

  medias = remoteMedias
    .filter((media) => personIdSet.has(media.personId))
    .map((media, index) => {
      const mediaUrl = buildProtectedAssetUrl(media.urlPath || '', apiBaseUrl, mediaToken)

      return {
        id: media.id,
        personId: media.personId,
        type: media.type || 'photo',
        url: mediaUrl,
        urlHd: mediaUrl,
        label: media.caption || t('Média {n}', { n: index + 1 }),
        source: media.source || null,
        displayOrder: Number.isFinite(media.displayOrder) ? media.displayOrder : index + 1,
        isFeatured: Boolean(media.isFeatured),
        mimeType: media.mimeType || null,
      }
    })

  annotations = remoteAnnotations.map((ann) => {
    let content = ann.content || ''
    // Annotation photo : l'adresse est reconstruite ici depuis photoPath, le serveur n'en garde aucune
    if (ann.type === 'photo' && content) {
      try {
        const parsed = typeof content === 'string' ? JSON.parse(content) : content
        if (parsed.photoPath) {
          parsed.url = buildProtectedAssetUrl(parsed.photoPath, apiBaseUrl, mediaToken)
          content = JSON.stringify(parsed)
        }
      } catch { /* ignore */ }
    }
    return {
      id: ann.id,
      type: ann.type || 'text',
      x: ann.x ?? 0,
      y: ann.y ?? 0,
      content,
      style: ann.style || {},
      zIndex: ann.zIndex ?? 0,
      createdBy: ann.createdBy || null,
    }
  })
}

// Index par personne, reconstruits quand le tableau est réassigné (les tableaux ne sont jamais
// mutés en place). Appelés pour chaque nœud à chaque frame par la galaxie : un parcours linéaire
// coûterait nœuds × éléments comparaisons par frame sur un grand arbre.
const EMPTY_MEDIAS = []
let mediasIndexSource = null
let mediasByPerson = new Map()

export function getPersonMedias(personId) {
  if (mediasIndexSource !== medias) {
    mediasIndexSource = medias
    mediasByPerson = new Map()
    for (const media of medias) {
      if (!mediasByPerson.has(media.personId)) mediasByPerson.set(media.personId, [])
      mediasByPerson.get(media.personId).push(media)
    }
    for (const list of mediasByPerson.values()) {
      list.sort((a, b) => {
        const aOrder = Number.isFinite(a.displayOrder) ? a.displayOrder : Number.MAX_SAFE_INTEGER
        const bOrder = Number.isFinite(b.displayOrder) ? b.displayOrder : Number.MAX_SAFE_INTEGER
        return aOrder - bOrder
      })
    }
  }
  return mediasByPerson.get(personId) || EMPTY_MEDIAS
}

let personsIndexSource = null
let personsById = new Map()

export function getPersonById(personId) {
  if (personsIndexSource !== persons) {
    personsIndexSource = persons
    personsById = new Map(persons.map((person) => [String(person.id), person]))
  }
  return personsById.get(String(personId)) || null
}

export function upsertPersonFromGraphPayload(person) {
  if (!person?.id) {
    return null
  }

  const index = persons.findIndex((candidate) => String(candidate.id) === String(person.id))
  const current = index >= 0 ? persons[index] : null
  const localPerson = mapRemotePersonToLocal(person, current)

  if (index >= 0) {
    persons = [
      ...persons.slice(0, index),
      localPerson,
      ...persons.slice(index + 1),
    ]
  } else {
    persons = [...persons, localPerson]
  }

  return localPerson
}

export function getParents(personId) {
  const fil = filiations.filter((filiation) => filiation.childId === personId)
  const result = []
  const seenParentIds = new Set()

  for (const filiation of fil) {
    if (filiation.unionId) {
      const union = unions.find((currentUnion) => currentUnion.id === filiation.unionId)
      if (union) {
        const p1 = persons.find((person) => person.id === union.partner1Id)
        const p2 = persons.find((person) => person.id === union.partner2Id)
        if (p1 && !seenParentIds.has(p1.id)) {
          seenParentIds.add(p1.id)
          result.push(p1)
        }

        if (p2 && !seenParentIds.has(p2.id)) {
          seenParentIds.add(p2.id)
          result.push(p2)
        }
      }
    } else if (filiation.parentId) {
      const parent = persons.find((person) => person.id === filiation.parentId)
      if (parent && !seenParentIds.has(parent.id)) {
        seenParentIds.add(parent.id)
        result.push(parent)
      }
    }
  }

  return result
}

export function getChildren(personId) {
  const childIds = new Set()
  const personUnions = unions.filter((union) => union.partner1Id === personId || union.partner2Id === personId)

  for (const union of personUnions) {
    const childrenInUnion = filiations.filter((filiation) => filiation.unionId === union.id)
    childrenInUnion.forEach((filiation) => childIds.add(filiation.childId))
  }

  const directFiliations = filiations.filter((filiation) => filiation.parentId === personId)
  directFiliations.forEach((filiation) => childIds.add(filiation.childId))

  return [...childIds]
    .map((id) => persons.find((person) => person.id === id))
    .filter(Boolean)
    .sort((a, b) => {
      const aYear = Number.isFinite(a.birthYear) ? a.birthYear : Number.MAX_SAFE_INTEGER
      const bYear = Number.isFinite(b.birthYear) ? b.birthYear : Number.MAX_SAFE_INTEGER
      return aYear - bYear
    })
}

export function getPersonUnions(personId) {
  return unions
    .filter((union) => union.partner1Id === personId || union.partner2Id === personId)
    .sort((a, b) => a.displayOrder - b.displayOrder)
}

export function getUnionChildren(unionId) {
  return filiations
    .filter((filiation) => filiation.unionId === unionId)
    .sort((a, b) => a.displayOrder - b.displayOrder)
    .map((filiation) => persons.find((person) => person.id === filiation.childId))
    .filter(Boolean)
}

export function getChildFiliation(childId) {
  return filiations.find((filiation) => filiation.childId === childId) || null
}

// ---- Annotations helpers ----

let annotationIdCounter = 0

export function addAnnotation(ann) {
  annotationIdCounter += 1
  const id = ann.id || `local-ann-${annotationIdCounter}`
  const newAnn = { ...ann, id }
  annotations = [...annotations, newAnn]
  return newAnn
}

export function updateAnnotation(id, changes) {
  const index = annotations.findIndex((a) => a.id === id)
  if (index < 0) return null
  const updated = { ...annotations[index], ...changes }
  annotations = [...annotations.slice(0, index), updated, ...annotations.slice(index + 1)]
  return updated
}

export function removeAnnotation(id) {
  annotations = annotations.filter((a) => a.id !== id)
}
