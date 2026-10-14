import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

import { env } from '../config/env.js'

// Clé d'API Immich d'un arbre : secrète au repos, jamais renvoyée au front ni écrite dans les
// journaux. Même mécanisme que le mot de passe de partage (share-password.ts) : AES-256-GCM,
// clé dérivée de JWT_SECRET. Changer ce secret rend les clés illisibles ; chaque arbre
// repasse alors en « à configurer », sans rien casser d'autre.
const VERSION = 'v1'

function getKey(): Buffer {
  return Buffer.from(hkdfSync('sha256', env.JWT_SECRET, 'parenthese', 'immich-api-key-v1', 32))
}

export function encryptImmichApiKey(value: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', getKey(), iv)
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${VERSION}:${Buffer.concat([iv, tag, encrypted]).toString('base64')}`
}

// null si la valeur stockée est absente, d'un autre format, ou illisible (JWT_SECRET changé).
export function decryptImmichApiKey(stored: string | null | undefined): string | null {
  if (!stored || !stored.startsWith(`${VERSION}:`)) {
    return null
  }

  try {
    const raw = Buffer.from(stored.slice(VERSION.length + 1), 'base64')
    const decipher = createDecipheriv('aes-256-gcm', getKey(), raw.subarray(0, 12))
    decipher.setAuthTag(raw.subarray(12, 28))
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}
