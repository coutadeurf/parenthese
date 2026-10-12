import { API_BASE_URL, apiRequest } from './client.js'

// Reconnaissance des visages : l'API du backend parle à Immich et ne lui expose ni son
// adresse ni sa clé. Les erreurs distinguent non configuré / injoignable / clé refusée.

function withAuth(options = {}, token) {
  if (!token) return options
  return { ...options, headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` } }
}

export function getImmichErrorMessage(error, t) {
  const code = error?.payload?.error || ''
  if (code === 'immich_not_configured') return t('Immich n’est pas configuré sur le serveur.')
  if (code === 'immich_unreachable') return t('Immich est injoignable.')
  if (code === 'immich_auth_failed') return t('La clé d’accès à Immich a été refusée.')
  if (code === 'immich_person_not_found') return t('Personne introuvable dans Immich.')
  if (code === 'invalid_immich_person_id') return t('Identifiant Immich invalide.')
  if (code === 'invalid_avatar_image') return t('La vignette Immich n’est pas une image valide.')
  if (code === 'storage_quota_exceeded') return t('Espace disque de l’arbre dépassé.')
  if (code === 'forbidden') return t('Seuls les administrateurs de l’arbre peuvent associer un visage Immich.')
  if (error?.status === 0 || error?.message === 'Failed to fetch') return t('Immich est injoignable.')
  return error?.message || t('Erreur inattendue.')
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

export async function assignImmichPerson(treeId, personId, immichPersonId, token) {
  return apiRequest(`/trees/${encodeURIComponent(treeId)}/immich/assign`, withAuth({
    method: 'POST',
    body: JSON.stringify({ personId, immichPersonId }),
  }, token))
}

export async function unassignImmichPerson(treeId, personId, token) {
  return apiRequest(`/trees/${encodeURIComponent(treeId)}/immich/unassign`, withAuth({
    method: 'POST',
    body: JSON.stringify({ personId }),
  }, token))
}
