// Modèle 0 : layouts actuels du repo (Sugiyama custom + blocs familiaux par défaut), tels quels
import { pathToFileURL } from 'node:url'
import { layoutModule, REPO } from '../load.mjs'

const blockModule = await import(pathToFileURL(`${REPO}components/galaxy/blockLayout.js`).href)

export const name = 'M0 actuel (Sugiyama custom)'

export async function layout(graphData) {
  const result = layoutModule.computeLayout(graphData)
  return { result, coupleBarMeta: layoutModule.coupleBarMeta }
}

export const variants = [
  { name: 'M0 actuel (Sugiyama custom)', layout },
  {
    name: 'M7 actuel (blocs familiaux, défaut)',
    layout: (graphData) => {
      const result = blockModule.computeBlockLayout(graphData)
      return { result, coupleBarMeta: layoutModule.coupleBarMeta }
    },
  },
]
