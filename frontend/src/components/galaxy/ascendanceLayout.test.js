import { describe, it, expect } from 'vitest'
import {
  computeAscendanceLayout,
  buildAscendanceView,
  pickDefaultAscendanceRoot,
  assignAscendanceGenerations,
} from './ascendanceLayout'
import { computeBlockLayout } from './blockLayout'
import { coupleBarMeta, componentOrderPerGen } from './elkLayout'
import { buildSiblingGroups } from './siblingReorder'
import { RENVOI_MIN_DX } from './constants'

const person = (id) => ({ id, firstName: id, lastName: '' })
const union = (id, partner1Id, partner2Id, displayOrder = 1) => ({ id, partner1Id, partner2Id, displayOrder })
const fil = (id, childId, unionId, extra = {}) => ({ id, childId, parentId: null, unionId, parentageType: 'biologique', displayOrder: 1, ...extra })
const filDirect = (id, childId, parentId, extra = {}) => ({ id, childId, parentId, unionId: null, parentageType: 'biologique', displayOrder: 1, ...extra })

// Écart vertical entre deux générations : PERSON_H (120) + écart inter-générations (60)
const GEN_HEIGHT = 180

// --- Helpers d'invariants ---

const byId = (layout) => new Map(layout.children.map((n) => [n.id, n]))
const cx = (node) => node.x + node.width / 2
const personIds = (layout) => layout.children.filter((n) => n._type === 'person').map((n) => n._data.id)
const edgeBetween = (layout, source, target) => layout.edges.find((e) => e.sources[0] === source && e.targets[0] === target)

// Chaque personne apparaît au plus une fois dans la vue
const expectUniquePersons = (layout) => {
  const ids = layout.children.filter((n) => n._type === 'person').map((n) => n.id)
  expect(new Set(ids).size, 'personne dupliquée dans la vue').toBe(ids.length)
}

// Pas de chevauchement horizontal entre nœuds d'une même génération
// (les conjoints isolés _compact se collent volontairement à leur partenaire)
const expectNoOverlapWithinGenerations = (layout) => {
  const byGen = new Map()
  for (const n of layout.children) {
    if (!byGen.has(n._generation)) byGen.set(n._generation, [])
    byGen.get(n._generation).push(n)
  }
  for (const [gen, nodes] of byGen) {
    const sorted = [...nodes].sort((a, b) => a.x - b.x)
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]
      const cur = sorted[i]
      if (prev._compact || cur._compact) continue
      expect(cur.x, `chevauchement en génération ${gen} entre ${prev.id} et ${cur.id}`).toBeGreaterThanOrEqual(prev.x + prev.width)
    }
  }
}

// En ascendance les parents sont au-dessus : chaque arête remonte (cas acycliques)
const expectEdgesPointUp = (layout) => {
  const map = byId(layout)
  for (const e of layout.edges) {
    expect(map.get(e.sources[0]).y, `l’arête ${e.id} ne remonte pas`).toBeLessThan(map.get(e.targets[0]).y)
  }
}

const serializeLayout = (layout) => JSON.stringify({
  nodes: layout.children.map((n) => `${n.id}:${n.x},${n.y}`).sort(),
  edges: layout.edges.map((e) => `${e.id}:${e.sources[0]}>${e.targets[0]}:${e._renvoi ? 'R' : ''}${e._secondary ? 'S' : ''}`).sort(),
})

// ============================================================
// 1. Racine sans parent connu
// ============================================================
describe('computeAscendanceLayout — racine sans parent connu', () => {
  // La racine a un conjoint et un enfant : le mode Ascendance ne montre que ses ancêtres
  const graph = {
    persons: ['r', 'sp', 'k'].map(person),
    unions: [union('uR', 'r', 'sp')],
    filiations: [fil('fR', 'k', 'uR')],
  }

  it('ne garde que la racine dans la vue, marquée comme telle', () => {
    const layout = computeAscendanceLayout(graph, 'r')
    expect(personIds(layout)).toEqual(['r'])
    expect(layout.edges).toEqual([])
    expect(layout.ascendanceRootId).toBe('r')
    const map = byId(layout)
    expect(map.get('p-r')._ascendanceRoot).toBe(true)
  })

  it('exclut le conjoint et les enfants de la racine de la vue', () => {
    const view = buildAscendanceView(graph, 'r')
    expect(view.persons.map((p) => p.id)).toEqual(['r'])
    expect(view.unions).toEqual([])
    expect(view.filiations).toEqual([])
  })
})

// ============================================================
// 2. Racine avec deux parents connus (génération immédiatement supérieure)
// ============================================================
describe('computeAscendanceLayout — deux parents connus', () => {
  const graph = {
    persons: ['r', 'p', 'm'].map(person),
    unions: [union('u1', 'p', 'm')],
    filiations: [fil('f1', 'r', 'u1')],
  }

  it('place les parents exactement une génération au-dessus de la racine', () => {
    const layout = computeAscendanceLayout(graph, 'r')
    const map = byId(layout)
    expect(personIds(layout).sort()).toEqual(['m', 'p', 'r'])
    expect(map.get('u-u1')).toBeDefined()
    expect(map.get('p-p')._generation).toBe(map.get('p-r')._generation - 1)
    expect(map.get('p-m')._generation).toBe(map.get('p-r')._generation - 1)
    expect(map.get('p-r').y - map.get('p-p').y).toBe(GEN_HEIGHT)
    expect(map.get('p-r').y - map.get('p-m').y).toBe(GEN_HEIGHT)
    expectEdgesPointUp(layout)
    expectNoOverlapWithinGenerations(layout)
  })

  it('place le père et la mère de part et d’autre du centre de leur union, centrée sur la racine', () => {
    const layout = computeAscendanceLayout(graph, 'r')
    const map = byId(layout)
    expect(Math.abs(cx(map.get('u-u1')) - cx(map.get('p-r')))).toBeLessThan(1)
    expect(map.get('p-p').x + map.get('p-p').width).toBeLessThanOrEqual(map.get('u-u1').x)
    expect(map.get('p-m').x).toBeGreaterThanOrEqual(map.get('u-u1').x + map.get('u-u1').width)
  })

  it('garde la filiation en lien direct (ni secondaire ni renvoi)', () => {
    const layout = computeAscendanceLayout(graph, 'r')
    const edge = edgeBetween(layout, 'u-u1', 'p-r')
    expect(edge).toBeDefined()
    expect(edge._secondary).toBeUndefined()
    expect(edge._renvoi).toBeUndefined()
  })

  it('ne marque pas l’union de la lignée comme secondaire', () => {
    computeAscendanceLayout(graph, 'r')
    const entry = coupleBarMeta.find((e) => e.elkId === 'u-u1')
    expect(entry).toBeDefined()
    expect(entry.virtual).toBe(false)
    expect(entry.secondary).toBeUndefined()
  })

  it('la racine choisie reste la racine, pas l’ancêtre le plus ancien', () => {
    const layout = computeAscendanceLayout(graph, 'r')
    expect(layout.ascendanceRootId).toBe('r')
    const map = byId(layout)
    expect(map.get('p-r')._ascendanceRoot).toBe(true)
    expect(map.get('p-p')._ascendanceRoot).toBeUndefined()
  })
})

