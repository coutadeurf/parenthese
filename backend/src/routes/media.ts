import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { z } from 'zod'

import { env, UPLOAD_BODY_LIMIT } from '../config/env.js'
import {
  applyMediaResponseHeaders,
  extensionForMime,
  InvalidMediaError,
  isMimeAllowedForType,
  removeStoredFile,
  sanitizeImage,
  scrubMp4Location,
  sniffMimeType,
  type BinaryMediaType,
} from '../lib/media-files.js'
import { syncPersonMediaOrder } from '../lib/media-order.js'
import { resolveTreeMediaDirectory } from '../lib/tree-purge.js'
import { canReadTree, canReadTreeWithMediaToken } from '../lib/tree-access.js'
import type { MembershipRole } from '../types/auth.js'
import { ContributionRouteError, resolveSubmissionContext } from './contributions.js'

const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_FILE_BYTES = 20 * 1024 * 1024

const treeIdParamSchema = z.object({
  id: z.string().min(1),
})

const treePersonParamsSchema = z.object({
  id: z.string().min(1),
  personId: z.string().min(1),
})

const mediaParamsSchema = z.object({
  id: z.string().min(1),
  mediaId: z.string().min(1),
})

const mediaSourceSchema = z.string().max(500).optional().nullable()

const downloadQuerySchema = z.object({
  token: z.string().min(1).optional(),
})

const uploadBinaryMediaSchema = z.object({
  submittedByLabel: z.string().trim().min(1).max(120).optional(),
  type: z.enum(['photo', 'video', 'audio', 'document', 'geojson', 'gpx']),
  fileName: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(120),
  sizeBytes: z.number().int().positive().max(MAX_FILE_BYTES),
  dataBase64: z.string().min(1),
  caption: z.string().max(280).optional().nullable(),
  source: mediaSourceSchema,
})

const uploadCitationMediaSchema = z.object({
  submittedByLabel: z.string().trim().min(1).max(120).optional(),
  type: z.literal('citation'),
  caption: z.string().trim().min(1).max(2000),
  source: mediaSourceSchema,
})

const YOUTUBE_URL_RE = /^https:\/\/(www\.)?(youtube\.com|youtu\.be)\//

const uploadYoutubeVideoSchema = z.object({
  submittedByLabel: z.string().trim().min(1).max(120).optional(),
  type: z.literal('video'),
  mimeType: z.literal('video/youtube'),
  youtubeUrl: z.string().max(500).regex(YOUTUBE_URL_RE),
  caption: z.string().max(280).optional().nullable(),
  source: mediaSourceSchema,
})

const uploadMediaSchema = z.union([uploadBinaryMediaSchema, uploadCitationMediaSchema, uploadYoutubeVideoSchema])

const uploadAvatarSchema = z.object({
  fileName: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(120),
  sizeBytes: z.number().int().positive().max(MAX_IMAGE_BYTES),
  dataBase64: z.string().min(1),
})

const reorderMediaSchema = z.object({
  orderedMediaIds: z.array(z.string().min(1)).min(1),
})

function hasAdminRight(role: MembershipRole): boolean {
  return role === 'owner' || role === 'admin'
}

// Racine du stockage des médias : partagée avec les portraits venus d'Immich (routes/immich.ts).
export function getStorageRoot(): string {
  return path.resolve(env.MEDIA_STORAGE_PATH)
}

