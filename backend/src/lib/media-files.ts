import { unlink } from 'node:fs/promises'
import path from 'node:path'

import type { FastifyReply } from 'fastify'
import sharp from 'sharp'

// Fichiers envoyés : le type vient des premiers octets, jamais de ce que déclare le navigateur.
// Un SVG, du HTML ou du XML servi depuis l'origine de l'application exécute du script (vol de session).

export type BinaryMediaType = 'photo' | 'video' | 'audio' | 'document' | 'geojson' | 'gpx'

export const IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const

const ALLOWED_BY_TYPE: Record<BinaryMediaType, readonly string[]> = {
  photo: IMAGE_MIME_TYPES,
  video: ['video/mp4', 'video/quicktime', 'video/webm'],
  audio: ['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/wav', 'audio/ogg', 'audio/webm', 'audio/flac'],
  document: [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain',
  ],
  geojson: ['application/geo+json'],
  gpx: ['application/gpx+xml'],
}

// Affichés tels quels par le navigateur ; tout le reste part en téléchargement
const INLINE_MIME_TYPES = new Set<string>([
  ...IMAGE_MIME_TYPES,
  ...ALLOWED_BY_TYPE.video,
  ...ALLOWED_BY_TYPE.audio,
  'application/pdf',
])

// Texte que l'application lit elle-même (tracés, citations) : servi avec son type, mais en pièce jointe
const TEXT_MIME_TYPES = new Set<string>(['text/plain', 'application/geo+json', 'application/gpx+xml'])

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/aac': '.aac',
  'audio/wav': '.wav',
  'audio/ogg': '.ogg',
  'audio/webm': '.weba',
  'audio/flac': '.flac',
  'application/pdf': '.pdf',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'text/plain': '.txt',
  'application/geo+json': '.geojson',
  'application/gpx+xml': '.gpx',
}

function startsWith(buf: Buffer, bytes: number[], offset = 0): boolean {
  if (buf.length < offset + bytes.length) return false
  return bytes.every((byte, index) => buf[offset + index] === byte)
}

function ascii(buf: Buffer, start: number, end: number): string {
  return buf.subarray(start, end).toString('latin1')
}

function isUtf8Text(buf: Buffer): boolean {
  if (buf.includes(0)) return false
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf)
    return true
  } catch {
    return false
  }
}