// ============================================================
// 3. Plusieurs générations d’ancêtres (quatre grands-parents)
// ============================================================
describe('computeAscendanceLayout — plusieurs générations', () => {
  const graph = {
    persons: ['r', 'p', 'm', 'g1', 'g2', 'g3', 'g4'].map(person),
    unions: [union('u1', 'p', 'm'), union('u0', 'g1', 'g2'), union('u2', 'g3', 'g4')],
    filiations: [fil('f1', 'r', 'u1'), fil('f0', 'p', 'u0'), fil('f2', 'm', 'u2')],
  }

  it('représente chaque personne une fois, génération après génération', () => {
    const layout = computeAscendanceLayout(graph, 'r')
    expectUniquePersons(layout)
    expect(personIds(layout).sort()).toEqual(['g1', 'g2', 'g3', 'g4', 'm', 'p', 'r'])
    const map = byId(layout)
    expect(map.get('p-g1').y).toBeLessThan(map.get('p-p').y)
    expect(map.get('p-g3').y).toBeLessThan(map.get('p-m').y)
    expect(map.get('p-p').y).toBeLessThan(map.get('p-r').y)
    expect(map.get('p-m').y).toBeLessThan(map.get('p-r').y)
    expectEdgesPointUp(layout)
    expectNoOverlapWithinGenerations(layout)
  })

  it('place les grands-parents exactement une génération au-dessus de leur enfant, sans décalage artificiel', () => {
    const layout = computeAscendanceLayout(graph, 'r')
    const map = byId(layout)
    for (const gp of ['p-g1', 'p-g2']) {
      expect(map.get(gp)._generation).toBe(map.get('p-p')._generation - 1)
      expect(map.get('p-p').y - map.get(gp).y).toBe(GEN_HEIGHT)
    }
    for (const gp of ['p-g3', 'p-g4']) {
      expect(map.get(gp)._generation).toBe(map.get('p-m')._generation - 1)
      expect(map.get('p-m').y - map.get(gp).y).toBe(GEN_HEIGHT)
    }
    // Branche paternelle centrée sur p ; branche maternelle à côté, au-dessus de m
    // (centrage familial : la première branche est ancrée, la seconde tassée à côté)
    expect(Math.abs(cx(map.get('u-u0')) - cx(map.get('p-p')))).toBeLessThan(1)
    expect(map.get('u-u2').x).toBeGreaterThan(map.get('p-g2').x + map.get('p-g2').width)
    expect(Math.abs(cx(map.get('u-u2')) - cx(map.get('p-m')))).toBeLessThan(RENVOI_MIN_DX)
  })

  it('centre la chaîne de la lignée directe sur la racine', () => {
    const map = byId(computeAscendanceLayout(graph, 'r'))
    expect(Math.abs(cx(map.get('u-u1')) - cx(map.get('p-r')))).toBeLessThan(1)
  })

  it('rend les deux branches parentales visibles en liens directs (pas de renvoi)', () => {
    const layout = computeAscendanceLayout(graph, 'r')
    for (const e of layout.edges) expect(e._secondary).toBeUndefined()
    // Branche paternelle
    const eP = edgeBetween(layout, 'u-u0', 'p-p')
    expect(eP).toBeDefined()
    expect(eP._renvoi).toBeUndefined()
    // Branche maternelle : directement visible au-dessus de m, jamais un renvoi
    const eM = edgeBetween(layout, 'u-u2', 'p-m')
    expect(eM).toBeDefined()
    expect(eM._renvoi).toBeUndefined()
    const eR = edgeBetween(layout, 'u-u1', 'p-r')
    expect(eR).toBeDefined()
    expect(eR._renvoi).toBeUndefined()
  })
})

// ============================================================
// 4. Une seule branche connue (parent unique)
// ============================================================
describe('computeAscendanceLayout — une seule branche connue', () => {
  const graph = {
    persons: ['r', 'm'].map(person),
    unions: [],
    filiations: [filDirect('f1', 'r', 'm')],
  }

  it('matérialise le parent inconnu sans inventer de personne', () => {
    const layout = computeAscendanceLayout(graph, 'r')
    const map = byId(layout)
    expect(personIds(layout).sort()).toEqual(['m', 'r'])
    expect(map.get('unknown-m')).toBeDefined()
    expect(map.get('unknown-m')._type).toBe('unknown')
    expect(map.get('vu-m')).toBeDefined()
    const edge = edgeBetween(layout, 'vu-m', 'p-r')
    expect(edge).toBeDefined()
    expect(edge._secondary).toBeUndefined()
    expect(map.get('p-m').y).toBeLessThan(map.get('p-r').y)
    expect(map.get('p-m')._generation).toBe(map.get('p-r')._generation - 1)
    expectEdgesPointUp(layout)
    expectNoOverlapWithinGenerations(layout)
  })

  it('marque l’union virtuelle comme telle dans coupleBarMeta', () => {
    computeAscendanceLayout(graph, 'r')
    const entry = coupleBarMeta.find((e) => e.elkId === 'vu-m')
    expect(entry).toBeDefined()
    expect(entry.virtual).toBe(true)
  })
})

