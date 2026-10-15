import { useEffect, useRef, useState } from 'react'
import { Download, ImagePlus, Trash2, Unplug, X } from 'lucide-react'
import './SettingsPanels.css'
import {
  deleteTree,
  exportGedcom,
  fetchTreeSettings,
  getTree,
  importGedcom,
  updateTree,
  updateTreeSettings,
} from '../api/treeApi'
import {
  checkImmichStatus,
  fetchImmichConfig,
  getImmichErrorMessage,
  removeImmichConfig,
  saveImmichConfig,
} from '../api/immichApi.js'
import PzBusy from './PzBusy.jsx'
import TreeVisitsSection from './TreeVisitsSection.jsx'
import { t } from '../i18n/index.js'

function normalizeSlug(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

const AdminPanel = ({
  visible,
  treeId,
  authToken,
  persons = [],
  onRootPersonChanged,
  onClose,
  onTreeDeleted,
  onGedcomImported,
  onOpenPhotoStart,
}) => {
  const [section, setSection] = useState('tree')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [successMessage, setSuccessMessage] = useState('')

  const [tree, setTree] = useState(null)
  const [treeName, setTreeName] = useState('')
  const [treeDescription, setTreeDescription] = useState('')
  // Personne racine configurée : l'affichage « rooted » (?layout=rooted) s'organise autour d'elle.
  // '' = choix automatique (personne la plus connectée).
  const [treeRootPersonId, setTreeRootPersonId] = useState('')
  // Contributions de la famille : 'pending' = validées par l'admin, 'direct' = appliquées immédiatement
  const [contributionPolicy, setContributionPolicy] = useState('pending')
  const [savingPolicy, setSavingPolicy] = useState(false)

  const [showDeleteModal, setShowDeleteModal] = useState(false)
  const [deleteConfirmName, setDeleteConfirmName] = useState('')
  const [gedcomFile, setGedcomFile] = useState(null)
  const [importingGedcom, setImportingGedcom] = useState(false)
  const gedcomInputRef = useRef(null)

  // Connexion Immich propre à cet arbre : l'adresse se choisit parmi celles autorisées par
  // l'opérateur du serveur, la clé n'est jamais relue et le champ vide la conserve.
  const [immichConfig, setImmichConfig] = useState(null)
  const [immichAllowedUrls, setImmichAllowedUrls] = useState([])
  const [immichApiUrl, setImmichApiUrl] = useState('')
  const [immichApiKey, setImmichApiKey] = useState('')
  const [immichStatus, setImmichStatus] = useState(null) // null : inconnu, 'ok', sinon le motif
  const [immichBusy, setImmichBusy] = useState(false)

  useEffect(() => {
    if (!visible || !treeId || !authToken) {
      return
    }

    let active = true
    setLoading(true)
    setErrorMessage('')
    setSuccessMessage('')
    setSection('tree')
    setShowDeleteModal(false)
    setDeleteConfirmName('')
    setGedcomFile(null)
    setImportingGedcom(false)

    setImmichConfig(null)
    setImmichAllowedUrls([])
    setImmichApiUrl('')
    setImmichApiKey('')
    setImmichStatus(null)
    fetchImmichConfig(treeId, authToken)
      .then(({ config, allowedApiUrls }) => {
        if (!active) return
        setImmichConfig(config)
        setImmichAllowedUrls(allowedApiUrls)
        setImmichApiUrl(allowedApiUrls.includes(config?.apiUrl) ? config.apiUrl : '')
      })
      .catch(() => {
        // Configuration non chargée : l'onglet Immich affichera l'état inconnu
      })

    fetchTreeSettings(treeId, authToken)
      .then((settings) => {
        if (!active || !settings) return
        setContributionPolicy(settings.contributorPolicy === 'direct' ? 'direct' : 'pending')
      })
      .catch(() => {
        // Réglage non chargé : on laisse la valeur par défaut affichée
      })

    getTree(treeId, authToken)
      .then((result) => {
        if (!active) return
        const loadedTree = result?.tree || null
        setTree(loadedTree)
        setTreeName(loadedTree?.name || '')
        setTreeDescription(loadedTree?.description || '')
        setTreeRootPersonId(loadedTree?.rootPersonId || '')
      })
      .catch(() => {
        if (!active) return
        setErrorMessage(t('Impossible de charger les paramètres de cet arbre.'))
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    return () => {
      active = false
    }
  }, [visible, treeId, authToken])

  const handlePolicyChange = async (nextPolicy) => {
    if (!treeId || !authToken || savingPolicy || nextPolicy === contributionPolicy) return
    const previous = contributionPolicy
    setContributionPolicy(nextPolicy)
    setSavingPolicy(true)
    setErrorMessage('')
    setSuccessMessage('')
    try {
      // Un seul réglage pour la famille, avec ou sans compte
      await updateTreeSettings(treeId, { contributorPolicy: nextPolicy, memberContributionPolicy: nextPolicy }, authToken)
      setSuccessMessage(nextPolicy === 'direct'
        ? t('Les modifications de la famille sont désormais appliquées directement.')
        : t('Vous validez désormais chaque proposition de la famille.'))
    } catch {
      setContributionPolicy(previous)
      setErrorMessage(t("Impossible d'enregistrer ce réglage."))
    } finally {
      setSavingPolicy(false)
    }
  }

  const handleSaveTree = async (event) => {
    event.preventDefault()
    if (!treeId || !authToken || saving || !tree) return

    const nextName = treeName.trim()
    if (nextName.length < 2) {
      setErrorMessage(t("Le nom de l'arbre est trop court."))
      return
    }

    setSaving(true)
    setErrorMessage('')
    setSuccessMessage('')

    try {
      const payload = {
        name: nextName,
        description: treeDescription.trim() || null,
        rootPersonId: treeRootPersonId || null,
      }

      const normalized = normalizeSlug(nextName)
      const slugWillChange = normalized && normalized !== tree.slug
      if (slugWillChange) {
        const confirmSlugUpdate = window.confirm(
          t('Souhaitez-vous mettre à jour aussi le lien de partage avec ce nouveau nom ?'),
        )
        if (confirmSlugUpdate) {
          payload.slug = normalized
        }
      }

      const updated = await updateTree(treeId, payload, authToken)
      // La racine a changé : l'arbre affiché se réorganise autour de la nouvelle personne
      if ((updated?.rootPersonId || null) !== (tree?.rootPersonId || null)) {
        await onRootPersonChanged?.()
      }
      setTree(updated)
      setTreeName(updated?.name || nextName)
      setTreeDescription(updated?.description || '')
      setSuccessMessage(t('Modifications enregistrées.'))
    } catch {
      setErrorMessage(t("Impossible d'enregistrer les modifications."))
    } finally {
      setSaving(false)
    }
  }

  const handleExportGedcom = async () => {
    if (!treeId || !authToken || saving) return
    setSaving(true)
    setErrorMessage('')
    setSuccessMessage('')

    try {
      const { blob, filename } = await exportGedcom(treeId, authToken)
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = filename
      link.click()
      URL.revokeObjectURL(url)
    } catch {
      setErrorMessage(t('Échec du téléchargement GEDCOM.'))
    } finally {
      setSaving(false)
    }
  }

  const readFileAsText = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error('read_failed'))
    reader.readAsText(file)
  })

  const handleImportGedcom = async () => {
    if (!treeId || !authToken || saving || !gedcomFile) {
      return
    }

    setSaving(true)
    setImportingGedcom(true)
    setErrorMessage('')
    setSuccessMessage('')

    try {
      const fileContent = await readFileAsText(gedcomFile)
      if (!fileContent.trim()) {
        setErrorMessage(t('Le fichier GEDCOM est vide.'))
        return
      }

      const result = await importGedcom(treeId, fileContent, authToken)
      const personsCreated = Number(result?.personsCreated || 0)
      const unionsCreated = Number(result?.unionsCreated || 0)
      const linksCreated = Number(result?.linksCreated || 0)

      setSuccessMessage(
        t('Import GEDCOM terminé : {persons} personnes, {unions} unions, {links} filiations.', {
          persons: personsCreated,
          unions: unionsCreated,
          links: linksCreated,
        }),
      )
      setGedcomFile(null)
      if (gedcomInputRef.current) {
        gedcomInputRef.current.value = ''
      }
      await onGedcomImported?.(result)
    } catch {
      setErrorMessage(t("Impossible d'importer ce fichier GEDCOM."))
    } finally {
      setImportingGedcom(false)
      setSaving(false)
    }
  }

  const handleDeleteTree = async () => {
    if (!treeId || !authToken || saving || !tree) return
    if (deleteConfirmName.trim() !== tree.name) {
      setErrorMessage(t('Le nom saisi ne correspond pas.'))
      return
    }

    setSaving(true)
    setErrorMessage('')
    setSuccessMessage('')

    try {
      await deleteTree(treeId, authToken)
      setShowDeleteModal(false)
      onTreeDeleted?.(treeId)
      onClose?.()
    } catch {
      setErrorMessage(t('Impossible de supprimer cet arbre.'))
    } finally {
      setSaving(false)
    }
  }

  // ── Connexion Immich de l'arbre ──────────────────────────────────────────────

  const testImmichConnection = async () => {
    if (!treeId || !authToken) return
    setImmichStatus('testing')
    try {
      const status = await checkImmichStatus(treeId, authToken)
      setImmichStatus(status?.available ? 'ok' : (status?.reason || 'unreachable'))
    } catch (err) {
      setImmichStatus('error')
      setErrorMessage(getImmichErrorMessage(err, t))
    }
  }

  const handleSaveImmichConfig = async (event) => {
    event.preventDefault()
    if (!treeId || !authToken || immichBusy) return

    const apiUrl = immichApiUrl
    if (!apiUrl) {
      setErrorMessage(t('Choisissez l’adresse de l’instance Immich.'))
      return
    }
    const apiKey = immichApiKey.trim()
    // Changer d'instance réclame une nouvelle clé : l'ancienne n'est ni conservée ni envoyée
    // au nouveau serveur.
    const changingInstance = Boolean(immichConfig?.configured && immichConfig.apiUrl && immichConfig.apiUrl !== apiUrl)
    if (changingInstance && !apiKey) {
      setErrorMessage(t('L’instance Immich change : indiquez la clé d’accès de la nouvelle instance, l’ancienne n’est pas conservée.'))
      return
    }
    if (!immichConfig?.configured && !apiKey) {
      setErrorMessage(t('Indiquez la clé d’accès à Immich pour la première configuration.'))
      return
    }

    setImmichBusy(true)
    setErrorMessage('')
    setSuccessMessage('')
    try {
      const config = await saveImmichConfig(treeId, { apiUrl, apiKey }, authToken)
      setImmichConfig(config || { configured: true, apiUrl, updatedAt: null })
      setImmichApiKey('')
      setSuccessMessage(t('Connexion Immich enregistrée.'))
      await testImmichConnection()
    } catch (err) {
      setErrorMessage(getImmichErrorMessage(err, t))
    } finally {
      setImmichBusy(false)
    }
  }

  const handleRemoveImmichConfig = async () => {
    if (!treeId || !authToken || immichBusy || !immichConfig?.configured) return
    if (!window.confirm(t('Supprimer la connexion Immich de cet arbre ? La reconnaissance des visages sera désactivée.'))) {
      return
    }

    setImmichBusy(true)
    setErrorMessage('')
    setSuccessMessage('')
    try {
      await removeImmichConfig(treeId, authToken)
      setImmichConfig({ configured: false, apiUrl: null, updatedAt: null })
      setImmichApiUrl('')
      setImmichApiKey('')
      setImmichStatus(null)
      setSuccessMessage(t('Connexion Immich supprimée.'))
    } catch (err) {
      setErrorMessage(getImmichErrorMessage(err, t))
    } finally {
      setImmichBusy(false)
    }
  }

  if (!visible) return null

  return (
    <div
      className="pz-overlay tree-settings-overlay"
      onClick={() => {
        if (!showDeleteModal) onClose?.()
      }}
    >
      <div
        className="pz-modal pz-modal--wide tree-settings-card"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="treeSettingsTitle"
      >
        <div className="pz-modal-head">
          <p className="pz-eyebrow">{t("Paramètres de l'arbre")}</p>
          <h1 id="treeSettingsTitle" className="pz-title">{tree?.name || t('Votre arbre')}</h1>
        </div>
        <button type="button" className="pz-btn pz-btn--ghost pz-btn--icon pz-modal-close" onClick={onClose} aria-label={t('Fermer')}>
          <X size={18} aria-hidden="true" />
        </button>

        <div className="pz-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={section === 'tree'} className="pz-tab" onClick={() => setSection('tree')}>{t('Votre arbre')}</button>
          <button type="button" role="tab" aria-selected={section === 'visits'} className="pz-tab" onClick={() => setSection('visits')}>{t('Visites')}</button>
          <button type="button" role="tab" aria-selected={section === 'data'} className="pz-tab" onClick={() => setSection('data')}>{t('Données')}</button>
          <button type="button" role="tab" aria-selected={section === 'immich'} className="pz-tab" onClick={() => setSection('immich')}>{t('Immich')}</button>
          <button type="button" role="tab" aria-selected={section === 'danger'} className="pz-tab" onClick={() => setSection('danger')}>{t('Avancé')}</button>
        </div>

        <div className="ts-content">
          {loading ? (
            <p className="pz-small ts-loading">{t('Chargement…')}</p>
          ) : (
            <>
              {errorMessage && <div className="pz-error" role="alert">{errorMessage}</div>}
              {successMessage && <div className="pz-success" role="status">{successMessage}</div>}

              {section === 'visits' && <TreeVisitsSection treeId={treeId} authToken={authToken} />}

              {section === 'tree' && (
                <form className="ts-panel" onSubmit={handleSaveTree}>
                  <div className="pz-field">
                    <label htmlFor="settingsTreeName">{t("Nom de l'arbre")}</label>
                    <input
                      id="settingsTreeName"
                      type="text"
                      value={treeName}
                      maxLength={120}
                      onChange={(event) => setTreeName(event.target.value)}
                      required
                    />
                  </div>

                  <div className="pz-field">
                    <label htmlFor="settingsTreeDescription">{t('Description')} <span className="ts-optional">{t('facultatif')}</span></label>
                    <input
                      id="settingsTreeDescription"
                      type="text"
                      value={treeDescription}
                      maxLength={500}
                      onChange={(event) => setTreeDescription(event.target.value)}
                      placeholder={t('Quelques mots pour accueillir la famille')}
                    />
                  </div>

                  <div className="pz-field">
                    <label htmlFor="settingsTreeRoot">{t('Personne racine')}</label>
                    <select
                      id="settingsTreeRoot"
                      value={treeRootPersonId}
                      onChange={(event) => setTreeRootPersonId(event.target.value)}
                    >
                      <option value="">{t('Choix automatique (personne la plus connectée)')}</option>
                      {[...persons]
                        .sort((a, b) => `${a.lastName} ${a.firstName}`.localeCompare(`${b.lastName} ${b.firstName}`, 'fr'))
                        .map((person) => (
                          <option key={person.id} value={person.id}>
                            {`${person.firstName || ''} ${person.lastName || ''}`.trim()}
                          </option>
                        ))}
                    </select>
                    <p className="pz-small">{t("L'affichage « rooted » (?layout=rooted) organise l'arbre autour d'elle.")}</p>
                  </div>

                  <div className="ts-actions">
                    <button type="submit" className="pz-btn pz-btn--primary" disabled={saving}>
                      <PzBusy busy={saving} busyLabel={t('Enregistrement en cours')}>{t('Enregistrer')}</PzBusy>
                    </button>
                  </div>

                  <fieldset className="ts-policy" disabled={savingPolicy}>
                    <legend className="pz-eyebrow">{t('Contributions de la famille')}</legend>
                    <p className="pz-small">{t('Ce que deviennent les ajouts et corrections faits avec le mot de passe de contribution.')}</p>
                    <label className={`ts-choice ${contributionPolicy === 'pending' ? 'is-active' : ''}`}>
                      <input
                        type="radio"
                        name="contributionPolicy"
                        value="pending"
                        checked={contributionPolicy === 'pending'}
                        onChange={() => handlePolicyChange('pending')}
                      />
                      <span className="ts-choice-text">
                        <strong>{t('Je valide chaque proposition')}</strong>
                        <small>{t("Rien n'apparaît dans l'arbre avant votre accord.")}</small>
                      </span>
                    </label>
                    <label className={`ts-choice ${contributionPolicy === 'direct' ? 'is-active' : ''}`}>
                      <input
                        type="radio"
                        name="contributionPolicy"
                        value="direct"
                        checked={contributionPolicy === 'direct'}
                        onChange={() => handlePolicyChange('direct')}
                      />
                      <span className="ts-choice-text">
                        <strong>{t("Les modifications s'appliquent tout de suite")}</strong>
                        <small>{t("La famille modifie l'arbre sans attendre. Vous gardez l'historique.")}</small>
                      </span>
                    </label>
                  </fieldset>
                </form>
              )}

              {section === 'data' && (
                <div className="ts-panel">
                  <div className="ts-row">
                    <div className="ts-row-text">
                      <strong>{t('Importer un fichier GEDCOM')}</strong>
                      <p className="pz-small">{t('Ajoute les personnes et les liens du fichier à cet arbre.')}</p>
                      {gedcomFile && <span className="pz-tag pz-tag--accent ts-file">{gedcomFile.name}</span>}
                    </div>
                    <div className="ts-row-actions">
                      <input
                        ref={gedcomInputRef}
                        className="ts-file-input"
                        type="file"
                        accept=".ged,text/x-gedcom,text/plain"
                        onChange={(event) => setGedcomFile(event.target.files?.[0] || null)}
                      />
                      <button type="button" className="pz-btn pz-btn--secondary pz-btn--sm" onClick={() => gedcomInputRef.current?.click()} disabled={saving}>
                        {t('Choisir un fichier')}
                      </button>
                      <button type="button" className="pz-btn pz-btn--primary pz-btn--sm" onClick={handleImportGedcom} disabled={saving || !gedcomFile}>
                        <PzBusy busy={importingGedcom} busyLabel={t('Import en cours')}>{t('Importer')}</PzBusy>
                      </button>
                    </div>
                  </div>

                  {onOpenPhotoStart && (
                    <div className="ts-row">
                      <div className="ts-row-text">
                        <strong>{t('Ajouter des portraits')}</strong>
                        <p className="pz-small">{t("Retrouver les photos de votre ancien logiciel, ou ajouter les premiers visages un par un.")}</p>
                      </div>
                      <div className="ts-row-actions">
                        <button type="button" className="pz-btn pz-btn--secondary pz-btn--sm" onClick={onOpenPhotoStart} disabled={saving}>
                          <ImagePlus size={15} aria-hidden="true" />
                          {t('Ajouter des portraits')}
                        </button>
                      </div>
                    </div>
                  )}

                  <div className="ts-row">
                    <div className="ts-row-text">
                      <strong>{t('Télécharger en GEDCOM')}</strong>
                      <p className="pz-small">{t("Le format standard, lisible par les autres logiciels d'arbre.")}</p>
                    </div>
                    <div className="ts-row-actions">
                      <button type="button" className="pz-btn pz-btn--secondary pz-btn--sm" onClick={handleExportGedcom} disabled={saving}>
                        <Download size={15} aria-hidden="true" />
                        {t('Télécharger .ged')}
                      </button>
                    </div>
                  </div>

                  <div className="ts-row ts-row--muted">
                    <div className="ts-row-text">
                      <strong>{t('Sauvegarde complète')}</strong>
                      <p className="pz-small">{t('Toutes les données et les médias. Bientôt disponible.')}</p>
                    </div>
                    <div className="ts-row-actions">
                      <button type="button" className="pz-btn pz-btn--secondary pz-btn--sm" disabled>
                        {t('Télécharger .zip')}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {section === 'immich' && (
                <div className="ts-panel">
                  <div className="ts-row">
                    <div className="ts-row-text">
                      <strong>{t('Reconnaissance des visages')}</strong>
                      <p className="pz-small">{t('La connexion Immich est propre à cet arbre : ses administrateurs choisissent une instance autorisée par l’opérateur du serveur et fournissent leur propre clé d’accès.')}</p>
                      <span className={`pz-tag ${immichConfig?.configured ? 'pz-tag--accent' : ''}`}>
                        {immichConfig === null
                          ? t('État inconnu')
                          : immichConfig.configured
                            ? t('Configurée')
                            : t('Non configurée')}
                      </span>
                      {immichConfig?.configured && (
                        <span className="pz-small">
                          {immichStatus === 'ok' && t('Instance joignable.')}
                          {immichStatus === 'testing' && t('Test en cours…')}
                          {immichStatus === 'not_configured' && t('Immich n’est pas configuré pour cet arbre.')}
                          {immichStatus === 'unreachable' && t('Immich est injoignable.')}
                          {immichStatus === 'error' && t('Test impossible.')}
                          {(immichStatus === null || immichStatus === undefined) && t('Connexion non testée depuis l’ouverture.')}
                        </span>
                      )}
                    </div>
                    {immichConfig?.configured && (
                      <div className="ts-row-actions">
                        <button type="button" className="pz-btn pz-btn--secondary pz-btn--sm" onClick={testImmichConnection} disabled={immichBusy}>
                          {t('Tester la connexion')}
                        </button>
                      </div>
                    )}
                  </div>

                  {immichAllowedUrls.length === 0 ? (
                    <p className="pz-small">
                      {immichConfig === null
                        ? t('État inconnu')
                        : t('Aucune instance Immich n’est autorisée par l’opérateur de ce serveur. La reconnaissance des visages reste désactivée.')}
                    </p>
                  ) : (
                  <form className="ts-panel" onSubmit={handleSaveImmichConfig}>
                    <div className="pz-field">
                      <label htmlFor="immichApiUrl">{t('Adresse de l’instance Immich')}</label>
                      <select
                        id="immichApiUrl"
                        value={immichApiUrl}
                        onChange={(event) => setImmichApiUrl(event.target.value)}
                        required
                      >
                        <option value="">{t('Choisir une instance…')}</option>
                        {immichAllowedUrls.map((url) => (
                          <option key={url} value={url}>{url}</option>
                        ))}
                      </select>
                    </div>

                    <div className="pz-field">
                      <label htmlFor="immichApiKey">{t('Clé d’accès Immich')}</label>
                      <input
                        id="immichApiKey"
                        type="password"
                        value={immichApiKey}
                        maxLength={512}
                        autoComplete="new-password"
                        onChange={(event) => setImmichApiKey(event.target.value)}
                        placeholder={immichConfig?.configured
                          ? (immichConfig.apiUrl && immichApiUrl !== immichConfig.apiUrl
                              ? t('Clé d’accès de la nouvelle instance requise')
                              : t('Laisser vide pour conserver la clé actuelle'))
                          : t('Clé créée dans Immich (Paramètres > Clés d’API)')}
                      />
                    </div>

                    <div className="ts-actions ts-row-actions">
                      <button type="submit" className="pz-btn pz-btn--primary pz-btn--sm" disabled={immichBusy}>
                        <PzBusy busy={immichBusy} busyLabel={t('Enregistrement en cours')}>{t('Enregistrer')}</PzBusy>
                      </button>
                      {immichConfig?.configured && (
                        <button type="button" className="pz-btn pz-btn--danger-ghost pz-btn--sm" onClick={handleRemoveImmichConfig} disabled={immichBusy}>
                          <Unplug size={15} aria-hidden="true" />
                          {t('Supprimer la connexion')}
                        </button>
                      )}
                    </div>
                  </form>
                  )}
                </div>
              )}

              {section === 'danger' && (
                <div className="ts-panel">
                  <div className="ts-danger">
                    <div className="ts-row-text">
                      <strong>{t('Supprimer cet arbre')}</strong>
                      <p className="pz-small">{t("Toutes les personnes, les souvenirs et les médias sont effacés, pour toute la famille. C'est définitif.")}</p>
                    </div>
                    <button type="button" className="pz-btn pz-btn--danger pz-btn--sm danger-action" onClick={() => setShowDeleteModal(true)}>
                      <Trash2 size={15} aria-hidden="true" />
                      {t('Supprimer cet arbre')}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {showDeleteModal && (
        <div className="pz-overlay ts-delete-overlay" onClick={(event) => { event.stopPropagation(); if (!saving) setShowDeleteModal(false) }}>
          <div className="pz-modal settings-delete-modal" role="dialog" aria-modal="true" aria-labelledby="treeDeleteTitle" onClick={(event) => event.stopPropagation()}>
            <div className="pz-modal-head">
              <p className="pz-eyebrow">{t('Dernière vérification')}</p>
              <h3 id="treeDeleteTitle" className="pz-title">{t('Supprimer « {name} »', { name: tree?.name ?? '' })}</h3>
              <p className="pz-sub">{t("Tapez le nom exact de l'arbre pour confirmer.")}</p>
            </div>
            <div className="pz-field">
              <label htmlFor="treeDeleteConfirm">{t("Nom de l'arbre")}</label>
              <input
                id="treeDeleteConfirm"
                type="text"
                value={deleteConfirmName}
                onChange={(event) => setDeleteConfirmName(event.target.value)}
                placeholder={tree?.name || ''}
                autoComplete="off"
              />
            </div>
            <div className="pz-modal-actions">
              <button type="button" className="pz-btn pz-btn--ghost" onClick={() => setShowDeleteModal(false)} disabled={saving}>
                {t('Annuler')}
              </button>
              <button type="button" className="pz-btn pz-btn--danger danger-action" onClick={handleDeleteTree} disabled={saving}>
                <PzBusy busy={saving} busyLabel={t('Suppression en cours')}>{t('Supprimer définitivement')}</PzBusy>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default AdminPanel
