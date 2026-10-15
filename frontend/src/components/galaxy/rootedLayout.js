import { persons as globalPersons, unions as globalUnions, filiations as globalFiliations } from '../../data/mockData'
import { computePedigreeLayout } from './pedigreeLayout'

// ============================================================
// Layout « rooted » : l'arbre généalogique classique organisé
// autour d'une personne racine (?layout=rooted&root=<id>).
//
// Les générations sont relatives à la racine (ancêtres au-dessus,
// descendants en dessous, voir elkLayout.computeRootedGenerations)
// et chaque chaîne de couple est ancrée au-dessus de son enfant de
// la ligne directe : la barre d'union à la verticale de l'enfant,
// la lignée du père à gauche, celle de la mère à droite, les
// collatéraux à l'extérieur de leur lignée (voir pedigreeLayout).
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
  const result = computePedigreeLayout(graphData, rootId)
  result.rootPersonId = rootId
  return result
}
