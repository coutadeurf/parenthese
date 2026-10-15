/**
 * Adaptateur pour transformer les données de l'API backend
 * vers le format attendu par le composant Galaxy
 */

import { t } from '../i18n/index.js'

/**
 * Convertit une date ISO (YYYY-MM-DD) en année
 * @param {string | null} isoDate - Date au format ISO
 * @returns {number | null} - Année ou null
 */
function dateToYear(isoDate) {
  if (!isoDate) return null
  const year = parseInt(isoDate.split('-')[0], 10)
  return isNaN(year) ? null : year
}

/**
 * Détermine si une personne est vivante
 * @param {string | null} deathDate - Date de décès
 * @returns {boolean}
 */
function isAlive(deathDate) {
  return !deathDate
}

/**
 * Adapte les données du graphe API vers le format Galaxy
 * @param {Object} apiGraph - Graphe depuis l'API { persons, unions, filiations, medias }
 * @param {string} treeId - ID de l'arbre pour construire les URLs
 * @returns {Object} - Format compatible Galaxy { persons, unions, filiations, medias }
 */
export function adaptGraphForGalaxy(apiGraph, _treeId) {
  if (!apiGraph) {
    return {
      persons: [],
      unions: [],
      filiations: [],
      medias: [],
    }
  }

  const { persons = [], unions = [], filiations = [], medias = [] } = apiGraph

  // Adapter les personnes
  const adaptedPersons = persons.map((p) => ({
    id: p.id,
    firstName: p.firstName || '',
    lastName: p.lastName || '',
    birthName: p.birthName || null,
    birthYear: dateToYear(p.birthDate),
    deathYear: dateToYear(p.deathDate),
    isAlive: isAlive(p.deathDate),
    sex: p.sex || null,
    note: p.notes || null,
    birthDate: p.birthDate,
    deathDate: p.deathDate,
    photo: p.avatarUrlPath ? `/api${p.avatarUrlPath}` : null,
    avatarFromImmich: Boolean(p.avatarFromImmich),
    frameType: 'round', // Default
  }))

  // Adapter les unions
  const adaptedUnions = unions.map((u) => ({
    id: u.id,
    partner1Id: u.partner1PersonId,
    partner2Id: u.partner2PersonId,
    unionType: u.unionType || 'union',
    startYear: dateToYear(u.startDate),
    endYear: dateToYear(u.endDate),
    displayOrder: u.displayOrder,
    startDate: u.startDate,
    endDate: u.endDate,
  }))

  // Adapter les filiations
  const adaptedFiliations = filiations.map((f) => ({
    id: f.id,
    childId: f.childPersonId,
    parentId: f.parentPersonId,
    unionId: f.viaUnionId,
    parentageType: f.parentageType || 'biologique',
    displayOrder: f.displayOrder,
  }))

  // Adapter les médias
  const adaptedMedias = medias.map((m) => ({
    id: m.id,
    personId: m.personId,
    type: m.type,
    url: m.type === 'photo' ? `/api${m.urlPath}` : null,
    urlHd: m.type === 'photo' ? `/api${m.urlPath}` : null,
    label: m.caption || t('Média {n}', { n: m.displayOrder }),
    source: m.source || null,
    displayOrder: m.displayOrder,
    isFeatured: m.isFeatured,
  }))

  return {
    persons: adaptedPersons,
    unions: adaptedUnions,
    filiations: adaptedFiliations,
    medias: adaptedMedias,
  }
}
