import { useState, useEffect, useRef, forwardRef } from 'react'
import { createPortal } from 'react-dom'
import { Save, Trash2, Plus, X, Search, Check, Play, ImagePlus, Sparkles, ChevronLeft, ChevronRight, ArrowUpToLine } from 'lucide-react'
import { getParents, getChildren, getPersonUnions, getPersonMedias, filiations, persons, unions } from '../data/mockData'
import { fetchImmichConfig } from '../api/immichApi.js'
import GeoMediaThumbnail from './GeoMediaThumbnail'
import ImmichFacePanel from './ImmichFacePanel.jsx'
import './PersonCard.css'
import PzBusy from './PzBusy.jsx'
import { t, dateLocale } from '../i18n/index.js'
import { formatPlace } from '../utils/place.js'

const TYPE_LABELS = {
  photo: t('Photo'),
  video: t('Vidéo'),
  audio: t('Audio'),
  document: t('Document'),
  citation: t('Citation'),
  geojson: t('Carte GPS'),
  gpx: t('Trace GPX'),
}

// Type d'union affiché (la valeur stockée reste l'enum français)
const UNION_TYPE_LABELS = {
  mariage: t('mariage'),
  union: t('union'),
}
const unionTypeLabel = (type) => UNION_TYPE_LABELS[type] || type

// Hauteurs fixes de l'onde du lecteur vocal (pas d'aléatoire au rendu)
const VOICE_WAVE = [40, 64, 48, 82, 58, 92, 70, 46, 68, 86, 52, 74, 42, 62, 88, 56, 46, 72, 84, 50, 64, 42]

