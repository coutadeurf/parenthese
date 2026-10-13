// Génère un arbre synthétique réaliste (~1300 personnes) pour mesurer les layouts sans données
// familiales réelles : lignée principale profonde, conjoints issus de familles alliées
// (beaux-parents), mariages entre branches éloignées (lignées partagées), parents uniques.
// Sortie : fixtures/synth1300-graph.json, même format que fetch-fixture.mjs (git-ignoré).
//
// Usage : node gen-synth.mjs [cible]   (défaut 1300)
import { writeFileSync, mkdirSync } from 'node:fs'

const target = Number(process.argv[2]) || 1300

// LCG déterministe : même graine = même arbre
let seed = 42
const rand = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return seed / 0x7fffffff
}
const rint = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1))

const persons = []
const unions = []
const filiations = []
let p = 0, u = 0, f = 0
const addPerson = () => {
  p += 1
  persons.push({ id: `s${p}`, firstName: `Prénom${p}`, lastName: 'Synth', birthDate: null, deathDate: null })
  return `s${p}`
}
const addUnion = (p1, p2) => {
  u += 1
  unions.push({ id: `u${u}`, partner1PersonId: p1, partner2PersonId: p2, unionType: 'marriage', displayOrder: u })
  return `u${u}`
}
const addFiliation = (childId, { viaUnionId = null, parentPersonId = null } = {}) => {
  f += 1
  filiations.push({ id: `f${f}`, childPersonId: childId, parentPersonId, viaUnionId, parentageType: 'biologique', displayOrder: f })
}

const MAX_GEN = 11

// Famille alliée : les parents du conjoint + 0 à 2 de ses frères et sœurs
function inLawFamily(spouseId) {
  const fp = addPerson(), mp = addPerson()
  const fu = addUnion(fp, mp)
  addFiliation(spouseId, { viaUnionId: fu })
  const sibs = rint(0, 2)
  for (let i = 0; i < sibs; i++) addFiliation(addPerson(), { viaUnionId: fu })
}

// Lignée principale : pyramide génération par génération
const rootCouple = [addPerson(), addPerson()]
const rootUnion = addUnion(rootCouple[0], rootCouple[1])
let frontier = [{ couple: rootCouple, unionId: rootUnion, gen: 0 }]
let mainPerson = rootCouple[0]

while (persons.length < target * 0.72 && frontier.length > 0) {
  const next = []
  for (const entry of frontier) {
    if (entry.gen >= MAX_GEN) continue
    const kids = rint(1, 4)
    for (let i = 0; i < kids; i++) {
      if (persons.length >= target * 0.72) break
      const kid = addPerson()
      addFiliation(kid, { viaUnionId: entry.unionId })
      if (rand() < 0.8) {
        // mariage : conjoint de la lignée, parfois issu d'une famille alliée
        const spouse = addPerson()
        const ku = addUnion(entry.gen % 2 === 0 ? kid : spouse, entry.gen % 2 === 0 ? spouse : kid)
        if (rand() < 0.4) inLawFamily(spouse)
        next.push({ couple: [kid, spouse], unionId: ku, gen: entry.gen + 1 })
        if (entry.gen === Math.floor(MAX_GEN / 2)) mainPerson = kid
      }
    }
  }
  frontier = next
}

// Feuilles supplémentaires pour approcher la cible
let guard = 0
while (persons.length < target * 0.9 && guard++ < 5000) {
  const parent = persons[rint(0, persons.length - 1)]
  const existing = filiations.filter(fl => fl.childPersonId === parent.id)
  const kid = addPerson()
  if (existing.length === 1 && existing[0].viaUnionId) {
    const un = unions.find(un2 => un2.id === existing[0].viaUnionId)
    if (un) { addFiliation(kid, { viaUnionId: un.id }); continue }
  }
  // parent unique (GEDCOM unilatéral) : filiation directe, pas d'union
  addFiliation(kid, { parentPersonId: parent.id })
}

// Mariages entre branches éloignées : la même chaîne de couple réclamée par deux lignées
const childlessPairs = []
for (const un of unions) {
  const hasKid = filiations.some(fl => fl.viaUnionId === un.id)
  if (!hasKid) childlessPairs.push(un)
}
for (let i = 0; i < Math.min(10, Math.floor(childlessPairs.length / 2)); i++) {
  const ua = childlessPairs[rint(0, childlessPairs.length - 1)]
  const ub = childlessPairs[rint(0, childlessPairs.length - 1)]
  if (!ua || !ub || ua === ub) continue
  if (ua.partner1PersonId === ub.partner1PersonId) continue
  const cross = addUnion(ua.partner1PersonId, ub.partner1PersonId)
  const kids = rint(1, 2)
  for (let k = 0; k < kids; k++) addFiliation(addPerson(), { viaUnionId: cross })
}

// Compléter jusqu'à la cible avec des familles alliées de feuilles
guard = 0
while (persons.length < target && guard++ < 5000) {
  const leaf = persons[rint(0, persons.length - 1)]
  const spouse = addPerson()
  inLawFamily(spouse)
  addUnion(leaf.id, spouse)
}

const graph = { persons, unions, filiations, medias: [], annotations: [] }
mkdirSync(new URL('./fixtures/', import.meta.url), { recursive: true })
writeFileSync(new URL('./fixtures/synth1300-graph.json', import.meta.url), JSON.stringify({
  treeId: 'synthetic',
  rootPersonId: mainPerson,
  graph,
}, null, 1))
console.log(`synth1300 : ${persons.length} personnes, ${unions.length} unions, ${filiations.length} filiations, racine ${mainPerson}`)
