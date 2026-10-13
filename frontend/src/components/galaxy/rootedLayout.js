import { persons as globalPersons, unions as globalUnions, filiations as globalFiliations } from '../../data/mockData'
import { computeBlockLayout } from './blockLayout'

// ============================================================
// Layout « rooted » : blocs familiaux organisés autour d'une
// personne racine (?layout=rooted&root=<id>).
//
// Les générations sont relatives à la racine (ancêtres au-dessus,
// descendants en dessous, voir elkLayout.computeRootedGenerations)
// et les lignées sont placées par proximité avec elle (voir
// blockLayout.computeBlockLayout) : la chaîne d'un couple partagé
// par deux lignées est placée sous celle qui est la plus proche de
// la racine, ce qui raccourcit les arêtes inter-branches et réduit
// les renvois « Voir les parents ».
// ============================================================

// Racine de repli déterministe (id invalide ou absent) : la personne
// la plus connectée de l'arbre, à égalité la plus petite identité.
export function resolveRootPersonId(graphData = null, rootPersonId = null) {
  const persons = graphData?.persons || globalPersons
  const unions = graphData?.unions || globalUnions
  const filiations = graphData?.filiations || globalFiliations

  if (rootPersonId != null && rootPersonId !== '') {
    const found = persons.find(p => String(p.id) === String(rootPersonId))
    if (found) return found.id
    console.warn(`Layout « rooted » : personne racine « ${rootPersonId} » introuvable, repli déterministe sur la personne la plus connectée`)
  }

  const degree = new Map()
  const bump = (pid, n) => degree.set(pid, (degree.get(pid) || 0) + n)
  persons.forEach(p => degree.set(p.id, 0))
  unions.forEach(u => {
    bump(u.partner1Id, 1)
    bump(u.partner2Id, 1)
  })
  filiations.forEach(f => {
    bump(f.childId, 1)
    if (f.parentId) bump(f.parentId, 1)
  })

  let best = null
  for (const p of persons) {
    const d = degree.get(p.id) || 0
    if (!best || d > best.d || (d === best.d && String(p.id) < String(best.id))) best = { id: p.id, d }
  }
  return best ? best.id : null
}

export function computeRootedLayout(graphData = null, rootPersonId = null) {
  const rootId = resolveRootPersonId(graphData, rootPersonId)
  const result = computeBlockLayout(graphData, rootId != null ? { rootPersonId: rootId } : {})
  result.rootPersonId = rootId
  return result
}
