import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { buildMediaUrl } from './utils/mediaToken.js'
import Galaxy from './components/Galaxy'
import PersonCard from './components/PersonCard.jsx'
import { FamilyWelcome, SouvenirPicker } from './components/FamilyOnboarding.jsx'
import { HELP_URL } from './utils/siteLinks.js'
import { hasSeenFamilyWelcome, markFamilyWelcomeSeen } from './utils/familyWelcome'
import MediaViewer from './components/MediaViewer'
import MediaManagerPanel from './components/MediaManagerPanel'
import AdminPanel from './components/AdminPanel'
import AccessGate from './components/AccessGate'
import AccountDashboard from './components/AccountDashboard'
import AccountPanel from './components/AccountPanel'
import TreeCreationWizard from './components/TreeCreationWizard'
import PhotoStartPanel from './components/PhotoStartPanel.jsx'
import ContributionPanel from './components/ContributionPanel'
import EditModeOverlay from './components/EditSessionBar.jsx'
import EditConfirmModal from './components/EditConfirmModal'
import DraftRestoreBanner from './components/DraftRestoreBanner'
import AddPersonPanel from './components/AddPersonPanel'
import ContributionSessionModal from './components/ContributionSessionModal'
import { ContextualNavbar } from './components/navbar'
import ZoomControl from './components/ZoomControl'
import { ExpandableSearch } from './components/search'
import { t, dateLocale } from './i18n/index.js'
import {
  createParentChildLink,
  deleteParentChildLink,
  deletePerson,
  deleteUnion,
  createPerson,
  createTree,
  createUnion,
  batchAnnotations,
  deletePersonAvatar,
  getTree,
  importGedcom,
  linkTreeAccess,
  updateTree,
  rotateTreePasswords,
  fetchSharePassword,
  rememberSharePassword,
  resolveTreeBySlug,
  uploadPersonAvatar,
  updatePerson,
  uploadAnnotationPhoto,
  reorderSiblings,
  uploadPersonMedia,
} from './api/treeApi'
import { getImmichErrorMessage, unassignImmichPerson } from './api/immichApi.js'
import { useAuth } from './hooks/useAuth'
import { useTreeAccess, getTreeTokenStorageKey, getSlugFromPathname, readTreeAccessRole, TREE_ID_FROM_ENV } from './hooks/useTreeAccess'
import { useMediaManager } from './hooks/useMediaManager'
import { useContributions } from './hooks/useContributions'
import { useUserRole } from './hooks/useUserRole'
import { usePersonSearch } from './hooks/usePersonSearch'
import { useEditMode } from './hooks/useEditMode'
import { useAnnotations } from './hooks/useAnnotations'
import AnnotationToolbar from './components/annotations/AnnotationToolbar'
import TextInputOverlay from './components/annotations/TextInputOverlay'
import { filiations, getChildren, getParents, getPersonUnions, medias, persons, unions } from './data/mockData'
import { readGedcomFile } from './utils/gedcomText'
import { loadMediaRefs, loadPhotoRefs, pickFirstFaces, prepareImageForUpload, saveMediaRefs, savePhotoRefs, sizeBucket } from './utils/photoImport'
import { fileToBase64, getAccountErrorMessage } from './utils/errorMessages'
import { getSiblingParentLinks } from './utils/familyLinks'
import { getUploadMimeType, inferMediaTypeFromMimeType, validateMediaFile } from './utils/mediaUpload'
import {
  getSource,
  identifyUser,
  resetUser,
  toInteractionMediaType,
  toJourneyRole,
  toOpaqueTreeId,
  trackAppEvent,
} from './utils/analytics'
import './App.css'
import './styles/pz.css'
import { setBooting } from './bootSignal.js'
import { saveContributorName } from './utils/contributorName'

function yearToIsoDate(value) {
  if (value === null || value === undefined || value === '') {
    return null
  }

  const raw = String(value).trim()

  // If user provided a full date YYYY-MM-DD, keep it.
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return raw
  }

  const year = Number.parseInt(raw.slice(0, 4), 10)
  if (!Number.isFinite(year)) {
    return null
  }

  return `${String(year).padStart(4, '0')}-01-01`
}

function extractYearFromIsoDate(value) {
  if (!value || typeof value !== 'string') return null
  const year = Number.parseInt(value.slice(0, 4), 10)
  return Number.isFinite(year) ? year : null
}

function normalizeSlug(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function generateSecurePassword() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/g, '')
  }
  // crypto.randomUUID n'est exposé qu'en contexte sécurisé (HTTPS ou localhost) :
  // sur du HTTP simple, getRandomValues reste disponible et donne le même UUID v4.
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function getAccountSelfPersonStorageKey(userEmail, treeId) {
  return `account_self_person_${userEmail || 'unknown'}_${treeId || 'none'}`
}

function buildContributionChangesFromDraft(draft = {}) {
  const changes = []
  const relationTypeToCanonical = (relation) => {
    if (!relation || !relation.sourcePersonId || !relation.targetPersonId) {
      return null
    }

    const sourcePersonId = String(relation.sourcePersonId)
    const targetPersonId = String(relation.targetPersonId)
    const relationType = String(relation.relationType || '')

    if (relationType === 'spouse') {
      const ordered = [sourcePersonId, targetPersonId].sort()
      return {
        relationType: 'spouse',
        sourcePersonId,
        targetPersonId,
        key: `spouse:${ordered[0]}:${ordered[1]}`,
      }
    }

    if (relationType === 'parent' || relationType === 'child') {
      const parentPersonId = relationType === 'parent' ? targetPersonId : sourcePersonId
      const childPersonId = relationType === 'parent' ? sourcePersonId : targetPersonId
      return {
        relationType: 'parent_child_link',
        parentPersonId,
        childPersonId,
        key: `parent_child:${parentPersonId}:${childPersonId}`,
      }
    }

    return null
  }

  const resolveRemovedRelationEntity = (canonicalRelation) => {
    if (!canonicalRelation) {
      return null
    }

    if (canonicalRelation.relationType === 'spouse') {
      const union = unions.find((candidate) => (
        (String(candidate.partner1Id) === canonicalRelation.sourcePersonId
          && String(candidate.partner2Id) === canonicalRelation.targetPersonId)
        || (String(candidate.partner1Id) === canonicalRelation.targetPersonId
          && String(candidate.partner2Id) === canonicalRelation.sourcePersonId)
      ))

      if (!union) {
        return null
      }

      return {
        entityType: 'union',
        action: 'delete',
        entityId: String(union.id),
      }
    }

    let link = filiations.find((candidate) => (
      String(candidate.childId) === canonicalRelation.childPersonId
      && String(candidate.parentId) === canonicalRelation.parentPersonId
    ))

    if (!link) {
      const relatedUnionIds = new Set(
        unions
          .filter((candidate) => (
            String(candidate.partner1Id) === canonicalRelation.parentPersonId
            || String(candidate.partner2Id) === canonicalRelation.parentPersonId
          ))
          .map((candidate) => String(candidate.id)),
      )

      link = filiations.find((candidate) => (
        String(candidate.childId) === canonicalRelation.childPersonId
        && candidate.unionId
        && relatedUnionIds.has(String(candidate.unionId))
      ))
    }

    if (!link) {
      return null
    }

    return {
      entityType: 'parent_child_link',
      action: 'delete',
      entityId: String(link.id),
    }
  }

  const addedPersons = Array.isArray(draft.addedPersons) ? draft.addedPersons : []
  for (const person of addedPersons) {
    if (!person || typeof person !== 'object') continue
    if (!person.firstName || !person.lastName) continue

    // Identifiant provisoire : le serveur le remplace par le vrai id pour créer les liens
    const ref = typeof person.ref === 'string' && person.ref.startsWith('tmp:') ? person.ref : null

    changes.push({
      entityType: 'person',
      action: 'create',
      after: {
        ...(ref ? { ref } : {}),
        firstName: String(person.firstName).trim(),
        lastName: String(person.lastName).trim(),
        birthName: person.birthName ? String(person.birthName).trim() : null,
        birthDate: person.birthDate || null,
        deathDate: person.deathDate || null,
      },
    })

    if (!ref) continue

    const linkedParentIds = new Set()
    for (const rel of Array.isArray(person.relations) ? person.relations : []) {
      if (!rel?.personId) continue
      const relatedId = String(rel.personId)
      if (rel.type === 'child') {
        linkedParentIds.add(relatedId)
        changes.push({ entityType: 'parent_child_link', action: 'create', after: { parentPersonId: relatedId, childPersonId: ref, parentageType: 'biologique' } })
      } else if (rel.type === 'parent') {
        changes.push({ entityType: 'parent_child_link', action: 'create', after: { parentPersonId: ref, childPersonId: relatedId, parentageType: 'biologique' } })
      } else if (rel.type === 'spouse') {
        changes.push({ entityType: 'union', action: 'create', after: { partner1PersonId: relatedId, partner2PersonId: ref, unionType: 'mariage' } })
      }
    }

    for (const link of Array.isArray(person.siblingParentLinks) ? person.siblingParentLinks : []) {
      if (!link?.parentId || linkedParentIds.has(String(link.parentId))) continue
      linkedParentIds.add(String(link.parentId))
      changes.push({
        entityType: 'parent_child_link',
        action: 'create',
        after: { parentPersonId: String(link.parentId), childPersonId: ref, viaUnionId: link.unionId || null, parentageType: 'biologique' },
      })
    }
  }

  const modifiedPersons = draft.modifiedPersons && typeof draft.modifiedPersons === 'object'
    ? draft.modifiedPersons
    : {}

  for (const [personId, rawChanges] of Object.entries(modifiedPersons)) {
    const source = rawChanges && typeof rawChanges === 'object' ? rawChanges : {}
    const after = {}

    if (Object.prototype.hasOwnProperty.call(source, 'firstName')) after.firstName = source.firstName || ''
    if (Object.prototype.hasOwnProperty.call(source, 'lastName')) after.lastName = source.lastName || ''
    if (Object.prototype.hasOwnProperty.call(source, 'birthName')) after.birthName = (source.birthName || '').trim() || null
    if (Object.prototype.hasOwnProperty.call(source, 'birthYear')) after.birthDate = yearToIsoDate(source.birthYear)
    if (Object.prototype.hasOwnProperty.call(source, 'deathYear')) after.deathDate = yearToIsoDate(source.deathYear)
    if (Object.prototype.hasOwnProperty.call(source, 'birthPlace')) after.birthPlace = (source.birthPlace || '').trim() || null
    if (Object.prototype.hasOwnProperty.call(source, 'profession')) after.profession = (source.profession || '').trim() || null
    if (Object.prototype.hasOwnProperty.call(source, 'region')) after.region = (source.region || '').trim() || null
    if (Object.prototype.hasOwnProperty.call(source, 'nationality')) after.nationality = (source.nationality || '').trim() || null
    if (Object.prototype.hasOwnProperty.call(source, 'note')) after.notes = source.note || null
    if (Object.prototype.hasOwnProperty.call(source, 'isAlive') && source.isAlive === true) after.deathDate = null

    if (Object.keys(after).length > 0) {
      changes.push({
        entityType: 'person',
        action: 'update',
        entityId: personId,
        after,
      })
    }
  }

  const deletedPersons = Array.isArray(draft.deletedPersons) ? draft.deletedPersons : []
  for (const personId of deletedPersons) {
    if (!personId) continue
    changes.push({
      entityType: 'person',
      action: 'delete',
      entityId: String(personId),
    })
  }

  const addedRelations = Array.isArray(draft.addedRelations) ? draft.addedRelations : []
  const removedRelations = Array.isArray(draft.removedRelations) ? draft.removedRelations : []
  const canonicalAddedRelations = []
  const canonicalRemovedRelations = []
  const addedRelationKeys = new Set()
  const removedRelationKeys = new Set()

  for (const relation of addedRelations) {
    const canonicalRelation = relationTypeToCanonical(relation)
    if (!canonicalRelation || addedRelationKeys.has(canonicalRelation.key)) continue
    canonicalAddedRelations.push(canonicalRelation)
    addedRelationKeys.add(canonicalRelation.key)
  }

  for (const relation of removedRelations) {
    const canonicalRelation = relationTypeToCanonical(relation)
    if (!canonicalRelation || removedRelationKeys.has(canonicalRelation.key)) continue
    canonicalRemovedRelations.push(canonicalRelation)
    removedRelationKeys.add(canonicalRelation.key)
  }

  const canceledRelationKeys = new Set(
    [...addedRelationKeys].filter((key) => removedRelationKeys.has(key)),
  )

  for (const canonicalRelation of canonicalAddedRelations) {
    if (canceledRelationKeys.has(canonicalRelation.key)) continue

    if (canonicalRelation.relationType === 'spouse') {
      changes.push({
        entityType: 'union',
        action: 'create',
        after: {
          partner1PersonId: canonicalRelation.sourcePersonId,
          partner2PersonId: canonicalRelation.targetPersonId,
          unionType: 'mariage',
        },
      })
    } else if (canonicalRelation.relationType === 'parent_child_link') {
      changes.push({
        entityType: 'parent_child_link',
        action: 'create',
        after: {
          parentPersonId: canonicalRelation.parentPersonId,
          childPersonId: canonicalRelation.childPersonId,
          parentageType: 'biologique',
        },
      })
    }
  }

  for (const relation of canonicalRemovedRelations) {
    if (canceledRelationKeys.has(relation.key)) continue
    const change = resolveRemovedRelationEntity(relation)
    if (!change) continue
    changes.push(change)
  }

  // Annotations (stickers, dessins, textes, photos canvas)
  const annData = Array.isArray(draft.annotationsData) ? draft.annotationsData : []
  const addedAnnIds = new Set(Array.isArray(draft.addedAnnotations) ? draft.addedAnnotations : [])
  const modifiedAnnIds = new Set(Array.isArray(draft.modifiedAnnotations) ? draft.modifiedAnnotations : [])
  const deletedAnnIds = Array.isArray(draft.deletedAnnotations) ? draft.deletedAnnotations : []

  for (const ann of annData) {
    const isAdded = addedAnnIds.has(ann.id)
    const isModified = modifiedAnnIds.has(ann.id)
    if (!isAdded && !isModified) continue
    const action = isAdded ? 'create' : 'update'
    const change = {
      entityType: 'annotation',
      action,
      after: {
        type: ann.type,
        x: ann.x,
        y: ann.y,
        content: ann.content,
        style: ann.style || {},
        zIndex: ann.zIndex || 0,
      },
    }
    if (action === 'update') change.entityId = String(ann.id)
    changes.push(change)
  }

  for (const annId of deletedAnnIds) {
    changes.push({ entityType: 'annotation', action: 'delete', entityId: String(annId) })
  }

  return changes
}

