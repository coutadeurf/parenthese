import { memo, useEffect, useImperativeHandle, useRef, useState, useCallback } from 'react'
import { getPersonMedias, getParents, getChildren, getPersonUnions, persons as graphPersons, unions as graphUnions, filiations as graphFiliations } from '../data/mockData'
import { PERSON_R, FLOAT_SPEED, FLOAT_AMPLITUDE, REPULSION_RADIUS, REPULSION_STRENGTH, MAX_ORBIT_MEDIAS, ENTRANCE_GEN_DELAY, ENTRANCE_NODE_DURATION, ENTRANCE_NODE_STAGGER, ENTRANCE_MAX_GEN_SPAN, ENTRANCE_MAX_NODE_SPAN, ENTRANCE_LINE_DELAY, ENTRANCE_LINE_DURATION, ENTRANCE_ORBIT_DELAY, ENTRANCE_ORBIT_DURATION, ENTRANCE_ORBIT_STAGGER } from './galaxy/constants'
import { easeOutCubic } from './galaxy/utils'
import { computeLayout, generateNodeRandomData, coupleBarMeta } from './galaxy/elkLayout'
import { computeBlockLayout } from './galaxy/blockLayout'
import { computeAscendanceLayout } from './galaxy/ascendanceLayout'

// Placement par blocs familiaux par défaut (mesures : tools/layout-bench). ?layout=sugiyama = placement Sugiyama.
const USE_BLOCK_LAYOUT = typeof window === 'undefined' || new URLSearchParams(window.location.search).get('layout') !== 'sugiyama'
import { findPathBFS } from './galaxy/pathfinding'
import { drawBackground, drawCoupleLinks, drawFiliations, drawAnnotations, drawPathHighlight, drawNodes, drawRenvoiPills, nodeRadius } from './galaxy/renderers'
import { buildSiblingGroups, moveInOrder, pickSlot, rubberBand, springStep, isSettled, buildOrderPayload, filiationsWithOrder } from './galaxy/siblingReorder'
import { annotations as annotationData } from '../data/mockData'
import { useImageCache } from './galaxy/useImageCache'
import { useGalaxyInteractions } from './galaxy/useGalaxyInteractions'
import './Galaxy.css'

// Assez bas pour cadrer un grand arbre entier à l'ouverture
// (le rendu à petite échelle reste bon marché grâce au niveau de détail selon le zoom)
const MIN_SCALE = 0.12

// Lissage exponentiel avec convergence exacte : renvoie la cible dès qu'on en est à moins de eps,
// sinon les états lissés n'atteignent jamais leur cible et la scène se redessine sans fin.
function approach(prev, target, k, eps = 1e-3) {
  const next = prev + (target - prev) * k
  return Math.abs(target - next) < eps ? target : next
}
const MAX_SCALE = 3.2
// Ouverture sur la personne de départ quand l'arbre entier serait illisible
const FOCUS_MIN_READABLE_SCALE = 0.5
const FOCUS_SCALE = 0.95

// Réordonner une fratrie : seuil avant de soulever à la souris, appui long au doigt
const REORDER_MOUSE_THRESHOLD = 4
const REORDER_TOUCH_SLOP = 8
const REORDER_LONG_PRESS_MS = 320
// Les frères et sœurs s'écartent sans rebond ; la personne lâchée se pose avec un léger rebond
const SHIFT_SPRING = { stiffness: 560, dampingRatio: 0.92 }
const DROP_SPRING = { stiffness: 480, dampingRatio: 0.72 }
const centerX = (node) => node.x + node.width / 2
const prefersReducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