// ============================================================
// 5. Ancêtres ayant plusieurs enfants (fratrie d’un ancêtre)
// ============================================================
describe('computeAscendanceLayout — ancêtre avec plusieurs enfants', () => {
  const graph = {
    persons: ['r', 'p', 'm', 'g1', 'g2', 's1', 's2'].map(person),
    unions: [union('u1', 'p', 'm'), union('u0', 'g1', 'g2')],
    filiations: [
      fil('f1', 'r', 'u1'),
      fil('f0', 'p', 'u0'),
      fil('fs1', 's1', 'u0', { displayOrder: 2 }),
      fil('fs2', 's2', 'u0', { displayOrder: 3 }),
    ],
  }

  it('montre la fratrie en liens secondaires, sans déplacer l’axe direct', () => {
    const layout = computeAscendanceLayout(graph, 'r')
    const map = byId(layout)
    expect(personIds(layout).sort()).toEqual(['g1', 'g2', 'm', 'p', 'r', 's1', 's2'])
    // Liens secondaires pour les frères et sœurs, lien direct pour la lignée
    expect(edgeBetween(layout, 'u-u0', 'p-s1')._secondary).toBe(true)
    expect(edgeBetween(layout, 'u-u0', 'p-s2')._secondary).toBe(true)
    expect(edgeBetween(layout, 'u-u0', 'p-p')._secondary).toBeUndefined()
    expect(edgeBetween(layout, 'u-u1', 'p-r')._secondary).toBeUndefined()
    // La fratrie est à la même génération que p, tassée à côté de la chaîne de couple
    expect(map.get('p-s1')._generation).toBe(map.get('p-p')._generation)
    expect(map.get('p-s2')._generation).toBe(map.get('p-p')._generation)
    const gen1 = layout.children.filter((n) => n._generation === map.get('p-p')._generation).sort((a, b) => a.x - b.x).map((n) => n.id)
    expect(gen1).toEqual(['p-p', 'u-u1', 'p-m', 'p-s1', 'p-s2'])
    expect(map.get('p-s1').x).toBeGreaterThan(map.get('p-m').x + map.get('p-m').width)
    // L’axe direct n’est pas déplacé : l’union des parents de p reste centrée au-dessus de p
    expect(Math.abs(cx(map.get('u-u0')) - cx(map.get('p-p')))).toBeLessThan(1)
    expect(Math.abs(cx(map.get('u-u1')) - cx(map.get('p-r')))).toBeLessThan(1)
    expectEdgesPointUp(layout)
    expectNoOverlapWithinGenerations(layout)
  })
})

// ============================================================
// 6. Une personne ayant plusieurs unions successives (remariage)
// ============================================================
describe('computeAscendanceLayout — plusieurs unions successives', () => {
  const graph = {
    persons: ['r', 'p', 'm', 's2', 'h'].map(person),
    unions: [union('u1', 'p', 'm'), union('u2', 'm', 's2')],
    filiations: [fil('f1', 'r', 'u1'), fil('f2', 'h', 'u2')],
  }

  it('garde les deux unions distinctes, la seconde en branche secondaire', () => {
    const layout = computeAscendanceLayout(graph, 'r')
    const map = byId(layout)
    expect(personIds(layout).sort()).toEqual(['h', 'm', 'p', 'r', 's2'])
    expect(map.get('u-u1')).toBeDefined()
    expect(map.get('u-u2')).toBeDefined()
    // L’enfant de la seconde union est un lien secondaire, pas un ancêtre direct
    expect(edgeBetween(layout, 'u-u2', 'p-h')._secondary).toBe(true)
    expect(edgeBetween(layout, 'u-u1', 'p-r')._secondary).toBeUndefined()
    // h est au même niveau que la racine (demi-frère/sœur), sous m
    expect(map.get('p-h')._generation).toBe(map.get('p-r')._generation)
    expect(map.get('p-h').y).toBeGreaterThan(map.get('p-m').y)
    expectEdgesPointUp(layout)
    expectNoOverlapWithinGenerations(layout)
  })

  it('chaîne les deux unions autour de m et marque la seconde union secondaire', () => {
    const layout = computeAscendanceLayout(graph, 'r')
    const map = byId(layout)
    const gen = map.get('p-m')._generation
    const chain = componentOrderPerGen.get(gen).find((ids) => ids.includes('p-m'))
    expect(new Set(chain)).toEqual(new Set(['p-p', 'u-u1', 'p-m', 'u-u2', 'p-s2']))
    expect(chain[2]).toBe('p-m')
    expect(coupleBarMeta.find((e) => e.elkId === 'u-u2').secondary).toBe(true)
    expect(coupleBarMeta.find((e) => e.elkId === 'u-u1').secondary).toBeUndefined()
    // L’union de la lignée reste centrée au-dessus de la racine (l’axe ne bouge pas)
    expect(Math.abs(cx(map.get('u-u1')) - cx(map.get('p-r')))).toBeLessThan(1)
    // La branche de remariage reste à la même génération que m, sous son union
    expect(map.get('p-s2')._generation).toBe(map.get('p-m')._generation)
    expect(map.get('p-h').y).toBe(map.get('p-s2').y + GEN_HEIGHT)
  })
})

// ============================================================
// 7. Enfants issus de différentes unions
// ============================================================
describe('computeAscendanceLayout — enfants issus de différentes unions', () => {
  const graph = {
    persons: ['r', 'c1', 'sp', 'p', 'm1', 'm2', 'c2'].map(person),
    unions: [union('u0', 'c1', 'sp'), union('u1', 'p', 'm1'), union('u2', 'p', 'm2')],
    filiations: [fil('f0', 'r', 'u0'), fil('f1', 'c1', 'u1'), fil('f2', 'c2', 'u2')],
  }

  it('distingue les deux unions de p et leurs descendances respectives', () => {
    const layout = computeAscendanceLayout(graph, 'r')
    const map = byId(layout)
    expect(personIds(layout).sort()).toEqual(['c1', 'c2', 'm1', 'm2', 'p', 'r', 'sp'])
    expect(map.get('u-u1')).toBeDefined()
    expect(map.get('u-u2')).toBeDefined()
    // c1 est sur la lignée directe, c2 en branche secondaire
    expect(edgeBetween(layout, 'u-u1', 'p-c1')._secondary).toBeUndefined()
    expect(edgeBetween(layout, 'u-u2', 'p-c2')._secondary).toBe(true)
    // c1 et c2 sont au même niveau, sous p
    expect(map.get('p-c1')._generation).toBe(map.get('p-c2')._generation)
    expect(map.get('p-c1').y).toBeGreaterThan(map.get('p-p').y)
    // L’axe direct (union des parents de la racine centrée sur elle) n’est pas déplacé par la branche de c2
    expect(Math.abs(cx(map.get('u-u0')) - cx(map.get('p-r')))).toBeLessThan(1)
    expect(map.get('p-c2').x).toBeGreaterThan(map.get('p-sp').x + map.get('p-sp').width)
    expectEdgesPointUp(layout)
    expectNoOverlapWithinGenerations(layout)
  })
})

