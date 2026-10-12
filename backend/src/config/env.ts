import { config as loadDotenv } from 'dotenv'
import { z } from 'zod'

// dotenv 17+ écrit « injected env (N) from .env » à chaque démarrage, même sans fichier : les journaux
// de l'API restent au format JSON de Fastify
loadDotenv({ quiet: true })

const DEV_DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/genealogy'
const DEV_JWT_SECRET = 'dev-secret-change-me-please'

// Valeurs d'exemple publiées dans le dépôt : une instance qui les garde a un secret connu de tous
const PUBLISHED_PLACEHOLDER_SECRETS = [
  DEV_JWT_SECRET,
  'change-me-in-production',
  'changeme',
]

// Adresses des proxys de confiance devant l'API (liste séparée par des virgules, mots-clés de proxy-addr :
// loopback, uniquelocal, linklocal, ou IP/CIDR). Par défaut : nginx sur la même machine (pm2) ou dans le
// réseau Docker (compose). L'adresse du client est la dernière entrée de X-Forwarded-For ajoutée par un
// proxy de confiance. `true` lirait l'adresse dans un en-tête que le client écrit lui-même, et Fastify
// ignore un nombre de sauts : ni l'un ni l'autre n'est accepté.
function parseTrustProxy(value: string): boolean | string {
  if (value === 'false') return false
  if (value === 'true' || /^\d+$/.test(value)) {
    throw new Error('TRUST_PROXY must list the proxy addresses (e.g. "loopback,uniquelocal"), not true or a hop count')
  }
  return value
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().min(1).default('0.0.0.0'),
  TRUST_PROXY: z.string().default('loopback,uniquelocal').transform(parseTrustProxy),
  DATABASE_URL: z.string().min(1).default(DEV_DATABASE_URL),
  JWT_SECRET: z.string().min(16).default(DEV_JWT_SECRET),
  JWT_EXPIRES_IN: z.string().default('7d'),
  // Les sessions de compte émises avant cette date sont refusées. Jusqu'au 30/09/2026, des sessions complètes
  // ont pu être écrites dans les annotations photo et les journaux : elles tombent toutes, chacun se reconnecte
  // une fois. Avancer cette date (ISO 8601) déconnecte tout le monde, sans changer JWT_SECRET (qui chiffre aussi
  // les mots de passe de partage lisibles).
  SESSIONS_NOT_BEFORE: z.coerce.date().default(new Date('2026-10-01T00:00:00Z')),
  JWT_TREE_ACCESS_EXPIRES_IN: z.string().default('24h'),
  CORS_ORIGIN: z
    .string()
    .default('http://localhost:5173,http://localhost:5174,http://localhost:5175,http://localhost:5176')
    .transform((value) => value.split(',').map((origin) => origin.trim()).filter(Boolean)),
  MEDIA_STORAGE_PATH: z.string().default('./storage/media'),
  // Place disque par arbre, et part réservée aux envois de la famille en attente de relecture
  MEDIA_QUOTA_PER_TREE_MB: z.coerce.number().int().positive().default(5120),
  MEDIA_PENDING_QUOTA_PER_TREE_MB: z.coerce.number().int().positive().default(500),
  // Reconnaissance des visages via Immich : désactivé par défaut, adresse et clé de l'instance.
  IMMICH_ENABLED: z.preprocess((val) => String(val).toLowerCase() === 'true', z.boolean()).default(false),
  IMMICH_API_URL: z.string().url().optional(),
  IMMICH_API_KEY: z.string().min(1).optional(),
})

export const env = envSchema.parse(process.env)

// Corps maximal des routes qui reçoivent un fichier en base64 ou un gros envoi (le reste de l'API : 1 Mo)
export const UPLOAD_BODY_LIMIT = 12 * 1024 * 1024

// Sans NODE_ENV, le schéma suppose « development » et la clé de signature retomberait sur une valeur publiée :
// un `node dist/server.js` lancé à la main avec un .env incomplet signerait alors les sessions avec une clé
// connue de tous. Hors développement ou test déclaré, une valeur publiée est refusée.
if (!process.env.NODE_ENV && PUBLISHED_PLACEHOLDER_SECRETS.includes(env.JWT_SECRET)) {
  throw new Error('JWT_SECRET is a published example value and NODE_ENV is not set: set NODE_ENV=development for local work, or generate a secret with `openssl rand -base64 48`')
}

if (env.NODE_ENV === 'production') {
  if (PUBLISHED_PLACEHOLDER_SECRETS.includes(env.JWT_SECRET)) {
    throw new Error('JWT_SECRET is a published example value: generate one with `openssl rand -base64 48`')
  }

  if (env.JWT_SECRET.length < 32) {
    console.warn('JWT_SECRET is shorter than 32 characters: generate a longer one with `openssl rand -base64 48`')
  }

  if (env.DATABASE_URL === DEV_DATABASE_URL) {
    throw new Error('DATABASE_URL must be overridden in production')
  }
}
