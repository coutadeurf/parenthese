import { API_BASE_URL, apiRequest } from './client.js'

// Reconnaissance des visages : la connexion Immich est propre à chaque arbre, configurée par
// ses administrateurs. L'adresse est choisie parmi celles autorisées par l'opérateur du
// serveur ; la clé d'API ne quitte jamais le backend. Les erreurs distinguent non configuré /
// injoignable / clé refusée.

function withAuth(options = {}, token) {
  if (!token) return options
  return { ...options, headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` } }
}

export function getImmichErrorMessage(error, t) {
  const code = error?.payload?.error || ''
  if (code === 'immich_not_configured') return t('Immich n’est pas configuré pour cet arbre.')
  if (code === 'immich_unreachable') return t('Immich est injoignable.')
  if (code === 'immich_auth_failed') return t('La clé d’accès à Immich a été refusée.')
  if (code === 'immich_person_not_found') return t('Personne introuvable dans Immich.')
  if (code === 'invalid_immich_person_id') return t('Identifiant Immich invalide.')
  if (code === 'invalid_avatar_image') return t('La vignette Immich n’est pas une image valide.')
  if (code === 'storage_quota_exceeded') return t('Espace disque de l’arbre dépassé.')
  if (code === 'api_key_required') return t('Indiquez la clé d’accès à Immich pour la première configuration.')
  if (code === 'api_url_not_allowed') return t('Cette adresse Immich n’est pas autorisée par l’opérateur du serveur.')
  if (code === 'forbidden') return t('Seuls les administrateurs de l’arbre peuvent associer un visage Immich.')
  if (error?.status === 0 || error?.message === 'Failed to fetch') return t('Immich est injoignable.')
  return error?.message || t('Erreur inattendue.')
}

// Connexion Immich de l'arbre : métadonnées sûres (jamais la clé) et adresses autorisées par
// l'opérateur, dont le panneau d'administration fait un menu.
export async function fetchImmichConfig(treeId, token) {
  const data = await apiRequest(`/trees/${encodeURIComponent(treeId)}/immich/config`, withAuth({}, token))
  return {
    config: data?.config || { configured: false, apiUrl: null, updatedAt: null },
    allowedApiUrls: Array.isArray(data?.allowedApiUrls) ? data.allowedApiUrls : [],
  }
}

export async function saveImmichConfig(treeId, { apiUrl, apiKey }, token) {
  const data = await apiRequest(`/trees/${encodeURIComponent(treeId)}/immich/config`, withAuth({
    method: 'PUT',
    body: JSON.stringify({ apiUrl, ...(apiKey ? { apiKey } : {}) }),
  }, token))
  return data?.config || null
}

export async function removeImmichConfig(treeId, token) {
  return apiRequest(`/trees/${encodeURIComponent(treeId)}/immich/config`, withAuth({
    method: 'DELETE',
  }, token))
}

export async function checkImmichStatus(treeId, token) {
  return apiRequest(`/trees/${encodeURIComponent(treeId)}/immich/status`, withAuth({}, token))
}

export async function listImmichPeople(treeId, token) {
  const data = await apiRequest(`/trees/${encodeURIComponent(treeId)}/immich/people`, withAuth({}, token))
  return Array.isArray(data?.people) ? data.people : []
}

export async function fetchImmichThumbnail(treeId, immichPersonId, token) {
  const path = `/trees/${encodeURIComponent(treeId)}/immich/thumbnail/${encodeURIComponent(immichPersonId)}`
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!response.ok) {
    throw new Error(`immich_thumbnail_failed_${response.status}`)
  }
  return URL.createObjectURL(await response.blob())
}

export async function assignImmichPerson(treeId, personId, immichPersonId, token, { replaceAvatar = false } = {}) {
  return apiRequest(`/trees/${encodeURIComponent(treeId)}/immich/assign`, withAuth({
    method: 'POST',
    // replaceAvatar : accord explicite pour remplacer un portrait déjà en place — le serveur
    // refuse sinon (409 avatar_exists), quelle que soit l'origine du portrait actuel.
    body: JSON.stringify({ personId, immichPersonId, ...(replaceAvatar ? { replaceAvatar: true } : {}) }),
  }, token))
}

export async function unassignImmichPerson(treeId, personId, token) {
  return apiRequest(`/trees/${encodeURIComponent(treeId)}/immich/unassign`, withAuth({
    method: 'POST',
    body: JSON.stringify({ personId }),
  }, token))
}