// ============================================================
// 8. Frères et sœurs d’un ancêtre, leurs conjoints et leurs descendants
// ============================================================
describe('computeAscendanceLayout — fratrie d’un ancêtre et ses descendants', () => {
  const graph = {
    persons: ['r', 'p', 'm', 'g1', 'g2', 's', 'ss', 'sc', 'sc2'].map(person),
    unions: [union('u1', 'p', 'm'), union('u0', 'g1', 'g2'), union('us', 's', 'ss')],
    filiations: [
      fil('f1', 'r', 'u1'),
      fil('f0', 'p', 'u0'),
      fil('fs', 's', 'u0', { displayOrder: 2 }),
      fil('fsc', 'sc', 'us'),
      filDirect('fsc2', 'sc2', 'sc'),
    ],
  }

  it('montre frère, conjoint et enfant, sans réexpanser au-delà d’un niveau', () => {
    const layout = computeAscendanceLayout(graph, 'r')
    const map = byId(layout)
    expect(personIds(layout).sort()).toEqual(['g1', 'g2', 'm', 'p', 'r', 's', 'sc', 'ss'])
    expect(map.get('p-sc2')).toBeUndefined()
    // Liens secondaires pour la branche collatérale, directs pour la lignée
    expect(edgeBetween(layout, 'u-u0', 'p-s')._secondary).toBe(true)
    expect(edgeBetween(layout, 'u-us', 'p-sc')._secondary).toBe(true)
    expect(edgeBetween(layout, 'u-u0', 'p-p')._secondary).toBeUndefined()
    expect(edgeBetween(layout, 'u-u1', 'p-r')._secondary).toBeUndefined()
    // sc est un niveau sous s ; l’union du frère est marquée secondaire
    expect(map.get('p-sc').y).toBeGreaterThan(map.get('p-s').y)
    expect(coupleBarMeta.find((e) => e.elkId === 'u-us').secondary).toBe(true)
    expect(coupleBarMeta.find((e) => e.elkId === 'u-u0').secondary).toBeUndefined()
    expectEdgesPointUp(layout)
    expectNoOverlapWithinGenerations(layout)
  })
})

// ============================================================
// 9. Une personne ou une union reliant deux branches (ancêtre commun proche)
// ============================================================
describe('computeAscendanceLayout — ancêtre commun à deux branches', () => {
  // g2 est à la fois grand-parent par p et par m
  const graph = {
    persons: ['r', 'p', 'm', 'g1', 'g2', 'g3'].map(person),
    unions: [union('u1', 'p', 'm'), union('u0', 'g1', 'g2'), union('u2', 'g2', 'g3')],
    filiations: [fil('f1', 'r', 'u1'), fil('f0', 'p', 'u0'), fil('f2', 'm', 'u2')],
  }

  it('représente g2 une seule fois, les deux filiations restent des liens directs', () => {
    const layout = computeAscendanceLayout(graph, 'r')
    expectUniquePersons(layout)
    expect(personIds(layout).sort()).toEqual(['g1', 'g2', 'g3', 'm', 'p', 'r'])
    const e1 = edgeBetween(layout, 'u-u0', 'p-p')
    const e2 = edgeBetween(layout, 'u-u2', 'p-m')
    expect(e1).toBeDefined()
    expect(e2).toBeDefined()
    expect(e1._secondary).toBeUndefined()
    expect(e2._secondary).toBeUndefined()
    // Les deux branches sont assez proches : aucun renvoi artificiel
    expect(e1._renvoi).toBeUndefined()
    expect(e2._renvoi).toBeUndefined()
    expectEdgesPointUp(layout)
    expectNoOverlapWithinGenerations(layout)
  })
})

// ============================================================
// 10. Parents inconnus
// ============================================================
describe('computeAscendanceLayout — parents inconnus', () => {
  // p n’a aucune filiation connue ; m n’a qu’un parent déclaré (gm), l’autre est inconnu
  const graph = {
    persons: ['r', 'p', 'm', 'gm'].map(person),
    unions: [union('u1', 'p', 'm')],
    filiations: [fil('f1', 'r', 'u1'), filDirect('f2', 'm', 'gm')],
  }

  it('ne montre que les personnes connues et matérialise l’inconnu', () => {
    const layout = computeAscendanceLayout(graph, 'r')
    const map = byId(layout)
    expect(personIds(layout).sort()).toEqual(['gm', 'm', 'p', 'r'])
    expect(map.get('unknown-gm')).toBeDefined()
    expect(map.get('unknown-gm')._type).toBe('unknown')
    expect(map.get('vu-gm')).toBeDefined()
    const edge = edgeBetween(layout, 'vu-gm', 'p-m')
    expect(edge).toBeDefined()
    expect(edge._secondary).toBeUndefined()
    expect(map.get('p-gm').y).toBeLessThan(map.get('p-m').y)
    expect(map.get('p-gm')._generation).toBe(map.get('p-m')._generation - 1)
    expectEdgesPointUp(layout)
    expectNoOverlapWithinGenerations(layout)
  })
})

// ============================================================
// 11. Filiations multiples pour un même enfant (liens directs conservés)
// ============================================================
describe('computeAscendanceLayout — filiations multiples', () => {
  // C a deux filiations enregistrées (deux familles) ; P2 a deux autres unions (remariages)
  const graph = {
    persons: ['C', 'P1', 'Q1', 'P2', 'Q2', 'S3', 'H3', 'S4', 'H4'].map(person),
    unions: [union('u1', 'P1', 'Q1'), union('u2', 'P2', 'Q2'), union('u3', 'P2', 'S3'), union('u4', 'P2', 'S4')],
    filiations: [
      fil('f1', 'C', 'u1'),
      fil('f2', 'C', 'u2', { displayOrder: 2 }),
      fil('f3', 'H3', 'u3'),
      fil('f4', 'H4', 'u4'),
    ],
  }

  it('une seule personne C ; les deux filiations restent des liens directs, sans renvoi', () => {
    const layout = computeAscendanceLayout(graph, 'C')
    expectUniquePersons(layout)
    expect(personIds(layout).sort()).toEqual(['C', 'H3', 'H4', 'P1', 'P2', 'Q1', 'Q2', 'S3', 'S4'])
    // Les deux filiations de C existent et visent la même personne
    const e1 = edgeBetween(layout, 'u-u1', 'p-C')
    const e2 = edgeBetween(layout, 'u-u2', 'p-C')
    expect(e1).toBeDefined()
    expect(e2).toBeDefined()
    expect(e1._secondary).toBeUndefined()
    expect(e2._secondary).toBeUndefined()
    // Un lien direct disponible n'est jamais remplacé par un renvoi
    expect(e1._renvoi).toBeUndefined()
    expect(e2._renvoi).toBeUndefined()
    // Les deux unions de parents sont au-dessus de C
    const map = byId(layout)
    expect(map.get('u-u1').y).toBeLessThan(map.get('p-C').y)
    expect(map.get('u-u2').y).toBeLessThan(map.get('p-C').y)
    // Les remariages de P2 restent visibles en branches secondaires
    expect(edgeBetween(layout, 'u-u3', 'p-H3')._secondary).toBe(true)
    expect(edgeBetween(layout, 'u-u4', 'p-H4')._secondary).toBe(true)
    expect(coupleBarMeta.find((e) => e.elkId === 'u-u3').secondary).toBe(true)
    expect(coupleBarMeta.find((e) => e.elkId === 'u-u4').secondary).toBe(true)
    expectEdgesPointUp(layout)
    expectNoOverlapWithinGenerations(layout)
  })
})

