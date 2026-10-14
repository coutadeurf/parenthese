import type { PrismaClient } from '@prisma/client'

import { env } from '../config/env.js'
import { decryptImmichApiKey } from './immich-secret.js'

// Client Immich : la reconnaissance des visages lit les personnes et leurs vignettes.
// Contrat vérifié sur la spécification OpenAPI officielle d'Immich v3.1.0 :
//   GET /api/server/ping                 -> 200 {"res":"pong"}
//   GET /api/people?page=N&size=M        -> 200 { people: PersonResponseDto[], total, hasNextPage, hidden } (size <= 1000)
//   GET /api/people/{id}                 -> 200 PersonResponseDto | 404 (id : UUID v4)
//   GET /api/people/{id}/thumbnail      -> 200 image binaire | 404
// Authentification : en-tête x-api-key ; clé refusée -> 401.

// Instance injoignable : réseau coupé, délai dépassé, réponse illisible.
export class ImmichUnavailableError extends Error {
  constructor(message = 'Immich est injoignable') {
    super(message)
    this.name = 'ImmichUnavailableError'
  }
}

// Clé d'API refusée par Immich (401/403).
export class ImmichAuthError extends Error {
  constructor(message = 'Clé d’API Immich refusée') {
    super(message)
    this.name = 'ImmichAuthError'
  }
}

// Personne ou vignette inexistante côté Immich (404).
export class ImmichNotFoundError extends Error {
  constructor(message = 'Personne Immich introuvable') {
    super(message)
    this.name = 'ImmichNotFoundError'
  }
}

const IMMICH_PEOPLE_PAGE_SIZE = 1000
const IMMICH_TIMEOUT_MS = 10_000

// Identifiants de personnes Immich : UUID v4 (spécification OpenAPI).
const IMMICH_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isImmichPersonId(value: string): boolean {
  return IMMICH_ID_RE.test(value)
}

export type ImmichPersonSummary = {
  id: string
  name: string
  hasThumbnail: boolean
}

type ImmichPeoplePage = {
  people?: unknown
  hasNextPage?: unknown
}

export class ImmichClient {
  private readonly apiUrl: string
  private readonly apiKey: string

  constructor(apiUrl: string, apiKey: string) {
    this.apiUrl = apiUrl.replace(/\/$/, '')
    this.apiKey = apiKey
  }

  private buildUrl(path: string): string {
    return new URL(path, `${this.apiUrl}/`).toString()
  }

  private async fetch(path: string): Promise<Response> {
    const url = this.buildUrl(path)
    let response: Response
    try {
      response = await fetch(url, {
        headers: { 'x-api-key': this.apiKey, Accept: 'application/json' },
        signal: AbortSignal.timeout(IMMICH_TIMEOUT_MS),
      })
    } catch (error) {
      // L'URL ne contient aucun secret ; la clé voyage dans l'en-tête, jamais dans les journaux.
      console.warn(`Immich injoignable : ${url} (${(error as Error).message})`)
      throw new ImmichUnavailableError()
    }

    if (response.ok) {
      return response
    }

    // Journal avec le statut et l'URL (sans secret), puis remontée d'une erreur distincte par cause.
    console.warn(`Immich a répondu ${response.status} sur ${url}`)
    if (response.status === 401 || response.status === 403) {
      throw new ImmichAuthError()
    }
    if (response.status === 404) {
      throw new ImmichNotFoundError()
    }
    throw new ImmichUnavailableError(`Immich a répondu ${response.status}`)
  }

  async ping(): Promise<boolean> {
    try {
      const response = await this.fetch('/api/server/ping')
      const payload = (await response.json()) as { res?: unknown }
      return payload?.res === 'pong'
    } catch {
      return false
    }
  }

  // Toutes les personnes (sans les masquées), en suivant la pagination d'Immich.
  async listPeople(): Promise<ImmichPersonSummary[]> {
    const people: ImmichPersonSummary[] = []
    let page = 1

    // Garde-fou : une instance qui répondrait toujours hasNextPage ne doit pas nous faire boucler.
    for (let guard = 0; guard < 1000; guard += 1, page += 1) {
      const response = await this.fetch(`/api/people?page=${page}&size=${IMMICH_PEOPLE_PAGE_SIZE}`)
      const payload = (await response.json()) as ImmichPeoplePage

      if (!Array.isArray(payload.people)) {
        throw new ImmichUnavailableError('Réponse Immich inattendue sur /api/people')
      }

      for (const person of payload.people as Array<{ id?: unknown; name?: unknown; thumbnailPath?: unknown }>) {
        if (typeof person?.id !== 'string' || typeof person?.name !== 'string') {
          throw new ImmichUnavailableError('Réponse Immich inattendue sur /api/people')
        }
        people.push({ id: person.id, name: person.name, hasThumbnail: typeof person.thumbnailPath === 'string' && person.thumbnailPath.length > 0 })
      }

      if (payload.hasNextPage !== true || (payload.people as unknown[]).length === 0) {
        break
      }
    }

    return people
  }