function buildContribChangesList(draft = {}) {
  const items = []
  const addedPersonEntries = Array.isArray(draft.addedPersons) ? draft.addedPersons : []
  const addedPersonIds = addedPersonEntries.filter((entry) => typeof entry !== 'object').map(String)

  for (const entry of addedPersonEntries) {
    const d = entry && typeof entry === 'object' ? entry : (draft.modifiedPersons?.[String(entry)] || {})
    const name = `${d.firstName || ''} ${d.lastName || ''}`.trim() || t('Nouvelle personne')
    items.push({ entityType: 'person', action: 'create', label: name })
  }

  for (const [id, d] of Object.entries(draft.modifiedPersons || {})) {
    if (addedPersonIds.includes(String(id))) continue
    const name = `${d.firstName || ''} ${d.lastName || ''}`.trim() || t('Personne')
    items.push({ entityType: 'person', action: 'update', label: name })
  }

  for (let i = 0; i < (draft.deletedPersons || []).length; i++) {
    items.push({ entityType: 'person', action: 'delete', label: t('Personne') })
  }

  const annData = Array.isArray(draft.annotationsData) ? draft.annotationsData : []
  const addedAnnIds = new Set(Array.isArray(draft.addedAnnotations) ? draft.addedAnnotations : [])
  const modifiedAnnIds = new Set(Array.isArray(draft.modifiedAnnotations) ? draft.modifiedAnnotations : [])
  const deletedAnnCount = (Array.isArray(draft.deletedAnnotations) ? draft.deletedAnnotations : []).length
  const annTypeLabel = (type) => ({ sticker: t('Sticker'), drawing: t('Dessin'), text: t('Texte'), photo: t('Photo') }[type] || t('Annotation'))

  for (const ann of annData) {
    if (addedAnnIds.has(ann.id)) items.push({ entityType: 'annotation', action: 'create', label: annTypeLabel(ann.type) })
    else if (modifiedAnnIds.has(ann.id)) items.push({ entityType: 'annotation', action: 'update', label: annTypeLabel(ann.type) })
  }
  for (let i = 0; i < deletedAnnCount; i++) {
    items.push({ entityType: 'annotation', action: 'delete', label: t('Annotation') })
  }

  for (let i = 0; i < (draft.addedRelations || []).length; i++) {
    items.push({ entityType: 'relation', action: 'create', label: t('Relation') })
  }
  for (let i = 0; i < (draft.removedRelations || []).length; i++) {
    items.push({ entityType: 'relation', action: 'delete', label: t('Relation') })
  }

  return items
}

