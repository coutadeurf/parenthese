import { describe, it, expect } from 'vitest'
import { computeRootedLayout, resolveRootPersonId } from './rootedLayout'
import { computeBlockLayout } from './blockLayout'
import { normalizeFiliationsForLayout } from './elkLayout'
import { PERSON_W } from './constants'

const person = (id) => ({ id, firstName: id, lastName: '' })
const union = (id, partner1Id, partner2Id) => ({ id, partner1Id, partner2Id, displayOrder: 1 })
const fil = (id, childId, unionId) => ({ id, childId, parentId: null, unionId, parentageType: 'biologique', displayOrder: 1 })
const filDirect = (id, childId, parentId) => ({ id, childId, parentId, unionId: null, parentageType: 'biologique', displayOrder: 1 })

const byIdMap = (result) => new Map(result.children.map((n) => [n.id, n]))
const genOf = (result, id) => result.children.find((n) => n.id === `p-${id}`)._generation
const centerX = (result, id) => {
  const n = result.children.find((n2) => n2.id === id)
  return n.x + n.width / 2
}

// Toute filiation valide (après normalisation) doit avoir une arête dans le layout,
// et chaque personne exactement un nœud : aucune relation n'est perdue au passage.
function expectGraphPreserved(result, graph) {
  const normalized = normalizeFiliationsForLayout(graph.filiations, graph.unions)
  expect(result.edges).toHaveLength(normalized.length)

  const nodeIds = new Set(result.children.map((n) => n.id))
  for (const edge of result.edges) {
    expect(nodeIds.has(edge.sources[0])).toBe(true)
    expect(nodeIds.has(edge.targets[0])).toBe(true)
  }

  const personNodes = result.children.filter((n) => n._type === 'person')
  expect(personNodes).toHaveLength(graph.persons.length)
  expect(new Set(personNodes.map((n) => n.id)).size).toBe(graph.persons.length)
}

describe('resolveRootPersonId', () => {
  it('renvoie la racine demandée quand elle existe, un repli déterministe sinon', () => {
    const graph = { persons: [person('a'), person('b')], unions: [], filiations: [] }
    expect(resolveRootPersonId(graph, 'a')).toBe('a')
    // Invalide : repli déterministe (à égalité de degré, la plus petite identité)
    expect(resolveRootPersonId(graph, '42')).toBe('a')
  })

  it('choisit un repli déterministe : la personne la plus connectée, à égalité la plus petite id', () => {
    // hub : 2 unions (2 liens) + 2 enfants (2 liens) = degré 4
    const graph = {
      persons: ['x', 'hub', 'sp1', 'sp2', 'k1', 'k2'].map(person),
      unions: [union('u1', 'hub', 'sp1'), union('u2', 'hub', 'sp2')],
      filiations: [fil('f1', 'k1', 'u1'), fil('f2', 'k2', 'u2')],
    }
    const missing = resolveRootPersonId(graph, null)
    const invalid = resolveRootPersonId(graph, 'inconnu')
    expect(missing).toBe('hub')
    expect(invalid).toBe('hub')
    expect(resolveRootPersonId(graph, null)).toBe(missing)
  })
})