// ============================================================
// 12. Données incohérentes (cycle)
// ============================================================
describe('computeAscendanceLayout — données cycliques', () => {
  // A et B se déclarent parents l’un de l’autre : aucune récursion infinie
  const graph = {
    persons: ['A', 'B'].map(person),
    unions: [union('u1', 'A', 'B'), union('u2', 'B', 'A')],
    filiations: [fil('f1', 'B', 'u1'), fil('f2', 'A', 'u2')],
  }

  it('termine et ne duplique aucune personne', () => {
    const layout = computeAscendanceLayout(graph, 'A')
    expectUniquePersons(layout)
    expect(personIds(layout).sort()).toEqual(['A', 'B'])
    expect(layout.children.length).toBeGreaterThan(0)
    for (const n of layout.children) expect(Number.isFinite(n.x)).toBe(true)
  })
})

// ============================================================
// 13. Plusieurs composantes familiales indépendantes
// ============================================================
describe('computeAscendanceLayout — composantes indépendantes', () => {
  const graph = {
    persons: ['r', 'p', 'm', 'x', 'y', 'z'].map(person),
    unions: [union('u1', 'p', 'm'), union('uX', 'x', 'y')],
    filiations: [fil('f1', 'r', 'u1'), fil('fX', 'z', 'uX')],
  }

  it('ignore la famille sans lien avec la racine', () => {
    const layout = computeAscendanceLayout(graph, 'r')
    expect(personIds(layout).sort()).toEqual(['m', 'p', 'r'])
    expect(layout.edges).toHaveLength(1)
    expect(edgeBetween(layout, 'u-u1', 'p-r')).toBeDefined()
    expectEdgesPointUp(layout)
  })
})

// ============================================================
// 14. Grand graphe (performance et invariants à grande échelle)
// ============================================================
describe('computeAscendanceLayout — grand graphe', () => {
  // Arbre binaire complet de 8 générations d’ancêtres, plus pour chaque ancêtre une
  // branche collatérale (fratrie + conjoint + enfant) : ~1300 personnes, ~500 unions
  const buildLargeGraph = (depth = 8) => {
    const persons = [person('r')]
    const unions = []
    const filiations = []
    let egos = ['r']
    for (let gen = 1; gen <= depth; gen++) {
      const next = []
      for (const childId of egos) {
        const fId = `a${gen}f-${childId}`
        const mId = `a${gen}m-${childId}`
        const uId = `u${gen}-${childId}`
        persons.push(person(fId), person(mId))
        unions.push(union(uId, fId, mId))
        filiations.push(fil(`f-${gen}-${childId}`, childId, uId))
        const sId = `s${gen}-${childId}`
        const spId = `sp${gen}-${childId}`
        const cId = `c${gen}-${childId}`
        const usId = `us${gen}-${childId}`
        persons.push(person(sId), person(spId), person(cId))
        filiations.push(fil(`fs-${gen}-${childId}`, sId, uId, { displayOrder: 2 }))
        unions.push(union(usId, sId, spId))
        filiations.push(fil(`fc-${gen}-${childId}`, cId, usId))
        next.push(fId, mId)
      }
      egos = next
    }
    return { persons, unions, filiations }
  }

  it('termine, sans doublon ni chevauchement, toutes les arêtes remontent', () => {
    const graph = buildLargeGraph(8)
    const layout = computeAscendanceLayout(graph, 'r')
    expect(layout.children.length).toBeGreaterThan(1000)
    expectUniquePersons(layout)
    expectEdgesPointUp(layout)
    expectNoOverlapWithinGenerations(layout)
    // La racine est à la profondeur de l’arbre ; seuls les descendants collatéraux
    // (enfants des fratries) peuvent dépasser d’un cran
    const map = byId(layout)
    const view = buildAscendanceView(graph, 'r')
    const rootGen = map.get('p-r')._generation
    expect(rootGen).toBe(8)
    const lineageGens = [...view.directPersonIds].map((pid) => map.get(`p-${pid}`)._generation)
    expect(Math.max(...lineageGens)).toBe(rootGen)
    for (const g of lineageGens) expect(g).toBeLessThanOrEqual(rootGen)
    // Chaque lien relie deux générations distantes d’exactement un cran
    for (const e of layout.edges) {
      const dy = map.get(e.targets[0]).y - map.get(e.sources[0]).y
      expect(dy, `l’arête ${e.id} ne respecte pas les générations`).toBeGreaterThanOrEqual(GEN_HEIGHT)
    }
  }, 20000)

  it('reste déterministe sur un grand graphe', () => {
    const graph = buildLargeGraph(5)
    const a = computeAscendanceLayout(graph, 'r')
    const b = computeAscendanceLayout(graph, 'r')
    expect(serializeLayout(b)).toBe(serializeLayout(a))
  }, 20000)
})

