// M6 : layout « rooted » du repo — blocs familiaux organisés autour d'une personne racine
// (générations relatives à la racine, lignées ordonnées par proximité, voir frontend
// src/components/galaxy/rootedLayout.js). La racine vient de ROOT=<id> ou du champ
// rootPersonId de la fixture, sinon du repli déterministe du layout.
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { REPO, layoutModule } from '../load.mjs'

const rootedModule = await import(pathToFileURL(`${REPO}components/galaxy/rootedLayout.js`).href)

function fixtureRootPersonId() {
  if (process.env.ROOT) return process.env.ROOT
  const name = process.env.FIXTURE || 'famille'
  try {
    const raw = JSON.parse(readFileSync(new URL(`../fixtures/${name}-graph.json`, import.meta.url), 'utf8'))
    return raw.rootPersonId ?? null
  } catch {
    return null
  }
}

export const name = 'M6 blocs ancrés racine'

export async function layout(graphData) {
  const result = rootedModule.computeRootedLayout(graphData, fixtureRootPersonId())
  return { result, coupleBarMeta: layoutModule.coupleBarMeta }
}