describe('computeRootedLayout', () => {
  it('place les ancêtres au-dessus de la racine et les descendants en dessous (convention de l’app)', () => {
    const graph = {
      persons: ['ggp1', 'ggp2', 'pa', 'ma', 'root', 'sp', 'kid', 'kidsp', 'gkid'].map(person),
      unions: [
        union('u0', 'ggp1', 'ggp2'),
        union('u1', 'pa', 'ma'),
        union('u2', 'root', 'sp'),
        union('u3', 'kid', 'kidsp'),
      ],
      filiations: [
        fil('f1', 'pa', 'u0'),
        fil('f2', 'root', 'u1'),
        fil('f3', 'kid', 'u2'),
        fil('f4', 'gkid', 'u3'),
      ],
    }
    const result = computeRootedLayout(graph, 'root')
    expectGraphPreserved(result, graph)

    // Générations relatives à la racine : ancêtres 0, racine 2, descendants 3, 4
    expect(genOf(result, 'ggp1')).toBe(0)
    expect(genOf(result, 'pa')).toBe(1)
    expect(genOf(result, 'root')).toBe(2)
    expect(genOf(result, 'kid')).toBe(3)
    expect(genOf(result, 'gkid')).toBe(4)
    // Conjoints alignés sur la même génération
    expect(genOf(result, 'ggp2')).toBe(0)
    expect(genOf(result, 'ma')).toBe(1)
    expect(genOf(result, 'sp')).toBe(2)
    // Convention Y : les générations montent vers le haut de l'écran
    const y = (id) => result.children.find((n) => n.id === `p-${id}`).y
    expect(y('ggp1')).toBeLessThan(y('root'))
    expect(y('kid')).toBeGreaterThan(y('root'))
    // La racine est marquée sur le résultat
    expect(result.rootPersonId).toBe('root')
  })

  it('garde les frères et sœurs au niveau de la racine, contigus, sous leurs parents centrés', () => {
    const graph = {
      persons: ['pa', 'ma', 'root', 's1', 's2', 's3'].map(person),
      unions: [union('u1', 'pa', 'ma')],
      filiations: [fil('f1', 'root', 'u1'), fil('f2', 's1', 'u1'), fil('f3', 's2', 'u1'), fil('f4', 's3', 'u1')],
    }
    const result = computeRootedLayout(graph, 'root')
    expectGraphPreserved(result, graph)

    for (const s of ['s1', 's2', 's3']) expect(genOf(result, s)).toBe(genOf(result, 'root'))

    // Contiguïté : aucune personne étrangère entre le premier et le dernier enfant
    const kidIds = new Set(['p-root', 'p-s1', 'p-s2', 'p-s3'])
    const sameGen = result.children.filter((n) => n._generation === genOf(result, 'root') && n._type === 'person')
    const xs = sameGen.map((n) => n.x)
    const minX = Math.min(...xs), maxX = Math.max(...xs)
    const intruders = sameGen.filter((n) => !kidIds.has(n.id) && n.x > minX && n.x < maxX)
    expect(intruders).toHaveLength(0)

    // Parents centrés au-dessus de la fratrie
    const kidsCenter = sameGen.reduce((s, n) => s + n.x + n.width / 2, 0) / sameGen.length
    expect(Math.abs(centerX(result, 'u-u1') - kidsCenter)).toBeLessThanOrEqual(PERSON_W / 2)
  })

  it('gère plusieurs partenaires : conjoints au niveau de la racine, enfants de chaque union dessous', () => {
    const graph = {
      persons: ['pa', 'ma', 'root', 'sp1', 'sp2', 'k1', 'k2'].map(person),
      unions: [union('u1', 'pa', 'ma'), union('u2', 'root', 'sp1'), union('u3', 'root', 'sp2')],
      filiations: [fil('f1', 'root', 'u1'), fil('f2', 'k1', 'u2'), fil('f3', 'k2', 'u3')],
    }
    const result = computeRootedLayout(graph, 'root')
    expectGraphPreserved(result, graph)

    expect(genOf(result, 'sp1')).toBe(genOf(result, 'root'))
    expect(genOf(result, 'sp2')).toBe(genOf(result, 'root'))
    expect(genOf(result, 'k1')).toBe(genOf(result, 'root') + 1)
    expect(genOf(result, 'k2')).toBe(genOf(result, 'root') + 1)

    // Chaque filiation est un vrai trait : ni renvoi ni couloir sur ce petit arbre
    expect(result.edges.filter((e) => e._renvoi || e._corridor)).toHaveLength(0)
  })

  it('gère demi-frères et sœurs d’unions différentes du même parent', () => {
    const graph = {
      persons: ['pa', 'ma', 'sp', 'a', 'b'].map(person),
      unions: [union('u1', 'pa', 'ma'), union('u2', 'pa', 'sp')],
      filiations: [fil('f1', 'a', 'u1'), fil('f2', 'b', 'u2')],
    }
    const result = computeRootedLayout(graph, 'a')
    expectGraphPreserved(result, graph)
    expect(genOf(result, 'a')).toBe(genOf(result, 'pa') + 1)
    expect(genOf(result, 'b')).toBe(genOf(result, 'pa') + 1)
  })

  it('place les parents du conjoint au niveau des parents de la racine (convention Geneanet)', () => {
    const graph = {
      persons: ['pa', 'ma', 'root', 'sp', 'bepa', 'bema'].map(person),
      unions: [union('u1', 'pa', 'ma'), union('u2', 'root', 'sp'), union('u3', 'bepa', 'bema')],
      filiations: [fil('f1', 'root', 'u1'), fil('f2', 'sp', 'u3')],
    }
    const result = computeRootedLayout(graph, 'root')
    expectGraphPreserved(result, graph)
    // Beaux-parents : une génération au-dessus du conjoint, alignés sur les parents de la racine
    expect(genOf(result, 'sp')).toBe(genOf(result, 'root'))
    expect(genOf(result, 'bepa')).toBe(genOf(result, 'root') - 1)
    expect(genOf(result, 'bepa')).toBe(genOf(result, 'pa'))
  })

  it('crée un nœud Inconnu pour un parent unique renseigné', () => {
    const graph = {
      persons: ['root', 'kid'].map(person),
      unions: [],
      filiations: [filDirect('f1', 'kid', 'root')],
    }
    const result = computeRootedLayout(graph, 'root')
    expectGraphPreserved(result, graph)
    const unknown = result.children.find((n) => n.id === 'unknown-root')
    expect(unknown).toBeTruthy()
    expect(unknown._type).toBe('unknown')
    expect(genOf(result, 'kid')).toBe(genOf(result, 'root') + 1)
  })

  it('préserve toutes les relations d’un mariage entre deux branches, avec moins de renvois que le défaut', () => {
    // Deux lignées issues d'un ancêtre commun ; un enfant de chaque lignée se marie.
    // La chaîne du couple est revendiquée par les deux lignées : l'autre garde une arête longue.
    const graph = {
      persons: [person('ggp1'), person('ggp2')],
      unions: [union('u0', 'ggp1', 'ggp2')],
      filiations: [],
    }
    const branch = (name) => {
      const spouse = `${name}sp`
      graph.persons.push(person(name), person(spouse))
      const u = union(`u-${name}`, name, spouse)
      graph.unions.push(u)
      graph.filiations.push(fil(`f-${name}`, name, 'u0'))
      for (let i = 1; i <= 5; i += 1) {
        const kid = `${name}k${i}`
        const kidSp = `${kid}sp`
        graph.persons.push(person(kid), person(kidSp))
        const uk = union(`u-${kid}`, kid, kidSp)
        graph.unions.push(uk)
        graph.filiations.push(fil(`f-${kid}`, kid, `u-${name}`))
        for (let j = 1; j <= 2; j += 1) {
          const gk = `${kid}g${j}`
          graph.persons.push(person(gk))
          graph.filiations.push(fil(`f-${gk}`, gk, `u-${kid}`))
        }
      }
      return `${name}k1`
    }
    const a1 = branch("a")
    const b1 = branch("b")
    // Mariage croisé entre les deux lignées + un enfant partagé
    graph.persons.push(person('cross'))
    const ux = union('u-cross', a1, b1)
    graph.unions.push(ux)
    graph.filiations.push(fil('f-cross', 'cross', 'u-cross'))

    const rooted = computeRootedLayout(graph, 'ggp1')
    const baseline = computeBlockLayout(graph)
    expectGraphPreserved(rooted, graph)
    expectGraphPreserved(baseline, graph)

    const renvois = (r) => r.edges.filter((e) => e._renvoi)
    expect(renvois(rooted).length).toBeLessThanOrEqual(renvois(baseline).length)

    // Un couloir (trait orthogonal inter-rangées) ne saute jamais plus d'une génération
    const byId = byIdMap(rooted)
    for (const e of rooted.edges.filter((e2) => e2._corridor)) {
      expect(byId.get(e.targets[0])._generation - byId.get(e.sources[0])._generation).toBe(1)
      expect(e._renvoi).toBeUndefined()
    }
    for (const e of renvois(rooted)) expect(e._corridor).toBeUndefined()
  })

  it('place une composante déconnectée sans la perdre ni la dupliquer', () => {
    const graph = {
      persons: ['pa', 'ma', 'root', 'qpa', 'qma', 'qkid'].map(person),
      unions: [union('u1', 'pa', 'ma'), union('u2', 'qpa', 'qma')],
      filiations: [fil('f1', 'root', 'u1'), fil('f2', 'qkid', 'u2')],
    }
    const result = computeRootedLayout(graph, 'root')
    expectGraphPreserved(result, graph)
    for (const n of result.children) {
      expect(Number.isFinite(n.x)).toBe(true)
      expect(Number.isFinite(n.y)).toBe(true)
      expect(n.x).toBeGreaterThanOrEqual(0)
    }
    // La composante déconnectée garde sa structure interne (parents au-dessus de l'enfant)
    expect(genOf(result, 'qkid')).toBe(genOf(result, 'qpa') + 1)
  })

  it('ne boucle pas sur un graphe cyclique malformé', () => {
    const graph = {
      persons: ['a', 'b'].map(person),
      unions: [union('u', 'a', 'b')],
      // a et b enfants de leur propre union : cycle de filiations
      filiations: [fil('f1', 'a', 'u'), fil('f2', 'b', 'u')],
    }
    const result = computeRootedLayout(graph, 'a')
    expect(result.children.filter((n) => n._type === 'person')).toHaveLength(2)
    for (const n of result.children) expect(Number.isFinite(n.x)).toBe(true)
  })

  it('un identifiant racine invalide retombe sur la racine déterministe, de façon reproductible', () => {
    const graph = {
      persons: ['x', 'hub', 'sp1', 'k1'].map(person),
      unions: [union('u1', 'hub', 'sp1')],
      filiations: [fil('f1', 'k1', 'u1')],
    }
    const invalid = computeRootedLayout(graph, 'personne-inconnue')
    const missing = computeRootedLayout(graph, null)
    expect(invalid.rootPersonId).toBe('hub')
    expect(missing.rootPersonId).toBe('hub')

    const pos = (r) => r.children.map((n) => `${n.id}:${Math.round(n.x)},${Math.round(n.y)}`).join(' ')
    expect(pos(invalid)).toBe(pos(missing))
  })

  it('changer de racine réorganise le placement de façon prévisible', () => {
    const graph = {
      persons: ['pa', 'ma', 'root', 'sp', 'kid'].map(person),
      unions: [union('u1', 'pa', 'ma'), union('u2', 'root', 'sp')],
      filiations: [fil('f1', 'root', 'u1'), fil('f2', 'kid', 'u2')],
    }
    const fromRoot = computeRootedLayout(graph, 'root')
    const fromKid = computeRootedLayout(graph, 'kid')

    // Racine = root : root à sa génération, ses parents une au-dessus
    expect(genOf(fromRoot, 'pa')).toBe(genOf(fromRoot, 'root') - 1)
    // Racine = kid : kid devient la référence, root une génération au-dessus de lui
    expect(genOf(fromKid, 'root')).toBe(genOf(fromKid, 'kid') - 1)
    expect(genOf(fromKid, 'pa')).toBe(genOf(fromKid, 'kid') - 2)
    // Le niveau de la référence détermine celui des beaux-parents
    const withInLaws = {
      persons: [...graph.persons, person('bepa'), person('bema')],
      unions: [...graph.unions, union('u3', 'bepa', 'bema')],
      filiations: [...graph.filiations, fil('f3', 'sp', 'u3')],
    }
    const r1 = computeRootedLayout(withInLaws, 'root')
    const r2 = computeRootedLayout(withInLaws, 'kid')
    expect(genOf(r1, 'bepa')).toBe(genOf(r1, 'root') - 1)
    expect(genOf(r2, 'bepa')).toBe(genOf(r2, 'kid') - 2)
  })
})