// ============================================================
// 15. Frère ou sœur de la racine (même génération, latéral)
// ============================================================
describe('computeAscendanceLayout — frère ou sœur de la racine', () => {
  const base = {
    persons: ['r', 'p', 'm'].map(person),
    unions: [union('u1', 'p', 'm')],
    filiations: [fil('f1', 'r', 'u1')],
  }
  // s est sœur de r (mêmes parents) ; elle a un conjoint ss et un enfant sc
  const withSibling = {
    persons: ['r', 'p', 'm', 's', 'ss', 'sc'].map(person),
    unions: [union('u1', 'p', 'm'), union('us', 's', 'ss')],
    filiations: [
      fil('f1', 'r', 'u1'),
      fil('fs', 's', 'u1', { displayOrder: 2 }),
      fil('fsc', 'sc', 'us'),
    ],
  }

  it('place la sœur sur la même génération que la racine, à côté d’elle', () => {
    const layout = computeAscendanceLayout(withSibling, 'r')
    const map = byId(layout)
    expect(map.get('p-s')._generation).toBe(map.get('p-r')._generation)
    expect(map.get('p-s').y).toBe(map.get('p-r').y)
    expect(map.get('p-s').x).not.toBe(map.get('p-r').x)
    // La racine et ses parents restent sur l’axe, la sœur ne les fait pas remonter
    expect(Math.abs(cx(map.get('u-u1')) - cx(map.get('p-r')))).toBeLessThan(1)
    // Le conjoint de la sœur est à sa génération, son enfant en dessous
    expect(map.get('p-ss')._generation).toBe(map.get('p-s')._generation)
    expect(map.get('p-sc').y).toBeGreaterThan(map.get('p-s').y)
    expect(edgeBetween(layout, 'u-u1', 'p-s')._secondary).toBe(true)
    expect(edgeBetween(layout, 'u-us', 'p-sc')._secondary).toBe(true)
    expectEdgesPointUp(layout)
    expectNoOverlapWithinGenerations(layout)
  })

  it('l’ajout de la sœur et de sa famille ne modifie pas les générations de la racine et de ses parents', () => {
    const before = byId(computeAscendanceLayout(base, 'r'))
    const after = byId(computeAscendanceLayout(withSibling, 'r'))
    for (const id of ['p-r', 'p-p', 'p-m', 'u-u1']) {
      expect(after.get(id)._generation, `${id} : génération modifiée par la fratrie`).toBe(before.get(id)._generation)
      expect(after.get(id).y, `${id} : position Y modifiée par la fratrie`).toBe(before.get(id).y)
    }
  })
})

// ============================================================
// 16. Branches collatérales larges des deux côtés (pas de renvoi sur la lignée)
// ============================================================
describe('computeAscendanceLayout — branches collatérales larges', () => {
  // Sœur de la racine (avec conjoint et enfant) + sœur de la mère (avec conjoint et enfant)
  const graph = {
    persons: ['r', 'p', 'm', 'gp1', 'gp2', 'gm1', 'gm2', 's', 'ss', 'sc', 'a', 'sa', 'sak'].map(person),
    unions: [
      union('u1', 'p', 'm'),
      union('u0', 'gp1', 'gp2'),
      union('u2', 'gm1', 'gm2'),
      union('us', 's', 'ss'),
      union('ua', 'a', 'sa'),
    ],
    filiations: [
      fil('f1', 'r', 'u1'),
      fil('f0', 'p', 'u0'),
      fil('f2', 'm', 'u2'),
      fil('fs', 's', 'u1', { displayOrder: 2 }),
      fil('fsc', 'sc', 'us'),
      fil('fa', 'a', 'u2', { displayOrder: 2 }),
      fil('fsak', 'sak', 'ua'),
    ],
  }

  it('la branche maternelle reste un lien direct au-dessus de m, jamais un renvoi', () => {
    const layout = computeAscendanceLayout(graph, 'r')
    const map = byId(layout)
    const eM = edgeBetween(layout, 'u-u2', 'p-m')
    expect(eM).toBeDefined()
    expect(eM._renvoi).toBeUndefined()
    expect(eM._secondary).toBeUndefined()
    const eR = edgeBetween(layout, 'u-u1', 'p-r')
    expect(eR).toBeDefined()
    expect(eR._renvoi).toBeUndefined()
    // Hiérarchie : m au-dessus de r, gm1/gm2 au-dessus de m
    expect(map.get('p-m')._generation).toBe(map.get('p-r')._generation - 1)
    expect(map.get('p-gm1')._generation).toBe(map.get('p-m')._generation - 1)
    expect(map.get('p-gm2')._generation).toBe(map.get('p-m')._generation - 1)
    // La sœur de la racine est sur la même génération que la racine
    expect(map.get('p-s')._generation).toBe(map.get('p-r')._generation)
    expectUniquePersons(layout)
    expectEdgesPointUp(layout)
    expectNoOverlapWithinGenerations(layout)
  })
})

// ============================================================
// 17. Ancêtre partagé éloigné : le renvoi reste fonctionnel
// ============================================================
describe('computeAscendanceLayout — ancêtre partagé éloigné (renvoi nécessaire)', () => {
  // gg1/gg2 sont parents de g1 (branche paternelle) et de g3 (branche maternelle) ;
  // les remariages de g2 et g4 élargissent les deux branches, la seconde
  // revendication de l’union partagée devient un renvoi
  const graph = {
    persons: ['r', 'p', 'm', 'g1', 'g2', 'g3', 'g4', 'gg1', 'gg2', 's2', 's4'].map(person),
    unions: [
      union('u1', 'p', 'm'),
      union('u0', 'g1', 'g2'),
      union('u2', 'g3', 'g4'),
      union('u00', 'gg1', 'gg2'),
      union('uR1', 'g2', 's2'),
      union('uR2', 'g4', 's4'),
    ],
    filiations: [
      fil('f1', 'r', 'u1'),
      fil('f0', 'p', 'u0'),
      fil('f2', 'm', 'u2'),
      fil('f3', 'g1', 'u00'),
      fil('f4', 'g3', 'u00'),
    ],
  }

  it('ne duplique pas l’ancêtre partagé et garde les renvois nécessaires fonctionnels', () => {
    const layout = computeAscendanceLayout(graph, 'r')
    expectUniquePersons(layout)
    const map = byId(layout)
    expect(personIds(layout).sort()).toEqual(['g1', 'g2', 'g3', 'g4', 'gg1', 'gg2', 'm', 'p', 'r', 's2', 's4'])
    // Le lien vers l’enfant principal de la chaîne (g1) reste direct
    const eG1 = edgeBetween(layout, 'u-u00', 'p-g1')
    expect(eG1).toBeDefined()
    expect(eG1._secondary).toBeUndefined()
    expect(eG1._renvoi).toBeUndefined()
    // La seconde revendication (g3), placée trop loin, devient un renvoi
    const eG3 = edgeBetween(layout, 'u-u00', 'p-g3')
    expect(eG3).toBeDefined()
    expect(eG3._secondary).toBeUndefined()
    expect(eG3._renvoi).toBe(true)
    // Les ancêtres partagés ne sont pas dupliqués et restent à la bonne génération
    expect(map.get('p-gg1')._generation).toBe(map.get('p-g1')._generation - 1)
    expect(map.get('p-gg2')._generation).toBe(map.get('p-g3')._generation - 1)
    expectEdgesPointUp(layout)
    expectNoOverlapWithinGenerations(layout)
  })
})