  // Une personne précise : 200 avec ses données, 404 si elle n'existe pas. Le 404 de la
  // vignette ne prouve rien (personne absente ou simple vignette manquante), l'existence
  // se vérifie donc ici.
  async getPerson(personId: string): Promise<ImmichPersonSummary> {
    const response = await this.fetch(`/api/people/${encodeURIComponent(personId)}`)
    const person = (await response.json()) as { id?: unknown; name?: unknown; thumbnailPath?: unknown }
    if (typeof person?.id !== 'string' || typeof person?.name !== 'string') {
      throw new ImmichUnavailableError('Réponse Immich inattendue sur /api/people/{id}')
    }
    return {
      id: person.id,
      name: person.name,
      hasThumbnail: typeof person.thumbnailPath === 'string' && person.thumbnailPath.length > 0,
    }
  }

  // Vignette d'une personne, en octets bruts (JPEG côté Immich). Absente -> ImmichNotFoundError.
  async getPersonThumbnail(personId: string): Promise<Buffer> {
    const response = await this.fetch(`/api/people/${encodeURIComponent(personId)}/thumbnail`)
    return Buffer.from(await response.arrayBuffer())
  }
}

// Instance Immich normalisée pour comparaison : origine + chemin, sans slash final. Null si l'URL
// est mal formée ou d'un autre protocole que http(s).
export function normalizeImmichApiUrl(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null
    }
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
  } catch {
    return null
  }
}

let allowedApiUrlsCache: string[] | undefined

// Instances Immich autorisées par l'opérateur du serveur (IMMICH_ALLOWED_API_URLS). C'est la seule
// liste d'adresses possibles : les administrateurs d'un arbre y choisissent la leur, le serveur
// ne devient jamais un proxy vers un service interne choisi librement. Les entrées invalides sont
// ignorées avec un avertissement.
export function getImmichAllowedApiUrls(): string[] {
  if (allowedApiUrlsCache !== undefined) {
    return allowedApiUrlsCache
  }

  const urls: string[] = []
  for (const entry of env.IMMICH_ALLOWED_API_URLS.split(',')) {
    const trimmed = entry.trim()
    if (!trimmed) {
      continue
    }
    const normalized = normalizeImmichApiUrl(trimmed)
    if (!normalized) {
      console.warn(`IMMICH_ALLOWED_API_URLS : entrée ignorée (URL http(s) invalide) : ${trimmed}`)
      continue
    }
    if (!urls.includes(normalized)) {
      urls.push(normalized)
    }
  }
  allowedApiUrlsCache = urls
  return urls
}

export function isImmichApiUrlAllowed(value: string): boolean {
  const normalized = normalizeImmichApiUrl(value)
  return normalized !== null && getImmichAllowedApiUrls().includes(normalized)
}

// Connexion Immich d'un arbre : résolue par arbre, côté serveur, à chaque requête. Pas de client
// global qui garderait les identifiants d'un arbre et pourrait servir un autre ; pas d'héritage
// de configuration du serveur. Une clé illisible (JWT_SECRET changé) vaut « non configuré », et
// une adresse retirée de la liste de l'opérateur aussi : la connexion existante cesse de marcher.
export async function getTreeImmichClient(prisma: PrismaClient, treeId: string): Promise<ImmichClient | null> {
  const config = await prisma.treeImmichConfig.findUnique({
    where: { treeId },
    select: { apiUrl: true, apiKeyEnc: true },
  })
  if (!config) {
    return null
  }

  const apiKey = decryptImmichApiKey(config.apiKeyEnc)
  if (!apiKey) {
    return null
  }

  if (!isImmichApiUrlAllowed(config.apiUrl)) {
    return null
  }

  return new ImmichClient(config.apiUrl, apiKey)
}
