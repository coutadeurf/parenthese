import { useCallback, useEffect, useRef, useState } from 'react'
import { ImagePlus, Loader2, Search, Unlink, UserRound, X } from 'lucide-react'
import { createPortal } from 'react-dom'

import {
  assignImmichPerson,
  checkImmichStatus,
  fetchImmichThumbnail,
  getImmichErrorMessage,
  listImmichPeople,
  unassignImmichPerson,
} from '../api/immichApi.js'
import { t } from '../i18n/index.js'
import PzBusy from './PzBusy.jsx'
import './ImmichFacePanel.css'

// Associer une personne de l'arbre à une personne Immich : sa vignette devient le portrait.
// Réservé aux administrateurs de l'arbre (l'API vérifie le rôle côté serveur).
const ImmichFacePanel = ({ person, treeId, token, onClose, onImmichChange }) => {
  const [available, setAvailable] = useState(null) // null : vérification en cours
  const [unavailableReason, setUnavailableReason] = useState('')
  const [people, setPeople] = useState([])
  const [loadingPeople, setLoadingPeople] = useState(false)
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState(null)
  const [thumbnailUrl, setThumbnailUrl] = useState(null)
  const [actionLoading, setActionLoading] = useState(false)
  const [error, setError] = useState('')
  const thumbnailRef = useRef(null)

  const releaseThumbnail = useCallback(() => {
    if (thumbnailRef.current) {
      URL.revokeObjectURL(thumbnailRef.current)
      thumbnailRef.current = null
    }
    setThumbnailUrl(null)
  }, [])

  useEffect(() => {
    let cancelled = false
    releaseThumbnail()

    const load = async () => {
      try {
        const status = await checkImmichStatus(treeId, token)
        if (cancelled) return
        setAvailable(Boolean(status?.available))
        setUnavailableReason(status?.available ? '' : (status?.reason || 'unreachable'))
        if (!status?.available) return

        setLoadingPeople(true)
        const immichPeople = await listImmichPeople(treeId, token)
        if (cancelled) return
        setPeople(immichPeople)
      } catch (err) {
        if (cancelled) return
        setAvailable(false)
        setUnavailableReason('')
        setError(getImmichErrorMessage(err, t))
      } finally {
        if (!cancelled) setLoadingPeople(false)
      }
    }

    load()
    return () => { cancelled = true }
  }, [treeId, token, releaseThumbnail])

  useEffect(() => releaseThumbnail, [releaseThumbnail])

  const loadThumbnail = useCallback(async (immichPersonId) => {
    releaseThumbnail()
    try {
      const url = await fetchImmichThumbnail(treeId, immichPersonId, token)
      thumbnailRef.current = url
      setThumbnailUrl(url)
    } catch {
      setThumbnailUrl(null)
    }
  }, [treeId, token, releaseThumbnail])

  const handleSelect = useCallback((immichPerson) => {
    setSelected(immichPerson)
    setError('')
    if (immichPerson?.hasThumbnail && immichPerson?.id) {
      loadThumbnail(immichPerson.id)
    } else {
      releaseThumbnail()
    }
  }, [loadThumbnail, releaseThumbnail])

  const handleAssign = useCallback(async () => {
    if (!selected || actionLoading) return
    setActionLoading(true)
    setError('')
    try {
      await assignImmichPerson(treeId, person.id, selected.id, token)
      onImmichChange?.(person.id)
      onClose?.()
    } catch (err) {
      setError(getImmichErrorMessage(err, t))
    } finally {
      setActionLoading(false)
    }
  }, [selected, actionLoading, treeId, person, token, onImmichChange, onClose])

  const handleUnassign = useCallback(async () => {
    if (!person.immichPersonId || actionLoading) return
    setActionLoading(true)
    setError('')
    try {
      await unassignImmichPerson(treeId, person.id, token)
      onImmichChange?.(person.id)
      onClose?.()
    } catch (err) {
      setError(getImmichErrorMessage(err, t))
    } finally {
      setActionLoading(false)
    }
  }, [person, actionLoading, treeId, token, onImmichChange, onClose])

  const filteredPeople = search.trim()
    ? people.filter((immichPerson) => immichPerson.name?.toLowerCase().includes(search.trim().toLowerCase()))
    : people

  const handleOverlayClick = (event) => {
    if (event.target === event.currentTarget) {
      onClose()
    }
  }

  return createPortal(
    <div className="pz-overlay immich-modal-overlay" onClick={handleOverlayClick}>
      <div className="pz-modal immich-modal-card" role="dialog" aria-modal="true" aria-labelledby="immichFaceTitle">
        <div className="pz-modal-head">
          <p className="pz-eyebrow">{t('Reconnaissance des visages')}</p>
          <h1 id="immichFaceTitle" className="pz-title">{person.firstName} <em>{person.lastName}</em></h1>
        </div>
        <button type="button" className="pz-btn pz-btn--ghost pz-btn--icon pz-modal-close" onClick={onClose} aria-label={t('Fermer')}>
          <X size={18} aria-hidden="true" />
        </button>

        {available === null || loadingPeople ? (
          <div className="immich-body"><PzBusy /></div>
        ) : available === false ? (
          <div className="immich-body">
            <p className="immich-empty">
              {unavailableReason === 'not_configured'
                ? t('Immich n’est pas configuré sur le serveur.')
                : t('Immich est injoignable.')}
            </p>
          </div>
        ) : (
          <div className="immich-body">
            {person.immichPersonId && (
              <div className="immich-current">
                <p>{t('{name} est déjà associée à une personne Immich.', { name: person.firstName || person.lastName })}</p>
                <button type="button" className="pz-btn pz-btn--danger-ghost" onClick={handleUnassign} disabled={actionLoading}>
                  <Unlink size={16} aria-hidden="true" /> {t('Retirer l’association')}
                </button>
              </div>
            )}

            <div className="pz-field">
              <span className="pz-label" id="immichSearchLabel">{t('Personne à associer dans Immich')}</span>
              <div className="immich-search">
                <Search size={16} aria-hidden="true" />
                <input
                  type="search"
                  aria-labelledby="immichSearchLabel"
                  placeholder={t('Rechercher par nom')}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
            </div>

            {filteredPeople.length === 0 ? (
              <p className="immich-empty">{people.length === 0 ? t('Aucune personne dans Immich.') : t('Aucune personne trouvée.')}</p>
            ) : (
              <div className="immich-list" role="listbox" aria-label={t('Personnes Immich')}>
                {filteredPeople.map((immichPerson) => (
                  <button
                    key={immichPerson.id}
                    type="button"
                    role="option"
                    aria-selected={selected?.id === immichPerson.id}
                    className={`immich-person ${selected?.id === immichPerson.id ? 'is-active' : ''}`}
                    onClick={() => handleSelect(immichPerson)}
                  >
                    <UserRound size={16} aria-hidden="true" />
                    <span>{immichPerson.name || t('Sans nom')}</span>
                  </button>
                ))}
              </div>
            )}

            <div className="immich-preview">
              {thumbnailUrl
                ? <img src={thumbnailUrl} alt={selected?.name || ''} />
                : <div className="immich-preview-empty"><ImagePlus size={22} aria-hidden="true" /></div>}
              <div className="immich-preview-name">{selected?.name || t('Aucune sélection')}</div>
            </div>

            {error && <div className="pz-error immich-error">{error}</div>}

            <div className="pz-modal-actions">
              <button type="button" className="pz-btn pz-btn--ghost" onClick={onClose}>{t('Annuler')}</button>
              <button type="button" className="pz-btn pz-btn--primary" onClick={handleAssign} disabled={!selected || actionLoading}>
                {actionLoading ? <Loader2 size={16} className="immich-spin" aria-hidden="true" /> : null}
                {t('Associer et prendre le portrait')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}

export default ImmichFacePanel