// ============================================================
// 18. Filiations multiples asymétriques (racine ancrée sous ses deux unions)
// ============================================================
describe('computeAscendanceLayout — filiations multiples asymétriques', () => {
  // r a deux filiations : u1 (p, m — p a des parents) et u2 (p2, m2 — sans parents connus)
  const graph = {
    persons: ['r', 'p', 'm', 'gp1', 'gp2', 'p2', 'm2'].map(person),
    unions: [union('u1', 'p', 'm'), union('u0', 'gp1', 'gp2'), union('u2', 'p2', 'm2')],
    filiations: [
      fil('f1', 'r', 'u1'),
      fil('f0', 'p', 'u0'),
      fil('f2', 'r', 'u2', { displayOrder: 2 }),
    ],
  }

  it('la racine reste strictement sous ses deux unions, sans arête horizontale ni renvoi', () => {
    const layout = computeAscendanceLayout(graph, 'r')
    const map = byId(layout)
    const e1 = edgeBetween(layout, 'u-u1', 'p-r')
    const e2 = edgeBetween(layout, 'u-u2', 'p-r')
    expect(e1).toBeDefined()
    expect(e2).toBeDefined()
    expect(e1._renvoi).toBeUndefined()
    expect(e2._renvoi).toBeUndefined()
    // Les deux unions sont exactement une génération au-dessus de la racine
    expect(map.get('u-u1')._generation).toBe(map.get('p-r')._generation - 1)
    expect(map.get('u-u2')._generation).toBe(map.get('p-r')._generation - 1)
    expect(map.get('u-u1').y).toBeLessThan(map.get('p-r').y)
    expect(map.get('u-u2').y).toBeLessThan(map.get('p-r').y)
    // La branche profonde (gp1/gp2) remonte au-dessus de p, sans déplacer la racine
    expect(map.get('p-gp1')._generation).toBe(map.get('p-p')._generation - 1)
    expect(Math.abs(cx(map.get('u-u1')) - cx(map.get('p-r')))).toBeLessThan(1)
    expectEdgesPointUp(layout)
    expectNoOverlapWithinGenerations(layout)
  })
})

// ============================================================
// Ordre manuel des fratries
// ============================================================
describe('computeAscendanceLayout — ordre de la fratrie', () => {
  const graph = {
    persons: ['r', 'p', 'm', 'a', 'b'].map(person),
    unions: [union('u1', 'p', 'm')],
    filiations: [
      fil('fa', 'a', 'u1'),
      fil('fb', 'b', 'u1', { displayOrder: 2 }),
      fil('fr', 'r', 'u1', { displayOrder: 3 }),
    ],
  }

  it('respecte le displayOrder choisi par la famille', () => {
    const layout = computeAscendanceLayout(graph, 'r')
    const map = byId(layout)
    const order = ['p-a', 'p-b', 'p-r'].sort((x, y) => map.get(x).x - map.get(y).x).map((id) => id.slice(2))
    expect(order).toEqual(['a', 'b', 'r'])
    // La racine reste sur l’axe, centrée sous ses parents
    expect(Math.abs(cx(map.get('u-u1')) - cx(map.get('p-r')))).toBeLessThan(1)
  })

  it('la fratrie reste réordonnable en mode édition (buildSiblingGroups)', () => {
    const layout = computeAscendanceLayout(graph, 'r')
    const groups = buildSiblingGroups(layout)
    expect(groups.get('p-a')).toMatchObject({ source: 'u-u1', ids: ['p-a', 'p-b', 'p-r'] })
  })
})

// ============================================================
// Déterminisme et non-régression du placement descendant
// ============================================================
describe('computeAscendanceLayout — déterminisme et non-régression', () => {
  // Graphe médian mêlant remariages, fratrie et filiations multiples
  const graph = {
    persons: ['C', 'P1', 'Q1', 'P2', 'Q2', 'S3', 'H3', 'S4', 'H4'].map(person),
    unions: [union('u1', 'P1', 'Q1'), union('u2', 'P2', 'Q2'), union('u3', 'P2', 'S3'), union('u4', 'P2', 'S4')],
    filiations: [
      fil('f1', 'C', 'u1'),
      fil('f2', 'C', 'u2', { displayOrder: 2 }),
      fil('f3', 'H3', 'u3'),
      fil('f4', 'H4', 'u4'),
    ],
  }

  it('produit un placement identique pour un même graphe et une même racine', () => {
    const a = computeAscendanceLayout(graph, 'C')
    const b = computeAscendanceLayout(graph, 'C')
    expect(serializeLayout(b)).toBe(serializeLayout(a))
  })

  it('ne modifie pas l’état partagé consommé par le placement descendant', () => {
    const before = serializeLayout(computeBlockLayout(graph))
    computeAscendanceLayout(graph, 'C')
    const after = serializeLayout(computeBlockLayout(graph))
    expect(after).toBe(before)
  })
})

// ============================================================
// Générations explicites (fonction pure)
// ============================================================
describe('assignAscendanceGenerations', () => {
  it('ancre la racine à 0 et remonte les parents d’un cran par génération', () => {
    const graph = {
      persons: ['r', 'p', 'm', 'g1', 'g2', 'g3', 'g4'].map(person),
      unions: [union('u1', 'p', 'm'), union('u0', 'g1', 'g2'), union('u2', 'g3', 'g4')],
      filiations: [fil('f1', 'r', 'u1'), fil('f0', 'p', 'u0'), fil('f2', 'm', 'u2')],
    }
    const gen = assignAscendanceGenerations(buildAscendanceView(graph, 'r'))
    expect(gen.get('r')).toBe(0)
    expect(gen.get('p')).toBe(-1)
    expect(gen.get('m')).toBe(-1)
    expect(gen.get('g1')).toBe(-2)
    expect(gen.get('g2')).toBe(-2)
    expect(gen.get('g3')).toBe(-2)
    expect(gen.get('g4')).toBe(-2)
  })

  it('met frères et sœurs à la même profondeur que la personne de la lignée', () => {
    const graph = {
      persons: ['r', 'p', 'm', 's'].map(person),
      unions: [union('u1', 'p', 'm')],
      filiations: [fil('f1', 'r', 'u1'), fil('fs', 's', 'u1', { displayOrder: 2 })],
    }
    const gen = assignAscendanceGenerations(buildAscendanceView(graph, 'r'))
    expect(gen.get('s')).toBe(gen.get('r'))
  })

  it('aligne les conjoints et place les enfants sous la profondeur max de leurs sources', () => {
    const graph = {
      persons: ['r', 'p', 'm', 's2', 'h'].map(person),
      unions: [union('u1', 'p', 'm'), union('u2', 'm', 's2')],
      filiations: [fil('f1', 'r', 'u1'), fil('f2', 'h', 'u2')],
    }
    const gen = assignAscendanceGenerations(buildAscendanceView(graph, 'r'))
    expect(gen.get('s2')).toBe(gen.get('m'))
    expect(gen.get('h')).toBe(gen.get('m') + 1)
  })

  it('borne les cycles (point fixe borné, valeurs finies)', () => {
    const graph = {
      persons: ['A', 'B'].map(person),
      unions: [union('u1', 'A', 'B'), union('u2', 'B', 'A')],
      filiations: [fil('f1', 'B', 'u1'), fil('f2', 'A', 'u2')],
    }
    const gen = assignAscendanceGenerations(buildAscendanceView(graph, 'A'))
    expect(Number.isFinite(gen.get('A'))).toBe(true)
    expect(Number.isFinite(gen.get('B'))).toBe(true)
  })

  it('retourne une map vide sans racine valide', () => {
    const gen = assignAscendanceGenerations(buildAscendanceView({ persons: [person('r')], unions: [], filiations: [] }, 'inconnu'))
    expect(gen.size).toBe(0)
  })
})