function stripDataUrlPrefix(value: string): string {
  const index = value.indexOf(',')
  if (value.startsWith('data:') && index >= 0) {
    return value.slice(index + 1)
  }

  return value
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

// Fichier décodé, reconnu à ses octets et nettoyé (photos sans métadonnées, vidéos sans position).
// Le type déclaré par le navigateur n'est plus qu'un indice pour les conteneurs ambigus.
export async function prepareUploadedFile(
  buffer: Buffer,
  type: BinaryMediaType,
  fileName: string,
): Promise<{ buffer: Buffer; mimeType: string; extension: string }> {
  const mimeType = sniffMimeType(buffer, type, fileName)
  if (!mimeType || !isMimeAllowedForType(type, mimeType)) {
    throw new InvalidMediaError('invalid_media_mime_type')
  }

  let cleaned = buffer
  if (type === 'photo') {
    cleaned = await sanitizeImage(buffer, mimeType)
  } else if (mimeType === 'video/mp4' || mimeType === 'video/quicktime' || mimeType === 'audio/mp4') {
    cleaned = scrubMp4Location(Buffer.from(buffer))
  }

  return { buffer: cleaned, mimeType, extension: extensionForMime(mimeType) }
}

// Octets réellement occupés par le dossier d'un arbre. Le total des médias en base ne voyait ni les portraits,
// ni les photos d'annotation, ni les fichiers restés après une suppression : le quota se contournait.
async function treeDiskUsage(treeId: string): Promise<number> {
  const directory = resolveTreeMediaDirectory(treeId, getStorageRoot())
  if (!directory) return 0
  let total = 0
  const walk = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(entryPath)
      } else if (entry.isFile()) {
        try {
          total += (await stat(entryPath)).size
        } catch {
          // effacé entre-temps
        }
      }
    }
  }
  await walk(directory)
  return total
}

// Place disque d'un arbre : total, et part des envois en attente de relecture (limite l'envoi en boucle)
export async function exceedsStorageQuota(app: FastifyRequest['server'], treeId: string, incomingBytes: number, isPending: boolean): Promise<boolean> {
  const MB = 1024 * 1024
  if ((await treeDiskUsage(treeId)) + incomingBytes > env.MEDIA_QUOTA_PER_TREE_MB * MB) {
    return true
  }

  if (!isPending) {
    return false
  }

  const pending = await app.prisma.mediaItem.aggregate({
    where: { treeId, status: 'pending', deletedAt: null },
    _sum: { sizeBytes: true },
  })
  return (pending._sum.sizeBytes ?? 0) + incomingBytes > env.MEDIA_PENDING_QUOTA_PER_TREE_MB * MB
}

// Seules les routes d'envoi acceptent un corps de 12 Mo (fichier en base64), le reste de l'API est à 1 Mo (app.ts)
const UPLOAD_RATE_LIMIT = { bodyLimit: UPLOAD_BODY_LIMIT, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }
// Portraits : réservés au propriétaire, mais l'app peut en placer quelques centaines d'un coup (photos
// retrouvées après un import GEDCOM), envoyées une par une. Le quota de stockage de l'arbre s'applique.
const AVATAR_RATE_LIMIT = { bodyLimit: UPLOAD_BODY_LIMIT, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }

export async function requireAdminMembership(app: FastifyRequest['server'], userId: string, treeId: string) {
  const membership = await app.prisma.treeMembership.findUnique({
    where: {
      treeId_userId: {
        treeId,
        userId,
      },
    },
    include: {
      tree: {
        select: {
          deletedAt: true,
        },
      },
    },
  })

  if (!membership || membership.tree.deletedAt || !hasAdminRight(membership.role)) {
    return null
  }

  return membership
}

// Session (en-tête) ou jeton médias (adresse d'une image). La session du compte n'est plus acceptée
// dans l'adresse : elle finissait dans les journaux, l'historique et les liens copiés.
async function canReadMedia(app: FastifyRequest['server'], treeId: string, request: FastifyRequest, token: string | undefined): Promise<boolean> {
  if (await canReadTree(app, treeId, request.actor)) {
    return true
  }
  return token ? canReadTreeWithMediaToken(app, treeId, token) : false
}