function App() {
  const auth = useAuth()
  const tree = useTreeAccess()
  useEffect(() => { setBooting(tree.bootState === 'loading') }, [tree.bootState])
  // Arbre partagé d'où l'on vient quand on ouvre l'écran compte : on y revient après connexion/création
  const pendingSharedTreeRef = useRef(null)
  // Son nom, affiché par l'écran compte : un ref lu au rendu ne redessine rien quand il change
  const [pendingSharedTreeName, setPendingSharedTreeName] = useState('')
  // Écran de compte ouvert depuis un arbre affiché : la croix y ramène
  const [accountFromTree, setAccountFromTree] = useState(false)
  const refreshTreeAndKeepSelection = useCallback(async (personId, options = {}) => {
    await tree.refreshCurrentTreeGraph({
      relayout: options.relayout !== false,
      avatarCacheBust: options.avatarCacheBust,
      rootPersonIdFromServer: options.rootPersonIdFromServer === true,
    })
    if (personId !== null && personId !== undefined) {
      const refreshedPerson = persons.find((candidate) => String(candidate.id) === String(personId)) || null
      tree.setSelectedPerson(refreshedPerson)
    }
  }, [tree.refreshCurrentTreeGraph, tree.setSelectedPerson]) // eslint-disable-line react-hooks/exhaustive-deps

  const media = useMediaManager({
    canEditCurrentTree: tree.canEditCurrentTree,
    canSubmitContribution: tree.canSubmitContribution,
    selectedPerson: tree.selectedPerson,
    treeContext: tree.treeContext,
    refreshCurrentTreeGraph: tree.refreshCurrentTreeGraph,
    refreshTreeAndKeepSelection,
  })
  const contrib = useContributions({
    canEditCurrentTree: tree.canEditCurrentTree,
    canSubmitContribution: tree.canSubmitContribution,
    treeContext: tree.treeContext,
    refreshCurrentTreeGraph: tree.refreshCurrentTreeGraph,
  })

  const [adminPanelVisible, setAdminPanelVisible] = useState(false)
  // Premiers visages : fenêtre ouverte après un import GEDCOM, ou depuis les paramètres de l'arbre
  const [photoStart, setPhotoStart] = useState({ visible: false, personsImported: null, refs: [], mediaRefs: [], faces: [] })
  const photoStartDirtyRef = useRef(false)
  const [showConfirmModal, setShowConfirmModal] = useState(false)
  const [showDraftBanner, setShowDraftBanner] = useState(false)
  const [accountPanelVisible, setAccountPanelVisible] = useState(false)
  const [linkedSelfPersonId, setLinkedSelfPersonId] = useState('')
  const [relationFeedback, setRelationFeedback] = useState({
    loading: false,
    success: '',
    error: '',
  })
  const [avatarActionState, setAvatarActionState] = useState({
    loading: false,
    error: '',
  })
  const [treeNotFound, setTreeNotFound] = useState(false)
  const [accountEntryMode, setAccountEntryMode] = useState('login')
  const [treeWizardVisible, setTreeWizardVisible] = useState(false)
  const [treeWizardLoading, setTreeWizardLoading] = useState(false)
  const [treeWelcomeVisible, setTreeWelcomeVisible] = useState(false)
  const [treeImportError, setTreeImportError] = useState('')
  const [contribInviteState, setContribInviteState] = useState({
    shareUrl: '',
    knownPasswords: {
      share: '',
    },
    loading: false,
    error: '',
    message: '',
  })

  const buildEmptyTreeContext = useCallback((overrides = {}) => ({
    treeId: '',
    treeName: '',
    treeDescription: '',
    treeOwnerName: '',
    treeOwnerEmail: '',
    role: '',
    accessMode: '',
    rootPersonId: null,
    accessToken: '',
    ...overrides,
  }), [])

  // Déterminer le rôle et permissions de l'utilisateur
  const userRole = useUserRole({
    treeContext: tree.treeContext,
    authenticated: auth.authenticated,
  })

  // Famille arrivée par le lien (mot de passe de partage, avec ou sans compte)
  const isFamilyVisitor = userRole.navbarType === 'contributor_anon' || userRole.navbarType === 'contributor_auth'
  const [familyWelcomeVisible, setFamilyWelcomeVisible] = useState(false)
  const [souvenirPickerVisible, setSouvenirPickerVisible] = useState(false)
  const [pendingMediaPersonId, setPendingMediaPersonId] = useState(null)

  useEffect(() => {
    if (isFamilyVisitor && tree.bootState === 'ready' && !hasSeenFamilyWelcome(tree.treeContext.treeId)) {
      setFamilyWelcomeVisible(true)
    }
  }, [isFamilyVisitor, tree.bootState, tree.treeContext.treeId])

  // La personne choisie dans « Pour qui ? » est sélectionnée : ouvrir ses souvenirs
  useEffect(() => {
    if (pendingMediaPersonId == null) return
    if (String(tree.selectedPerson?.id) !== String(pendingMediaPersonId)) return
    setPendingMediaPersonId(null)
    media.handleOpenMediaManager()
  }, [pendingMediaPersonId, tree.selectedPerson]) // eslint-disable-line react-hooks/exhaustive-deps

  const closeFamilyWelcome = useCallback(() => {
    markFamilyWelcomeSeen(tree.treeContext.treeId)
    setFamilyWelcomeVisible(false)
  }, [tree.treeContext.treeId])

  const accountUser = auth.userAuth.user || null
  const linkedSelfPerson = useMemo(() => (
    persons.find((candidate) => String(candidate.id) === String(linkedSelfPersonId)) || null
  ), [linkedSelfPersonId, tree.graphRevision, tree.treeContext.treeId])

  // Les visages à demander en premier : la famille proche de « Moi » (ou de la personne de départ),
  // sinon les générations les plus récentes
  const computeFirstFaces = useCallback(() => pickFirstFaces({
    persons,
    selfId: linkedSelfPersonId || tree.treeContext.rootPersonId || null,
    getParents,
    getChildren,
    getPartners: (id) => getPersonUnions(id)
      .map((union) => (union.partner1Id === id ? union.partner2Id : union.partner1Id))
      .map((partnerId) => persons.find((person) => person.id === partnerId))
      .filter(Boolean),
  }), [linkedSelfPersonId, tree.treeContext.rootPersonId])

  const openPhotoStart = useCallback(({ personsImported = null, refs = null, mediaRefs = null, treeId = null } = {}) => {
    photoStartDirtyRef.current = false
    setPhotoStart({
      visible: true,
      personsImported,
      refs: refs ?? loadPhotoRefs(treeId || tree.treeContext.treeId),
      mediaRefs: mediaRefs ?? loadMediaRefs(treeId || tree.treeContext.treeId),
      faces: computeFirstFaces(),
    })
  }, [computeFirstFaces, tree.treeContext.treeId])


  const accountDisplayName = useMemo(() => {
    if (linkedSelfPerson) {
      const fullName = `${linkedSelfPerson.firstName || ''} ${linkedSelfPerson.lastName || ''}`.trim()
      if (fullName) {
        return fullName
      }
    }

    const firstName = accountUser?.firstName || accountUser?.name || ''
    if (firstName && String(firstName).trim()) {
      return String(firstName).trim()
    }

    const email = accountUser?.email || ''
    if (!email) {
      return t('Compte')
    }

    return String(email).split('@')[0] || t('Compte')
  }, [accountUser?.email, accountUser?.firstName, accountUser?.name, linkedSelfPerson])

  const accountEmail = accountUser?.email || ''
  const accountAvatarPhoto = linkedSelfPerson?.photo || ''
  const activeAccountTreeName = useMemo(() => {
    const activeTree = auth.accountTrees.find(
      (candidate) => String(candidate.id) === String(tree.treeContext.treeId),
    )
    return activeTree?.name || tree.treeContext.treeName || ''
  }, [auth.accountTrees, tree.treeContext.treeId, tree.treeContext.treeName])

  const isDemoMode = tree.treeContext.accessMode === 'demo'
  const canEditInCurrentMode = tree.canSubmitContribution || isDemoMode

  // Recherche de personnes avec scoring
  const search = usePersonSearch(persons)

  // Mode édition avec auto-save
  const editMode = useEditMode({
    treeId: tree.treeContext.treeId,
    canEdit: canEditInCurrentMode,
  })

  const localEntityCounterRef = useRef(0)
  const makeLocalId = useCallback((prefix) => {
    localEntityCounterRef.current += 1
    return `${prefix}-${Date.now().toString(36)}-${localEntityCounterRef.current}`
  }, [])
  const shareSessionStartedAtRef = useRef(0)
  const shareSessionTimeSentRef = useRef(false)

  const journeyRole = useMemo(
    () => toJourneyRole(tree.treeContext.role),
    [tree.treeContext.role],
  )
  const opaqueTreeId = useMemo(
    () => toOpaqueTreeId(tree.treeContext.treeId),
    [tree.treeContext.treeId],
  )
  const isTrackableShareSession = Boolean(
    tree.bootState === 'ready'
    && tree.treeContext.accessMode === 'share'
    && tree.treeContext.treeId
    && journeyRole,
  )

  const captureTreeTimeSpent = useCallback(() => {
    if (!isTrackableShareSession || shareSessionTimeSentRef.current) return
    if (!shareSessionStartedAtRef.current) return

    const elapsedSeconds = Math.max(1, Math.round((Date.now() - shareSessionStartedAtRef.current) / 1000))
    trackAppEvent('tree_time_spent', {
      seconds: elapsedSeconds,
      role: journeyRole,
      tree_id: opaqueTreeId,
    })
    shareSessionTimeSentRef.current = true
  }, [isTrackableShareSession, journeyRole, opaqueTreeId])

  useEffect(() => {
    if (!isTrackableShareSession) {
      shareSessionStartedAtRef.current = 0
      shareSessionTimeSentRef.current = false
      return
    }

    shareSessionStartedAtRef.current = Date.now()
    shareSessionTimeSentRef.current = false
    trackAppEvent('tree_viewed', {
      role: journeyRole,
      tree_id: opaqueTreeId,
    })

    const fiveMinutesTimeout = window.setTimeout(() => {
      captureTreeTimeSpent()
    }, 5 * 60 * 1000)

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        captureTreeTimeSpent()
      }
    }
    const handlePageHide = () => {
      captureTreeTimeSpent()
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('pagehide', handlePageHide)

    return () => {
      window.clearTimeout(fiveMinutesTimeout)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('pagehide', handlePageHide)
      captureTreeTimeSpent()
    }
  }, [captureTreeTimeSpent, isTrackableShareSession, journeyRole, opaqueTreeId])

  const trackTreeInteraction = useCallback((mediaType) => {
    if (!isTrackableShareSession) return
    trackAppEvent('tree_interaction', {
      role: journeyRole,
      media_type: mediaType,
      tree_id: opaqueTreeId,
    })
  }, [isTrackableShareSession, journeyRole, opaqueTreeId])

  // Identifiant technique du compte, jamais l'adresse email (engagement de la page Données et vie privée).
  // Remise à zéro seulement à la déconnexion : la faire à chaque ouverture anonyme effaçait le visiteur
  // de la landing (cookie partagé sur .parenthese.io, démo en iframe) et coupait le funnel.
  const wasAuthenticatedRef = useRef(false)
  useEffect(() => {
    if (auth.authenticated && auth.userAuth.user?.id) {
      wasAuthenticatedRef.current = true
      identifyUser(auth.userAuth.user.id)
      return
    }

    if (wasAuthenticatedRef.current) {
      wasAuthenticatedRef.current = false
      resetUser()
    }
  }, [auth.authenticated, auth.userAuth.user?.id])

  // Démo : une ouverture par chargement, puis une interaction de chaque type (sans aucun contenu de l'arbre).
  // Ne compte que les visiteurs sans compte, la démo sert aussi de fond après une inscription.
  const demoOpenedRef = useRef(false)
  const demoInteractionsRef = useRef(new Set())
  useEffect(() => {
    if (!isDemoMode || tree.bootState !== 'ready' || auth.authenticated || demoOpenedRef.current) return
    demoOpenedRef.current = true
    const query = new URLSearchParams(window.location.search)
    trackAppEvent('demo_opened', { embed: query.has('embed'), source: getSource() })
  }, [isDemoMode, tree.bootState, auth.authenticated])

  const trackDemoInteraction = useCallback((type) => {
    if (!isDemoMode || auth.authenticated || demoInteractionsRef.current.has(type)) return
    demoInteractionsRef.current.add(type)
    trackAppEvent('demo_interaction', { type, embed: new URLSearchParams(window.location.search).has('embed') })
  }, [isDemoMode, auth.authenticated])

  useEffect(() => {
    const treeId = tree.treeContext.treeId
    if (!treeId || !accountEmail) {
      setLinkedSelfPersonId('')
      return
    }

    try {
      const saved = localStorage.getItem(getAccountSelfPersonStorageKey(accountEmail, treeId)) || ''
      setLinkedSelfPersonId(saved)
    } catch {
      setLinkedSelfPersonId('')
    }
  }, [accountEmail, tree.treeContext.treeId])

  useEffect(() => {
    if (!linkedSelfPersonId || !tree.treeContext.treeId || !accountEmail) {
      return
    }

    const exists = persons.some((candidate) => String(candidate.id) === String(linkedSelfPersonId))
    if (!exists) {
      setLinkedSelfPersonId('')
      try {
        localStorage.removeItem(getAccountSelfPersonStorageKey(accountEmail, tree.treeContext.treeId))
      } catch {
        // Ignore storage failures
      }
    }
  }, [accountEmail, linkedSelfPersonId, tree.graphRevision, tree.treeContext.treeId])

  // Annotations canvas (dessin, stickers, texte)
  const annot = useAnnotations({
    editModeActive: editMode.isActive,
    updateDraft: editMode.updateDraft,
  })

  const handlePersonSelect = useCallback((personLike) => {
    const personId = personLike && typeof personLike === 'object' ? personLike.id : personLike
    if (personId === null || personId === undefined) {
      tree.setSelectedPerson(null)
      return
    }

    const freshPerson = persons.find((candidate) => String(candidate.id) === String(personId)) || personLike || null
    tree.setSelectedPerson(freshPerson)
    trackTreeInteraction('text')
    trackDemoInteraction('person')
  }, [tree.setSelectedPerson, trackTreeInteraction, trackDemoInteraction]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleMediaSelectFresh = useCallback((media, personLike) => {
    const personId = personLike && typeof personLike === 'object' ? personLike.id : personLike
    const freshPerson = personId !== null && personId !== undefined
      ? persons.find((candidate) => String(candidate.id) === String(personId)) || personLike || null
      : personLike || null

    tree.handleMediaSelect(media, freshPerson)
    trackTreeInteraction(toInteractionMediaType(media?.type))
    trackDemoInteraction('media')
  }, [tree.handleMediaSelect, trackTreeInteraction, trackDemoInteraction]) // eslint-disable-line react-hooks/exhaustive-deps

  // Ref that Galaxy fills with a pointer to its transformRef (for computing view center)
  const galaxyTransformReadRef = useRef(null)
  // Ref exposant l'API zoom de Galaxy au ZoomControl
  const galaxyZoomApiRef = useRef(null)

  // Called by AnnotationToolbar when user picks a photo file for canvas annotation
  const handleAnnotationPhotoFile = useCallback(async (file) => {
    const treeId = tree.treeContext.treeId
    const token = tree.treeContext.accessToken || auth.userAuth.token
    if (!treeId || !token || !file) return

    try {
      const dataBase64 = await fileToBase64(file)
      const result = await uploadAnnotationPhoto(
        treeId,
        {
          fileName: file.name || 'photo.jpg',
          mimeType: file.type || 'image/jpeg',
          sizeBytes: file.size,
          dataBase64,
        },
        token,
      )

      // Compute world-space view center so the photo appears in the middle of the screen
      const view = galaxyTransformReadRef.current?.current || { x: 0, y: 0, scale: 1 }
      const worldX = (window.innerWidth / 2 - view.x) / view.scale
      const worldY = (window.innerHeight / 2 - view.y) / view.scale

      // Get natural dimensions from the file
      const img = new Image()
      img.onload = () => {
        // Adresse d'affichage avec le jeton médias ; le serveur n'enregistre que photoPath
        const fullUrl = buildMediaUrl(result.photoPath, import.meta.env.VITE_API_BASE_URL || '/api')
        annot.placePhoto(worldX, worldY, result.photoPath, fullUrl, img.naturalWidth, img.naturalHeight)
        URL.revokeObjectURL(img.src)
      }
      img.onerror = () => URL.revokeObjectURL(img.src)
      img.src = URL.createObjectURL(file)
    } catch {
      // silent — user can retry
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree.treeContext.treeId, tree.treeContext.accessToken, auth.userAuth.token])

  // Afficher le banner de restauration si un draft existe au mount
  useEffect(() => {
    if (editMode.hasDraft && !editMode.isActive) {
      setShowDraftBanner(true)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Toggle édition avec confirmation si draft en cours
  const handleEditToggle = useCallback(() => {
    if (editMode.isActive && editMode.hasDraft) {
      setShowConfirmModal(true)
    } else {
      if (!editMode.isActive) trackDemoInteraction('edit')
      editMode.toggle()
    }
  }, [editMode.isActive, editMode.hasDraft, editMode.toggle, trackDemoInteraction]) // eslint-disable-line react-hooks/exhaustive-deps

  // Actions de la modal de confirmation
  const handleConfirmContinue = useCallback(() => {
    setShowConfirmModal(false)
  }, [])

  const handleConfirmSaveAndQuit = useCallback(() => {
    editMode.saveDraft()
    editMode.deactivate()
    setShowConfirmModal(false)
  }, [editMode.saveDraft, editMode.deactivate]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleConfirmDiscard = useCallback(() => {
    editMode.clearDraft()
    editMode.deactivate()
    setShowConfirmModal(false)
  }, [editMode.clearDraft, editMode.deactivate]) // eslint-disable-line react-hooks/exhaustive-deps

  // Actions du banner de restauration
  const handleDraftRestore = useCallback(() => {
    editMode.activate()
    setShowDraftBanner(false)
  }, [editMode.activate]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleDraftDiscard = useCallback(() => {
    editMode.clearDraft()
    setShowDraftBanner(false)
  }, [editMode.clearDraft]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!relationFeedback.success) return undefined

    const timeout = setTimeout(() => {
      setRelationFeedback((current) => ({ ...current, success: '' }))
    }, 2500)

    return () => clearTimeout(timeout)
  }, [relationFeedback.success])

  useEffect(() => {
    setAvatarActionState({ loading: false, error: '' })
  }, [tree.selectedPerson?.id])

  // Panneau ajout personne
  const [addPersonPanelVisible, setAddPersonPanelVisible] = useState(false)
  // Quitter le mode édition ferme le panneau d'ajout (sinon il réapparaît au retour, vide)
  useEffect(() => {
    if (!editMode.isActive) setAddPersonPanelVisible(false)
  }, [editMode.isActive])
  const [addPersonLoading, setAddPersonLoading] = useState(false)
  const [addPersonError, setAddPersonError] = useState('')

  const handleOpenAddPerson = useCallback(() => {
    setAddPersonError('')
    // Le panneau d'ajout vit dans le mode édition : la famille y entre sans passer par le crayon
    if (!editMode.isActive) editMode.activate()
    setAddPersonPanelVisible(true)
  }, [editMode.isActive, editMode.activate]) // eslint-disable-line react-hooks/exhaustive-deps

  // « Ajouter un souvenir » : choisir la personne, puis ouvrir ses souvenirs
  const handleOpenSouvenirPicker = useCallback(() => {
    markFamilyWelcomeSeen(tree.treeContext.treeId)
    setFamilyWelcomeVisible(false)
    setSouvenirPickerVisible(true)
  }, [tree.treeContext.treeId])

  const handleSouvenirPick = useCallback((person) => {
    setSouvenirPickerVisible(false)
    tree.setSelectedPerson(person)
    setPendingMediaPersonId(person.id)
  }, [tree.setSelectedPerson]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleSouvenirPickerAddPerson = useCallback(() => {
    setSouvenirPickerVisible(false)
    handleOpenAddPerson()
  }, [handleOpenAddPerson])

  const handleCloseAddPerson = useCallback(() => {
    setAddPersonPanelVisible(false)
    setAddPersonError('')
  }, [])

  const handleAddPersonSubmit = useCallback(async (formData) => {
    if (!tree.treeContext.treeId && !isDemoMode) return

    setAddPersonLoading(true)
    setAddPersonError('')

    try {
      // Un frère ou une sœur reçoit les mêmes parents que la personne choisie :
      // sans parent connu, on s'arrête avant de créer quoi que ce soit.
      const siblingParentLinks = []
      if (Array.isArray(formData.relations)) {
        for (const rel of formData.relations) {
          if (rel.type !== 'sibling') continue
          const links = getSiblingParentLinks(rel.personId, filiations, unions)
          if (links.length === 0) {
            const sibling = persons.find((person) => String(person.id) === String(rel.personId))
            const siblingName = [sibling?.firstName, sibling?.lastName].filter(Boolean).join(' ')
            setAddPersonError(siblingName
              ? t("Ajoutez d'abord un parent à {name} pour pouvoir lui rattacher un frère ou une sœur.", { name: siblingName })
              : t("Ajoutez d'abord un parent à cette personne pour pouvoir lui rattacher un frère ou une sœur."))
            return
          }
          siblingParentLinks.push(...links)
        }
      }

      if (!tree.canEditCurrentTree) {
        if (isDemoMode) {
          const personId = makeLocalId('local-person')
          const birthYear = extractYearFromIsoDate(formData.birthDate)
          const deathYear = extractYearFromIsoDate(formData.deathDate)
          const newPerson = {
            id: personId,
            firstName: formData.firstName,
            lastName: formData.lastName || '',
            birthName: formData.birthName || null,
            birthDate: formData.birthDate || null,
            deathDate: formData.deathDate || null,
            birthYear,
            deathYear,
            isAlive: !deathYear,
            photo: null,
            frameType: 'round',
          }

          persons.push(newPerson)

          for (const rel of formData.relations) {
            if (rel.type === 'spouse') {
              const existsUnion = unions.some((union) => (
                (String(union.partner1Id) === String(rel.personId) && String(union.partner2Id) === String(personId))
                || (String(union.partner1Id) === String(personId) && String(union.partner2Id) === String(rel.personId))
              ))
              if (!existsUnion) {
                unions.push({
                  id: makeLocalId('local-union'),
                  partner1Id: rel.personId,
                  partner2Id: personId,
                  unionType: 'mariage',
                  startYear: null,
                  endYear: null,
                  displayOrder: unions.length + 1,
                })
              }
            } else if (rel.type === 'parent') {
              filiations.push({
                id: makeLocalId('local-filiation'),
                childId: rel.personId,
                parentId: personId,
                unionId: null,
                parentageType: 'biologique',
                displayOrder: filiations.length + 1,
              })
            } else if (rel.type === 'child') {
              filiations.push({
                id: makeLocalId('local-filiation'),
                childId: personId,
                parentId: rel.personId,
                unionId: null,
                parentageType: 'biologique',
                displayOrder: filiations.length + 1,
              })
            }
          }

          for (const link of siblingParentLinks) {
            const alreadyLinked = filiations.some((filiation) => (
              String(filiation.childId) === String(personId)
              && (link.unionId
                ? String(filiation.unionId) === link.unionId
                : String(filiation.parentId) === link.parentId)
            ))
            if (alreadyLinked) continue
            filiations.push({
              id: makeLocalId('local-filiation'),
              childId: personId,
              parentId: link.unionId ? null : link.parentId,
              unionId: link.unionId,
              parentageType: 'biologique',
              displayOrder: filiations.length + 1,
            })
          }

          tree.bumpGraphRevision()
          tree.setSelectedPerson({ ...newPerson })
        }

        const draft = editMode.restoreDraft()
        const addedPersons = [
          ...(draft.addedPersons || []),
          {
            ref: `tmp:${makeLocalId('personne')}`,
            firstName: formData.firstName,
            lastName: formData.lastName,
            birthName: formData.birthName || null,
            birthDate: formData.birthDate || null,
            deathDate: formData.deathDate || null,
            relations: (formData.relations || []).map((rel) => ({ type: rel.type, personId: rel.personId })),
            siblingParentLinks,
          },
        ]
        editMode.updateDraft({ addedPersons })
        // La personne n'apparaît dans l'arbre qu'après envoi : on passe tout de suite à l'envoi
        // (prénom, un mot), la famille n'a pas à chercher le bouton
        setAddPersonPanelVisible(false)
        setDraftNotice(t('{name} est dans vos modifications. Envoyez-les quand vous avez fini.', { name: formData.firstName }))
        setContribSubmitError('')
        setContribChanges(buildContribChangesList(editMode.restoreDraft()))
        setShowContribModal(true)
        return
      }

      if (!auth.userAuth.token) return

      const newPerson = await createPerson(
        tree.treeContext.treeId,
        {
          firstName: formData.firstName,
          lastName: formData.lastName,
          birthName: formData.birthName,
          birthDate: formData.birthDate,
          deathDate: formData.deathDate,
        },
        auth.userAuth.token
      )

      // Créer les liens de relation
      const linkedParentIds = new Set()
      for (const rel of formData.relations) {
        if (rel.type === 'child') {
          linkedParentIds.add(String(rel.personId))
          await createParentChildLink(
            tree.treeContext.treeId,
            { parentPersonId: rel.personId, childPersonId: newPerson.id, parentageType: 'biologique', displayOrder: 1 },
            auth.userAuth.token
          )
        } else if (rel.type === 'parent') {
          await createParentChildLink(
            tree.treeContext.treeId,
            { parentPersonId: newPerson.id, childPersonId: rel.personId, parentageType: 'biologique', displayOrder: 1 },
            auth.userAuth.token
          )
        } else if (rel.type === 'spouse') {
          await createUnion(
            tree.treeContext.treeId,
            { partner1PersonId: rel.personId, partner2PersonId: newPerson.id, unionType: 'mariage', displayOrder: 1 },
            auth.userAuth.token
          )
        }
      }

      for (const link of siblingParentLinks) {
        if (linkedParentIds.has(link.parentId)) continue
        linkedParentIds.add(link.parentId)
        await createParentChildLink(
          tree.treeContext.treeId,
          {
            parentPersonId: link.parentId,
            childPersonId: newPerson.id,
            viaUnionId: link.unionId,
            parentageType: 'biologique',
            displayOrder: 1,
          },
          auth.userAuth.token
        )
      }

      // Mettre à jour le draft avec la nouvelle personne
      editMode.updateDraft({
        addedPersons: [...(editMode.restoreDraft().addedPersons || []), newPerson.id],
      })

      await tree.refreshCurrentTreeGraph()
    } catch (err) {
      setAddPersonError(err.message || t("Erreur lors de l'ajout de la personne"))
    } finally {
      setAddPersonLoading(false)
    }
  }, [auth.userAuth.token, tree.canEditCurrentTree, tree.treeContext.treeId, isDemoMode, makeLocalId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Modal session contribution (contributeurs)
  const [showContribModal, setShowContribModal] = useState(false)
  const [contribChanges, setContribChanges] = useState([])
  const [contribSubmitLoading, setContribSubmitLoading] = useState(false)
  const [contribSubmitError, setContribSubmitError] = useState('')
  const [contribSuccess, setContribSuccess] = useState(false)
  const [draftNotice, setDraftNotice] = useState('')

  // Ordre d'une fratrie (glisser dans l'arbre ou flèches de la fiche) : appliqué tout de suite, enregistré ensuite.
  // L'arbre a déjà glissé à la nouvelle place ; en cas d'échec il revient en arrière et on le dit.
  const [siblingOrderRevision, setSiblingOrderRevision] = useState(0)
  const handleReorderSiblings = useCallback(async (order) => {
    const previous = new Map()
    order.forEach((entry, index) => {
      for (const filiation of filiations) {
        if (!entry.linkIds.includes(String(filiation.id))) continue
        previous.set(filiation, filiation.displayOrder)
        filiation.displayOrder = index + 1
      }
    })
    setSiblingOrderRevision((current) => current + 1)
    if (isDemoMode) return
    try {
      await reorderSiblings(tree.treeContext.treeId, order, tree.treeContext.accessToken || auth.userAuth.token)
    } catch (error) {
      for (const [filiation, value] of previous) filiation.displayOrder = value
      setSiblingOrderRevision((current) => current + 1)
      setDraftNotice(t("L'ordre n'a pas pu être enregistré. Réessayez."))
      throw error
    }
  }, [isDemoMode, tree.treeContext.treeId, tree.treeContext.accessToken, auth.userAuth.token])

  const canReorderSiblings = editMode.isActive && (tree.canEditCurrentTree || isDemoMode)
  const [siblingPlace, setSiblingPlace] = useState(null)
  useEffect(() => {
    const personId = tree.selectedPerson?.id
    setSiblingPlace(personId != null && canReorderSiblings ? galaxyZoomApiRef.current?.getSiblingPlace?.(personId) ?? null : null)
  }, [tree.selectedPerson?.id, canReorderSiblings, siblingOrderRevision, tree.graphRevision])

  // Mode d'affichage de l'arbre : 'descendance' (arbre entier) ou 'ascendance' (ancêtres de la
  // personne racine). ?layout=rooted force l'ascendance ; sinon le choix mémorisé sur l'appareil
  // gagne (convention de persistance pz-*, comme la langue).
  const [viewMode, setViewMode] = useState(() => {
    if (typeof window === 'undefined') return 'descendance'
    const fromUrl = new URLSearchParams(window.location.search).get('layout')
    if (fromUrl === 'rooted') return 'ascendance'
    try {
      const stored = window.localStorage.getItem('pz-view-mode')
      if (stored === 'ascendance' || stored === 'descendance') return stored
    } catch { /* stockage indisponible : mode par défaut */ }
    return 'descendance'
  })
  // Racine de session du mode ascendance (bouton « Voir l'ascendance de cette personne »)
  const [ascendanceRootId, setAscendanceRootId] = useState(null)
  const handleViewModeChange = useCallback((mode) => {
    setViewMode(mode)
    try { window.localStorage.setItem('pz-view-mode', mode) } catch { /* stockage indisponible */ }
    trackAppEvent('view_mode_changed', { mode })
  }, [])
  const handleShowAscendance = useCallback((personId) => {
    setAscendanceRootId(personId ?? null)
  }, [])
  // La racine de session est propre à l'arbre ouvert
  useEffect(() => { setAscendanceRootId(null) }, [tree.treeContext.treeId])
  useEffect(() => {
    if (!draftNotice) return undefined
    const timer = setTimeout(() => setDraftNotice(''), 4500)
    return () => clearTimeout(timer)
  }, [draftNotice])

  // Soumission des modifications
  const handleEditSubmit = useCallback(async () => {
    if (isDemoMode) {
      // Démo: édition locale uniquement, jamais de persistance serveur.
      editMode.saveDraft()
      editMode.deactivate()
      setContribSubmitError('')
      setShowContribModal(false)
      return
    }

    if (userRole.isAdmin) {
      const token = auth.userAuth.token
      const treeId = tree.treeContext.treeId
      const draft = editMode.restoreDraft()

      if (token && treeId) {
        // Appliquer les modifications de personnes depuis le draft
        const modifiedPersons = draft.modifiedPersons || {}
        for (const [personId, rawChanges] of Object.entries(modifiedPersons)) {
          const payload = {}
          if (Object.prototype.hasOwnProperty.call(rawChanges, 'firstName')) payload.firstName = rawChanges.firstName || ''
          if (Object.prototype.hasOwnProperty.call(rawChanges, 'lastName')) payload.lastName = rawChanges.lastName || ''
          if (Object.prototype.hasOwnProperty.call(rawChanges, 'birthName')) payload.birthName = (rawChanges.birthName || '').trim() || null
          if (Object.prototype.hasOwnProperty.call(rawChanges, 'birthYear')) payload.birthDate = yearToIsoDate(rawChanges.birthYear)
          if (Object.prototype.hasOwnProperty.call(rawChanges, 'deathYear')) payload.deathDate = yearToIsoDate(rawChanges.deathYear)
          if (Object.prototype.hasOwnProperty.call(rawChanges, 'birthPlace')) payload.birthPlace = (rawChanges.birthPlace || '').trim() || null
          if (Object.prototype.hasOwnProperty.call(rawChanges, 'profession')) payload.profession = (rawChanges.profession || '').trim() || null
          if (Object.prototype.hasOwnProperty.call(rawChanges, 'region')) payload.region = (rawChanges.region || '').trim() || null
          if (Object.prototype.hasOwnProperty.call(rawChanges, 'nationality')) payload.nationality = (rawChanges.nationality || '').trim() || null
          if (Object.prototype.hasOwnProperty.call(rawChanges, 'isAlive') && rawChanges.isAlive === true) payload.deathDate = null
          if (Object.prototype.hasOwnProperty.call(rawChanges, 'note')) payload.notes = rawChanges.note || null

          if (Object.keys(payload).length > 0) {
            try {
              await updatePerson(treeId, personId, payload, token)
            } catch (err) {
              console.error('Failed to update person:', personId, err)
            }
          }
        }

        // Appliquer les annotations
        const addedAnnIds = new Set(draft.addedAnnotations || [])
        const modifiedAnnIds = new Set(draft.modifiedAnnotations || [])
        const deletedAnnIds = draft.deletedAnnotations || []
        const annData = draft.annotationsData || []

        const batchPayload = {
          create: annData
            .filter((a) => addedAnnIds.has(a.id))
            .map((a) => ({
              type: a.type,
              x: a.x,
              y: a.y,
              content: a.content,
              style: a.style || {},
              zIndex: a.zIndex || 0,
            })),
          update: annData
            .filter((a) => modifiedAnnIds.has(a.id))
            .map((a) => ({
              id: a.id,
              x: a.x,
              y: a.y,
              content: a.content,
              style: a.style || {},
              zIndex: a.zIndex || 0,
            })),
          delete: deletedAnnIds,
        }

        const hasAnnotationChanges = batchPayload.create.length > 0 || batchPayload.update.length > 0 || batchPayload.delete.length > 0

        if (hasAnnotationChanges) {
          try {
            await batchAnnotations(treeId, batchPayload, token)
          } catch (err) {
            console.error('Failed to submit annotations:', err)
          }
        }
      }

      await tree.refreshCurrentTreeGraph({ relayout: false })
      editMode.clearDraft()
      editMode.deactivate()
    } else {
      // Contributeur → ouvrir modal session nommée
      setContribSubmitError('')
      setContribChanges(buildContribChangesList(editMode.restoreDraft()))
      setShowContribModal(true)
    }
  }, [userRole.isAdmin, auth.userAuth.token, tree.treeContext.treeId, isDemoMode]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleContribSessionSubmit = useCallback(async ({ comment, name }) => {
    setContribSubmitLoading(true)
    setContribSubmitError('')

    try {
      const draft = editMode.restoreDraft()
      const changes = buildContributionChangesFromDraft(draft)

      if (changes.length === 0) {
        setContribSubmitError(t('Aucune modification à soumettre.'))
        return
      }

      const now = new Date()
      const dateStr = now.toLocaleDateString(dateLocale, { day: '2-digit', month: '2-digit', year: 'numeric' })
      const contributorName = (name || auth.userAuth.user?.name || '').trim()
      if (name) saveContributorName(name)
      const title = (contributorName
        ? t('Contribution de {name} · {date}', { name: contributorName, date: dateStr })
        : t('Contribution de la famille · {date}', { date: dateStr })).slice(0, 120)

      const result = await contrib.handleSubmitContributionSession({
        title,
        comment: comment || null,
        ...(contributorName ? { submittedByLabel: contributorName } : {}),
        changes,
      })

      if (!result?.ok) {
        setContribSubmitError(result?.error || t("Erreur lors de l'envoi des contributions"))
        return
      }

      editMode.clearDraft()
      editMode.deactivate()
      setShowContribModal(false)
      setContribSubmitError('')
      setContribSuccess(true)
      setDraftNotice('')
      setTimeout(() => setContribSuccess(false), 6000)
    } catch (err) {
      setContribSubmitError(err.message || t("Erreur lors de l'envoi des contributions"))
    } finally {
      setContribSubmitLoading(false)
    }
  }, [contrib, editMode, auth.userAuth.user]) // eslint-disable-line react-hooks/exhaustive-deps

  const resolveContributionShareUrl = useCallback(async () => {
    const slugFromPath = getSlugFromPathname()
    if (slugFromPath) {
      setContribInviteState((current) => ({
        ...current,
        shareUrl: `${window.location.origin}/arbre/${encodeURIComponent(slugFromPath)}`,
      }))
      return
    }

    if (!tree.treeContext.treeId) {
      setContribInviteState((current) => ({ ...current, shareUrl: '' }))
      return
    }

    const accessToken = tree.treeContext.accessToken || auth.userAuth.token
    if (!accessToken) {
      setContribInviteState((current) => ({ ...current, shareUrl: '' }))
      return
    }

    try {
      const result = await getTree(tree.treeContext.treeId, accessToken)
      const slug = result?.tree?.slug || ''
      setContribInviteState((current) => ({
        ...current,
        shareUrl: slug ? `${window.location.origin}/arbre/${encodeURIComponent(slug)}` : '',
      }))
    } catch {
      setContribInviteState((current) => ({ ...current, shareUrl: '' }))
    }
  }, [auth.userAuth.token, tree.treeContext.accessToken, tree.treeContext.treeId])

  const handleOpenContributionPanel = useCallback(async () => {
    const treeId = tree.treeContext.treeId
    await resolveContributionShareUrl()
    let share = ''
    const accessToken = auth.userAuth.token || tree.treeContext.accessToken
    if (treeId && accessToken && tree.canEditCurrentTree) {
      try {
        share = (await fetchSharePassword(treeId, accessToken))?.share || ''
      } catch {
        share = ''
      }
    }
    setContribInviteState((current) => ({
      ...current,
      knownPasswords: { share },
      error: '',
      message: '',
    }))
    await contrib.handleOpenContributionPanel()
  }, [contrib, resolveContributionShareUrl, tree.treeContext.treeId, tree.canEditCurrentTree, tree.treeContext.accessToken, auth.userAuth.token]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleContributionPasswordRemember = useCallback(async ({ password }) => {
    const accessToken = auth.userAuth.token || tree.treeContext.accessToken
    if (!tree.treeContext.treeId || !accessToken) {
      return { ok: false, error: t('Session invalide.') }
    }

    setContribInviteState((current) => ({ ...current, loading: true, error: '', message: '' }))
    try {
      const result = await rememberSharePassword(tree.treeContext.treeId, String(password || '').trim(), accessToken)
      setContribInviteState((current) => ({
        ...current,
        knownPasswords: { share: result?.share || '' },
        loading: false,
        error: '',
        message: t("C'est bien lui. Rien ne change pour la famille."),
      }))
      return { ok: true }
    } catch (error) {
      const message = error?.status === 422
        ? t("Ce n'est pas le mot de passe actuel de l'arbre.")
        : getAccountErrorMessage(error)
      setContribInviteState((current) => ({ ...current, loading: false, error: message, message: '' }))
      return { ok: false, error: message }
    }
  }, [auth.userAuth.token, tree.treeContext.accessToken, tree.treeContext.treeId])

  const handleContributionPasswordRotate = useCallback(async ({ password }) => {
    if (!tree.treeContext.treeId) {
      return { ok: false, error: t('Arbre introuvable.') }
    }

    const accessToken = tree.treeContext.accessToken || auth.userAuth.token
    if (!accessToken) {
      return { ok: false, error: t('Session invalide.') }
    }

    const nextPassword = String(password || '').trim()
    if (nextPassword.length < 8) {
      return { ok: false, error: t('Minimum 8 caractères.') }
    }

    if (nextPassword === contribInviteState.knownPasswords.share) {
      setContribInviteState((current) => ({
        ...current,
        loading: false,
        error: '',
        message: t("C'est déjà le mot de passe actuel."),
      }))
      return { ok: true }
    }

    const payload = { password: nextPassword }

    setContribInviteState((current) => ({
      ...current,
      loading: true,
      error: '',
      message: '',
    }))

    try {
      await rotateTreePasswords(tree.treeContext.treeId, payload, accessToken)
      const storedPasswords = { share: nextPassword }

      setContribInviteState((current) => ({
        ...current,
        knownPasswords: storedPasswords,
        loading: false,
        error: '',
        message: t('Mot de passe changé. Envoyez le nouveau à la famille.'),
      }))
      return { ok: true }
    } catch (error) {
      const message = getAccountErrorMessage(error)
      setContribInviteState((current) => ({
        ...current,
        loading: false,
        error: message,
        message: '',
      }))
      return { ok: false, error: message }
    }
  }, [auth.userAuth.token, contribInviteState.knownPasswords.share, tree.treeContext.accessToken, tree.treeContext.treeId])

  // Sauvegarde modification personne (mode édition)
  // Admin → appel API direct et immédiat.
  // Contributeur/membre → mise dans le draft local, soumis ensuite pour approbation.
  const handlePersonSave = useCallback(async (personId, changes) => {
    if (!tree.canEditCurrentTree) {
      // Mode contribution : accumuler dans le draft local
      const draft = editMode.restoreDraft()
      const modifiedPersons = draft.modifiedPersons || {}
      modifiedPersons[personId] = { ...modifiedPersons[personId], ...changes }
      editMode.updateDraft({ modifiedPersons })

      const localPerson = persons.find((candidate) => String(candidate.id) === String(personId))
      if (localPerson) {
        if (Object.prototype.hasOwnProperty.call(changes, 'firstName')) localPerson.firstName = changes.firstName || ''
        if (Object.prototype.hasOwnProperty.call(changes, 'lastName')) localPerson.lastName = changes.lastName || ''
        if (Object.prototype.hasOwnProperty.call(changes, 'birthName')) localPerson.birthName = changes.birthName || null
        if (Object.prototype.hasOwnProperty.call(changes, 'birthYear')) {
          const iso = yearToIsoDate(changes.birthYear)
          localPerson.birthDate = iso
          localPerson.birthYear = iso ? Number(iso.slice(0, 4)) : null
        }
        if (Object.prototype.hasOwnProperty.call(changes, 'deathYear')) {
          const iso = yearToIsoDate(changes.deathYear)
          localPerson.deathDate = iso
          localPerson.deathYear = iso ? Number(iso.slice(0, 4)) : null
        }
        if (Object.prototype.hasOwnProperty.call(changes, 'birthPlace')) localPerson.birthPlace = changes.birthPlace || null
        if (Object.prototype.hasOwnProperty.call(changes, 'profession')) localPerson.profession = changes.profession || null
        if (Object.prototype.hasOwnProperty.call(changes, 'region')) localPerson.region = changes.region || null
        if (Object.prototype.hasOwnProperty.call(changes, 'nationality')) localPerson.nationality = changes.nationality || null
        if (Object.prototype.hasOwnProperty.call(changes, 'note')) localPerson.note = changes.note || null
        if (Object.prototype.hasOwnProperty.call(changes, 'isAlive') && changes.isAlive === true) {
          localPerson.deathYear = null
        }
        tree.setSelectedPerson({ ...localPerson })
      }
      return
    }

    // Admin : appliquer directement via l'API
    const accessToken = tree.treeContext.accessToken || auth.userAuth.token
    if (!accessToken || !tree.treeContext.treeId) return

    const payload = {}
    if (Object.prototype.hasOwnProperty.call(changes, 'firstName')) payload.firstName = changes.firstName || ''
    if (Object.prototype.hasOwnProperty.call(changes, 'lastName')) payload.lastName = changes.lastName || ''
    if (Object.prototype.hasOwnProperty.call(changes, 'birthName')) payload.birthName = (changes.birthName || '').trim() || null
    if (Object.prototype.hasOwnProperty.call(changes, 'birthYear')) payload.birthDate = yearToIsoDate(changes.birthYear)
    if (Object.prototype.hasOwnProperty.call(changes, 'deathYear')) payload.deathDate = yearToIsoDate(changes.deathYear)
    if (Object.prototype.hasOwnProperty.call(changes, 'birthPlace')) payload.birthPlace = (changes.birthPlace || '').trim() || null
    if (Object.prototype.hasOwnProperty.call(changes, 'profession')) payload.profession = (changes.profession || '').trim() || null
    if (Object.prototype.hasOwnProperty.call(changes, 'region')) payload.region = (changes.region || '').trim() || null
    if (Object.prototype.hasOwnProperty.call(changes, 'nationality')) payload.nationality = (changes.nationality || '').trim() || null
    if (Object.prototype.hasOwnProperty.call(changes, 'isAlive') && changes.isAlive === true) payload.deathDate = null
    if (Object.prototype.hasOwnProperty.call(changes, 'note')) payload.notes = changes.note || null

    if (Object.keys(payload).length > 0) {
      await updatePerson(tree.treeContext.treeId, personId, payload, accessToken)
    }

    await refreshTreeAndKeepSelection(personId, { relayout: false, avatarCacheBust: Date.now() })
  }, [auth.userAuth.token, tree.canEditCurrentTree, tree.treeContext.accessToken, tree.treeContext.treeId, refreshTreeAndKeepSelection]) // eslint-disable-line react-hooks/exhaustive-deps

  const handlePersonAvatarUpload = useCallback(async (personId, file) => {
    const accessToken = tree.treeContext.accessToken || auth.userAuth.token
    if (!accessToken || !tree.treeContext.treeId) return

    setAvatarActionState({ loading: true, error: '' })
    const prepared = await prepareImageForUpload(file)
    const validationError = validateMediaFile(prepared, 'photo')
    if (validationError) {
      setAvatarActionState({ loading: false, error: validationError })
      return
    }

    try {
      const dataBase64 = await fileToBase64(prepared)
      await uploadPersonAvatar(
        tree.treeContext.treeId,
        personId,
        {
          fileName: prepared.name || 'avatar.jpg',
          mimeType: getUploadMimeType(prepared, 'photo'),
          sizeBytes: prepared.size,
          dataBase64,
        },
        accessToken,
      )
      trackAppEvent('portrait_added', { via: 'card' })
      await refreshTreeAndKeepSelection(personId, { relayout: true })
      setAvatarActionState({ loading: false, error: '' })
    } catch (error) {
      setAvatarActionState({ loading: false, error: getAccountErrorMessage(error) })
    }
  }, [auth.userAuth.token, tree.treeContext.accessToken, tree.treeContext.treeId, refreshTreeAndKeepSelection])

  // Visage venu d'Immich : recharger l'arbre pour montrer le nouveau portrait (ou le portrait restant)
  const handleImmichChange = useCallback(async (personId) => {
    await refreshTreeAndKeepSelection(personId, { relayout: false, avatarCacheBust: Date.now() })
  }, [refreshTreeAndKeepSelection])

  const handlePersonAvatarDelete = useCallback(async (personId, avatarFromImmich = false) => {
    const accessToken = tree.treeContext.accessToken || auth.userAuth.token
    if (!accessToken || !tree.treeContext.treeId) return

    setAvatarActionState({ loading: true, error: '' })

    try {
      // Portrait venu d'Immich : le désassignement retire le portrait et l'association d'un
      // coup ; la suppression seule laisserait une association pendante en base.
      if (avatarFromImmich) {
        await unassignImmichPerson(tree.treeContext.treeId, personId, accessToken)
        await refreshTreeAndKeepSelection(personId, { relayout: false, avatarCacheBust: Date.now() })
      } else {
        await deletePersonAvatar(tree.treeContext.treeId, personId, accessToken)
        await refreshTreeAndKeepSelection(personId, { relayout: true })
      }
      setAvatarActionState({ loading: false, error: '' })
    } catch (error) {
      setAvatarActionState({
        loading: false,
        error: avatarFromImmich ? getImmichErrorMessage(error, t) : getAccountErrorMessage(error),
      })
    }
  }, [auth.userAuth.token, tree.treeContext.accessToken, tree.treeContext.treeId, refreshTreeAndKeepSelection])

  // Suppression personne (mode édition, admin)
  const handlePersonDelete = useCallback(async (personId) => {
    if (!tree.treeContext.treeId && !isDemoMode) return

    if (isDemoMode) {
      for (let idx = persons.length - 1; idx >= 0; idx -= 1) {
        if (String(persons[idx].id) === String(personId)) {
          persons.splice(idx, 1)
        }
      }

      const removedUnionIds = new Set()
      for (let idx = unions.length - 1; idx >= 0; idx -= 1) {
        const union = unions[idx]
        if (
          String(union.partner1Id) === String(personId)
          || String(union.partner2Id) === String(personId)
        ) {
          removedUnionIds.add(union.id)
          unions.splice(idx, 1)
        }
      }

      for (let idx = filiations.length - 1; idx >= 0; idx -= 1) {
        const filiation = filiations[idx]
        const touchesPerson = (
          String(filiation.childId) === String(personId)
          || String(filiation.parentId) === String(personId)
        )
        const touchesRemovedUnion = filiation.unionId && removedUnionIds.has(filiation.unionId)
        if (touchesPerson || touchesRemovedUnion) {
          filiations.splice(idx, 1)
        }
      }

      for (let idx = medias.length - 1; idx >= 0; idx -= 1) {
        if (String(medias[idx].personId) === String(personId)) {
          medias.splice(idx, 1)
        }
      }

      tree.setSelectedPerson(null)
      tree.bumpGraphRevision()
      return
    }

    if (tree.canEditCurrentTree) {
      const accessToken = tree.treeContext.accessToken || auth.userAuth.token
      if (!accessToken) return

      await deletePerson(tree.treeContext.treeId, personId, accessToken)
      await refreshTreeAndKeepSelection(null, { relayout: true })
      tree.setSelectedPerson(null)
      return
    }

    // Mettre a jour le draft
    const draft = editMode.restoreDraft()
    const deletedPersons = [...(draft.deletedPersons || []), personId]
    editMode.updateDraft({ deletedPersons })

    tree.setSelectedPerson(null)
  }, [auth.userAuth.token, refreshTreeAndKeepSelection, tree.canEditCurrentTree, tree.treeContext.accessToken, tree.treeContext.treeId, isDemoMode]) // eslint-disable-line react-hooks/exhaustive-deps

  // Ajout d'une relation (mode édition)
  const handleAddRelation = useCallback(async (sourcePersonId, targetPersonId, relationType) => {
    if (isDemoMode) {
      let relationAdded = false

      if (relationType === 'spouse') {
        const existsUnion = unions.some((candidate) => (
          (String(candidate.partner1Id) === String(sourcePersonId) && String(candidate.partner2Id) === String(targetPersonId))
          || (String(candidate.partner1Id) === String(targetPersonId) && String(candidate.partner2Id) === String(sourcePersonId))
        ))

        if (!existsUnion) {
          unions.push({
            id: makeLocalId('local-union'),
            partner1Id: sourcePersonId,
            partner2Id: targetPersonId,
            unionType: 'mariage',
            startYear: null,
            endYear: null,
            displayOrder: unions.length + 1,
          })
          relationAdded = true
        }
      } else {
        const childId = relationType === 'parent' ? sourcePersonId : targetPersonId
        const parentId = relationType === 'parent' ? targetPersonId : sourcePersonId
        const existsLink = filiations.some((candidate) => (
          String(candidate.childId) === String(childId)
          && String(candidate.parentId) === String(parentId)
        ))

        if (!existsLink) {
          filiations.push({
            id: makeLocalId('local-filiation'),
            childId,
            parentId,
            unionId: null,
            parentageType: 'biologique',
            displayOrder: filiations.length + 1,
          })
          relationAdded = true
        }
      }

      if (!relationAdded) {
        setRelationFeedback({ loading: false, success: '', error: t('Lien déjà présent') })
        return
      }

      const draft = editMode.restoreDraft()
      const addedRelations = [...(draft.addedRelations || []), { sourcePersonId, targetPersonId, relationType }]
      editMode.updateDraft({ addedRelations })
      tree.bumpGraphRevision()
      setRelationFeedback({ loading: false, success: t('Lien familial ajouté (démo locale)'), error: '' })
      return
    }

    if (!tree.canEditCurrentTree) {
      const draft = editMode.restoreDraft()
      const addedRelations = [...(draft.addedRelations || []), { sourcePersonId, targetPersonId, relationType }]
      editMode.updateDraft({ addedRelations })
      setRelationFeedback({ loading: false, success: t('Lien ajouté à la contribution'), error: '' })
      return
    }

    const accessToken = tree.treeContext.accessToken || auth.userAuth.token
    if (!accessToken || !tree.treeContext.treeId) return

    setRelationFeedback({ loading: true, success: '', error: '' })

    try {
      if (relationType === 'parent') {
        // sourcePersonId est l'enfant, targetPersonId est le parent
        await createParentChildLink(
          tree.treeContext.treeId,
          { parentPersonId: targetPersonId, childPersonId: sourcePersonId, parentageType: 'biologique', displayOrder: 1 },
          accessToken
        )
      } else if (relationType === 'child') {
        // sourcePersonId est le parent, targetPersonId est l'enfant
        await createParentChildLink(
          tree.treeContext.treeId,
          { parentPersonId: sourcePersonId, childPersonId: targetPersonId, parentageType: 'biologique', displayOrder: 1 },
          accessToken
        )
      } else if (relationType === 'spouse') {
        await createUnion(
          tree.treeContext.treeId,
          { partner1PersonId: sourcePersonId, partner2PersonId: targetPersonId, unionType: 'mariage', displayOrder: 1 },
          accessToken
        )
      }

      // Mettre à jour le draft
      const draft = editMode.restoreDraft()
      const addedRelations = [...(draft.addedRelations || []), { sourcePersonId, targetPersonId, relationType }]
      editMode.updateDraft({ addedRelations })

      await refreshTreeAndKeepSelection(sourcePersonId, { relayout: true })
      setRelationFeedback({ loading: false, success: t('Lien familial ajouté'), error: '' })
    } catch (err) {
      setRelationFeedback({ loading: false, success: '', error: getAccountErrorMessage(err) })
      console.error('Failed to add relation:', err)
    }
  }, [auth.userAuth.token, tree.canEditCurrentTree, tree.treeContext.accessToken, tree.treeContext.treeId, refreshTreeAndKeepSelection, isDemoMode, makeLocalId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Suppression d'une relation (mode édition)
  const handleRemoveRelation = useCallback(async (sourcePersonId, targetPersonId, relationType) => {
    if (isDemoMode) {
      let relationRemoved = false

      if (relationType === 'spouse') {
        for (let idx = unions.length - 1; idx >= 0; idx -= 1) {
          const union = unions[idx]
          if (
            (String(union.partner1Id) === String(sourcePersonId) && String(union.partner2Id) === String(targetPersonId))
            || (String(union.partner1Id) === String(targetPersonId) && String(union.partner2Id) === String(sourcePersonId))
          ) {
            const removedUnionId = union.id
            unions.splice(idx, 1)
            for (let fIdx = filiations.length - 1; fIdx >= 0; fIdx -= 1) {
              if (filiations[fIdx].unionId && String(filiations[fIdx].unionId) === String(removedUnionId)) {
                filiations.splice(fIdx, 1)
              }
            }
            relationRemoved = true
            break
          }
        }
      } else {
        const childId = relationType === 'parent' ? sourcePersonId : targetPersonId
        const parentId = relationType === 'parent' ? targetPersonId : sourcePersonId
        for (let idx = filiations.length - 1; idx >= 0; idx -= 1) {
          const filiation = filiations[idx]
          if (
            String(filiation.childId) === String(childId)
            && String(filiation.parentId) === String(parentId)
          ) {
            filiations.splice(idx, 1)
            relationRemoved = true
          }
        }
      }

      if (!relationRemoved) {
        setRelationFeedback({ loading: false, success: '', error: t('Relation introuvable pour suppression') })
        return
      }

      const draft = editMode.restoreDraft()
      const removedRelations = [...(draft.removedRelations || []), { sourcePersonId, targetPersonId, relationType }]
      editMode.updateDraft({ removedRelations })
      tree.bumpGraphRevision()
      setRelationFeedback({ loading: false, success: t('Lien familial supprimé (démo locale)'), error: '' })
      return
    }

    if (!tree.canEditCurrentTree) {
      const draft = editMode.restoreDraft()
      const removedRelations = [...(draft.removedRelations || []), { sourcePersonId, targetPersonId, relationType }]
      editMode.updateDraft({ removedRelations })
      setRelationFeedback({ loading: false, success: t('Suppression de lien ajoutée à la contribution'), error: '' })
      return
    }

    const accessToken = tree.treeContext.accessToken || auth.userAuth.token
    if (!accessToken || !tree.treeContext.treeId) return

    setRelationFeedback({ loading: true, success: '', error: '' })

    try {
      let relationRemoved = false

      if (relationType === 'spouse') {
        const union = unions.find((candidate) => (
          (String(candidate.partner1Id) === String(sourcePersonId) && String(candidate.partner2Id) === String(targetPersonId)) ||
          (String(candidate.partner1Id) === String(targetPersonId) && String(candidate.partner2Id) === String(sourcePersonId))
        ))

        if (union) {
          await deleteUnion(tree.treeContext.treeId, union.id, accessToken)
          relationRemoved = true
        }
      } else {
        const childId = relationType === 'parent' ? sourcePersonId : targetPersonId
        const parentId = relationType === 'parent' ? targetPersonId : sourcePersonId

        let link = filiations.find((candidate) => (
          String(candidate.childId) === String(childId) &&
          String(candidate.parentId) === String(parentId)
        ))

        if (!link) {
          const relatedUnionIds = new Set(
            unions
              .filter((candidate) => (
                String(candidate.partner1Id) === String(parentId) ||
                String(candidate.partner2Id) === String(parentId)
              ))
              .map((candidate) => candidate.id),
          )

          link = filiations.find((candidate) => (
            String(candidate.childId) === String(childId) &&
            candidate.unionId &&
            relatedUnionIds.has(candidate.unionId)
          ))
        }

        if (link) {
          await deleteParentChildLink(tree.treeContext.treeId, link.id, accessToken)
          relationRemoved = true
        }
      }

      if (!relationRemoved) {
        setRelationFeedback({ loading: false, success: '', error: t('Relation introuvable pour suppression') })
        return
      }

      const draft = editMode.restoreDraft()
      const removedRelations = [...(draft.removedRelations || []), { sourcePersonId, targetPersonId, relationType }]
      editMode.updateDraft({ removedRelations })

      await refreshTreeAndKeepSelection(sourcePersonId, { relayout: true })
      setRelationFeedback({ loading: false, success: t('Lien familial supprimé'), error: '' })
    } catch (err) {
      setRelationFeedback({ loading: false, success: '', error: getAccountErrorMessage(err) })
      console.error('Failed to remove relation:', err)
    }
  }, [auth.userAuth.token, tree.canEditCurrentTree, tree.treeContext.accessToken, tree.treeContext.treeId, refreshTreeAndKeepSelection, isDemoMode]) // eslint-disable-line react-hooks/exhaustive-deps

  // Raccourcis clavier : Ctrl+E (toggle), Ctrl+S (save), ESC (quit)
  useEffect(() => {
    function handleKeyDown(e) {
      // Ignorer si focus dans un input/textarea
      const tag = document.activeElement?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return

      if (e.ctrlKey && e.key === 'e') {
        e.preventDefault()
        handleEditToggle()
      } else if (e.ctrlKey && e.key === 's') {
        if (editMode.isActive) {
          e.preventDefault()
          editMode.saveDraft()
        }
      } else if (e.key === 'Escape') {
        if (annot.selectedAnnotationId) {
          annot.selectAnnotation(null)
        } else if (editMode.isActive) {
          handleEditToggle()
        }
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (editMode.isActive && annot.selectedAnnotationId) {
          e.preventDefault()
          annot.deleteSelectedAnnotation()
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }) // re-bind chaque render pour capter isActive/hasDraft à jour

  useEffect(() => {
    if (!tree.canEditCurrentTree) {
      setAdminPanelVisible(false)
    }
    if (!canEditInCurrentMode) {
      editMode.deactivate()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree.canEditCurrentTree, canEditInCurrentMode])

  const openAccountTree = useCallback(async (entry, token, options = {}) => {
    const accessMode = entry?.accessMode || 'member'
    const role = entry?.role || (accessMode === 'share' ? 'contributor' : 'member')

    await tree.openTreeGraph(entry.id, token, {
      treeName: entry?.name || '',
      treeDescription: entry?.description || '',
      treeOwnerName: entry?.ownerName || '',
      treeOwnerEmail: entry?.ownerEmail || '',
      role,
      accessMode,
      promptWizard: Boolean(options.promptWizard),
    })

    auth.persistLastOpenedTree({
      treeId: entry.id,
      accessMode,
    })
  }, [auth.persistLastOpenedTree, tree.openTreeGraph])

  // Bootstrap
  useEffect(() => {
    let active = true

    const bootstrap = async () => {
      const query = new URLSearchParams(window.location.search)

      // Explicit demo modes (landing iframe / forced demo)
      if (query.has('embed') || query.has('demo')) {
        tree.handleUseDemo()
        return
      }

      const slug = getSlugFromPathname()
      let resolvedTreeId = TREE_ID_FROM_ENV
      let resolvedTreeName = ''
      let resolvedTreeDescription = ''
      const resolvedTreeOwnerName = ''
      const resolvedTreeOwnerEmail = ''

      // Root app:
      // - not connected => demo by default
      // - connected => continue bootstrap to open the user's tree
      if (!slug && !TREE_ID_FROM_ENV && !query.has('account')) {
        const userToken = auth.restoreUserToken()
        if (!userToken) {
          tree.handleUseDemo()
          return
        }
      }

      setTreeNotFound(false)

      if (slug) {
        try {
          const treeInfo = await resolveTreeBySlug(slug)
          resolvedTreeId = treeInfo.id
          resolvedTreeName = treeInfo.name || ''
          resolvedTreeDescription = treeInfo.description || ''
        } catch (error) {
          if (!active) return
          tree.setBootState('need-access')
          tree.setTreeContext(buildEmptyTreeContext())
          const notFound = error?.status === 404 || error?.payload?.error === 'tree_not_found'
          setTreeNotFound(notFound)
          tree.setGateError(notFound ? t("Cet arbre n'existe pas.") : t('Impossible de résoudre ce lien de partage.'))
          // Lien mort, mais la session du compte reste valable : « Créer mon arbre » ou « Mon compte »
          // doivent ouvrir le compte connecté, pas un écran de connexion vide
          const storedUserToken = auth.restoreUserToken()
          if (storedUserToken) {
            try {
              await auth.loadAccountTrees(storedUserToken)
              if (!active) return
              auth.setUserAuth({ token: storedUserToken, user: auth.restoreUserProfile?.() || null })
            } catch {
              auth.clearStoredUserToken()
            }
          }
          return
        }
      }

      const userToken = auth.restoreUserToken()
      if (userToken) {
        try {
          const { trees, lastOpenedTree } = await auth.loadAccountTrees(userToken)
          if (!active) return

          auth.setUserAuth({
            token: userToken,
            user: auth.restoreUserProfile?.() || null,
          })

          if (resolvedTreeId) {
            const resolvedTree = trees.find((entry) => String(entry.id) === String(resolvedTreeId))
            if (resolvedTree) {
              try {
                await openAccountTree(resolvedTree, userToken, { promptWizard: true })
                return
              } catch {
                // Fallback vers ecran partage
              }
            }

            tree.setTreeContext(buildEmptyTreeContext({
              treeId: resolvedTreeId,
              treeName: resolvedTreeName,
              treeDescription: resolvedTreeDescription,
              treeOwnerName: resolvedTreeOwnerName,
              treeOwnerEmail: resolvedTreeOwnerEmail,
            }))
            tree.setGateError('')
            tree.setBootState('need-access')
            return
          }

          const preferredTree = lastOpenedTree
            ? trees.find((entry) =>
              String(entry.id) === String(lastOpenedTree.treeId)
              && (!lastOpenedTree.accessMode || entry.accessMode === lastOpenedTree.accessMode))
            : null

          if (preferredTree) {
            try {
              await openAccountTree(preferredTree, userToken, { promptWizard: true })
              return
            } catch {
              // Fallback sur arbre suivant
            }
          }

          if (trees.length > 0) {
            try {
              await openAccountTree(trees[0], userToken, { promptWizard: true })
              return
            } catch {
              auth.setAccountError(t("Aucun arbre accessible n'a pu être chargé automatiquement."))
            }
            tree.setBootState('account')
            return
          }

          // Premier utilisateur : aucun arbre → galaxie démo + bouton onboarding
          tree.handleUseDemo()
          setAccountEntryMode('register')
          setTreeWizardVisible(true)
          return
        } catch {
          auth.clearStoredUserToken()
        }
      }

      if (resolvedTreeId) {
        const shareToken = localStorage.getItem(getTreeTokenStorageKey(resolvedTreeId))
        if (shareToken) {
          try {
            await tree.openTreeGraph(resolvedTreeId, shareToken, {
              treeName: resolvedTreeName,
              treeDescription: resolvedTreeDescription,
              treeOwnerName: resolvedTreeOwnerName,
              treeOwnerEmail: resolvedTreeOwnerEmail,
              // Rôle lu dans le jeton : un contributeur qui recharge la page reste contributeur
              role: readTreeAccessRole(shareToken),
              accessMode: 'share',
              promptWizard: false,
            })
            return
          } catch {
            localStorage.removeItem(getTreeTokenStorageKey(resolvedTreeId))
          }
        }
      }

      if (!active) return

      if (resolvedTreeId) {
        tree.setTreeContext(buildEmptyTreeContext({
          treeId: resolvedTreeId,
          treeName: resolvedTreeName,
          treeDescription: resolvedTreeDescription,
          treeOwnerName: resolvedTreeOwnerName,
          treeOwnerEmail: resolvedTreeOwnerEmail,
        }))
        tree.setGateError('')
        tree.setBootState('need-access')
        return
      }

      // ?account=register (CTA de la landing) : écran compte directement en création
      if (query.get('account') === 'register') {
        setAccountEntryMode('register')
        trackAppEvent('account_screen_viewed', { mode: 'register', from_shared_tree: false, source: getSource() })
      }
      tree.setBootState('account')
    }

    bootstrap()

    return () => {
      active = false
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleUseDemo = () => {
    setTreeNotFound(false)
    tree.handleUseDemo()
    auth.setAccountError('')
    setAccountPanelVisible(false)
    setTreeWelcomeVisible(false)
    setTreeWizardVisible(false)
    media.resetMediaManager()
    setAdminPanelVisible(false)
    contrib.resetContribState()
  }

  // Fallback auto: si l'utilisateur est connecté mais n'a aucun arbre,
  // on bascule automatiquement sur la démo (utile en production quand la création d'account laisse l'UI vide).
  // Sauf s'il a ouvert lui-même « Mon compte » : l'écran « Vos arbres » sait afficher un compte vide, et c'est
  // là que se trouvent la déconnexion et « Supprimer mon compte » (sans ça, introuvables sans arbre).
  useEffect(() => {
    if (
      tree.bootState === 'account' &&
      auth.authenticated &&
      !auth.accountLoading &&
      auth.accountTrees.length === 0 &&
      !accountFromTree &&
      !pendingSharedTreeRef.current // retour sur un arbre partagé en cours : pas d'assistant "votre arbre"
    ) {
      handleUseDemo()
      setAccountEntryMode('register')
      setTreeWizardVisible(true)
    }
  }, [tree.bootState, auth.authenticated, auth.accountLoading, auth.accountTrees.length, accountFromTree]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleUseAccount = (mode = 'login') => {
    const ctx = tree.treeContext
    pendingSharedTreeRef.current = ctx.treeId && ctx.accessMode !== 'demo' && ctx.accessMode !== 'member'
      ? {
        treeId: ctx.treeId,
        treeName: ctx.treeName,
        treeDescription: ctx.treeDescription,
        treeOwnerName: ctx.treeOwnerName,
        treeOwnerEmail: ctx.treeOwnerEmail,
      }
      : null
    setPendingSharedTreeName(pendingSharedTreeRef.current?.treeName || '')
    setTreeNotFound(false)
    tree.setGateError('')
    auth.setAccountError('')
    setAccountPanelVisible(false)
    setAccountEntryMode(mode === 'register' ? 'register' : 'login')
    trackAppEvent('account_screen_viewed', { mode: mode === 'register' ? 'register' : 'login', from_shared_tree: Boolean(pendingSharedTreeRef.current?.treeId) })
    media.resetMediaManager()
    setAdminPanelVisible(false)
    contrib.resetContribState()
    setAccountFromTree(tree.bootState === 'ready')
    tree.setBootState('account')
  }

  const handleBackToTree = () => {
    auth.setAccountError('')
    setAccountFromTree(false)
    tree.setBootState('ready')
  }

  const handleBackToAccess = () => {
    setAccountFromTree(false)
    setTreeNotFound(false)
    auth.setAccountError('')
    setAccountPanelVisible(false)
    setAccountEntryMode('login')
    tree.setGateError('')
    tree.setWizardVisibility(false)
    setTreeWizardVisible(false)
    media.resetMediaManager()
    setAdminPanelVisible(false)
    contrib.resetContribState()
    tree.setBootState('need-access')
  }

  // Après connexion ou création de compte depuis un arbre partagé : rattacher l'accès au compte
  // (jeton d'arbre déjà en poche) et rouvrir l'arbre ; sans jeton, retour à la grille d'accès de
  // cet arbre, où le mot de passe fera le rattachement. Renvoie true si le retour a été géré.
  const resumePendingSharedTree = async (token) => {
    const pending = pendingSharedTreeRef.current
    if (!pending?.treeId) {
      return false
    }

    // Le ref reste posé jusqu'à la fin : il bloque l'assistant "votre arbre" pendant le rattachement
    try {
      const shareToken = localStorage.getItem(getTreeTokenStorageKey(pending.treeId))
      if (shareToken) {
        try {
          await linkTreeAccess(pending.treeId, shareToken, token)
          const { trees } = await auth.loadAccountTrees(token)
          const entry = trees.find((candidate) => String(candidate.id) === String(pending.treeId))
          if (entry) {
            await openAccountTree(entry, token, { promptWizard: false })
            return true
          }
        } catch {
          // Jeton expiré ou refusé : on repasse par le mot de passe
        }
      }

      tree.setTreeContext(buildEmptyTreeContext(pending))
      tree.setGateError('')
      tree.setBootState('need-access')
      return true
    } finally {
      pendingSharedTreeRef.current = null
      setPendingSharedTreeName('')
    }
  }

  const handleLogin = async (email, password) => {
    const success = await auth.handleLogin(email, password)
    if (!success) {
      return
    }

    const token = auth.restoreUserToken()
    if (!token) {
      tree.setBootState('account')
      return
    }

    if (await resumePendingSharedTree(token)) {
      return
    }

    const { trees, lastOpenedTree } = await auth.loadAccountTrees(token)
    const preferredTree = lastOpenedTree
      ? trees.find((entry) =>
        String(entry.id) === String(lastOpenedTree.treeId)
        && (!lastOpenedTree.accessMode || entry.accessMode === lastOpenedTree.accessMode))
      : null
    const target = preferredTree || trees[0] || null
    if (!target) {
      handleUseDemo()
      setAccountEntryMode('register')
      setTreeWizardVisible(true)
      return
    }

    try {
      await openAccountTree(target, token, { promptWizard: true })
    } catch {
      tree.setBootState('account')
    }
  }

  const handleRegister = async (firstName, email, password) => {
    const success = await auth.handleRegister(firstName, email, password)
    if (!success) {
      return
    }
    trackAppEvent('account_registered', { from_shared_tree: Boolean(pendingSharedTreeRef.current?.treeId), source: getSource() })

    const token = auth.restoreUserToken()
    if (token && await resumePendingSharedTree(token)) {
      return
    }

    handleUseDemo()
    setAccountEntryMode('register')
    setTreeWizardVisible(true)
  }

  const handleOpenTreeFromAccount = async (treeId) => {
    if (!auth.userAuth.token) {
      return
    }

    auth.setAccountLoading(true)
    auth.setAccountError('')

    try {
      const treeInfo = auth.accountTrees.find((candidate) => String(candidate.id) === String(treeId))
      if (!treeInfo) {
        return
      }
      await openAccountTree(treeInfo, auth.userAuth.token, { promptWizard: true })
    } catch (error) {
      auth.setAccountError(getAccountErrorMessage(error))
    } finally {
      auth.setAccountLoading(false)
    }
  }

  const handleOpenTreeWizard = () => {
    trackDemoInteraction('create_tree')
    auth.setAccountError('')
    setTreeWelcomeVisible(false)
    setTreeWizardVisible(true)
  }

  const handleCreateTreeFromWizard = async (payload) => {
    const token = auth.userAuth.token
    if (!token) {
      return t('Session invalide ou expirée. Reconnectez-vous.')
    }

    setTreeWizardLoading(true)
    auth.setAccountLoading(true)
    auth.setAccountError('')

    try {
      const normalizedSlug = normalizeSlug(payload.treeName)
      const safeSlug = normalizedSlug.length >= 3
        ? normalizedSlug
        : `famille-${Date.now().toString(36)}`

      // Un seul mot de passe de partage, gardé chiffré par le serveur pour que le propriétaire le voie
      const sharePassword = generateSecurePassword()
      const createdTree = await createTree(
        {
          name: payload.treeName,
          slug: safeSlug,
          description: null,
          visitorPassword: sharePassword,
          contributorPassword: sharePassword,
        },
        token,
      )
      trackAppEvent('tree_created', { tree_id: toOpaqueTreeId(createdTree.id) })

      // Arbre déjà tenu dans un logiciel : on importe son fichier au lieu de commencer par « vous »,
      // sinon la personne saisie ici existerait deux fois après l'import
      if (payload.gedcomFile) {
        let imported = null
        let importError = ''
        try {
          const content = (await readGedcomFile(payload.gedcomFile)).text
          imported = content.trim()
            ? await importGedcom(createdTree.id, content, token)
            : null
          if (!imported) importError = t('Le fichier GEDCOM est vide.')
        } catch (error) {
          importError = getAccountErrorMessage(error) || t("Impossible d'importer ce fichier GEDCOM.")
        }

        await auth.loadAccountTrees(token)
        await tree.openTreeGraph(createdTree.id, token, {
          treeName: createdTree.name || payload.treeName,
          treeDescription: createdTree.description || '',
          role: 'owner',
          accessMode: 'member',
          rootPersonId: null,
          promptWizard: false,
        })
        await auth.persistLastOpenedTree({ treeId: createdTree.id, accessMode: 'member' })
        setTreeWizardVisible(false)

        if (imported) {
          const refs = Array.isArray(imported.photoRefs) ? imported.photoRefs : []
          const mediaRefs = Array.isArray(imported.mediaRefs) ? imported.mediaRefs : []
          savePhotoRefs(createdTree.id, refs)
          saveMediaRefs(createdTree.id, mediaRefs)
          trackAppEvent('gedcom_imported', {
            persons: sizeBucket(imported.personsCreated || 0),
            photo_refs: sizeBucket(refs.length),
            media_refs: sizeBucket(mediaRefs.length),
            via: 'wizard',
          })
          openPhotoStart({ personsImported: (imported.personsCreated || 0) + (imported.personsReused || 0), refs, mediaRefs })
        } else {
          // L'arbre existe déjà : on l'ouvre vide et on dit où réessayer, plutôt que d'en créer un second
          setTreeImportError(importError)
        }
        return null
      }

      const createdSelf = await createPerson(
        createdTree.id,
        {
          firstName: payload.selfFirstName,
          lastName: payload.selfLastName,
          birthDate: yearToIsoDate(payload.selfBirthYear),
        },
        token,
      )

      if (createdSelf?.id) {
        await updateTree(
          createdTree.id,
          { rootPersonId: createdSelf.id },
          token,
        )

        if (payload.photoFile) {
          const validationError = validateMediaFile(payload.photoFile, 'photo')
          if (!validationError) {
            try {
              const dataBase64 = await fileToBase64(payload.photoFile)
              await uploadPersonAvatar(
                createdTree.id,
                createdSelf.id,
                {
                  fileName: payload.photoFile.name || 'avatar.jpg',
                  mimeType: getUploadMimeType(payload.photoFile, 'photo'),
                  sizeBytes: payload.photoFile.size,
                  dataBase64,
                },
                token,
              )
            } catch {
              // La photo est optionnelle: ignorer l'echec sans bloquer la creation.
            }
          }
        }
      }

      await auth.loadAccountTrees(token)
      await tree.openTreeGraph(createdTree.id, token, {
        treeName: createdTree.name || payload.treeName,
        treeDescription: createdTree.description || '',
        role: 'owner',
        accessMode: 'member',
        rootPersonId: createdSelf?.id || null,
        promptWizard: false,
      })
      await auth.persistLastOpenedTree({
        treeId: createdTree.id,
        accessMode: 'member',
      })

      setTreeWizardVisible(false)
      setTreeWelcomeVisible(true)
      return null
    } catch (error) {
      const message = getAccountErrorMessage(error)
      auth.setAccountError(message)
      return message
    } finally {
      auth.setAccountLoading(false)
      setTreeWizardLoading(false)
    }
  }

  const handleLogout = async () => {
    setTreeNotFound(false)
    await auth.handleLogout()
    resetSignedOutState()
  }

  // Suppression du compte : même remise à zéro que la déconnexion une fois la session effacée.
  const handleDeleteAccount = async (password) => {
    const errorMessage = await auth.handleDeleteAccount(password)
    if (errorMessage) {
      return errorMessage
    }

    setTreeNotFound(false)
    resetSignedOutState()
    return null
  }

  function resetSignedOutState() {
    setAccountFromTree(false)
    tree.setWizardState({ visible: false, loading: false, error: '' })
    setAccountPanelVisible(false)
    setTreeWizardVisible(false)
    setTreeWelcomeVisible(false)
    setAccountEntryMode('login')
    media.resetMediaManager()
    setAdminPanelVisible(false)
    contrib.resetContribState()
    tree.setBootState('account')
  }

  const handleGateUnlock = async (treeId, password) => {
    const access = await tree.handleUnlock(treeId, password, {
      userToken: auth.userAuth.token || '',
      treeName: tree.treeContext.treeName,
      treeDescription: tree.treeContext.treeDescription,
      treeOwnerName: tree.treeContext.treeOwnerName,
      treeOwnerEmail: tree.treeContext.treeOwnerEmail,
    })

    if (!access) {
      return
    }

    setTreeNotFound(false)
    if (auth.userAuth.token) {
      await auth.loadAccountTrees(auth.userAuth.token)
      auth.persistLastOpenedTree({
        treeId,
        accessMode: 'share',
      })
    }
  }

  const handleTreeDeleted = async (deletedTreeId) => {
    if (!auth.userAuth.token) {
      handleUseAccount('login')
      return
    }

    try {
      const { trees, lastOpenedTree } = await auth.loadAccountTrees(auth.userAuth.token)

      const preferredTree = lastOpenedTree
        ? trees.find((entry) =>
          String(entry.id) === String(lastOpenedTree.treeId)
          && (!lastOpenedTree.accessMode || entry.accessMode === lastOpenedTree.accessMode))
        : null

      const nextTree = trees.find((entry) => String(entry.id) !== String(deletedTreeId)) || preferredTree || trees[0] || null
      if (nextTree) {
        await openAccountTree(nextTree, auth.userAuth.token, { promptWizard: true })
        return
      }

      handleUseDemo()
      setAccountEntryMode('register')
      setTreeWizardVisible(true)
    } catch {
      tree.setBootState('account')
    }
  }

  const handleGedcomImported = useCallback(async (result, treeIdOverride = null) => {
    await refreshTreeAndKeepSelection(null, { relayout: true })
    const refs = Array.isArray(result?.photoRefs) ? result.photoRefs : []
    const mediaRefs = Array.isArray(result?.mediaRefs) ? result.mediaRefs : []
    savePhotoRefs(treeIdOverride || tree.treeContext.treeId, refs)
    saveMediaRefs(treeIdOverride || tree.treeContext.treeId, mediaRefs)
    trackAppEvent('gedcom_imported', {
      persons: sizeBucket(result?.personsCreated || 0),
      photo_refs: sizeBucket(refs.length),
      media_refs: sizeBucket(mediaRefs.length),
    })
    setAdminPanelVisible(false)
    openPhotoStart({ personsImported: (result?.personsCreated || 0) + (result?.personsReused || 0), refs, mediaRefs })
  }, [refreshTreeAndKeepSelection, openPhotoStart, tree.treeContext.treeId])

  // La personne racine vient d'être changée dans la configuration : le graphe est rechargé
  // pour relire la racine côté serveur et réorganiser l'affichage autour d'elle.
  const handleRootPersonChanged = useCallback(async () => {
    await refreshTreeAndKeepSelection(tree.selectedPerson?.id ?? null, { relayout: true, rootPersonIdFromServer: true })
  }, [refreshTreeAndKeepSelection, tree.selectedPerson])

  // Un portrait envoyé sans recharger l'arbre (rechargé une fois, à la fermeture de la fenêtre).
  // Renvoie un message d'erreur, ou '' si c'est fait.
  const sendPortrait = useCallback(async (personId, file) => {
    const accessToken = tree.treeContext.accessToken || auth.userAuth.token
    if (!accessToken || !tree.treeContext.treeId) return t('Session expirée, reconnectez-vous.')
    const prepared = await prepareImageForUpload(file)
    const validationError = validateMediaFile(prepared, 'photo')
    if (validationError) return validationError
    const payload = {
      fileName: prepared.name || 'avatar.jpg',
      mimeType: getUploadMimeType(prepared, 'photo'),
      sizeBytes: prepared.size,
      dataBase64: await fileToBase64(prepared),
    }
    // Trop d'envois d'un coup (429) : on attend et on réessaie, deux fois au plus
    for (let attempt = 0; ; attempt += 1) {
      try {
        await uploadPersonAvatar(tree.treeContext.treeId, personId, payload, accessToken)
        photoStartDirtyRef.current = true
        return ''
      } catch (error) {
        if (error?.status === 429 && attempt < 2) {
          await new Promise((resolve) => window.setTimeout(resolve, 15000))
          continue
        }
        return getAccountErrorMessage(error)
      }
    }
  }, [auth.userAuth.token, tree.treeContext.accessToken, tree.treeContext.treeId])

  const handlePhotoStartUploadOne = useCallback(async (personId, file) => {
    const error = await sendPortrait(personId, file)
    if (!error) trackAppEvent('portrait_added', { via: 'first_faces' })
    return error
  }, [sendPortrait])

  const handlePhotoStartBulk = useCallback(async (matches, onProgress) => {
    const placedIds = []
    for (let i = 0; i < matches.length; i += 1) {
      const error = await sendPortrait(matches[i].personId, matches[i].file)
      if (!error) placedIds.push(matches[i].personId)
      onProgress?.(i + 1)
    }
    trackAppEvent('portraits_bulk_placed', { placed: sizeBucket(placedIds.length), failed: sizeBucket(matches.length - placedIds.length) })
    return { placedIds }
  }, [sendPortrait])

  // Les autres fichiers retrouvés dans le dossier : des souvenirs, avec le titre et la source du logiciel
  const handlePhotoStartMedia = useCallback(async (matches, onProgress) => {
    const accessToken = tree.treeContext.accessToken || auth.userAuth.token
    const added = []
    for (let i = 0; i < matches.length; i += 1) {
      const { personId, file, caption, source } = matches[i]
      try {
        if (!accessToken || !tree.treeContext.treeId) break
        const prepared = await prepareImageForUpload(file)
        const type = inferMediaTypeFromMimeType(prepared.type)
        if (!validateMediaFile(prepared, type)) {
          const payload = {
            type,
            fileName: prepared.name || file.name,
            mimeType: getUploadMimeType(prepared, type),
            sizeBytes: prepared.size,
            dataBase64: await fileToBase64(prepared),
            caption: caption ? String(caption).slice(0, 280) : null,
            source: source ? String(source).slice(0, 500) : null,
          }
          // Trop d'envois d'un coup (429) : on attend et on réessaie, deux fois au plus
          for (let attempt = 0; ; attempt += 1) {
            try {
              await uploadPersonMedia(tree.treeContext.treeId, personId, payload, accessToken)
              added.push(matches[i])
              photoStartDirtyRef.current = true
              break
            } catch (error) {
              if (error?.status === 429 && attempt < 2) {
                await new Promise((resolve) => window.setTimeout(resolve, 15000))
                continue
              }
              break
            }
          }
        }
      } catch {
        // Fichier illisible : compté comme non envoyé
      }
      onProgress?.(i + 1)
    }
    trackAppEvent('memories_bulk_added', { added: sizeBucket(added.length), failed: sizeBucket(matches.length - added.length) })
    return { added }
  }, [auth.userAuth.token, tree.treeContext.accessToken, tree.treeContext.treeId])

  const handlePhotoStartClose = useCallback(async () => {
    setPhotoStart((current) => ({ ...current, visible: false }))
    if (photoStartDirtyRef.current) {
      photoStartDirtyRef.current = false
      await refreshTreeAndKeepSelection(null, { relayout: true, avatarCacheBust: Date.now() })
    }
  }, [refreshTreeAndKeepSelection])

  const handleSelectSelfPerson = (personId) => {
    const treeId = tree.treeContext.treeId
    if (!treeId || !accountEmail) {
      return
    }

    const nextValue = personId ? String(personId) : ''
    setLinkedSelfPersonId(nextValue)

    try {
      const storageKey = getAccountSelfPersonStorageKey(accountEmail, treeId)
      if (nextValue) {
        localStorage.setItem(storageKey, nextValue)
      } else {
        localStorage.removeItem(storageKey)
      }
    } catch {
      // Ignore storage failures
    }
  }


  if (tree.bootState === 'loading') {
    return (
      <div className="app app-loading" />
    )
  }

  if (tree.bootState === 'need-access') {
    return (
      <div className="app">
        <AccessGate
          initialTreeId={tree.treeContext.treeId}
          treeName={tree.treeContext.treeName}
          treeDescription={tree.treeContext.treeDescription}
          treeOwnerName={tree.treeContext.treeOwnerName}
          treeOwnerEmail={tree.treeContext.treeOwnerEmail}
          treeNotFound={treeNotFound}
          loading={tree.gateLoading}
          errorMessage={tree.gateError}
          onSubmit={handleGateUnlock}
          onUseDemo={handleUseDemo}
          onUseAccount={handleUseAccount}
        />
      </div>
    )
  }

  if (tree.bootState === 'account') {
    return (
      <div className="app">
        <AccountDashboard
          authenticated={auth.authenticated}
          loading={auth.accountLoading}
          errorMessage={auth.accountError}
          trees={auth.accountTrees}
          activeTreeId={tree.treeContext.treeId}
          defaultMode={accountEntryMode}
          pendingTreeName={pendingSharedTreeName}
          onLogin={handleLogin}
          onRegister={handleRegister}
          onOpenTree={handleOpenTreeFromAccount}
          onStartTreeWizard={handleOpenTreeWizard}
          onLogout={handleLogout}
          onDeleteAccount={handleDeleteAccount}
          onBackToAccess={handleBackToAccess}
          onBackToTree={accountFromTree ? handleBackToTree : undefined}
          onUseDemo={handleUseDemo}
        />
      </div>
    )
  }

  const isEmptyTree = persons.length === 0
    && !!tree.treeContext.treeId
    && tree.canEditCurrentTree
    && tree.treeContext.accessMode !== 'demo'

  return (
    <div className="app">
      {/* Bannière de bienvenue (premier utilisateur, mode démo) */}
      {treeWelcomeVisible && (
        <div className="tree-created-prompt" role="status">
          <strong>{t('Votre arbre est créé.')}</strong>
          {t("Ajoutez un proche pour commencer, comme votre mère, votre père ou un frère. Il suffit d'un prénom.")}
          <button type="button" onClick={() => setTreeWelcomeVisible(false)} aria-label={t('Fermer')}>
            {t('Fermer')}
          </button>
        </div>
      )}
      {treeImportError && (
        <div className="tree-created-prompt tree-created-prompt--error" role="alert">
          <strong>{t("Votre arbre est créé, mais l'import n'a pas abouti.")}</strong>
          {` ${treeImportError} `}
          {t("Vous pouvez réessayer depuis les paramètres de l'arbre.")}
          <button type="button" onClick={() => setTreeImportError('')} aria-label={t('Fermer')}>
            {t('Fermer')}
          </button>
        </div>
      )}
      {/* Bouton premier ajout (arbre vide) */}
      {isEmptyTree && (
        <button
          type="button"
          className="empty-tree-add"
          onClick={() => { editMode.activate(); handleOpenAddPerson() }}
          aria-label={t('Ajouter une première personne')}
        >
          <svg className="empty-tree-add-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="16" />
            <line x1="8" y1="12" x2="16" y2="12" />
          </svg>
          <div className="empty-tree-add-body">
            <span className="empty-tree-add-title">{t('Ajouter une personne')}</span>
            <span className="empty-tree-add-hint">{t("Commencer l'arbre")}</span>
          </div>
          <svg className="empty-tree-add-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="6 4 10 8 6 12" />
          </svg>
        </button>
      )}
      {/* Recherche Expandable */}
      <ExpandableSearch
        results={search.results}
        hasResults={search.hasResults}
        onSearch={search.handleSearch}
        onClear={search.clearSearch}
        onResultClick={(person) => {
          const fullPerson = persons.find(p => p.id === person.id)
          if (!fullPerson) return
          trackDemoInteraction('search')
          tree.setSelectedPerson(fullPerson)
          galaxyZoomApiRef.current?.focusPerson?.(fullPerson.id)
        }}
      />
      {/* Draft Restore Banner (au reload si draft trouvé) */}
      <DraftRestoreBanner
        visible={showDraftBanner && !editMode.isActive}
        draftTimestamp={editMode.draftTimestamp}
        onRestore={handleDraftRestore}
        onDiscard={handleDraftDiscard}
      />
      {/* Edit Mode Overlay */}
      <EditModeOverlay
        active={editMode.isActive}
        hasDraft={editMode.hasDraft}
        draftTimestamp={editMode.draftTimestamp}
        role={userRole.isAdmin ? 'admin' : 'contributor'}
        onDeactivate={editMode.deactivate}
        onSubmit={handleEditSubmit}
      />
      {/* Confirmation Modal (quitter mode édition avec draft) */}
      <EditConfirmModal
        visible={showConfirmModal}
        onContinue={handleConfirmContinue}
        onSaveAndQuit={handleConfirmSaveAndQuit}
        onDiscard={handleConfirmDiscard}
      />
      {/* Slide-in Ajouter Personne */}
      <AddPersonPanel
        visible={addPersonPanelVisible && editMode.isActive}
        persons={persons}
        loading={addPersonLoading}
        error={addPersonError}
        onSubmit={handleAddPersonSubmit}
        onClose={handleCloseAddPerson}
      />
      {/* Modal Session Contribution (contributeurs) */}
      <ContributionSessionModal
        visible={showContribModal}
        changes={contribChanges}
        recap={(() => {
          const d = editMode.restoreDraft()
          return {
            added: (d.addedPersons || []).length + (d.addedAnnotations || []).length,
            modified: Object.keys(d.modifiedPersons || {}).length + (d.modifiedAnnotations || []).length,
            deleted: (d.deletedPersons || []).length + (d.deletedAnnotations || []).length,
          }
        })()}
        loading={contribSubmitLoading}
        error={contribSubmitError}
        askName={!auth.userAuth.user?.name}
        onSubmit={handleContribSessionSubmit}
        onCancel={() => setShowContribModal(false)}
      />
      {/* Toast succès contribution */}
      <FamilyWelcome
        visible={familyWelcomeVisible && !souvenirPickerVisible}
        treeName={tree.treeContext.treeName}
        onAddSouvenir={handleOpenSouvenirPicker}
        onLook={closeFamilyWelcome}
      />
      <SouvenirPicker
        visible={souvenirPickerVisible}
        persons={persons}
        rootPersonId={tree.treeContext.rootPersonId}
        onPick={handleSouvenirPick}
        onAddPerson={handleSouvenirPickerAddPerson}
        onClose={() => setSouvenirPickerVisible(false)}
      />
      {draftNotice && !contribSuccess && !showContribModal && (
        <div className="contrib-success-toast" role="status">{draftNotice}</div>
      )}
      {contribSuccess && (
        <div className="contrib-success-toast" role="status">
          {t("Merci, c'est envoyé ! Ça apparaîtra dans l'arbre une fois relu.")}
        </div>
      )}
      {/* Navbar contextuelle */}
      <ContextualNavbar
        userRole={userRole}
        pendingContributions={contrib.contribState.sessions?.length || 0}
        editModeActive={editMode.isActive}
        trees={auth.accountTrees}
        activeTreeId={tree.treeContext.treeId}
        onEditClick={handleEditToggle}
        onAddPersonClick={handleOpenAddPerson}
        onAddSouvenirClick={isFamilyVisitor ? handleOpenSouvenirPicker : undefined}
        helpUrl={isFamilyVisitor ? HELP_URL : ''}
        onShareClick={userRole.isAdmin ? handleOpenContributionPanel : undefined}
        onTreeSelect={handleOpenTreeFromAccount}
        onCreateTree={handleOpenTreeWizard}
        onProfileClick={handleUseAccount}
        onAccountClick={() => setAccountPanelVisible(true)}
        onSettingsClick={() => setAdminPanelVisible(true)}
        onLogout={handleLogout}
        userDisplayName={accountDisplayName}
        userEmail={accountEmail}
        userAvatarPhoto={accountAvatarPhoto}
        linkedPersonName={linkedSelfPerson ? `${linkedSelfPerson.firstName || ''} ${linkedSelfPerson.lastName || ''}`.trim() : ''}
        activeTreeName={activeAccountTreeName}
        annotationTools={editMode.isActive ? {
          activeTool: annot.activeTool,
          onToolChange: annot.setActiveTool,
          currentStyle: annot.currentStyle,
          onStyleChange: annot.setCurrentStyle,
          selectedAnnotationId: annot.selectedAnnotationId,
          selectedSticker: annot.selectedSticker,
          onStickerSelect: annot.setSelectedSticker,
          onDelete: annot.deleteSelectedAnnotation,
          isDragging: annot.isDragging,
          isOverTrash: annot.isOverTrash,
          onPhotoFileSelected: handleAnnotationPhotoFile,
        } : null}
        viewMode={viewMode}
        onViewModeChange={handleViewModeChange}
      />
      <Galaxy
        onPersonSelect={handlePersonSelect}
        onMediaSelect={handleMediaSelectFresh}
        selectedPersonId={tree.selectedPerson?.id || null}
        searchHighlightIds={search.matchedPersonIds}
        layoutMode={viewMode}
        ascendanceRootId={ascendanceRootId}
        graphRevision={tree.graphRevision}
        annotationHandlers={editMode.isActive ? annot : null}
        transformReadRef={galaxyTransformReadRef}
        zoomApiRef={galaxyZoomApiRef}
        focusPersonId={tree.treeContext.rootPersonId}
        assetRevision={tree.assetRevision}
        photoHint={tree.canEditCurrentTree}
        reorderEnabled={canReorderSiblings}
        onReorderSiblings={handleReorderSiblings}
      />
      <ZoomControl zoomApiRef={galaxyZoomApiRef} />
      {tree.selectedPerson && (
        <PersonCard
          person={tree.selectedPerson}
          onClose={() => tree.setSelectedPerson(null)}
          onMediaSelect={handleMediaSelectFresh}
          editMode={editMode.isActive}
          canManageMedia={tree.canSubmitContribution || tree.canEditCurrentTree}
          onManageMedia={media.handleOpenMediaManager}
          onAvatarUpload={tree.canEditCurrentTree ? handlePersonAvatarUpload : undefined}
          onAvatarDelete={tree.canEditCurrentTree ? handlePersonAvatarDelete : undefined}
          treeId={tree.treeContext.treeId || null}
          immichToken={tree.treeContext.accessToken || auth.userAuth.token}
          onImmichChange={tree.canEditCurrentTree ? handleImmichChange : undefined}
          avatarActionLoading={avatarActionState.loading}
          avatarActionError={avatarActionState.error}
          isAdmin={userRole.isAdmin}
          onSave={handlePersonSave}
          onDelete={handlePersonDelete}
          onAddRelation={handleAddRelation}
          onRemoveRelation={handleRemoveRelation}
          relationActionLoading={relationFeedback.loading}
          relationActionSuccess={relationFeedback.success}
          relationActionError={relationFeedback.error}
          siblingPlace={siblingPlace}
          onMoveSibling={(delta) => galaxyZoomApiRef.current?.moveSibling?.(tree.selectedPerson.id, delta)}
          onShowAscendance={viewMode === 'ascendance' ? handleShowAscendance : undefined}
        />
      )}
      {tree.selectedMedia && (
        <MediaViewer
          media={tree.selectedMedia.media}
          person={tree.selectedMedia.person}
          onClose={() => tree.setSelectedMedia(null)}
        />
      )}
      <MediaManagerPanel
        visible={media.mediaManagerState.visible}
        person={tree.selectedPerson}
        medias={media.selectedPersonMedias}
        loading={media.mediaManagerState.loading}
        errorMessage={media.mediaManagerState.error}
        notice={media.mediaManagerState.notice}
        canManage={tree.canEditCurrentTree}
        onClose={media.handleCloseMediaManager}
        onUpload={media.handleUploadPersonMedia}
        onMove={media.handleMovePersonMedia}
        onDelete={media.handleDeletePersonMedia}
      />
      <ContributionPanel
        visible={contrib.contribState.visible}
        treeId={tree.treeContext.treeId}
        canModerate={tree.canEditCurrentTree}
        loading={contrib.contribState.loading}
        errorMessage={contrib.contribState.error}
        inviteShareUrl={contribInviteState.shareUrl}
        inviteKnownPasswords={contribInviteState.knownPasswords}
        inviteSaving={contribInviteState.loading}
        inviteError={contribInviteState.error}
        inviteMessage={contribInviteState.message}
        sessions={contrib.contribState.sessions}
        reviewingSessionId={contrib.contribState.reviewingSessionId}
        onClose={contrib.handleCloseContributionPanel}
        onRefresh={contrib.refreshContributionSessions}
        onRotatePasswords={handleContributionPasswordRotate}
        onRememberPassword={handleContributionPasswordRemember}
        onReviewSession={contrib.handleReviewContributionSession}
      />
      <AccountPanel
        visible={accountPanelVisible}
        userDisplayName={accountDisplayName}
        userEmail={accountEmail}
        linkedPerson={linkedSelfPerson}
        selectedPersonId={linkedSelfPersonId}
        people={persons}
        onSelectPerson={handleSelectSelfPerson}
        onManageAccount={() => handleUseAccount('login')}
        onClose={() => setAccountPanelVisible(false)}
      />
      <AdminPanel
        visible={adminPanelVisible}
        treeId={tree.treeContext.treeId}
        authToken={tree.treeContext.accessToken}
        persons={persons}
        onRootPersonChanged={handleRootPersonChanged}
        isAdmin={userRole.isAdmin}
        onTreeDeleted={handleTreeDeleted}
        onGedcomImported={handleGedcomImported}
        onOpenPhotoStart={() => { setAdminPanelVisible(false); openPhotoStart() }}
        onClose={() => setAdminPanelVisible(false)}
      />
      <PhotoStartPanel
        visible={photoStart.visible}
        personsImported={photoStart.personsImported}
        photoRefs={photoStart.refs}
        mediaRefs={photoStart.mediaRefs}
        faces={photoStart.faces}
        onUploadOne={handlePhotoStartUploadOne}
        onBulkPlace={handlePhotoStartBulk}
        onBulkMedia={handlePhotoStartMedia}
        onRefsChange={(refs) => savePhotoRefs(tree.treeContext.treeId, refs)}
        onMediaRefsChange={(refs) => saveMediaRefs(tree.treeContext.treeId, refs)}
        onClose={handlePhotoStartClose}
      />
      {/* Annotation Toolbar (visible uniquement en mode édition) */}
      {editMode.isActive && (
        <AnnotationToolbar
          activeTool={annot.activeTool}
          onToolChange={annot.setActiveTool}
          currentStyle={annot.currentStyle}
          onStyleChange={annot.setCurrentStyle}
          selectedAnnotationId={annot.selectedAnnotationId}
          selectedAnnotation={annot.selectedAnnotation}
          selectedSticker={annot.selectedSticker}
          onStickerSelect={annot.setSelectedSticker}
          onDelete={annot.deleteSelectedAnnotation}
          onResizeSelected={annot.resizeSelected}
          onPhotoFileSelected={handleAnnotationPhotoFile}
          isDragging={annot.isDragging}
          isOverTrash={annot.isOverTrash}
        />
      )}
      {/* Text Input Overlay (saisie texte sur canvas) */}
      <TextInputOverlay
        textInputState={annot.textInputState}
        currentStyle={annot.currentStyle}
        onCommit={annot.commitTextInput}
        onCancel={annot.cancelTextInput}
      />
      {/* Onboarding premier arbre */}
      <TreeCreationWizard
        visible={treeWizardVisible}
        loading={treeWizardLoading}
        defaultFirstName={accountDisplayName}
        onClose={() => setTreeWizardVisible(false)}
        onSubmit={handleCreateTreeFromWizard}
      />
    </div>
  )
}

export default App