const PersonCard = ({
  person,
  onClose,
  onMediaSelect,
  editMode = false,
  canManageMedia = false,
  onManageMedia,
  onAvatarUpload,
  onAvatarDelete,
  treeId = null,
  immichToken = null,
  onImmichChange,
  avatarActionLoading = false,
  avatarActionError = '',
  isAdmin = false,
  onSave,
  onDelete,
  onAddRelation,
  onRemoveRelation,
  relationActionLoading = false,
  relationActionSuccess = '',
  relationActionError = '',
  siblingPlace = null,
  onMoveSibling,
  onShowAscendance,
}) => {
  // Souvenirs d'abord quand il y en a, ou quand on peut en ajouter : c'est là qu'est le bouton
  const [tab, setTab] = useState(() => (getPersonMedias(person.id).length > 0 || canManageMedia ? 'medias' : 'infos'))

  // État local pour les modifications en mode édition
  const [edits, setEdits] = useState({})
  const [hasChanges, setHasChanges] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveSuccess, setSaveSuccess] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [showImmichPanel, setShowImmichPanel] = useState(false)
  // null : connexion Immich de l'arbre inconnue, puis booléen. Le menu de source ne se propose
  // qu'à qui peut agir (owner/admin de l'arbre, comme pour toute action Immich) et seulement
  // si l'arbre est connecté ou qu'une association passée demande un nettoyage.
  const [immichConfigured, setImmichConfigured] = useState(null)
  const [showSourceMenu, setShowSourceMenu] = useState(false)
  const [sourceMenuPos, setSourceMenuPos] = useState({ top: 0, left: 0 })
  const sourceBtnRef = useRef(null)

  // Inline relation search state
  const [activeRelationSearch, setActiveRelationSearch] = useState(null) // 'parent' | 'spouse' | 'child' | null
  const [relationSearchQuery, setRelationSearchQuery] = useState('')
  const relationSearchRef = useRef(null)
  const avatarInputRef = useRef(null)

  // Reset edits quand la personne change
  useEffect(() => {
    setEdits({})
    setHasChanges(false)
    setShowDeleteConfirm(false)
    setActiveRelationSearch(null)
    setRelationSearchQuery('')
    setSaveSuccess(false)
    setShowSourceMenu(false)
  }, [person.id])

  // Connexion Immich de l'arbre : métadonnées sans clé. Une erreur (rôle périmé, réseau) se
  // traduit par « non configuré » : la fiche reste utilisable, simplement sans choix de source.
  // Seul un administrateur de l'arbre voit l'option Immich, comme côté serveur.
  useEffect(() => {
    let cancelled = false
    setImmichConfigured(null)
    setShowSourceMenu(false)
    if (!editMode || !isAdmin || !treeId || !onImmichChange || !immichToken) return undefined
    fetchImmichConfig(treeId, immichToken)
      .then(({ config }) => { if (!cancelled) setImmichConfigured(Boolean(config?.configured)) })
      .catch(() => { if (!cancelled) setImmichConfigured(false) })
    return () => { cancelled = true }
  }, [editMode, isAdmin, treeId, immichToken, onImmichChange])

  useEffect(() => {
    if (!showSourceMenu) return undefined
    const onKeyDown = (event) => { if (event.key === 'Escape') setShowSourceMenu(false) }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [showSourceMenu])

  const immichUsable = isAdmin && Boolean(immichConfigured || person.avatarFromImmich)
  const openAvatarPicker = () => {
    if (avatarActionLoading) return
    if (immichUsable) {
      const rect = sourceBtnRef.current?.getBoundingClientRect()
      if (rect) {
        setSourceMenuPos({
          top: Math.round(rect.bottom) + 6,
          left: Math.round(Math.min(rect.left, window.innerWidth - 252)),
        })
      }
      setShowSourceMenu(true)
    } else {
      avatarInputRef.current?.click()
    }
  }
  const chooseFileSource = () => { setShowSourceMenu(false); avatarInputRef.current?.click() }
  const chooseImmichSource = () => { setShowSourceMenu(false); setShowImmichPanel(true) }

  // Focus search input when relation search opens
  useEffect(() => {
    if (activeRelationSearch) {
      setTimeout(() => relationSearchRef.current?.focus(), 50)
    }
  }, [activeRelationSearch])

  // Close relation search on click outside
  useEffect(() => {
    if (!activeRelationSearch) return

    function handleClick(e) {
      if (!e.target.closest('.relation-search-inline')) {
        setActiveRelationSearch(null)
        setRelationSearchQuery('')
      }
    }

    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [activeRelationSearch])

  const getEditValue = (field, fallback) => {
    return field in edits ? edits[field] : (fallback ?? '')
  }

  const handleFieldChange = (field, value) => {
    setEdits(prev => ({ ...prev, [field]: value }))
    setHasChanges(true)
  }

  const handleSave = async () => {
    if (!hasChanges || !onSave) return
    setSaving(true)
    try {
      await onSave(person.id, edits)
      setHasChanges(false)
      setSaveSuccess(true)
      setTimeout(() => setSaveSuccess(false), 2000)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = () => {
    if (!onDelete) return
    onDelete(person.id)
    setShowDeleteConfirm(false)
  }

  const handleAvatarFileChange = async (event) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || !onAvatarUpload) return
    await onAvatarUpload(person.id, file)
  }

  // Relation actions
  const handleRelationAdd = (targetPerson, relationType) => {
    onAddRelation?.(person.id, targetPerson.id, relationType)
    setActiveRelationSearch(null)
    setRelationSearchQuery('')
  }

  const handleRelationRemove = (targetPersonId, relationType) => {
    onRemoveRelation?.(person.id, targetPersonId, relationType)
  }

  const toYear = (val) => {
    if (val === null || val === undefined) return Number.NaN
    if (Number.isFinite(val)) return Number(val)
    const m = String(val).match(/^(\d{4})/)
    return m ? Number(m[1]) : Number.NaN
  }

  const birthYearNumber = toYear(person.birthYear ?? person.birthDate)
  const deathYearNumber = toYear(person.deathYear ?? person.deathDate)
  const hasBirthYear = Number.isFinite(birthYearNumber)
  const hasDeathYear = Number.isFinite(deathYearNumber)
  const age = hasBirthYear
    ? person.isAlive
      ? new Date().getFullYear() - birthYearNumber
      : hasDeathYear
        ? deathYearNumber - birthYearNumber
        : null
    : null

  const parentsList = getParents(person.id)
  const childrenList = getChildren(person.id)
  const personUnions = getPersonUnions(person.id)
  const childFiliations = filiations
    .filter((f) => String(f.childId) === String(person.id))
    .sort((a, b) => (a.displayOrder || 0) - (b.displayOrder || 0))
  const preferredFiliation = (() => {
    if (childFiliations.length === 0) return null

    // Prefer an explicit union-based parentage when present.
    const viaUnion = childFiliations.find((f) => f.unionId && unions.some((u) => String(u.id) === String(f.unionId)))
    if (viaUnion) return viaUnion

    // If multiple parents exist, avoid stale "parent unique" metadata.
    if (parentsList.length > 1) {
      return childFiliations.find((f) => (f.parentageType || 'biologique') === 'biologique') || childFiliations[0]
    }

    return childFiliations[0]
  })()
  const personMedias = getPersonMedias(person.id)

  // Filter persons for relation search (exclude current person + already linked)
  const getFilteredPersonsForRelation = (relationType) => {
    const excludeIds = new Set([person.id])

    // Exclude persons already in that relation
    if (relationType === 'parent') {
      parentsList.forEach(p => excludeIds.add(p.id))
    } else if (relationType === 'child') {
      childrenList.forEach(c => excludeIds.add(c.id))
    } else if (relationType === 'spouse') {
      personUnions.forEach(u => {
        excludeIds.add(u.partner1Id === person.id ? u.partner2Id : u.partner1Id)
      })
      // Basic guardrail: never propose direct parent/child as spouse.
      parentsList.forEach(p => excludeIds.add(p.id))
      childrenList.forEach(c => excludeIds.add(c.id))
    }

    return persons.filter(p => {
      if (excludeIds.has(p.id)) return false
      if (!relationSearchQuery) return true
      const fullName = `${p.firstName} ${p.lastName || ''}`.toLowerCase()
      return fullName.includes(relationSearchQuery.toLowerCase())
    })
  }

  const getParentageLabel = () => {
    if (!preferredFiliation) return null
    if (preferredFiliation.unionId) {
      const union = unions.find(u => u.id === preferredFiliation.unionId)
      if (union) {
        const p1 = persons.find(p => p.id === union.partner1Id)
        const p2 = persons.find(p => p.id === union.partner2Id)
        return `${p1?.firstName || '?'} + ${p2?.firstName || '?'} (${unionTypeLabel(union.unionType)})`
      }
    }

    if (preferredFiliation.parentId && parentsList.length <= 1) {
      const parent = persons.find(p => p.id === preferredFiliation.parentId)
      if (preferredFiliation.parentageType === 'inconnu') {
        return t('{name} (parent unique, autre parent inconnu)', { name: parent?.firstName || '?' })
      }
      return t('{name} (parent unique)', { name: parent?.firstName || '?' })
    }
    return null
  }

  const renderMediaIcon = (media) => {
    if (media.type === 'photo') {
      return media.url
        ? <img src={media.url} alt="" />
        : <span>&#128247;</span>
    }

    if (media.type === 'video') return <span>&#9654;</span>
    if (media.type === 'audio') return <span>&#9835;</span>
    if (media.type === 'document') return <span>&#128196;</span>
    if (media.type === 'citation') return <span>&laquo;</span>

    if (media.type === 'geojson' || media.type === 'gpx') {
      return <GeoMediaThumbnail media={media} className="person-card-media-thumb" />
    }

    return <span>{media.type?.toUpperCase?.() || '?'}</span>
  }

  // Rendu d'un champ éditable ou lecture seule
  const renderEditableValue = ({ field, value, placeholder, type = 'text', format = null }) => {
    if (!editMode) {
      const isEmptyValue = value === null || value === undefined || value === ''
      // Une date complète se lit « 22 octobre 1928 », pas « 1928-10-22 »
      const shown = type === 'date' && /^\d{4}-\d{2}-\d{2}/.test(String(value))
        ? new Date(`${String(value).slice(0, 10)}T00:00:00Z`).toLocaleDateString(dateLocale, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
        : format ? format(value) : value
      return <span className="value">{isEmptyValue ? '-' : shown}</span>
    }
    return (
      <input
        type={type}
        className="pc-input value--editable"
        value={getEditValue(field, value)}
        onChange={(e) => handleFieldChange(field, e.target.value)}
        placeholder={placeholder || '...'}
      />
    )
  }

  // Souvenirs regroupés par nature : citation, voix, images, autres
  const quoteMedia = personMedias.find((m) => m.type === 'citation' && m.label)
  const voiceMedias = personMedias.filter((m) => m.type === 'audio')
  const visualMedias = personMedias.filter((m) => m.type === 'photo' || m.type === 'video')
  const otherMedias = personMedias.filter((m) => !['citation', 'audio', 'photo', 'video'].includes(m.type) || (m.type === 'citation' && m !== quoteMedia))

  const initials = `${person.firstName?.[0] || ''}${person.lastName?.[0] || ''}` || '?'
  const lifeLine = (() => {
    const born = person.birthYear || (person.birthDate ? String(person.birthDate).slice(0, 4) : '')
    const died = person.deathYear || (person.deathDate ? String(person.deathDate).slice(0, 4) : '')
    const parts = []
    if (born) parts.push(`${born}${person.birthPlace ? `, ${formatPlace(person.birthPlace)}` : ''}`)
    if (!person.isAlive && died) parts.push(died)
    return parts.join(' – ')
  })()
  const ageLabel = age === null ? null : person.isAlive ? t('{age} ans', { age }) : t('{age} ans au décès', { age })

  const renderRelationRow = (target, relationType, meta) => (
    <div key={`${relationType}-${target?.id}`} className="pc-rel-row">
      <span className="pc-rel-avatar" aria-hidden="true">
        {target?.photo ? <img src={target.photo} alt="" /> : <span>{target?.firstName?.[0] || '?'}</span>}
      </span>
      <span className="pc-rel-name">{target?.firstName} {target?.lastName || ''}</span>
      {meta && <span className="pc-rel-meta">{meta}</span>}
      <button
        type="button"
        className="pz-btn pz-btn--ghost pz-btn--icon pc-rel-remove"
        aria-label={t('Retirer {name}', { name: target?.firstName })}
        onClick={() => handleRelationRemove(target.id, relationType)}
        disabled={relationActionLoading}
      >
        <X size={15} strokeWidth={2} />
      </button>
    </div>
  )

  const renderRelationAdd = (relationType, label, placeholder) => (
    activeRelationSearch === relationType ? (
      <RelationSearchInline
        ref={relationSearchRef}
        query={relationSearchQuery}
        onQueryChange={setRelationSearchQuery}
        results={getFilteredPersonsForRelation(relationType)}
        onSelect={(p) => handleRelationAdd(p, relationType)}
        onClose={() => { setActiveRelationSearch(null); setRelationSearchQuery('') }}
        placeholder={placeholder}
      />
    ) : (
      <button type="button" className="pc-rel-add" onClick={() => setActiveRelationSearch(relationType)} disabled={relationActionLoading}>
        <Plus size={15} strokeWidth={2} />
        {label}
      </button>
    )
  )

  return (
    <div className={`person-card ${editMode ? 'person-card--edit-mode' : ''}`} role="dialog" aria-label={t('Fiche de {name}', { name: `${person.firstName} ${person.lastName || ''}` })}>
      <span className="pc-grab" aria-hidden="true" />
      <button type="button" className="pz-btn pz-btn--ghost pz-btn--icon pc-close" onClick={onClose} aria-label={t('Fermer la fiche')}>
        <X size={18} strokeWidth={2} />
      </button>

      {/* ── En-tête : visage, nom, repères ── */}
      <header className="pc-head">
        <div className="pc-photo-wrap">
          {onAvatarUpload && (
            <input
              ref={avatarInputRef}
              type="file"
              accept="image/*"
              className="pc-hidden-input"
              onChange={handleAvatarFileChange}
              disabled={avatarActionLoading}
            />
          )}
          {/* Portrait vide chez le propriétaire : le cadre lui-même invite à poser la photo, sans passer par l'édition */}
          {!person.photo && onAvatarUpload && !editMode ? (
            <button
              type="button"
              className="pc-photo pc-photo--add"
              onClick={() => avatarInputRef.current?.click()}
              disabled={avatarActionLoading}
            >
              <ImagePlus size={22} strokeWidth={1.8} aria-hidden="true" />
              <span>{avatarActionLoading ? t('Envoi') : t('Ajouter une photo')}</span>
            </button>
          ) : (
            <div className="pc-photo">
              {person.photo
                ? <img src={person.photo} alt={`${person.firstName} ${person.lastName || ''}`} />
                : <span className="pc-photo-initials">{initials}</span>}
            </div>
          )}
          {editMode && onAvatarUpload && (
            <div className="pc-photo-actions">
              <button
                ref={sourceBtnRef}
                type="button"
                className="pc-photo-btn"
                onClick={openAvatarPicker}
                disabled={avatarActionLoading}
                aria-haspopup="menu"
                aria-expanded={showSourceMenu}
              >
                {person.photo ? t('Changer') : t('Ajouter une photo')}
              </button>
              {person.photo && (
                <button
                  type="button"
                  className="pc-photo-btn pc-photo-btn--danger"
                  onClick={() => onAvatarDelete?.(person.id, person.avatarFromImmich)}
                  disabled={avatarActionLoading}
                >
                  {t('Retirer')}
                </button>
              )}
            </div>
          )}
        </div>

        <div className="pc-id">
          {editMode ? (
            <div className="pc-name-edit">
              <input
                type="text"
                className="pc-input pc-input--name"
                value={getEditValue('firstName', person.firstName)}
                onChange={(e) => handleFieldChange('firstName', e.target.value)}
                placeholder={t('Prénom')}
                aria-label={t('Prénom')}
              />
              <input
                type="text"
                className="pc-input pc-input--name pc-input--last"
                value={getEditValue('lastName', person.lastName)}
                onChange={(e) => handleFieldChange('lastName', e.target.value)}
                placeholder={t('Nom')}
                aria-label={t('Nom')}
              />
            </div>
          ) : (
            <h2 className="pc-name">
              {person.firstName} <em>{person.lastName}</em>
            </h2>
          )}
          {!editMode && lifeLine && <p className="pc-life">{lifeLine}</p>}
          <div className="pc-chips">
            {editMode && <span className="pz-tag pz-tag--accent pz-tag--dot">{t('Édition')}</span>}
            {editMode && siblingPlace && (
              <span className="pz-tag pc-order" role="group" aria-label={t('Place {n} sur {total} parmi les frères et sœurs', { n: siblingPlace.index + 1, total: siblingPlace.count })}>
                <button type="button" className="pc-order-btn" onClick={() => onMoveSibling?.(-1)} disabled={siblingPlace.index === 0} aria-label={t('Déplacer à gauche')} title={t('Déplacer à gauche')}>
                  <ChevronLeft size={15} strokeWidth={2} aria-hidden="true" />
                </button>
                <span className="pc-order-label" aria-hidden="true">{siblingPlace.index + 1}/{siblingPlace.count}</span>
                <button type="button" className="pc-order-btn" onClick={() => onMoveSibling?.(1)} disabled={siblingPlace.index === siblingPlace.count - 1} aria-label={t('Déplacer à droite')} title={t('Déplacer à droite')}>
                  <ChevronRight size={15} strokeWidth={2} aria-hidden="true" />
                </button>
              </span>
            )}
            {!editMode && ageLabel && <span className="pz-tag">{ageLabel}</span>}
            {!editMode && person.profession && <span className="pz-tag">{person.profession}</span>}
          </div>
        </div>
      </header>

      {/* Mode Ascendance : recenter la vue sur les ancêtres de cette personne */}
      {onShowAscendance && (
        <button type="button" className="pz-btn pz-btn--ghost pz-btn--sm pc-ascendance" onClick={() => onShowAscendance(person.id)}>
          <ArrowUpToLine size={15} strokeWidth={2} aria-hidden="true" />
          {t('Voir l’ascendance de cette personne')}
        </button>
      )}

      {avatarActionError && <div className="pz-error pc-inline-msg">{avatarActionError}</div>}

      {/* ── Onglets ── */}
      <div className="pz-tabs pc-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'medias'} className="pz-tab" onClick={() => setTab('medias')}>
          {t('Souvenirs')}{personMedias.length > 0 ? ` · ${personMedias.length}` : ''}
        </button>
        <button type="button" role="tab" aria-selected={tab === 'infos'} className="pz-tab" onClick={() => setTab('infos')}>
          {t('Infos')}
        </button>
        {editMode && (
          <button type="button" role="tab" aria-selected={tab === 'relations'} className="pz-tab" onClick={() => setTab('relations')}>
            {t('Liens')}
          </button>
        )}
      </div>

      <div className="pc-body">
        {/* ── Souvenirs ── */}
        {tab === 'medias' && (
          <div className="pc-souvenirs">
            {personMedias.length === 0 && (
              <div className="pc-empty">
                <p className="pz-sub">{t('Pas encore de souvenir pour {name}.', { name: person.firstName })}</p>
                <p className="pz-small">{canManageMedia ? t('Une photo, une anecdote, sa voix. Vous pouvez ajouter le premier.') : t('Une photo, une anecdote, sa voix.')}</p>
              </div>
            )}

            {quoteMedia && (
              <button type="button" className="pc-quote" onClick={() => onMediaSelect?.(quoteMedia, person)}>
                « {quoteMedia.label} »
                {quoteMedia.source && <small>{quoteMedia.source}</small>}
              </button>
            )}

            {voiceMedias.map((media) => (
              <button key={media.id} type="button" className="pc-voice" onClick={() => onMediaSelect?.(media, person)}>
                <span className="pc-voice-play" aria-hidden="true"><Play size={13} fill="currentColor" strokeWidth={0} /></span>
                <span className="pc-voice-wave" aria-hidden="true">{VOICE_WAVE.map((h, i) => <i key={i} style={{ height: `${h}%` }} />)}</span>
                <span className="pc-voice-label">{media.label || t('Enregistrement')}</span>
              </button>
            ))}

            {visualMedias.length > 0 && (
              <div className="pc-grid">
                {visualMedias.map((media) => (
                  <button
                    key={media.id}
                    type="button"
                    className={`pc-tile pc-tile--${media.type}`}
                    onClick={() => onMediaSelect?.(media, person)}
                    title={media.label || TYPE_LABELS[media.type]}
                  >
                    {media.type === 'photo' && media.url
                      ? <img src={media.url} alt={media.label || ''} loading="lazy" />
                      : <span className="pc-tile-video"><Play size={18} fill="currentColor" strokeWidth={0} /></span>}
                    {media.label && <span className="pc-tile-label">{media.label}</span>}
                  </button>
                ))}
                {canManageMedia && (
                  <button type="button" className="pc-tile pc-tile--add" onClick={() => onManageMedia?.()} aria-label={t('Ajouter des souvenirs')}>
                    <Plus size={20} strokeWidth={1.8} />
                  </button>
                )}
              </div>
            )}

            {otherMedias.length > 0 && (
              <div className="pc-list">
                {otherMedias.map((media) => (
                  <button key={media.id} type="button" className="pc-list-item" onClick={() => onMediaSelect?.(media, person)}>
                    <span className={`pc-list-icon pc-list-icon--${media.type}`}>{renderMediaIcon(media)}</span>
                    <span className="pc-list-text">
                      <span className="pc-list-label">{media.label || TYPE_LABELS[media.type]}</span>
                      <span className="pc-list-type">{TYPE_LABELS[media.type] || media.type}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}

            {canManageMedia && (
              <button type="button" className={`pz-btn pz-btn--block ${isAdmin ? 'pz-btn--soft' : 'pz-btn--primary'}`} onClick={() => onManageMedia?.()}>
                <Plus size={16} strokeWidth={2} />
                {isAdmin ? t('Ajouter ou ranger des souvenirs') : t('Ajouter un souvenir')}
              </button>
            )}
          </div>
        )}

        {/* ── Infos ── */}
        {tab === 'infos' && (
          <div className="pc-infos">
            <section className="pc-section">
              <h3 className="pz-eyebrow">{t('État civil')}</h3>
              <div className="pc-rows">
                <div className="pc-row">
                  <span className="pc-label">{t('Naissance')}</span>
                  {renderEditableValue({ field: 'birthYear', value: person.birthDate || person.birthYear, placeholder: t('Date de naissance'), type: 'date' })}
                </div>
                {(person.birthPlace || editMode) && (
                  <div className="pc-row">
                    <span className="pc-label">{t('Lieu')}</span>
                    {renderEditableValue({ field: 'birthPlace', value: person.birthPlace || '', placeholder: t('Lieu de naissance'), format: formatPlace })}
                  </div>
                )}
                {(person.birthName || editMode) && (
                  <div className="pc-row">
                    <span className="pc-label">{t('Nom de naissance')}</span>
                    {renderEditableValue({ field: 'birthName', value: person.birthName || '', placeholder: t('Nom de naissance') })}
                  </div>
                )}
                {editMode && (
                  <div className="pc-row">
                    <span className="pc-label">{t('Statut')}</span>
                    <button
                      type="button"
                      className={`pc-alive ${getEditValue('isAlive', person.isAlive) ? 'is-alive' : 'is-deceased'}`}
                      onClick={() => handleFieldChange('isAlive', !getEditValue('isAlive', person.isAlive))}
                    >
                      <span className="pc-alive-dot" />
                      {getEditValue('isAlive', person.isAlive) ? t('En vie') : t('Décédé(e)')}
                    </button>
                  </div>
                )}
                {(!getEditValue('isAlive', person.isAlive) || (!editMode && !person.isAlive)) && (
                  <div className="pc-row">
                    <span className="pc-label">{t('Décès')}</span>
                    {renderEditableValue({ field: 'deathYear', value: person.deathDate || person.deathYear || '', placeholder: t('Date de décès'), type: 'date' })}
                  </div>
                )}
                {!editMode && (
                  <div className="pc-row">
                    <span className="pc-label">{t('Âge')}</span>
                    <span className="value">{ageLabel || '-'}</span>
                  </div>
                )}
                {(person.region || editMode) && (
                  <div className="pc-row">
                    <span className="pc-label">{t('Région')}</span>
                    {renderEditableValue({ field: 'region', value: person.region || '', placeholder: t('Région') })}
                  </div>
                )}
                {(person.nationality || editMode) && (
                  <div className="pc-row">
                    <span className="pc-label">{t('Nationalité')}</span>
                    {renderEditableValue({ field: 'nationality', value: person.nationality || '', placeholder: t('Nationalité') })}
                  </div>
                )}
                {(person.profession || editMode) && (
                  <div className="pc-row">
                    <span className="pc-label">{t('Métier')}</span>
                    {renderEditableValue({ field: 'profession', value: person.profession || '', placeholder: t('Métier') })}
                  </div>
                )}
              </div>
            </section>

            {!editMode && (parentsList.length > 0 || personUnions.length > 0 || childrenList.length > 0) && (
              <section className="pc-section">
                <h3 className="pz-eyebrow">{t('Famille')}</h3>
                <div className="pc-rows">
                  {parentsList.length > 0 && (
                    <div className="pc-row">
                      <span className="pc-label">{t('Parents')}</span>
                      <span className="value">{getParentageLabel() || parentsList.map(p => `${p.firstName} ${p.lastName}`).join(t(' et '))}</span>
                    </div>
                  )}
                  {preferredFiliation && preferredFiliation.parentageType !== 'biologique' && parentsList.length <= 1 && (
                    <div className="pc-row">
                      <span className="pc-label">{t('Filiation')}</span>
                      <span className="value">{preferredFiliation.parentageType === 'adoption' ? t('Adoption') : t('Parent inconnu')}</span>
                    </div>
                  )}
                  {personUnions.length > 0 && (
                    <div className="pc-row">
                      <span className="pc-label">{personUnions.length > 1 ? t('Unions') : t('Union')}</span>
                      <span className="value">
                        {personUnions.map(u => {
                          const partnerId = u.partner1Id === person.id ? u.partner2Id : u.partner1Id
                          const partner = persons.find(p => p.id === partnerId)
                          const yearRange = u.startYear ? (u.endYear ? `${u.startYear}–${u.endYear}` : t('depuis {year}', { year: u.startYear })) : ''
                          return `${partner?.firstName || '?'} ${partner?.lastName || ''}${yearRange ? ` (${yearRange})` : ''}`
                        }).join(', ')}
                      </span>
                    </div>
                  )}
                  {childrenList.length > 0 && (
                    <div className="pc-row">
                      <span className="pc-label">{t('Enfants')}</span>
                      <span className="value">{childrenList.map(c => c.firstName).join(', ')}</span>
                    </div>
                  )}
                </div>
              </section>
            )}

            {(person.note || editMode) && (
              <section className="pc-section">
                <h3 className="pz-eyebrow">{t('Notes')}</h3>
                {editMode ? (
                  <textarea
                    className="pc-input pc-note-input"
                    value={getEditValue('note', person.note || '')}
                    onChange={(e) => handleFieldChange('note', e.target.value)}
                    placeholder={t("Une anecdote, un trait de caractère, ce qu'on se raconte à son sujet")}
                    rows={3}
                  />
                ) : (
                  <p className="pc-note">{person.note}</p>
                )}
              </section>
            )}
          </div>
        )}

        {/* ── Liens (édition) ── */}
        {tab === 'relations' && editMode && (
          <div className="pc-infos">
            {(relationActionLoading || relationActionSuccess || relationActionError) && (
              <div className={relationActionError ? 'pz-error pc-inline-msg' : relationActionSuccess ? 'pz-success pc-inline-msg' : 'pc-inline-msg pc-inline-msg--loading'}>
                {relationActionLoading ? t('Mise à jour des liens…') : relationActionError || relationActionSuccess}
              </div>
            )}

            <section className="pc-section">
              <h3 className="pz-eyebrow">{t('Parents')}</h3>
              {parentsList.length > 0 ? parentsList.map(p => renderRelationRow(p, 'parent')) : <p className="pc-rel-empty">{t("Aucun parent pour l'instant")}</p>}
              {renderRelationAdd('parent', t('Ajouter un parent'), t('Rechercher un parent'))}
            </section>

            <section className="pc-section">
              <h3 className="pz-eyebrow">{t('Conjoint·e·s')}</h3>
              {personUnions.length > 0 ? personUnions.map(u => {
                const partnerId = u.partner1Id === person.id ? u.partner2Id : u.partner1Id
                const partner = persons.find(p => p.id === partnerId)
                return renderRelationRow(partner || { id: partnerId, firstName: '?' }, 'spouse', unionTypeLabel(u.unionType))
              }) : <p className="pc-rel-empty">{t('Aucun·e conjoint·e')}</p>}
              {renderRelationAdd('spouse', t('Ajouter un·e conjoint·e'), t('Rechercher un·e conjoint·e'))}
            </section>

            <section className="pc-section">
              <h3 className="pz-eyebrow">{t('Enfants')}</h3>
              {childrenList.length > 0 ? childrenList.map(c => renderRelationRow(c, 'child')) : <p className="pc-rel-empty">{t('Aucun enfant')}</p>}
              {renderRelationAdd('child', t('Ajouter un enfant'), t('Rechercher un enfant'))}
            </section>
          </div>
        )}
      </div>

      {/* ── Actions d'édition ── */}
      {editMode && (
        <footer className="pc-foot">
          {showDeleteConfirm ? (
            <div className="pc-delete-confirm">
              <span>{t("Supprimer {name} de l'arbre ?", { name: person.firstName })}</span>
              <div className="pc-delete-actions">
                <button type="button" className="pz-btn pz-btn--ghost pz-btn--sm" onClick={() => setShowDeleteConfirm(false)}>{t('Annuler')}</button>
                <button type="button" className="pz-btn pz-btn--danger pz-btn--sm" onClick={handleDelete}>{t('Supprimer')}</button>
              </div>
            </div>
          ) : (
            <>
              {isAdmin && (
                <button type="button" className="pz-btn pz-btn--danger-ghost pz-btn--sm" onClick={() => setShowDeleteConfirm(true)}>
                  <Trash2 size={15} strokeWidth={2} />
                  {t('Supprimer')}
                </button>
              )}
              <button
                type="button"
                className={`pz-btn pz-btn--primary pc-save ${saveSuccess ? 'is-saved' : ''}`}
                disabled={(!hasChanges && !saveSuccess) || saving}
                onClick={handleSave}
              >
                {saveSuccess ? (<><Check size={16} strokeWidth={2.5} />{t('Enregistré')}</>) : (<PzBusy busy={saving} busyLabel={t('Enregistrement en cours')}><Save size={16} strokeWidth={2} />{t('Enregistrer')}</PzBusy>)}
              </button>
            </>
          )}
        </footer>
      )}

      {/* ── Choix de la source du portrait (menu contextuel) ── */}
      {showSourceMenu && (
        createPortal(
          <>
            <div className="pc-source-backdrop" onClick={() => setShowSourceMenu(false)} />
            <div className="pc-source-menu pz-menu" role="menu" aria-label={t('Source du portrait')} style={{ top: `${sourceMenuPos.top}px`, left: `${sourceMenuPos.left}px` }}>
              <button type="button" role="menuitem" className="pz-menu-item" onClick={chooseFileSource}>
                <ImagePlus size={16} aria-hidden="true" /> {t('Depuis un fichier')}
              </button>
              <button type="button" role="menuitem" className="pz-menu-item" onClick={chooseImmichSource}>
                <Sparkles size={16} aria-hidden="true" /> {t('Depuis Immich')}
              </button>
            </div>
          </>,
          document.body,
        )
      )}

      {/* ── Association d'un visage Immich (modale) ── */}
      {showImmichPanel && treeId && (
        <ImmichFacePanel
          person={person}
          treeId={treeId}
          token={immichToken}
          onClose={() => setShowImmichPanel(false)}
          onImmichChange={onImmichChange}
        />
      )}
    </div>
  )
}

/**
 * Recherche en ligne pour ajouter un lien (parent, conjoint·e, enfant)
 */
const RelationSearchInline = forwardRef(function RelationSearchInline(
  { query, onQueryChange, results, onSelect, onClose, placeholder },
  ref
) {
  const filtered = results.slice(0, 6)

  return (
    <div className="relation-search-inline pc-search">
      <div className="pc-search-field">
        <Search size={15} strokeWidth={2} className="pc-search-icon" />
        <input
          ref={ref}
          type="text"
          className="pc-search-input"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder={placeholder}
          autoComplete="off"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation()
              onClose()
            }
          }}
        />
        <button type="button" className="pz-btn pz-btn--ghost pz-btn--icon pc-search-close" onClick={onClose} aria-label={t('Fermer la recherche')}>
          <X size={15} strokeWidth={2} />
        </button>
      </div>
      {filtered.length > 0 ? (
        <ul className="pc-search-list">
          {filtered.map((p) => (
            <li key={p.id}>
              <button type="button" className="pc-search-item" onClick={() => onSelect(p)}>
                <span className="pc-rel-avatar" aria-hidden="true">
                  {p.photo ? <img src={p.photo} alt="" /> : <span>{p.firstName[0]}</span>}
                </span>
                <span className="pc-rel-name">{p.firstName} <em>{p.lastName || ''}</em></span>
                {p.birthYear && <span className="pc-rel-meta">{p.birthYear}</span>}
              </button>
            </li>
          ))}
        </ul>
      ) : query ? (
        <p className="pc-rel-empty">{t('Aucune personne ne correspond')}</p>
      ) : null}
    </div>
  )
})

export default PersonCard