export const mediaRoutes: FastifyPluginAsync = async (app) => {
  app.post('/trees/:id/persons/:personId/media', UPLOAD_RATE_LIMIT, async (request, reply) => {
    const actor = request.actor
    if (!actor) {
      return reply.code(401).send({ error: 'authentication_required' })
    }

    const params = treePersonParamsSchema.safeParse(request.params)
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_params' })
    }

    const payload = uploadMediaSchema.safeParse(request.body)
    if (!payload.success) {
      return reply.code(400).send({ error: 'invalid_payload', details: payload.error.flatten() })
    }

    // Administrateur : le souvenir est visible tout de suite. Famille (lien de partage, membre) :
    // il devient une contribution, visible après relecture sauf si l'arbre applique tout de suite.
    const membership = actor.kind === 'user' ? await requireAdminMembership(app, actor.userId, params.data.id) : null
    let contribution: Awaited<ReturnType<typeof resolveSubmissionContext>> | null = null
    if (!membership) {
      try {
        contribution = await resolveSubmissionContext(app, actor, params.data.id)
      } catch (error) {
        if (error instanceof ContributionRouteError) {
          return reply.code(error.statusCode).send({ error: error.code })
        }
        throw error
      }
    }
    const isPending = contribution?.autoStatus === 'pending'
    const uploaderUserId = actor.kind === 'user' ? actor.userId : null

    const person = await app.prisma.person.findFirst({
      where: {
        id: params.data.personId,
        treeId: params.data.id,
        deletedAt: null,
      },
      select: {
        id: true,
        firstName: true,
      },
    })

    if (!person) {
      return reply.code(404).send({ error: 'person_not_found' })
    }

    // Fichier reconnu, nettoyé et compté AVANT toute écriture : un envoi refusé ne laisse ni contribution
    // vide en attente ni fichier sur le disque
    let prepared: { buffer: Buffer; mimeType: string; extension: string } | null = null
    let uploadFileName = ''
    let uploadCaption: string | null = null
    if (!('youtubeUrl' in payload.data)) {
      if (payload.data.type === 'citation') {
        const citationText = payload.data.caption.trim()
        if (!citationText) {
          return reply.code(400).send({ error: 'citation_text_required' })
        }
        prepared = { buffer: Buffer.from(citationText, 'utf8'), mimeType: 'text/plain', extension: '.txt' }
        uploadFileName = 'citation.txt'
        uploadCaption = citationText
      } else {
        const decoded = Buffer.from(stripDataUrlPrefix(payload.data.dataBase64), 'base64')
        if (!decoded.length) {
          return reply.code(400).send({ error: 'empty_media_file' })
        }
        if (decoded.length !== payload.data.sizeBytes) {
          return reply.code(400).send({ error: 'size_mismatch' })
        }
        if (payload.data.type === 'photo' && decoded.length > MAX_IMAGE_BYTES) {
          return reply.code(400).send({ error: 'image_too_large' })
        }
        try {
          prepared = await prepareUploadedFile(decoded, payload.data.type, payload.data.fileName)
        } catch (error) {
          if (error instanceof InvalidMediaError) {
            return reply.code(400).send({ error: 'invalid_media_mime_type' })
          }
          throw error
        }
        uploadFileName = payload.data.fileName
        uploadCaption = payload.data.caption ?? null
      }

      if (await exceedsStorageQuota(app, params.data.id, prepared.buffer.length, isPending)) {
        return reply.code(413).send({ error: 'storage_quota_exceeded' })
      }
    }

    // Une contribution d'une ligne, créée avant le média pour qu'il la référence
    const now = new Date()
    const contributionSession = contribution
      ? await app.prisma.contributionSession.create({
          data: {
            treeId: params.data.id,
            submittedByUserId: contribution.submittedByUserId,
            submittedByLabel: payload.data.submittedByLabel?.trim() || contribution.submittedByLabel,
            mode: contribution.mode,
            status: contribution.autoStatus,
            title: `Souvenir pour ${person.firstName}`.slice(0, 120),
            reviewedAt: contribution.autoStatus === 'approved' ? now : undefined,
            reviewedBy: contribution.autoStatus === 'approved' ? contribution.submittedByUserId : undefined,
          },
        })
      : null

    const recordContributionChange = async (mediaId: string, after: Record<string, unknown>) => {
      if (!contributionSession || !contribution) {
        return
      }
      await app.prisma.contributionChange.create({
        data: {
          sessionId: contributionSession.id,
          entityType: 'media',
          entityId: mediaId,
          action: 'create',
          afterJson: { personId: params.data.personId, ...after },
          decision: contribution.autoStatus === 'approved' ? 'approved' : undefined,
        },
      })
    }

    const auditActor = contribution
      ? { actorType: contribution.actorType, actorId: contribution.actorId }
      : { actorType: 'user', actorId: uploaderUserId }

    // --- YouTube video (no file upload) ---
    if ('youtubeUrl' in payload.data) {
      const mediaCount = await app.prisma.mediaItem.count({
        where: { treeId: params.data.id, personId: params.data.personId, status: 'approved', deletedAt: null },
      })
      const normalizedSource = normalizeOptionalText(payload.data.source)
      const mediaId = randomUUID()
      const media = await app.prisma.mediaItem.create({
        data: {
          id: mediaId,
          treeId: params.data.id,
          personId: params.data.personId,
          type: 'video',
          mimeType: 'video/youtube',
          filePath: payload.data.youtubeUrl,
          caption: payload.data.caption ?? null,
          source: normalizedSource,
          sizeBytes: 0,
          displayOrder: isPending ? 0 : mediaCount + 1,
          isFeatured: !isPending && mediaCount < 3,
          uploadedBy: uploaderUserId,
          status: isPending ? 'pending' : 'approved',
          contributionSessionId: contributionSession?.id ?? null,
        },
      })
      if (!isPending) {
        await syncPersonMediaOrder(app.prisma, params.data.id, params.data.personId)
      }
      await recordContributionChange(mediaId, { type: 'video', mimeType: 'video/youtube', caption: payload.data.caption ?? null })
      await app.prisma.auditLog.create({
        data: {
          treeId: params.data.id,
          ...auditActor,
          action: 'media_uploaded',
          entityType: 'media_item',
          entityId: mediaId,
          payloadJson: { personId: params.data.personId, type: 'video', youtubeUrl: payload.data.youtubeUrl },
        },
      })
      return reply.code(201).send({ media, status: media.status })
    }

    if (!prepared) {
      return reply.code(400).send({ error: 'invalid_payload' })
    }

    const normalizedSource = normalizeOptionalText(payload.data.source)
    const mediaId = randomUUID()
    const relativePath = path.posix.join(params.data.id, params.data.personId, `${mediaId}${prepared.extension}`)
    const storageRoot = getStorageRoot()
    const absolutePath = path.resolve(storageRoot, relativePath)

    if (!absolutePath.startsWith(storageRoot + path.sep)) {
      return reply.code(400).send({ error: 'invalid_media_path' })
    }

    await mkdir(path.dirname(absolutePath), { recursive: true })
    await writeFile(absolutePath, prepared.buffer)

    const mediaCount = await app.prisma.mediaItem.count({
      where: {
        treeId: params.data.id,
        personId: params.data.personId,
        status: 'approved',
        deletedAt: null,
      },
    })

    const media = await app.prisma.mediaItem.create({
      data: {
        id: mediaId,
        treeId: params.data.id,
        personId: params.data.personId,
        type: payload.data.type,
        mimeType: prepared.mimeType,
        filePath: relativePath,
        caption: uploadCaption,
        source: normalizedSource,
        sizeBytes: prepared.buffer.length,
        displayOrder: isPending ? 0 : mediaCount + 1,
        isFeatured: !isPending && mediaCount < 3,
        uploadedBy: uploaderUserId,
        status: isPending ? 'pending' : 'approved',
        contributionSessionId: contributionSession?.id ?? null,
      },
    })

    if (!isPending) {
      await syncPersonMediaOrder(app.prisma, params.data.id, params.data.personId)
    }

    await recordContributionChange(mediaId, { type: payload.data.type, mimeType: prepared.mimeType, caption: uploadCaption })

    await app.prisma.auditLog.create({
      data: {
        treeId: params.data.id,
        ...auditActor,
        action: 'media_uploaded',
        entityType: 'media_item',
        entityId: mediaId,
        payloadJson: {
          personId: params.data.personId,
          type: payload.data.type,
          fileName: uploadFileName,
          sizeBytes: prepared.buffer.length,
        },
      },
    })

    return reply.code(201).send({ media, status: media.status })
  })

  app.post('/trees/:id/persons/:personId/avatar', AVATAR_RATE_LIMIT, async (request, reply) => {
    if (!request.actor || request.actor.kind !== 'user') {
      return reply.code(401).send({ error: 'authentication_required' })
    }

    const params = treePersonParamsSchema.safeParse(request.params)
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_params' })
    }

    const payload = uploadAvatarSchema.safeParse(request.body)
    if (!payload.success) {
      return reply.code(400).send({ error: 'invalid_payload', details: payload.error.flatten() })
    }

    const membership = await requireAdminMembership(app, request.actor.userId, params.data.id)
    if (!membership) {
      return reply.code(403).send({ error: 'forbidden' })
    }

    const person = await app.prisma.person.findFirst({
      where: {
        id: params.data.personId,
        treeId: params.data.id,
        deletedAt: null,
      },
      select: {
        id: true,
        avatarPath: true,
        immichPersonId: true,
      },
    })

    if (!person) {
      return reply.code(404).send({ error: 'person_not_found' })
    }

    const fileBuffer = Buffer.from(stripDataUrlPrefix(payload.data.dataBase64), 'base64')

    if (!fileBuffer.length) {
      return reply.code(400).send({ error: 'empty_media_file' })
    }

    if (fileBuffer.length !== payload.data.sizeBytes) {
      return reply.code(400).send({ error: 'size_mismatch' })
    }

    if (fileBuffer.length > MAX_IMAGE_BYTES) {
      return reply.code(400).send({ error: 'image_too_large' })
    }

    let prepared: Awaited<ReturnType<typeof prepareUploadedFile>>
    try {
      prepared = await prepareUploadedFile(fileBuffer, 'photo', payload.data.fileName)
    } catch (error) {
      if (error instanceof InvalidMediaError) {
        return reply.code(400).send({ error: 'invalid_avatar_mime_type' })
      }
      throw error
    }

    if (await exceedsStorageQuota(app, params.data.id, prepared.buffer.length, false)) {
      return reply.code(413).send({ error: 'storage_quota_exceeded' })
    }

    const relativePath = path.posix.join(
      params.data.id,
      params.data.personId,
      `avatar-${randomUUID()}${prepared.extension}`,
    )
    const storageRoot = getStorageRoot()
    const absolutePath = path.resolve(storageRoot, relativePath)

    if (!absolutePath.startsWith(storageRoot + path.sep)) {
      return reply.code(400).send({ error: 'invalid_media_path' })
    }

    await mkdir(path.dirname(absolutePath), { recursive: true })
    await writeFile(absolutePath, prepared.buffer)

    await app.prisma.person.updateMany({
      where: {
        id: params.data.personId,
        treeId: params.data.id,
        deletedAt: null,
      },
      data: {
        avatarPath: relativePath,
        avatarMimeType: prepared.mimeType,
        updatedBy: request.actor.userId,
        // Un portrait déposé à la main remplace aussi le lien Immich : sans cela, l'association
        // survivrait invisible en base (le graphe ne publie que l'origine du portrait) et ne
        // pourrait plus être retirée depuis l'interface.
        ...(person.immichPersonId ? { immichPersonId: null } : {}),
      },
    })

    // L'ancien portrait ne reste pas sur le disque
    await removeStoredFile(storageRoot, person.avatarPath)

    await app.prisma.auditLog.create({
      data: {
        treeId: params.data.id,
        actorType: 'user',
        actorId: request.actor.userId,
        action: 'person_avatar_updated',
        entityType: 'person',
        entityId: params.data.personId,
        ...(person.immichPersonId ? { payloadJson: { immichLinkRemoved: true } } : {}),
      },
    })

    return reply.code(201).send({ ok: true })
  })

  app.delete('/trees/:id/persons/:personId/avatar', async (request, reply) => {
    if (!request.actor || request.actor.kind !== 'user') {
      return reply.code(401).send({ error: 'authentication_required' })
    }

    const params = treePersonParamsSchema.safeParse(request.params)
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_params' })
    }

    const membership = await requireAdminMembership(app, request.actor.userId, params.data.id)
    if (!membership) {
      return reply.code(403).send({ error: 'forbidden' })
    }

    const person = await app.prisma.person.findFirst({
      where: { id: params.data.personId, treeId: params.data.id, deletedAt: null },
      select: { avatarPath: true },
    })

    const updated = await app.prisma.person.updateMany({
      where: {
        id: params.data.personId,
        treeId: params.data.id,
        deletedAt: null,
      },
      data: {
        avatarPath: null,
        avatarMimeType: null,
        updatedBy: request.actor.userId,
      },
    })

    if (updated.count === 0) {
      return reply.code(404).send({ error: 'person_not_found' })
    }

    await removeStoredFile(getStorageRoot(), person?.avatarPath)

    await app.prisma.auditLog.create({
      data: {
        treeId: params.data.id,
        actorType: 'user',
        actorId: request.actor.userId,
        action: 'person_avatar_removed',
        entityType: 'person',
        entityId: params.data.personId,
      },
    })

    return reply.send({ ok: true })
  })

  app.patch('/trees/:id/persons/:personId/media/reorder', async (request, reply) => {
    if (!request.actor || request.actor.kind !== 'user') {
      return reply.code(401).send({ error: 'authentication_required' })
    }

    const params = treePersonParamsSchema.safeParse(request.params)
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_params' })
    }

    const payload = reorderMediaSchema.safeParse(request.body)
    if (!payload.success) {
      return reply.code(400).send({ error: 'invalid_payload', details: payload.error.flatten() })
    }

    const membership = await requireAdminMembership(app, request.actor.userId, params.data.id)
    if (!membership) {
      return reply.code(403).send({ error: 'forbidden' })
    }

    const existing = await app.prisma.mediaItem.findMany({
      where: {
        treeId: params.data.id,
        personId: params.data.personId,
        status: 'approved',
        deletedAt: null,
      },
      select: {
        id: true,
      },
    })

    const existingIds = existing.map((item: { id: string }) => item.id)
    const orderedIds = payload.data.orderedMediaIds

    if (existingIds.length !== orderedIds.length) {
      return reply.code(400).send({ error: 'invalid_media_order_payload' })
    }

    const existingSet = new Set(existingIds)
    const orderedSet = new Set(orderedIds)
    if (orderedSet.size !== orderedIds.length || orderedIds.some((id) => !existingSet.has(id))) {
      return reply.code(400).send({ error: 'invalid_media_order_payload' })
    }

    for (let index = 0; index < orderedIds.length; index += 1) {
      await app.prisma.mediaItem.updateMany({
        where: {
          id: orderedIds[index],
          treeId: params.data.id,
          personId: params.data.personId,
          deletedAt: null,
        },
        data: {
          displayOrder: index + 1,
        },
      })
    }

    await syncPersonMediaOrder(app.prisma, params.data.id, params.data.personId)

    await app.prisma.auditLog.create({
      data: {
        treeId: params.data.id,
        actorType: 'user',
        actorId: request.actor.userId,
        action: 'media_reordered',
        entityType: 'media_item',
        entityId: params.data.personId,
        payloadJson: {
          personId: params.data.personId,
          orderedMediaIds: payload.data.orderedMediaIds,
        },
      },
    })

    return reply.send({ ok: true })
  })

  app.delete('/trees/:id/persons/:personId/media/:mediaId', async (request, reply) => {
    if (!request.actor || request.actor.kind !== 'user') {
      return reply.code(401).send({ error: 'authentication_required' })
    }

    const params = z
      .object({
        id: z.string().min(1),
        personId: z.string().min(1),
        mediaId: z.string().min(1),
      })
      .safeParse(request.params)

    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_params' })
    }

    const membership = await requireAdminMembership(app, request.actor.userId, params.data.id)
    if (!membership) {
      return reply.code(403).send({ error: 'forbidden' })
    }

    const existingMedia = await app.prisma.mediaItem.findFirst({
      where: { id: params.data.mediaId, treeId: params.data.id, personId: params.data.personId, deletedAt: null },
      select: { filePath: true },
    })

    const updateResult = await app.prisma.mediaItem.updateMany({
      where: {
        id: params.data.mediaId,
        treeId: params.data.id,
        personId: params.data.personId,
        deletedAt: null,
      },
      data: {
        deletedAt: new Date(),
      },
    })

    if (updateResult.count === 0) {
      return reply.code(404).send({ error: 'media_not_found' })
    }

    // Supprimé = effacé du disque (la ligne reste pour le journal)
    await removeStoredFile(getStorageRoot(), existingMedia?.filePath)

    await syncPersonMediaOrder(app.prisma, params.data.id, params.data.personId)

    await app.prisma.auditLog.create({
      data: {
        treeId: params.data.id,
        actorType: 'user',
        actorId: request.actor.userId,
        action: 'media_deleted',
        entityType: 'media_item',
        entityId: params.data.mediaId,
        payloadJson: {
          personId: params.data.personId,
        },
      },
    })

    return reply.send({ ok: true })
  })

  app.get('/trees/:id/persons/:personId/avatar', async (request, reply) => {
    const params = treePersonParamsSchema.safeParse(request.params)
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_params' })
    }

    const query = downloadQuerySchema.safeParse(request.query)
    if (!query.success) {
      return reply.code(400).send({ error: 'invalid_query' })
    }

    if (!(await canReadMedia(app, params.data.id, request, query.data.token))) {
      return reply.code(401).send({ error: 'authentication_required' })
    }

    const person = await app.prisma.person.findFirst({
      where: {
        id: params.data.personId,
        treeId: params.data.id,
        deletedAt: null,
      },
      select: {
        avatarPath: true,
        avatarMimeType: true,
      },
    })

    if (!person?.avatarPath) {
      return reply.code(404).send({ error: 'avatar_not_found' })
    }

    const storageRoot = getStorageRoot()
    const absolutePath = path.resolve(storageRoot, person.avatarPath)
    if (!absolutePath.startsWith(storageRoot + path.sep)) {
      return reply.code(400).send({ error: 'invalid_media_path' })
    }

    let fileBuffer: Buffer
    try {
      fileBuffer = await readFile(absolutePath)
    } catch {
      return reply.code(404).send({ error: 'media_file_missing' })
    }

    applyMediaResponseHeaders(reply, person.avatarMimeType, 'portrait')

    return reply.send(fileBuffer)
  })

  app.get('/trees/:id/media/:mediaId', async (request, reply) => {
    const params = mediaParamsSchema.safeParse(request.params)
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_params' })
    }

    const query = downloadQuerySchema.safeParse(request.query)
    if (!query.success) {
      return reply.code(400).send({ error: 'invalid_query' })
    }

    if (!(await canReadMedia(app, params.data.id, request, query.data.token))) {
      return reply.code(401).send({ error: 'authentication_required' })
    }

    const media = await app.prisma.mediaItem.findFirst({
      where: {
        id: params.data.mediaId,
        treeId: params.data.id,
        deletedAt: null,
      },
      select: {
        filePath: true,
        mimeType: true,
      },
    })

    if (!media) {
      return reply.code(404).send({ error: 'media_not_found' })
    }

    // YouTube videos: filePath is the YouTube URL, redirect the browser
    if (media.mimeType === 'video/youtube') {
      return reply.code(302).redirect(media.filePath)
    }

    const storageRoot = getStorageRoot()
    const absolutePath = path.resolve(storageRoot, media.filePath)
    if (!absolutePath.startsWith(storageRoot + path.sep)) {
      return reply.code(400).send({ error: 'invalid_media_path' })
    }

    let fileBuffer: Buffer
    try {
      fileBuffer = await readFile(absolutePath)
    } catch {
      return reply.code(404).send({ error: 'media_file_missing' })
    }

    applyMediaResponseHeaders(reply, media.mimeType, path.basename(media.filePath))

    return reply.send(fileBuffer)
  })

  // ---- Annotation Photos ----
  const MAX_ANNOTATION_PHOTO_BYTES = 3 * 1024 * 1024

  const uploadAnnotationPhotoSchema = z.object({
    fileName: z.string().min(1).max(255),
    mimeType: z.string().min(1).max(120),
    sizeBytes: z.number().int().positive().max(MAX_ANNOTATION_PHOTO_BYTES),
    dataBase64: z.string().min(1),
  })

  const annotationPhotoParamsSchema = z.object({
    id: z.string().min(1),
    photoId: z.string().min(1),
  })

  app.post('/trees/:id/annotation-photos', UPLOAD_RATE_LIMIT, async (request, reply) => {
    if (!request.actor || request.actor.kind !== 'user') {
      return reply.code(401).send({ error: 'authentication_required' })
    }

    const params = treeIdParamSchema.safeParse(request.params)
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_params' })
    }

    const payload = uploadAnnotationPhotoSchema.safeParse(request.body)
    if (!payload.success) {
      return reply.code(400).send({ error: 'invalid_payload', details: payload.error.flatten() })
    }

    const membership = await requireAdminMembership(app, request.actor.userId, params.data.id)
    if (!membership) {
      return reply.code(403).send({ error: 'forbidden' })
    }

    const fileBuffer = Buffer.from(stripDataUrlPrefix(payload.data.dataBase64), 'base64')

    if (!fileBuffer.length) {
      return reply.code(400).send({ error: 'empty_photo_file' })
    }

    if (fileBuffer.length !== payload.data.sizeBytes) {
      return reply.code(400).send({ error: 'size_mismatch' })
    }

    if (fileBuffer.length > MAX_ANNOTATION_PHOTO_BYTES) {
      return reply.code(400).send({ error: 'photo_too_large' })
    }

    let prepared: Awaited<ReturnType<typeof prepareUploadedFile>>
    try {
      prepared = await prepareUploadedFile(fileBuffer, 'photo', payload.data.fileName)
    } catch (error) {
      if (error instanceof InvalidMediaError) {
        return reply.code(400).send({ error: 'invalid_annotation_photo_mime_type' })
      }
      throw error
    }

    if (await exceedsStorageQuota(app, params.data.id, prepared.buffer.length, false)) {
      return reply.code(413).send({ error: 'storage_quota_exceeded' })
    }

    const photoId = randomUUID()
    const relativePath = path.posix.join(params.data.id, 'annotation-photos', `${photoId}${prepared.extension}`)
    const storageRoot = getStorageRoot()
    const absolutePath = path.resolve(storageRoot, relativePath)

    if (!absolutePath.startsWith(storageRoot + path.sep)) {
      return reply.code(400).send({ error: 'invalid_photo_path' })
    }

    await mkdir(path.dirname(absolutePath), { recursive: true })
    await writeFile(absolutePath, prepared.buffer)

    return reply.code(201).send({
      photoId,
      photoPath: `/trees/${params.data.id}/annotation-photos/${photoId}`,
    })
  })

  app.get('/trees/:id/annotation-photos/:photoId', async (request, reply) => {
    const params = annotationPhotoParamsSchema.safeParse(request.params)
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_params' })
    }

    const query = downloadQuerySchema.safeParse(request.query)
    if (!query.success) {
      return reply.code(400).send({ error: 'invalid_query' })
    }

    if (!(await canReadMedia(app, params.data.id, request, query.data.token))) {
      return reply.code(401).send({ error: 'authentication_required' })
    }

    // Find the file: scan for photoId with any extension
    const storageRoot = getStorageRoot()
    const photoDir = path.resolve(storageRoot, params.data.id, 'annotation-photos')
    const photoIdSafe = params.data.photoId.replace(/[^a-zA-Z0-9-]/g, '')
    if (!photoIdSafe) {
      return reply.code(400).send({ error: 'invalid_photo_id' })
    }

    // Try common extensions
    const extensions = ['.jpg', '.jpeg', '.png', '.webp', '.gif']
    let foundPath: string | null = null
    let foundMime = 'image/jpeg'
    const mimeMap: Record<string, string> = {
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
      '.webp': 'image/webp', '.gif': 'image/gif',
    }

    for (const ext of extensions) {
      const candidate = path.resolve(photoDir, `${photoIdSafe}${ext}`)
      if (!candidate.startsWith(storageRoot + path.sep)) continue
      try {
        await readFile(candidate) // existence check
        foundPath = candidate
        foundMime = mimeMap[ext] || 'image/jpeg'
        break
      } catch { /* not found, try next */ }
    }

    if (!foundPath) {
      return reply.code(404).send({ error: 'photo_not_found' })
    }

    let fileBuffer: Buffer
    try {
      fileBuffer = await readFile(foundPath)
    } catch {
      return reply.code(404).send({ error: 'photo_file_missing' })
    }

    applyMediaResponseHeaders(reply, foundMime, path.basename(foundPath))

    return reply.send(fileBuffer)
  })
}
