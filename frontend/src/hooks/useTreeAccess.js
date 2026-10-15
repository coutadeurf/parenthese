import { useCallback, useMemo, useRef, useState } from 'react'
import { setMediaToken } from '../utils/mediaToken.js'
import { API_BASE_URL } from '../api/client'
import { fetchTreeGraph, unlockTreeAccess } from '../api/treeApi'
import { loadGraphData, persons as graphPersons, resetToDemoData } from '../data/mockData'
import { getShareErrorMessage } from '../utils/errorMessages'

export const TREE_ID_FROM_ENV = (import.meta.env.VITE_TREE_ID || '').trim()

const TOKEN_STORAGE_PREFIX = 'tree_access_token_'

// Mot de passe de partage unique (25/09/2026) : tout accès partagé peut proposer.
// Les jetons et accès « visitor » d'avant valent contributeur.
function normalizeRole(role) {
  const value = String(role || '').trim().toLowerCase()
  return value === 'visitor' ? 'contributor' : value
}

export function getTreeTokenStorageKey(treeId) {
  return `${TOKEN_STORAGE_PREFIX}${treeId}`
}

// Rôle d'un jeton d'accès partagé : toujours contributeur depuis le mot de passe unique (le serveur tranche)
export function readTreeAccessRole() {
  return 'contributor'
}

export function getSlugFromPathname() {
  const match = window.location.pathname.match(/^\/arbre\/([^/]+)$/)
  return match ? decodeURIComponent(match[1]) : null
}