// ============================================================
// Choix de la racine par défaut et construction de la vue
// ============================================================
describe('pickDefaultAscendanceRoot', () => {
  it('retourne null sans personne', () => {
    expect(pickDefaultAscendanceRoot([], [], [])).toBeNull()
  })

  it('choisit la personne la plus connectée', () => {
    const persons = ['a', 'b', 'c', 'd', 'e'].map(person)
    const unions = [union('u1', 'a', 'b'), union('u2', 'a', 'd')]
    const filiations = [fil('f1', 'c', 'u1'), fil('f2', 'e', 'u2')]
    expect(pickDefaultAscendanceRoot(persons, unions, filiations)).toBe('a')
  })

  it('départage à égalité par identifiant (déterministe)', () => {
    expect(pickDefaultAscendanceRoot(['b', 'a'].map(person), [], [])).toBe('a')
  })

  it('sert de racine de repli quand aucune racine n’est fournie', () => {
    const persons = ['a', 'b', 'c', 'd', 'e'].map(person)
    const unions = [union('u1', 'a', 'b'), union('u2', 'a', 'd')]
    const filiations = [fil('f1', 'c', 'u1'), fil('f2', 'e', 'u2')]
    const layout = computeAscendanceLayout({ persons, unions, filiations })
    expect(layout.ascendanceRootId).toBe('a')
    expect(byId(layout).get('p-a')._ascendanceRoot).toBe(true)
  })
})

describe('buildAscendanceView', () => {
  it('retourne une vue vide pour une racine inconnue du graphe', () => {
    const view = buildAscendanceView({ persons: [person('r')], unions: [], filiations: [] }, 'inconnu')
    expect(view.persons).toEqual([])
    expect(view.unions).toEqual([])
    expect(view.filiations).toEqual([])
    expect(view.rootPersonId).toBeNull()
  })

  it('la clôture directe suit les filiations réelles, depuis la racine', () => {
    const graph = {
      persons: ['r', 'p', 'm', 'g1', 'g2', 'g3', 'g4'].map(person),
      unions: [union('u1', 'p', 'm'), union('u0', 'g1', 'g2'), union('u2', 'g3', 'g4')],
      filiations: [fil('f1', 'r', 'u1'), fil('f0', 'p', 'u0'), fil('f2', 'm', 'u2')],
    }
    const view = buildAscendanceView(graph, 'r')
    expect(view.directPersonOrder).toEqual(['r', 'p', 'm', 'g1', 'g2', 'g3', 'g4'])
    expect([...view.directPersonIds].sort()).toEqual(['g1', 'g2', 'g3', 'g4', 'm', 'p', 'r'])
    expect(view.rootPersonId).toBe('r')
  })

  it('borne les branches collatérales à un niveau de descendants', () => {
    const graph = {
      persons: ['r', 'p', 'm', 'g1', 'g2', 's', 'ss', 'sc', 'sc2'].map(person),
      unions: [union('u1', 'p', 'm'), union('u0', 'g1', 'g2'), union('us', 's', 'ss')],
      filiations: [
        fil('f1', 'r', 'u1'),
        fil('f0', 'p', 'u0'),
        fil('fs', 's', 'u0', { displayOrder: 2 }),
        fil('fsc', 'sc', 'us'),
        filDirect('fsc2', 'sc2', 'sc'),
      ],
    }
    const view = buildAscendanceView(graph, 'r')
    const ids = view.persons.map((p) => p.id)
    expect(ids).toContain('s')
    expect(ids).toContain('ss')
    expect(ids).toContain('sc')
    expect(ids).not.toContain('sc2')
  })

  it('inclut les remariages des ancêtres en unions secondaires, pas ceux de la racine', () => {
    const graph = {
      persons: ['r', 'p', 'm', 's2', 'h', 'sp', 'k'].map(person),
      unions: [union('u1', 'p', 'm'), union('u2', 'm', 's2'), union('uR', 'r', 'sp')],
      filiations: [fil('f1', 'r', 'u1'), fil('f2', 'h', 'u2'), fil('fR', 'k', 'uR')],
    }
    const view = buildAscendanceView(graph, 'r')
    const ids = view.persons.map((p) => p.id)
    expect(ids.sort()).toEqual(['h', 'm', 'p', 'r', 's2'])
    expect([...view.secondaryUnionIds]).toEqual(['u2'])
    expect(view.unions.map((u) => u.id).sort()).toEqual(['u1', 'u2'])
  })

  it('ne duplique aucune personne, union ni filiation dans la vue', () => {
    const graph = {
      persons: ['C', 'P1', 'Q1', 'P2', 'Q2', 'S3', 'H3', 'S4', 'H4'].map(person),
      unions: [union('u1', 'P1', 'Q1'), union('u2', 'P2', 'Q2'), union('u3', 'P2', 'S3'), union('u4', 'P2', 'S4')],
      filiations: [
        fil('f1', 'C', 'u1'),
        fil('f2', 'C', 'u2', { displayOrder: 2 }),
        fil('f3', 'H3', 'u3'),
        fil('f4', 'H4', 'u4'),
      ],
    }
    const view = buildAscendanceView(graph, 'C')
    for (const [key, list] of [['persons', view.persons], ['unions', view.unions], ['filiations', view.filiations]]) {
      const ids = list.map((item) => String(item.id))
      expect(new Set(ids).size, `${key} dupliqués dans la vue`).toBe(ids.length)
    }
  })
})