const Galaxy = ({ onPersonSelect, onMediaSelect, selectedPersonId, searchHighlightIds = [], graphRevision = 0, annotationHandlers = null, transformReadRef = null, zoomApiRef = null, focusPersonId = null, assetRevision = 0, photoHint = false, reorderEnabled = false, onReorderSiblings = null, layoutMode = 'descendance', ascendanceRootId = null }) => {
  const canvasRef = useRef(null)
  // Lu au calcul du cadrage seulement : changer de personne de départ ne recadre pas une vue en cours
  const focusPersonIdRef = useRef(focusPersonId)
  // Mis à jour hors du rendu, avant l'effet de cadrage déclaré plus bas (même phase, ordre de déclaration)
  useEffect(() => { focusPersonIdRef.current = focusPersonId }, [focusPersonId])
  // Mode d'affichage ('descendance' | 'ascendance') et racine résolue du placement en cours
  const layoutModeRef = useRef(layoutMode)
  useEffect(() => { layoutModeRef.current = layoutMode }, [layoutMode])
  const ascendanceRootRef = useRef(null)
  // Synchronisé ici (avant l'effet de layout) : la sélection sert de racine par défaut en mode Ascendance
  const selectedPersonIdRef = useRef(null)
  useEffect(() => { selectedPersonIdRef.current = selectedPersonId }, [selectedPersonId])
  // Propriétaire : un portrait vide survolé montre « + photo »
  const photoHintRef = useRef(photoHint)
  useEffect(() => { photoHintRef.current = photoHint }, [photoHint])
  const layoutDataRef = useRef(null)
  const [layoutReady, setLayoutReady] = useState(false)
  const transformRef = useRef({ x: 0, y: 0, scale: 1 })

  // Expose transformRef to parent so it can compute world coords (e.g. for photo placement)
  if (transformReadRef) transformReadRef.current = transformRef
  const targetTransformRef = useRef({ x: 0, y: 0, scale: 1 })
  const initialTransformRef = useRef(null)
  const mouseWorldPos = useRef({ x: -9999, y: -9999 })
  const dprRef = useRef(1)
  const pinchRef = useRef(null) // { dist, center }
  const nodeRandomDataRef = useRef(new Map())
  const hoveredNodeId = useRef(null)
  const hoveredMediaKey = useRef(null)
  const hoverScales = useRef(new Map())
  const mediaHoverState = useRef(new Map())
  const dragLiftProgress = useRef(0)
  const entranceRef = useRef(null)
  const selectedGlowScales = useRef(new Map())
  const searchGlowScales = useRef(new Map())
  const searchHighlightIdsRef = useRef([])
  const immediateRelativesRef = useRef(new Set())
  const pathEdgesRef = useRef([])
  const pathNodesRef = useRef([])
  const pathLabelRef = useRef('')
  const pathProgressRef = useRef(new Map())
  const pathLabelAlpha = useRef(0)
  const pathStartTime = useRef(-1)
  const lastPathInputRef = useRef({ selected: null, hovered: null })
  const [displayLabel, setDisplayLabel] = useState('')
  const displayLabelRef = useRef('')

  // Réordonner une fratrie (mode édition, administrateurs) : décalage animé de chaque nœud vers sa place
  // dans le placement affiché, état du geste en cours, soulèvement de la personne tenue
  const offsetsRef = useRef(new Map())
  const reorderRef = useRef(null)
  const liftScalesRef = useRef(new Map())
  const groupsCacheRef = useRef({ layout: null, groups: new Map() })
  const lastFrameRef = useRef(0)
  const reorderEnabledRef = useRef(reorderEnabled)
  const onReorderRef = useRef(onReorderSiblings)
  useEffect(() => { reorderEnabledRef.current = reorderEnabled }, [reorderEnabled])
  useEffect(() => { onReorderRef.current = onReorderSiblings }, [onReorderSiblings])

  // Rendu à la demande : la boucle rAF tourne mais ne redessine que si quelque chose a changé
  // (transform, états lissés, entrée, souris, annotations, image chargée, rendu React, resize).
  const needsRedrawRef = useRef(true)
  const lastAnnotationDataRef = useRef(null)
  const markDirty = useCallback(() => { needsRedrawRef.current = true }, [])
  useEffect(() => { needsRedrawRef.current = true })

  const imageCache = useImageCache(`${graphRevision}:${assetRevision}`, markDirty)

  // Position animée d'un nœud
  const getAnimatedPos = useCallback((node, time) => {
    const baseCx = node.x + node.width / 2 + (offsetsRef.current.get(node.id)?.x || 0)
    const baseCy = node.y + node.height / 2
    const rd = nodeRandomDataRef.current.get(node.id)
    if (!rd) return { cx: baseCx, cy: baseCy }

    let cx = baseCx + rd.offsetX
    let cy = baseCy + rd.offsetY

    cx += Math.sin(time * rd.floatSpeedX + rd.floatPhaseX) * rd.floatAmpX
    cy += Math.sin(time * rd.floatSpeedY + rd.floatPhaseY) * rd.floatAmpY

    if ((node._type === 'person' || node._type === 'unknown') && reorderRef.current?.phase !== 'dragging') {
      const mouse = mouseWorldPos.current
      const dx = cx - mouse.x
      const dy = cy - mouse.y
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (dist < REPULSION_RADIUS && dist > 1) {
        const force = (1 - dist / REPULSION_RADIUS) * REPULSION_STRENGTH
        cx += (dx / dist) * force
        cy += (dy / dist) * force
      }
    }

    return { cx, cy }
  }, [])

  const {
    isDragging, isZooming, zoomTimeoutRef, hasDragged,
    handleMouseDown, handleMouseMove, handleMouseUp,
    handleMouseLeave, handleWheel, handleClick,
  } = useGalaxyInteractions({
    canvasRef, transformRef, targetTransformRef,
    layoutDataRef, nodeRandomDataRef, entranceRef,
    hoveredNodeIdRef: hoveredNodeId, hoveredMediaKeyRef: hoveredMediaKey, mouseWorldPosRef: mouseWorldPos,
    getAnimatedPos, onPersonSelect, onMediaSelect,
    annotationHandlers,
    minScale: MIN_SCALE,
    maxScale: MAX_SCALE,
  })

  // ---------- Réordonner une fratrie ----------
  // Le glisser ne déplace une personne qu'à l'horizontale, parmi ses frères et sœurs. Pour chaque place visée,
  // le vrai placement est recalculé : l'arbre se réarrange pendant le geste et rien ne saute au lâcher.
  const getSiblingGroups = useCallback(() => {
    const layout = layoutDataRef.current
    if (groupsCacheRef.current.layout !== layout) groupsCacheRef.current = { layout, groups: buildSiblingGroups(layout) }
    return groupsCacheRef.current.groups
  }, [])

  const canReorderNow = useCallback(() => (
    reorderEnabledRef.current && (layoutModeRef.current === 'ascendance' || USE_BLOCK_LAYOUT) && Boolean(layoutDataRef.current) && Boolean(entranceRef.current?.finished)
  ), [])

  const worldX = useCallback((clientX) => {
    const rect = canvasRef.current?.getBoundingClientRect()
    const t = transformRef.current
    return rect ? (clientX - rect.left - t.x) / t.scale : 0
  }, [])

  // Personne réordonnable sous le pointeur
  const reorderTargetAt = useCallback((clientX, clientY) => {
    if (!canReorderNow()) return null
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return null
    const t = transformRef.current
    const wx = (clientX - rect.left - t.x) / t.scale
    const wy = (clientY - rect.top - t.y) / t.scale
    const groups = getSiblingGroups()
    const now = performance.now()
    for (const node of layoutDataRef.current.children) {
      if (node._type !== 'person' || !groups.has(node.id)) continue
      const pos = getAnimatedPos(node, now)
      if (Math.hypot(pos.cx - wx, pos.cy - wy) < nodeRadius(node)) return node
    }
    return null
  }, [canReorderNow, getSiblingGroups, getAnimatedPos])

  // Placement complet pour un ordre de la fratrie, recalé sur la source (les parents ne bougent pas)
  const layoutForOrder = useCallback((group, order, base) => {
    const graph = {
      persons: graphPersons,
      unions: graphUnions,
      filiations: filiationsWithOrder(graphFiliations, graphUnions, group.source, order),
    }
    // Le réordonnancement recalcule le placement du mode en cours (l'ascendance garde sa racine)
    const result = layoutModeRef.current === 'ascendance'
      ? computeAscendanceLayout(graph, ascendanceRootRef.current)
      : computeBlockLayout(graph)
    const baseSource = base.children.find((n) => n.id === group.source)
    const source = result.children.find((n) => n.id === group.source)
    const shift = baseSource && source ? baseSource.x - source.x : 0
    if (shift) result.children.forEach((n) => { n.x += shift })
    return result
  }, [])

  // Remplace le placement affiché : chaque nœud garde sa position à l'écran puis glisse vers sa nouvelle place
  const swapLayout = useCallback((next, frontId = null) => {
    const prev = layoutDataRef.current
    if (!prev || !next) return
    const prevById = new Map(prev.children.map((n) => [n.id, n]))
    const offsets = offsetsRef.current
    const reduce = prefersReducedMotion()
    for (const node of next.children) {
      const old = prevById.get(node.id)
      if (!old) continue
      const current = offsets.get(node.id)
      const delta = old.x + (current?.x || 0) - node.x
      if (reduce && node.id !== frontId) { offsets.delete(node.id); continue }
      if (Math.abs(delta) > 0.01 || current) offsets.set(node.id, { x: delta, v: current?.v || 0, spring: current?.spring || SHIFT_SPRING })
    }
    if (frontId) {
      const i = next.children.findIndex((n) => n.id === frontId)
      if (i >= 0) next.children.push(...next.children.splice(i, 1))
    }
    layoutDataRef.current = next
    needsRedrawRef.current = true
  }, [])

  // Envoie l'ordre ; en cas d'échec, l'arbre revient en glissant à l'ordre précédent
  const commitOrder = useCallback((group, order, base) => {
    const payload = buildOrderPayload(graphFiliations, graphUnions, group.source, order)
    const result = onReorderRef.current?.(payload)
    if (result && typeof result.catch === 'function') {
      result.catch(() => { if (!reorderRef.current) swapLayout(base) })
    }
  }, [swapLayout])

  const reorderWindowListeners = useRef(null)

  const endReorder = useCallback((commit) => {
    const drag = reorderRef.current
    if (reorderWindowListeners.current) {
      window.removeEventListener('mousemove', reorderWindowListeners.current.move)
      window.removeEventListener('mouseup', reorderWindowListeners.current.up)
      reorderWindowListeners.current = null
    }
    if (!drag) return
    clearTimeout(drag.timer)
    reorderRef.current = null
    if (drag.phase !== 'dragging') return
    const offset = offsetsRef.current.get(drag.nodeId)
    if (offset) offsetsRef.current.set(drag.nodeId, { ...offset, v: 0, spring: DROP_SPRING })
    if (canvasRef.current) canvasRef.current.style.cursor = 'grab'
    if (!commit) {
      swapLayout(drag.base, drag.nodeId)
    } else if (drag.index !== drag.originalIndex) {
      commitOrder(drag.group, moveInOrder(drag.group.ids, drag.nodeId, drag.index), drag.base)
    }
    needsRedrawRef.current = true
  }, [swapLayout, commitOrder])

  const updateReorder = useCallback((clientX) => {
    const drag = reorderRef.current
    if (drag?.phase !== 'dragging') return
    const slots = drag.slots
    drag.targetCenter = rubberBand(worldX(clientX) - drag.grab, slots[0], slots[slots.length - 1])
    const index = pickSlot(slots, drag.targetCenter, drag.index)
    if (index !== drag.index) {
      drag.index = index
      if (!drag.layouts.has(index)) drag.layouts.set(index, layoutForOrder(drag.group, moveInOrder(drag.group.ids, drag.nodeId, index), drag.base))
      swapLayout(drag.layouts.get(index), drag.nodeId)
    }
    needsRedrawRef.current = true
  }, [worldX, layoutForOrder, swapLayout])

  const startReorder = useCallback((clientX) => {
    const press = reorderRef.current
    const base = layoutDataRef.current
    const group = press && getSiblingGroups().get(press.nodeId)
    const node = group && base.children.find((n) => n.id === press.nodeId)
    if (!node) { reorderRef.current = null; return }
    clearTimeout(press.timer)
    const byId = new Map(base.children.map((n) => [n.id, n]))
    const index = group.ids.indexOf(press.nodeId)
    const visualCenter = centerX(node) + (offsetsRef.current.get(node.id)?.x || 0)
    reorderRef.current = {
      phase: 'dragging',
      nodeId: press.nodeId,
      group,
      base,
      slots: group.ids.map((id) => centerX(byId.get(id))),
      index,
      originalIndex: index,
      layouts: new Map([[index, base]]),
      grab: worldX(clientX) - visualCenter,
      targetCenter: visualCenter,
      pointer: press.pointer,
    }
    swapLayout(base, press.nodeId)
    // Le geste n'est ni un panoramique ni un clic
    isDragging.current = false
    hasDragged.current = true
    hoveredNodeId.current = null
    if (canvasRef.current) canvasRef.current.style.cursor = 'grabbing'
    if (press.pointer === 'touch') navigator.vibrate?.(8)
    if (press.pointer === 'mouse') {
      const move = (e) => updateReorder(e.clientX)
      const up = () => endReorder(true)
      reorderWindowListeners.current = { move, up }
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
    }
  }, [getSiblingGroups, worldX, swapLayout, updateReorder, endReorder, isDragging, hasDragged])

  // Appui sur une personne réordonnable : la souris attend quelques pixels, le doigt un appui long
  const beginReorderPress = useCallback((clientX, clientY, pointer) => {
    const node = reorderTargetAt(clientX, clientY)
    if (!node) return false
    const press = { phase: 'pressing', nodeId: node.id, pointer, startX: clientX, startY: clientY, lastX: clientX, timer: null }
    if (pointer === 'touch') press.timer = setTimeout(() => { if (reorderRef.current === press) startReorder(press.lastX) }, REORDER_LONG_PRESS_MS)
    reorderRef.current = press
    return true
  }, [reorderTargetAt, startReorder])

  // Flèches de la fiche : même animation, une place à gauche ou à droite
  const moveSibling = useCallback((personId, delta) => {
    if (reorderRef.current || !canReorderNow()) return false
    const nodeId = `p-${personId}`
    const group = getSiblingGroups().get(nodeId)
    if (!group) return false
    const index = group.ids.indexOf(nodeId)
    const target = index + delta
    if (target < 0 || target >= group.ids.length) return false
    const base = layoutDataRef.current
    const order = moveInOrder(group.ids, nodeId, target)
    swapLayout(layoutForOrder(group, order, base), nodeId)
    commitOrder(group, order, base)
    return true
  }, [canReorderNow, getSiblingGroups, swapLayout, layoutForOrder, commitOrder])

  const getSiblingPlace = useCallback((personId) => {
    if (layoutMode !== 'ascendance' && !USE_BLOCK_LAYOUT) return null
    if (!layoutDataRef.current) return null
    const group = getSiblingGroups().get(`p-${personId}`)
    return group ? { index: group.ids.indexOf(`p-${personId}`), count: group.ids.length } : null
  }, [getSiblingGroups, layoutMode])

  // Échap annule le glisser en cours
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && reorderRef.current?.phase === 'dragging') endReorder(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [endReorder])

  // Sortie du mode édition pendant un geste : on annule
  useEffect(() => { if (!reorderEnabled && reorderRef.current) endReorder(false) }, [reorderEnabled, endReorder])

  // Expose zoom API to parent (ZoomControl component), posée au commit et non pendant le rendu
  useImperativeHandle(zoomApiRef, () => ({
    zoomTo: (newScale) => {
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const cx = rect.width / 2
      const cy = rect.height / 2
      const base = targetTransformRef.current
      const clamped = Math.min(MAX_SCALE, Math.max(MIN_SCALE, newScale))
      const ratio = clamped / base.scale
      targetTransformRef.current = {
        scale: clamped,
        x: cx - ratio * (cx - base.x),
        y: cy - ratio * (cy - base.y),
      }
    },
    resetZoom: () => {
      if (initialTransformRef.current) {
        targetTransformRef.current = { ...initialTransformRef.current }
      }
    },
    // Recherche : glisse jusqu'à la personne, dans la partie de l'écran que la fiche ne couvre pas
    // (fiche à gauche sur ordinateur, 408 px ; par le bas sur téléphone)
    focusPerson: (personId) => {
      const canvas = canvasRef.current
      const node = layoutDataRef.current?.children.find(n => n.id === `p-${personId}`)
      if (!canvas || !node) return
      const rect = canvas.getBoundingClientRect()
      const pos = getAnimatedPos(node, performance.now())
      const scale = Math.min(MAX_SCALE, Math.max(targetTransformRef.current.scale, 1))
      const phone = rect.width <= 768
      const screenX = phone ? rect.width / 2 : (408 + rect.width) / 2
      const screenY = phone ? rect.height * 0.22 : rect.height / 2
      targetTransformRef.current = { scale, x: screenX - pos.cx * scale, y: screenY - pos.cy * scale }
    },
    getScale: () => transformRef.current.scale,
    moveSibling,
    getSiblingPlace,
    MIN_SCALE,
    MAX_SCALE,
  }), [getAnimatedPos, moveSibling, getSiblingPlace])

  // Zoom util (used by pinch)
  const zoomAt = useCallback((factor, center) => {
    const base = targetTransformRef.current
    const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, base.scale * factor))
    const ratio = newScale / base.scale
    isZooming.current = true
    if (zoomTimeoutRef.current) clearTimeout(zoomTimeoutRef.current)
    zoomTimeoutRef.current = setTimeout(() => { isZooming.current = false }, 220)
    targetTransformRef.current = {
      scale: newScale,
      x: center.x - ratio * (center.x - base.x),
      y: center.y - ratio * (center.y - base.y),
    }
  }, [isZooming, targetTransformRef, zoomTimeoutRef])

  // Resize canvas to device pixel ratio
  useEffect(() => {
    const resize = () => {
      const canvas = canvasRef.current
      if (!canvas) return
      const cssW = window.innerWidth
      const cssH = window.innerHeight
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      dprRef.current = dpr
      canvas.width = Math.floor(cssW * dpr)
      canvas.height = Math.floor(cssH * dpr)
      canvas.style.width = `${cssW}px`
      canvas.style.height = `${cssH}px`
      needsRedrawRef.current = true
    }
    resize()
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])

  // Layout
  useEffect(() => {
    // Mode Ascendance : sous-graphe construit autour de la personne racine (racine explicite,
    // sinon personne de départ configurée, sinon sélection en cours, sinon personne la plus connectée)
    const isAscendance = layoutMode === 'ascendance'
    const result = isAscendance
      ? computeAscendanceLayout(null, ascendanceRootId ?? focusPersonIdRef.current ?? selectedPersonIdRef.current ?? null)
      : (USE_BLOCK_LAYOUT ? computeBlockLayout() : computeLayout())
    ascendanceRootRef.current = result.ascendanceRootId ?? null

    const canvas = canvasRef.current
    if (!canvas) return
    if (!result.children.length) {
      layoutDataRef.current = result
      needsRedrawRef.current = true
      setLayoutReady(true)
      return
    }
    const cssW = canvas.clientWidth || window.innerWidth
    const cssH = canvas.clientHeight || window.innerHeight

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    result.children.forEach(n => {
      minX = Math.min(minX, n.x)
      minY = Math.min(minY, n.y)
      maxX = Math.max(maxX, n.x + n.width)
      maxY = Math.max(maxY, n.y + n.height)
    })
    const graphW = maxX - minX
    const graphH = maxY - minY
    const maxInitScale = 1.2
    const padding = 80
    const fitScale = Math.min(
      (cssW - padding * 2) / Math.max(graphW, 1),
      (cssH - padding * 2) / Math.max(graphH, 1),
      maxInitScale,
    )
    let scale = Math.max(MIN_SCALE, fitScale)
    let offsetX = (cssW - graphW * scale) / 2 - minX * scale
    let offsetY = (cssH - graphH * scale) / 2 - minY * scale

    // Grand arbre : vu en entier, les portraits deviennent des pastilles illisibles.
    // On ouvre sur la personne de départ, à une taille où l'on reconnaît les visages.
    // En mode Ascendance, la personne de départ est la racine de la vue (les ancêtres au-dessus).
    const focusId = isAscendance && result.ascendanceRootId != null
      ? result.ascendanceRootId
      : focusPersonIdRef.current
    const personNodes = result.children.filter((n) => n._type === 'person')
    let focusNode = focusId != null
      ? personNodes.find((n) => String(n._data?.id) === String(focusId))
      : null
    // Sans personne de départ : la personne avec un portrait la plus proche du centre de la famille
    if (!focusNode && personNodes.length > 0) {
      const cx = personNodes.reduce((sum, n) => sum + n.x + n.width / 2, 0) / personNodes.length
      const cy = personNodes.reduce((sum, n) => sum + n.y + n.height / 2, 0) / personNodes.length
      const candidates = personNodes.some((n) => n._data?.photo) ? personNodes.filter((n) => n._data?.photo) : personNodes
      focusNode = candidates.reduce((best, n) => {
        const d = (n.x + n.width / 2 - cx) ** 2 + (n.y + n.height / 2 - cy) ** 2
        return !best || d < best.d ? { n, d } : best
      }, null)?.n || null
    }
    if (focusNode && fitScale < FOCUS_MIN_READABLE_SCALE) {
      scale = FOCUS_SCALE
      offsetX = cssW / 2 - (focusNode.x + focusNode.width / 2) * scale
      // En ascendance la racine est en bas de la vue : on la pose plus bas pour garder les ancêtres visibles
      offsetY = cssH * (isAscendance ? 0.72 : 0.42) - (focusNode.y + focusNode.height / 2) * scale
    }

    const init = { x: offsetX, y: offsetY, scale }
    initialTransformRef.current = init
    transformRef.current = init
    targetTransformRef.current = init
    nodeRandomDataRef.current = generateNodeRandomData(result.children, result.edges)

    // Construire le schedule d'animation d'entrée
    const genGroups = new Map()
    result.children.forEach(node => {
      const gen = node._generation ?? 0
      if (!genGroups.has(gen)) genGroups.set(gen, [])
      genGroups.get(gen).push(node)
    })
    genGroups.forEach(group => group.sort((a, b) => a.x - b.x))

    const nodeSchedule = new Map()
    const coupleSchedule = new Map()
    const edgeSchedule = new Map()
    const orbitSchedule = new Map()
    let maxEndMs = 0

    // Délais réduits sur les grands arbres pour que l'entrée reste courte (voir constants.js)
    const genDelay = Math.min(ENTRANCE_GEN_DELAY, ENTRANCE_MAX_GEN_SPAN / Math.max(1, genGroups.size - 1))
    genGroups.forEach((nodes, gen) => {
      const genStart = gen * genDelay
      const nodeStagger = Math.min(ENTRANCE_NODE_STAGGER, ENTRANCE_MAX_NODE_SPAN / Math.max(1, nodes.length - 1))
      nodes.forEach((node, idx) => {
        const startMs = genStart + idx * nodeStagger + Math.random() * 40
        nodeSchedule.set(node.id, { startMs, duration: ENTRANCE_NODE_DURATION })
        maxEndMs = Math.max(maxEndMs, startMs + ENTRANCE_NODE_DURATION)
      })
    })

    coupleBarMeta.forEach(({ elkId, p1Key, p2Key }) => {
      const s1 = nodeSchedule.get(p1Key)
      const s2 = nodeSchedule.get(p2Key)
      if (s1 && s2) {
        const startMs = Math.max(s1.startMs, s2.startMs) + ENTRANCE_NODE_DURATION * 0.5 + ENTRANCE_LINE_DELAY * 0.3
        coupleSchedule.set(elkId, { startMs, duration: ENTRANCE_LINE_DURATION })
        maxEndMs = Math.max(maxEndMs, startMs + ENTRANCE_LINE_DURATION)
      }
    })

    if (result.edges) {
      result.edges.forEach(edge => {
        const sourceId = edge.sources[0]
        const sSource = nodeSchedule.get(sourceId)
        if (sSource) {
          const startMs = sSource.startMs + ENTRANCE_LINE_DELAY
          edgeSchedule.set(edge.id, { startMs, duration: ENTRANCE_LINE_DURATION })
          maxEndMs = Math.max(maxEndMs, startMs + ENTRANCE_LINE_DURATION)
        }
      })
    }

    result.children.forEach(node => {
      if (node._type !== 'person') return
      const sNode = nodeSchedule.get(node.id)
      if (!sNode) return
      const pMedias = getPersonMedias(node._data.id)
      const count = Math.min(pMedias.length, MAX_ORBIT_MEDIAS)
      for (let i = 0; i < count; i++) {
        const startMs = sNode.startMs + sNode.duration + ENTRANCE_ORBIT_DELAY + i * ENTRANCE_ORBIT_STAGGER
        orbitSchedule.set(`${node.id}:${i}`, { startMs, duration: ENTRANCE_ORBIT_DURATION })
        maxEndMs = Math.max(maxEndMs, startMs + ENTRANCE_ORBIT_DURATION)
      }
    })

    entranceRef.current = {
      startTime: -1,
      nodeSchedule, coupleSchedule, edgeSchedule, orbitSchedule,
      totalDurationMs: maxEndMs,
      finished: false,
    }

    offsetsRef.current = new Map()
    reorderRef.current = null
    layoutDataRef.current = result
    needsRedrawRef.current = true
    setLayoutReady(true)
  }, [graphRevision, layoutMode, ascendanceRootId])

  // Sync searchHighlightIds
  useEffect(() => {
    searchHighlightIdsRef.current = searchHighlightIds
  }, [searchHighlightIds])

  // Recalculer les proches immédiats
  useEffect(() => {
    const relatives = new Set()
    if (selectedPersonId != null) {
      getParents(selectedPersonId).forEach(p => relatives.add(`p-${p.id}`))
      getChildren(selectedPersonId).forEach(c => relatives.add(`p-${c.id}`))
      getPersonUnions(selectedPersonId).forEach(u => {
        const spouseId = u.partner1Id === selectedPersonId ? u.partner2Id : u.partner1Id
        relatives.add(`p-${spouseId}`)
      })
    }
    immediateRelativesRef.current = relatives
  }, [selectedPersonId])

  // Boucle d'animation + rendu canvas
  useEffect(() => {
    if (!layoutReady) return

    let rafId

    const animate = (timestamp) => {
      let dirty = needsRedrawRef.current
      needsRedrawRef.current = false

      const entrance = entranceRef.current
      if (entrance && entrance.startTime < 0) entrance.startTime = timestamp
      const elapsed = entrance ? timestamp - entrance.startTime : Infinity
      const entranceActive = entrance && !entrance.finished
      if (entranceActive && elapsed > entrance.totalDurationMs + 100) entrance.finished = true
      // Pendant l'entrée et le fondu des annotations qui la suit, on redessine chaque frame
      if (entrance && elapsed < entrance.totalDurationMs + 500) dirty = true

      // Lissage du transform
      const target = targetTransformRef.current
      const prev = transformRef.current
      const easing = isDragging.current ? 0.24 : isZooming.current ? 0.08 : 0.14
      const next = {
        x: approach(prev.x, target.x, easing, 0.05),
        y: approach(prev.y, target.y, easing, 0.05),
        scale: approach(prev.scale, target.scale, easing, 1e-4),
      }
      if (next.x !== prev.x || next.y !== prev.y || next.scale !== prev.scale) dirty = true
      transformRef.current = next

      // Réordonnancement : la personne tenue suit le pointeur, les autres glissent vers leur place
      const dt = lastFrameRef.current ? Math.min(0.034, (timestamp - lastFrameRef.current) / 1000) : 1 / 60
      lastFrameRef.current = timestamp
      const drag = reorderRef.current?.phase === 'dragging' ? reorderRef.current : null
      if (offsetsRef.current.size > 0) {
        for (const [id, state] of offsetsRef.current) {
          if (drag && id === drag.nodeId) continue
          const next = springStep(state, dt, state.spring)
          if (isSettled(next)) offsetsRef.current.delete(id)
          else offsetsRef.current.set(id, { ...next, spring: state.spring })
        }
        dirty = true
      }
      if (drag && layoutDataRef.current) {
        const held = layoutDataRef.current.children.find((n) => n.id === drag.nodeId)
        if (held) offsetsRef.current.set(drag.nodeId, { x: drag.targetCenter - centerX(held), v: 0, spring: DROP_SPRING })
        dirty = true
      }
      for (const [id, value] of liftScalesRef.current) {
        const target = drag && id === drag.nodeId ? 1 : 0
        const next = approach(value, target, 0.28, 0.002)
        if (next === 0 && target === 0) liftScalesRef.current.delete(id)
        else liftScalesRef.current.set(id, next)
        if (next !== value) dirty = true
      }
      if (drag && !liftScalesRef.current.has(drag.nodeId)) { liftScalesRef.current.set(drag.nodeId, 0); dirty = true }

      const layoutData = layoutDataRef.current
      const canvas = canvasRef.current
      if (!layoutData || !canvas) { rafId = requestAnimationFrame(animate); return }
      const { x, y, scale } = transformRef.current

      // Positions animées
      const posMap = new Map()
      layoutData.children.forEach(node => {
        posMap.set(node.id, getAnimatedPos(node, timestamp))
      })

      const nodeMap = new Map()
      layoutData.children.forEach(n => nodeMap.set(n.id, n))

      // Lissage hover states
      const hoverEasing = 0.12
      layoutData.children.forEach(node => {
        if (node._type !== 'person') return
        const targetScale = hoveredNodeId.current === node.id ? 1 : 0
        const prevScale = hoverScales.current.get(node.id) || 0
        const newScale = approach(prevScale, targetScale, hoverEasing)
        if (newScale !== prevScale) { dirty = true; hoverScales.current.set(node.id, newScale) }
        const rd = nodeRandomDataRef.current.get(node.id)
        const pMedias = getPersonMedias(node._data.id)
        const orbitSlots = rd?.orbitSlots || []
        const orbitCount = Math.min(pMedias.length, MAX_ORBIT_MEDIAS)
        const pos = posMap.get(node.id)
        for (let i = 0; i < orbitCount; i++) {
          const key = `${node.id}:${i}`
          const slot = orbitSlots[i]
          if (!slot || !pos) continue
          const isHovered = hoveredMediaKey.current === key
          const prevMh = mediaHoverState.current.get(key) || { scale: 0, dx: 0, dy: 0 }
          const dirX = Math.cos(slot.angle)
          const dirY = Math.sin(slot.angle)
          const targetS = isHovered ? 1 : 0
          const targetDx = isHovered ? dirX * 6 : 0
          const targetDy = isHovered ? dirY * 6 : 0
          const nextMh = {
            scale: approach(prevMh.scale, targetS, hoverEasing),
            dx: approach(prevMh.dx, targetDx, hoverEasing),
            dy: approach(prevMh.dy, targetDy, hoverEasing),
          }
          if (nextMh.scale !== prevMh.scale || nextMh.dx !== prevMh.dx || nextMh.dy !== prevMh.dy) {
            dirty = true
            mediaHoverState.current.set(key, nextMh)
          }
        }
      })

      // Lerp annotation drag lift (0 → 1)
      const dragTarget = annotationHandlers?.isDragging ? 1 : 0
      const prevLift = dragLiftProgress.current
      dragLiftProgress.current = approach(prevLift, dragTarget, 0.15, 0.005)
      if (dragLiftProgress.current !== prevLift) dirty = true
      // Outil d'annotation actif : l'aperçu suit la souris, on redessine
      if (annotationHandlers?.activeTool || annotationHandlers?.isDragging) dirty = true
      if (annotationData !== lastAnnotationDataRef.current) { lastAnnotationDataRef.current = annotationData; dirty = true }

      // Lissage glow sélection
      const selectedElkId = selectedPersonIdRef.current != null ? `p-${selectedPersonIdRef.current}` : null
      const selectionEasing = 0.08
      layoutData.children.forEach(node => {
        if (node._type !== 'person') return
        let targetGlow = 0
        if (selectedElkId) {
          if (node.id === selectedElkId) targetGlow = 1.0
          else if (immediateRelativesRef.current.has(node.id)) targetGlow = 0.6
        }
        const prevGlow = selectedGlowScales.current.get(node.id) || 0
        const nextGlow = approach(prevGlow, targetGlow, selectionEasing)
        if (nextGlow !== prevGlow) { dirty = true; selectedGlowScales.current.set(node.id, nextGlow) }
      })

      // Animation search highlight glow
      const searchEasing = 0.12
      const searchHighlightSet = new Set(searchHighlightIdsRef.current.map(id => `p-${id}`))
      layoutData.children.forEach(node => {
        if (node._type !== 'person') return
        const targetSearchGlow = searchHighlightSet.has(node.id) ? 1.2 : 0
        const prevSearchGlow = searchGlowScales.current.get(node.id) || 0
        const nextSearchGlow = approach(prevSearchGlow, targetSearchGlow, searchEasing)
        if (nextSearchGlow !== prevSearchGlow) { dirty = true; searchGlowScales.current.set(node.id, nextSearchGlow) }
      })

      // Chemin BFS
      const currentHovered = hoveredNodeId.current
      const pathInputChanged = lastPathInputRef.current.selected !== selectedElkId ||
                                lastPathInputRef.current.hovered !== currentHovered
      if (pathInputChanged) {
        dirty = true
        lastPathInputRef.current = { selected: selectedElkId, hovered: currentHovered }
        if (selectedElkId && currentHovered && currentHovered !== selectedElkId && currentHovered.startsWith('p-')) {
          const result = findPathBFS(selectedElkId, currentHovered, layoutData)
          pathNodesRef.current = result ? result.nodePath : []
          pathEdgesRef.current = result ? result.edgePath : []
          pathLabelRef.current = result ? result.label : ''
          pathStartTime.current = timestamp
        } else {
          pathNodesRef.current = []
          pathEdgesRef.current = []
          pathLabelRef.current = ''
          pathStartTime.current = -1
        }
      }

      // Lissage highlight chemin
      const PATH_EDGE_STAGGER = 120
      const PATH_EDGE_DURATION = 300
      const pathElapsed = pathStartTime.current > 0 ? timestamp - pathStartTime.current : -1
      const pathEasing = 0.12
      const activePathEdges = new Set(pathEdgesRef.current.map(e => e.id))
      const activePathNodes = new Set(pathNodesRef.current)

      for (let i = 0; i < pathEdgesRef.current.length; i++) {
        const e = pathEdgesRef.current[i]
        const staggeredTarget = pathElapsed >= 0
          ? easeOutCubic(Math.min(1, Math.max(0, (pathElapsed - i * PATH_EDGE_STAGGER) / PATH_EDGE_DURATION)))
          : 0
        if (pathProgressRef.current.get(e.id) !== staggeredTarget) { dirty = true; pathProgressRef.current.set(e.id, staggeredTarget) }
      }
      for (let i = 0; i < pathNodesRef.current.length; i++) {
        const n = pathNodesRef.current[i]
        const edgeIdx = Math.max(0, i - 1)
        const staggeredTarget = pathElapsed >= 0
          ? easeOutCubic(Math.min(1, Math.max(0, (pathElapsed - edgeIdx * PATH_EDGE_STAGGER) / PATH_EDGE_DURATION)))
          : 0
        if (pathProgressRef.current.get(n) !== staggeredTarget) { dirty = true; pathProgressRef.current.set(n, staggeredTarget) }
      }

      for (const [key, val] of pathProgressRef.current) {
        if (!activePathEdges.has(key) && !activePathNodes.has(key)) {
          dirty = true
          const next = val + (0 - val) * pathEasing
          if (Math.abs(next) < 0.001) pathProgressRef.current.delete(key)
          else pathProgressRef.current.set(key, next)
        }
      }

      const lastEdgeStart = (pathEdgesRef.current.length - 1) * PATH_EDGE_STAGGER
      const targetLabelAlpha = pathElapsed >= 0 && pathElapsed > lastEdgeStart ? 1 : 0
      const prevLabelAlpha = pathLabelAlpha.current
      pathLabelAlpha.current = approach(prevLabelAlpha, targetLabelAlpha, pathEasing)
      if (pathLabelAlpha.current !== prevLabelAlpha) dirty = true

      // Mise à jour de l'overlay HTML (seulement quand la valeur change)
      const newDisplayLabel = pathLabelAlpha.current > 0.05 ? pathLabelRef.current : ''
      if (newDisplayLabel !== displayLabelRef.current) {
        displayLabelRef.current = newDisplayLabel
        setDisplayLabel(newDisplayLabel)
      }

      // Rien n'a changé : on ne redessine pas
      if (!dirty) { rafId = requestAnimationFrame(animate); return }

      // === RENDU ===
      const ctx = canvas.getContext('2d')
      ctx.setTransform(dprRef.current, 0, 0, dprRef.current, 0, 0)
      drawBackground(ctx, canvas)
      ctx.save()
      ctx.translate(x, y)
      ctx.scale(scale, scale)

      // Fenêtre visible en coordonnées monde (culling + niveau de détail dans les renderers)
      const cssW = canvas.width / dprRef.current
      const cssH = canvas.height / dprRef.current
      const view = { x0: -x / scale, y0: -y / scale, x1: (cssW - x) / scale, y1: (cssH - y) / scale, scale }
      drawCoupleLinks(ctx, coupleBarMeta, posMap, nodeMap, nodeRandomDataRef.current, entrance, entranceActive, elapsed, view)
      drawFiliations(ctx, layoutData.edges, posMap, nodeMap, nodeRandomDataRef.current, entrance, entranceActive, elapsed, view)
      drawPathHighlight(ctx, {
        pathEdgesRef: pathEdgesRef.current,
        pathNodesRef: pathNodesRef.current,
        pathLabelAlpha: pathLabelAlpha.current,
        pathProgressRef: pathProgressRef.current,
        selectedElkId,
        hoveredNodeId: hoveredNodeId.current,
        coupleBarMeta,
        posMap, nodeMap,
        nodeRandomData: nodeRandomDataRef.current,
        layoutData,
      })
      drawNodes(ctx, layoutData, posMap, entrance, entranceActive, elapsed, {
        nodeRandomData: nodeRandomDataRef.current,
        imageCache: imageCache.current,
        hoverScales: hoverScales.current,
        selectedGlowScales: selectedGlowScales.current,
        searchGlowScales: searchGlowScales.current,
        mediaHoverState: mediaHoverState.current,
        entrance, entranceActive, elapsed,
        view,
        photoHint: photoHintRef.current,
        liftScales: liftScalesRef.current,
      })
      drawRenvoiPills(ctx)
      // Annotations dessinées APRES les noeuds pour que stickers/texte soient au-dessus
      // Annotations : ancrer aux personnes proches pour qu'elles suivent le layout
      const personPosMap = new Map()
      layoutData.children.forEach(node => {
        if (node._type === 'person') {
          const pos = posMap.get(node.id)
          if (pos) personPosMap.set(node._data.id, pos)
        }
      })
      const anchoredAnnotations = annotationData.map((ann) => {
        let anchorId = ann.anchorId || null
        let offsetX = ann.offsetX ?? 0
        let offsetY = ann.offsetY ?? 0

        if (!anchorId) {
          // Trouver la personne la plus proche et stocker l'offset
          let nearestId = null
          let nearestD2 = Infinity
          for (const [pid, pos] of personPosMap.entries()) {
            const dx = ann.x - pos.cx
            const dy = ann.y - pos.cy
            const d2 = dx * dx + dy * dy
            if (d2 < nearestD2) {
              nearestD2 = d2
              nearestId = pid
              offsetX = dx
              offsetY = dy
            }
          }
          if (nearestId) {
            anchorId = nearestId
            ann.anchorId = nearestId
            ann.offsetX = offsetX
            ann.offsetY = offsetY
          }
        }

        const base = anchorId ? personPosMap.get(anchorId) : null
        const drawX = base ? base.cx + offsetX : ann.x
        const drawY = base ? base.cy + offsetY : ann.y
        // Keep underlying data in sync so hitTest/drag use the drawn position
        ann.x = drawX
        ann.y = drawY
        return { ...ann, x: drawX, y: drawY }
      })

      // Afficher les annotations en dernier, après l'animation d'entrée
      const stickerPreview = annotationHandlers?.activeTool === 'sticker' && annotationHandlers?.selectedSticker
        ? { emoji: annotationHandlers.selectedSticker, x: mouseWorldPos.current.x, y: mouseWorldPos.current.y, fontSize: 40 }
        : null
      const draggingAnnotationId = annotationHandlers?.isDragging ? annotationHandlers.selectedAnnotationId : null
      const entranceAlpha = !entranceActive ? 1 : Math.min(1, Math.max(0, (elapsed - entrance.totalDurationMs) / 300))
      if (entranceAlpha > 0) {
        drawAnnotations(
          ctx,
          anchoredAnnotations,
          annotationHandlers?.selectedAnnotationId ?? null,
          annotationHandlers?.drawingPathRef?.current ?? null,
          stickerPreview,
          draggingAnnotationId,
          dragLiftProgress.current,
          entranceAlpha,
          imageCache.current,
        )
      }
      ctx.restore()

      rafId = requestAnimationFrame(animate)
    }

    rafId = requestAnimationFrame(animate)
    return () => {
      cancelAnimationFrame(rafId)
      if (zoomTimeoutRef.current) clearTimeout(zoomTimeoutRef.current)
    }
  }, [layoutReady, getAnimatedPos, isDragging, isZooming, zoomTimeoutRef, imageCache])

  // Prevent default wheel
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const prevent = (e) => e.preventDefault()
    canvas.addEventListener('wheel', prevent, { passive: false })
    return () => canvas.removeEventListener('wheel', prevent)
  }, [])

  return (
    <>
    <canvas
      ref={canvasRef}
      className="galaxy-canvas"
      style={{ touchAction: 'none' }}
      onMouseDown={(e) => {
        if (e.button === 0 && beginReorderPress(e.clientX, e.clientY, 'mouse')) { hasDragged.current = false; return }
        handleMouseDown(e)
      }}
      onMouseMove={(e) => {
        needsRedrawRef.current = true
        const press = reorderRef.current
        if (press?.phase === 'dragging') return
        if (press?.phase === 'pressing' && press.pointer === 'mouse') {
          if (Math.abs(e.clientX - press.startX) > REORDER_MOUSE_THRESHOLD || Math.abs(e.clientY - press.startY) > REORDER_MOUSE_THRESHOLD) {
            startReorder(press.startX)
            updateReorder(e.clientX)
          }
          return
        }
        handleMouseMove(e)
        // En mode édition, une personne réordonnable se saisit
        if (canvasRef.current && hoveredNodeId.current && reorderEnabledRef.current && getSiblingGroups().has(hoveredNodeId.current)) {
          canvasRef.current.style.cursor = 'grab'
        }
      }}
      onMouseUp={(e) => {
        const press = reorderRef.current
        if (press?.phase === 'pressing') reorderRef.current = null
        if (press?.phase === 'dragging') return
        handleMouseUp(e)
      }}
      onMouseLeave={(e) => { needsRedrawRef.current = true; if (reorderRef.current?.phase !== 'dragging') handleMouseLeave(e) }}
      onWheel={handleWheel}
      onTouchStart={(e) => {
        if (e.touches.length === 1) {
          const t = e.touches[0]
          // Appui long sur une personne réordonnable ; d'ici là, le doigt fait défiler l'arbre comme d'habitude
          beginReorderPress(t.clientX, t.clientY, 'touch')
          handleMouseDown({ clientX: t.clientX, clientY: t.clientY, preventDefault: () => e.preventDefault() })
        } else if (e.touches.length === 2) {
          e.preventDefault()
          // Un deuxième doigt annule le glisser d'une personne (retour à sa place, rien n'est enregistré)
          if (reorderRef.current) endReorder(false)
          // Stop any ongoing single-finger pan before starting pinch
          handleMouseUp()
          const [a, b] = e.touches
          const dx = a.clientX - b.clientX
          const dy = a.clientY - b.clientY
          const dist = Math.hypot(dx, dy)
          const center = { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 }
          pinchRef.current = { dist, center }
        }
      }}
      onTouchMove={(e) => {
        needsRedrawRef.current = true
        if (e.touches.length === 1) {
          const t = e.touches[0]
          const press = reorderRef.current
          if (press?.phase === 'dragging') { updateReorder(t.clientX); return }
          if (press?.phase === 'pressing') {
            press.lastX = t.clientX
            if (Math.hypot(t.clientX - press.startX, t.clientY - press.startY) > REORDER_TOUCH_SLOP) endReorder(false)
          }
          handleMouseMove({ clientX: t.clientX, clientY: t.clientY, preventDefault: () => e.preventDefault() })
        } else if (e.touches.length === 2) {
          e.preventDefault()
          const [a, b] = e.touches
          const dx = a.clientX - b.clientX
          const dy = a.clientY - b.clientY
          const dist = Math.hypot(dx, dy)
          const center = { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 }
          if (pinchRef.current) {
            const factor = dist / pinchRef.current.dist
            zoomAt(factor, center)
            pinchRef.current = { dist, center }
          } else {
            pinchRef.current = { dist, center }
          }
        }
      }}
      onTouchEnd={(e) => {
        if (reorderRef.current && e.touches.length === 0) {
          const wasDragging = reorderRef.current.phase === 'dragging'
          endReorder(true)
          if (wasDragging) { handleMouseUp(); return }
        }
        pinchRef.current = null
        if (e.touches.length === 1) {
          // One finger remains after pinch: restart single-finger pan with it
          // and mark hasDragged=true so the lift doesn't fire an accidental click
          const t = e.touches[0]
          handleMouseUp()
          handleMouseDown({ clientX: t.clientX, clientY: t.clientY, preventDefault: () => e.preventDefault() })
          hasDragged.current = true
        } else {
          handleMouseUp()
        }
      }}
      onTouchCancel={() => {
        // System interruption (notification, keyboard, etc.) — reset all touch state
        if (reorderRef.current) endReorder(false)
        pinchRef.current = null
        handleMouseUp()
      }}
      onClick={handleClick}
    />
    {displayLabel && (
      <div className="path-label-overlay">{displayLabel}</div>
    )}
    </>
  )
}

export default memo(Galaxy)