export function useTreeAccess() {
  const [treeContext, setTreeContext] = useState({
    treeId: '',
    treeName: '',
    treeDescription: '',
    treeOwnerName: '',
    treeOwnerEmail: '',
    role: '',
    accessMode: '',
    rootPersonId: null,
    accessToken: '',
  })
  const [bootState, setBootState] = useState('loading')
  const [gateLoading, setGateLoading] = useState(false)
  const [gateError, setGateError] = useState('')
  const [selectedPerson, setSelectedPerson] = useState(null)
  const [selectedMedia, setSelectedMedia] = useState(null)
  const [wizardState, setWizardState] = useState({ visible: false, loading: false, error: '' })
  const [graphRevision, setGraphRevision] = useState(0)
  // Change à chaque chargement des données, même sans nouveau placement : l'arbre y charge les images manquantes
  const [assetRevision, setAssetRevision] = useState(0)
  // Horodatage des portraits stable pendant la session : un rechargement ne force pas à tout retélécharger.
  // Il ne change que lorsqu'un portrait change (envoi d'une nouvelle photo). Posé au premier chargement
  // d'un arbre, pas au rendu (Date.now() rendrait le rendu impur).
  const avatarCacheBustRef = useRef(null)

  const canEditCurrentTree = useMemo(() => {
    const role = normalizeRole(treeContext.role)
    return role === 'owner' || role === 'admin'
  }, [treeContext.role])
  const canSubmitContribution = useMemo(() => {
    const role = normalizeRole(treeContext.role)
    return Boolean(role) && role !== 'visitor'
  }, [treeContext.role])

  const openTreeGraph = async (treeId, token, options = {}) => {
    const graphPayload = await fetchTreeGraph(treeId, token)
    setMediaToken(graphPayload.mediaToken)
    loadGraphData(graphPayload.graph, {
      mediaToken: graphPayload.mediaToken,
      apiBaseUrl: API_BASE_URL,
      avatarCacheBust: options.avatarCacheBust ?? (avatarCacheBustRef.current ??= Date.now()),
    })
    if (options.avatarCacheBust) avatarCacheBustRef.current = options.avatarCacheBust
    setAssetRevision((current) => current + 1)
    if (options.relayout !== false) {
      setGraphRevision((current) => current + 1)
    }
    const preferredRootPersonId = options.rootPersonId ?? graphPayload.rootPersonId ?? null
    const rootPerson = preferredRootPersonId
      ? graphPersons.find((person) => String(person.id) === String(preferredRootPersonId)) || null
      : null
    // Par le lien de partage, la famille arrive sur l'arbre et sa carte d'accueil, pas sur une fiche ouverte
    const openedByShareLink = (options.accessMode ?? '') === 'share'
    setSelectedPerson(openedByShareLink ? null : rootPerson)
    setSelectedMedia(null)

    setTreeContext((current) => ({
      treeId,
      treeName: options.treeName ?? current.treeName,
      treeDescription: options.treeDescription ?? current.treeDescription,
      treeOwnerName: options.treeOwnerName ?? current.treeOwnerName,
      treeOwnerEmail: options.treeOwnerEmail ?? current.treeOwnerEmail,
      role: normalizeRole(options.role ?? current.role),
      accessMode: options.accessMode ?? current.accessMode,
      rootPersonId: preferredRootPersonId,
      accessToken: token,
    }))

    const effectiveRole = normalizeRole(options.role)
    const shouldPromptWizard =
      Boolean(options.promptWizard) &&
      (effectiveRole === 'owner' || effectiveRole === 'admin') &&
      Array.isArray(graphPayload?.graph?.persons) &&
      graphPayload.graph.persons.length === 0

    if (shouldPromptWizard) {
      setWizardState({ visible: true, loading: false, error: '' })
    } else {
      setWizardState((current) => ({ ...current, visible: false, loading: false, error: '' }))
    }

    setBootState('ready')
    return graphPayload
  }

  const refreshCurrentTreeGraph = async (options = {}) => {
    await openTreeGraph(treeContext.treeId, treeContext.accessToken, {
      treeName: treeContext.treeName,
      treeDescription: treeContext.treeDescription,
      treeOwnerName: treeContext.treeOwnerName,
      treeOwnerEmail: treeContext.treeOwnerEmail,
      role: treeContext.role,
      accessMode: treeContext.accessMode,
      // Relit la racine depuis le graphe plutôt que de conserver celle déjà chargée :
      // la configuration de l'arbre vient peut-être de la changer.
      rootPersonId: options.rootPersonIdFromServer === true ? undefined : treeContext.rootPersonId,
      promptWizard: false,
      relayout: options.relayout !== false,
      avatarCacheBust: options.avatarCacheBust,
    })
  }

  const bumpGraphRevision = useCallback(() => {
    setGraphRevision((current) => current + 1)
  }, [])

  const handleUnlock = async (treeId, password, options = {}) => {
    setGateLoading(true)
    setGateError('')

    try {
      const access = await unlockTreeAccess(treeId, password, options.userToken || '')
      localStorage.setItem(getTreeTokenStorageKey(treeId), access.token)
      await openTreeGraph(treeId, access.token, {
        treeName: options.treeName ?? treeContext.treeName,
        treeDescription: options.treeDescription ?? treeContext.treeDescription,
        treeOwnerName: options.treeOwnerName ?? treeContext.treeOwnerName,
        treeOwnerEmail: options.treeOwnerEmail ?? treeContext.treeOwnerEmail,
        role: access.role,
        accessMode: 'share',
        promptWizard: false,
      })
      return access
    } catch (error) {
      setGateError(getShareErrorMessage(error))
      return null
    } finally {
      setGateLoading(false)
    }
  }

  const handleMediaSelect = (media, person) => {
    setSelectedMedia({ media, person })
  }

  const setWizardVisibility = (visible, error = '') => {
    setWizardState((current) => ({
      ...current,
      visible,
      error,
    }))
  }

  const handleSkipWizard = () => {
    setWizardState({ visible: false, loading: false, error: '' })
  }

  const handleUseDemo = () => {
    resetToDemoData()
    setGraphRevision((current) => current + 1)
    setSelectedPerson(null)
    setSelectedMedia(null)
    setGateError('')
    setWizardState({ visible: false, loading: false, error: '' })
    setTreeContext({
      treeId: '',
      treeName: '',
      treeDescription: '',
      treeOwnerName: '',
      treeOwnerEmail: '',
      role: '',
      accessMode: 'demo',
      rootPersonId: null,
      accessToken: '',
    })
    setBootState('ready')
  }

  return {
    treeContext, setTreeContext,
    bootState, setBootState,
    assetRevision,
    gateLoading, gateError, setGateError,
    selectedPerson, setSelectedPerson,
    selectedMedia, setSelectedMedia,
    wizardState, setWizardState,
    graphRevision,
    bumpGraphRevision,
    canEditCurrentTree,
    canSubmitContribution,
    openTreeGraph,
    refreshCurrentTreeGraph,
    handleUnlock,
    handleMediaSelect,
    setWizardVisibility,
    handleSkipWizard,
    handleUseDemo,
  }
}