// Type réel d'après la signature binaire. `declaredType` départage les conteneurs communs (MP4 audio ou vidéo).
export function sniffMimeType(buf: Buffer, declaredType: BinaryMediaType, fileName = ''): string | null {
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (ascii(buf, 0, 6) === 'GIF87a' || ascii(buf, 0, 6) === 'GIF89a') return 'image/gif'
  if (ascii(buf, 0, 4) === 'RIFF' && ascii(buf, 8, 12) === 'WEBP') return 'image/webp'
  if (ascii(buf, 0, 4) === 'RIFF' && ascii(buf, 8, 12) === 'WAVE') return 'audio/wav'
  if (ascii(buf, 0, 5) === '%PDF-') return 'application/pdf'
  if (ascii(buf, 4, 8) === 'ftyp') {
    const brand = ascii(buf, 8, 12)
    if (brand === 'qt  ') return 'video/quicktime'
    if (declaredType === 'audio' || brand === 'M4A ' || brand === 'M4B ') return 'audio/mp4'
    return 'video/mp4'
  }
  if (startsWith(buf, [0x1a, 0x45, 0xdf, 0xa3])) return declaredType === 'audio' ? 'audio/webm' : 'video/webm'
  if (ascii(buf, 0, 4) === 'OggS') return 'audio/ogg'
  if (ascii(buf, 0, 4) === 'fLaC') return 'audio/flac'
  if (ascii(buf, 0, 3) === 'ID3') return 'audio/mpeg'
  if (buf.length > 1 && buf[0] === 0xff && (buf[1] === 0xf1 || buf[1] === 0xf9)) return 'audio/aac'
  if (buf.length > 1 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'audio/mpeg'
  if (startsWith(buf, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'application/msword'
  if (startsWith(buf, [0x50, 0x4b, 0x03, 0x04]) && fileName.toLowerCase().endsWith('.docx')) {
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  }

  if (!isUtf8Text(buf)) return null
  const text = buf.toString('utf8').replace(/^﻿/, '').trimStart()

  if (declaredType === 'geojson') {
    try {
      const parsed = JSON.parse(text)
      return parsed && typeof parsed === 'object' ? 'application/geo+json' : null
    } catch {
      return null
    }
  }

  if (declaredType === 'gpx') {
    return /^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<gpx[\s>]/.test(text) ? 'application/gpx+xml' : null
  }

  // Texte brut accepté comme document, sauf s'il ressemble à une page ou un balisage
  if (declaredType === 'document' && !/^</.test(text)) return 'text/plain'

  return null
}

export function isMimeAllowedForType(type: BinaryMediaType, mimeType: string): boolean {
  return ALLOWED_BY_TYPE[type].includes(mimeType)
}

export function extensionForMime(mimeType: string): string {
  return EXTENSION_BY_MIME[mimeType] ?? '.bin'
}

export class InvalidMediaError extends Error {}

// Photos : rotation du téléphone appliquée aux pixels, puis réencodage sans aucune métadonnée
// (GPS, appareil, date). Un GIF peut être animé : réencodé image par image, ce qui borne ses dimensions et
// retire ses blocs XMP et commentaires (il passait tel quel, sans aucune limite).
export async function sanitizeImage(buf: Buffer, mimeType: string): Promise<Buffer> {
  try {
    if (mimeType === 'image/gif') {
      return await sharp(buf, { animated: true, limitInputPixels: 50_000_000, failOn: 'error' }).gif().toBuffer()
    }
    const image = sharp(buf, { limitInputPixels: 50_000_000, failOn: 'error' }).rotate()
    if (mimeType === 'image/jpeg') return await image.jpeg({ quality: 90, mozjpeg: true }).toBuffer()
    if (mimeType === 'image/png') return await image.png().toBuffer()
    if (mimeType === 'image/webp') return await image.webp({ quality: 90 }).toBuffer()
  } catch {
    throw new InvalidMediaError('invalid_image')
  }

  throw new InvalidMediaError('invalid_image')
}

// Vidéos et sons MP4/MOV de téléphone : la position (ISO 6709, ex. « +50.6300+003.0600/ ») vit dans
// la boîte `moov`. On remet ses chiffres à zéro sur place, sans toucher à la taille ni aux images.
export function scrubMp4Location(buf: Buffer): Buffer {
  let offset = 0
  while (offset + 8 <= buf.length) {
    let size = buf.readUInt32BE(offset)
    const type = ascii(buf, offset + 4, offset + 8)
    let header = 8
    if (size === 1) {
      if (offset + 16 > buf.length) break
      size = Number(buf.readBigUInt64BE(offset + 8))
      header = 16
    } else if (size === 0) {
      size = buf.length - offset
    }
    if (size < header) break

    if (type === 'moov') {
      const end = Math.min(offset + size, buf.length)
      const region = buf.subarray(offset + header, end)
      const text = region.toString('latin1')
      // Chaque partie est bornée : la forme d'avant, `(?:CRS[^/]*)?`, rebalayait le reste de la boîte depuis
      // chaque position, et un faux MP4 de 8 Mo rempli de « +1+1CRS » bloquait l'API pendant des heures.
      const pattern = /[+-]\d{1,3}(?:\.\d{1,12})?[+-]\d{1,3}(?:\.\d{1,12})?(?:[+-]\d{1,6}(?:\.\d{1,12})?)?(?:CRS[^/]{0,40})?\//g
      for (const match of text.matchAll(pattern)) {
        const zeroed = match[0].replace(/\d/g, '0')
        region.write(zeroed, match.index ?? 0, 'latin1')
      }
    }

    offset += size
  }
  return buf
}

// En-têtes de diffusion d'un fichier envoyé, décidés d'après le type enregistré (y compris pour
// les fichiers envoyés avant ces contrôles, dont le type venait du navigateur).
export function applyMediaResponseHeaders(reply: FastifyReply, storedMimeType: string | null | undefined, downloadName: string): void {
  const mimeType = (storedMimeType ?? '').toLowerCase()
  reply.header('X-Content-Type-Options', 'nosniff')
  reply.header('Cache-Control', 'private, max-age=300')

  if (INLINE_MIME_TYPES.has(mimeType)) {
    reply.type(mimeType)
    // Le lecteur PDF des navigateurs ne s'affiche pas dans un bac à sable
    if (mimeType !== 'application/pdf') {
      reply.header('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox")
    }
    return
  }

  reply.type(TEXT_MIME_TYPES.has(mimeType) ? `${mimeType}; charset=utf-8` : 'application/octet-stream')
  reply.header('Content-Security-Policy', "default-src 'none'; sandbox")
  const safeName = downloadName.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100) || 'fichier'
  reply.header('Content-Disposition', `attachment; filename="${safeName}"`)
}

// Portrait venu d'une association Immich : son fichier porte le préfixe « immich- ». Le graphe
// ne publie jamais l'identifiant Immich, seulement cette origine du portrait.
export function isImmichAvatarPath(avatarPath: string | null | undefined): boolean {
  return avatarPath != null && path.basename(avatarPath).startsWith('immich-')
}

// Efface un fichier du stockage, sans jamais sortir du dossier racine
export async function removeStoredFile(storageRoot: string, relativePath: string | null | undefined): Promise<void> {
  if (!relativePath || /^https?:\/\//.test(relativePath)) return
  const absolutePath = path.resolve(storageRoot, relativePath)
  if (!absolutePath.startsWith(storageRoot + path.sep)) return
  try {
    await unlink(absolutePath)
  } catch {
    // déjà absent
  }
}
