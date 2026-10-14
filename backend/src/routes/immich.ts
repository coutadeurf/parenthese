import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { z } from 'zod'

import {
  getImmichAllowedApiUrls,
  getTreeImmichClient,
  isImmichApiUrlAllowed,
  isImmichPersonId,
  normalizeImmichApiUrl,
  ImmichAuthError,
  ImmichNotFoundError,
  ImmichUnavailableError,
  type ImmichPersonSummary,
} from '../lib/immich.js'
import { encryptImmichApiKey } from '../lib/immich-secret.js'
import { InvalidMediaError, isImmichAvatarPath, removeStoredFile, sniffMimeType } from '../lib/media-files.js'
import { exceedsStorageQuota, getStorageRoot, prepareUploadedFile, requireAdminMembership } from './media.js'

// Reconnaissance des visages : associer une personne de l'arbre à une personne Immich, dont la
// vignette devient son portrait. Chaque arbre porte sa propre connexion Immich : une adresse
// choisie parmi celles autorisées par l'opérateur du serveur (IMMICH_ALLOWED_API_URLS), et une
// clé chiffrée en base. Toutes les routes sont rattachées à un arbre, réservées à ses
// administrateurs, et ne parlent jamais à l'instance d'un autre arbre.

const treeParamSchema = z.object({ id: z.string().min(1) })

const assignSchema = z.object({
  personId: z.string().min(1),
  immichPersonId: z.string().refine(isImmichPersonId, 'invalid_immich_person_id'),
  // Remplacer un portrait déjà en place demande un accord explicite, quelle que soit son
  // origine (posé à la main ou venu d'une association Immich précédente).
  replaceAvatar: z.boolean().optional(),
})

const unassignSchema = z.object({
  personId: z.string().min(1),
})

const thumbnailParamSchema = z.object({
  id: z.string().min(1),
  immichPersonId: z.string().refine(isImmichPersonId, 'invalid_immich_person_id'),
})

// Connexion Immich d'un arbre : adresse choisie parmi celles autorisées par l'opérateur du
// serveur (IMMICH_ALLOWED_API_URLS). La clé se joint à la mise à jour ou, si le champ reste
// vide, celle en place est conservée — jamais relue par le front.
const configPayloadSchema = z.object({
  apiUrl: z
    .string()
    .url()
    .refine((value) => value.startsWith('http://') || value.startsWith('https://'), 'invalid_api_url'),
  apiKey: z.string().min(1).max(512).optional(),
})

const MAX_THUMBNAIL_BYTES = 5 * 1024 * 1024

function replyImmichError(request: FastifyRequest, reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof ImmichNotFoundError) {
    return reply.code(404).send({ error: 'immich_person_not_found' })
  }
  if (error instanceof ImmichAuthError) {
    return reply.code(502).send({ error: 'immich_auth_failed' })
  }
  if (error instanceof ImmichUnavailableError) {
    return reply.code(503).send({ error: 'immich_unreachable' })
  }
  request.log.error({ err: error }, 'Erreur inattendue pendant un appel à Immich')
  return reply.code(500).send({ error: 'immich_api_error' })
}

// Métadonnées sûres d'une connexion Immich d'arbre : jamais la clé, jamais son chiffré. Une
// adresse sortie de la liste de l'opérateur vaut « non configuré » : la connexion est inerte.
function immichConfigSummary(config: { apiUrl: string; updatedAt: Date } | null) {
  if (!config || !isImmichApiUrlAllowed(config.apiUrl)) {
    return { configured: false, apiUrl: null, updatedAt: null }
  }
  return { configured: true, apiUrl: config.apiUrl, updatedAt: config.updatedAt }
}

// Portraits venus d'Immich : même nommage que les envois manuels (« avatar-<uuid> »), avec le
// préfixe « immich- » qui dit au désassignement que le fichier nous appartient. Un portrait
// envoyé à la main n'est jamais touché par le désassignement.
function buildAvatarRelativePath(treeId: string, personId: string, extension: string): string {
  return path.posix.join(treeId, personId, `immich-${randomUUID()}${extension}`)
}

export const immichRoutes: FastifyPluginAsync = async (app) => {
  // ── Connexion Immich de l'arbre : lecture, écriture, suppression. Réservées aux
  // administrateurs de l'arbre ; la clé d'API ne quitte jamais le serveur.

  app.get('/trees/:id/immich/config', async (request, reply) => {
    if (!request.actor || request.actor.kind !== 'user') {
      return reply.code(401).send({ error: 'authentication_required' })
    }

    const params = treeParamSchema.safeParse(request.params)
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_params' })
    }

    if (!(await requireAdminMembership(app, request.actor.userId, params.data.id))) {
      return reply.code(403).send({ error: 'forbidden' })
    }

    const config = await app.prisma.treeImmichConfig.findUnique({
      where: { treeId: params.data.id },
      select: { apiUrl: true, updatedAt: true },
    })

    return reply.send({
      config: immichConfigSummary(config),
      // Les administrateurs choisissent parmi cette liste : le front en fait un menu, pas un champ libre.
      allowedApiUrls: getImmichAllowedApiUrls(),
    })
  })

  app.put('/trees/:id/immich/config', async (request, reply) => {
    if (!request.actor || request.actor.kind !== 'user') {
      return reply.code(401).send({ error: 'authentication_required' })
    }

    const params = treeParamSchema.safeParse(request.params)
    const payload = configPayloadSchema.safeParse(request.body)
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_params' })
    }
    if (!payload.success) {
      return reply.code(400).send({ error: 'invalid_payload', details: payload.error.flatten() })
    }

    if (!(await requireAdminMembership(app, request.actor.userId, params.data.id))) {
      return reply.code(403).send({ error: 'forbidden' })
    }

    // L'adresse doit faire partie de la liste de l'opérateur : le serveur ne devient jamais
    // un proxy vers un service interne choisi librement (SSRF).
    if (!isImmichApiUrlAllowed(payload.data.apiUrl)) {
      return reply.code(400).send({ error: 'api_url_not_allowed' })
    }

    const treeId = params.data.id
    const existing = await app.prisma.treeImmichConfig.findUnique({
      where: { treeId },
      select: { apiUrl: true, apiKeyEnc: true },
    })

    // Sans nouvelle clé, la clé en place est conservée — mais il en faut une pour une
    // première configuration : on ne devine jamais d'identifiants ailleurs.
    if (!payload.data.apiKey && !existing) {
      return reply.code(400).send({ error: 'api_key_required' })
    }

    // Changer d'instance n'emmène jamais la clé de l'ancienne : elle ne vaut rien pour la
    // nouvelle, et on ne l'envoie pas à un serveur qui n'est pas le sien.
    if (existing && !payload.data.apiKey
      && normalizeImmichApiUrl(existing.apiUrl) !== normalizeImmichApiUrl(payload.data.apiUrl)) {
      return reply.code(400).send({ error: 'api_key_required' })
    }

    const apiKeyEnc = payload.data.apiKey
      ? encryptImmichApiKey(payload.data.apiKey)
      : existing!.apiKeyEnc

    const config = await app.prisma.treeImmichConfig.upsert({
      where: { treeId },
      create: { treeId, apiUrl: payload.data.apiUrl, apiKeyEnc },
      update: { apiUrl: payload.data.apiUrl, apiKeyEnc },
      select: { apiUrl: true, updatedAt: true },
    })

    // Journal d'audit : jamais la clé, seulement le fait qu'elle a changé.
    await app.prisma.auditLog.create({
      data: {
        treeId,
        actorType: 'user',
        actorId: request.actor.userId,
        action: 'immich_config_updated',
        entityType: 'tree_immich_config',
        entityId: treeId,
        payloadJson: { apiUrl: payload.data.apiUrl, apiKeyChanged: Boolean(payload.data.apiKey) },
      },
    })

    return reply.send({ config: immichConfigSummary(config) })
  })

  app.delete('/trees/:id/immich/config', async (request, reply) => {
    if (!request.actor || request.actor.kind !== 'user') {
      return reply.code(401).send({ error: 'authentication_required' })
    }

    const params = treeParamSchema.safeParse(request.params)
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_params' })
    }

    if (!(await requireAdminMembership(app, request.actor.userId, params.data.id))) {
      return reply.code(403).send({ error: 'forbidden' })
    }

    const treeId = params.data.id
    const removed = await app.prisma.treeImmichConfig.deleteMany({ where: { treeId } })

    if (removed.count > 0) {
      await app.prisma.auditLog.create({
        data: {
          treeId,
          actorType: 'user',
          actorId: request.actor.userId,
          action: 'immich_config_removed',
          entityType: 'tree_immich_config',
          entityId: treeId,
          payloadJson: {},
        },
      })
    }

    return reply.send({ config: { configured: false, apiUrl: null, updatedAt: null } })
  })

  app.get('/trees/:id/immich/status', async (request, reply) => {
    if (!request.actor || request.actor.kind !== 'user') {
      return reply.code(401).send({ error: 'authentication_required' })
    }

    const params = treeParamSchema.safeParse(request.params)
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_params' })
    }

    if (!(await requireAdminMembership(app, request.actor.userId, params.data.id))) {
      return reply.code(403).send({ error: 'forbidden' })
    }

    const client = await getTreeImmichClient(app.prisma, params.data.id)
    if (!client) {
      return reply.send({ available: false, reason: 'not_configured' })
    }

    const available = await client.ping()
    return reply.send({ available, reason: available ? null : 'unreachable' })
  })

  app.get('/trees/:id/immich/people', async (request, reply) => {
    if (!request.actor || request.actor.kind !== 'user') {
      return reply.code(401).send({ error: 'authentication_required' })
    }

    const params = treeParamSchema.safeParse(request.params)
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_params' })
    }

    if (!(await requireAdminMembership(app, request.actor.userId, params.data.id))) {
      return reply.code(403).send({ error: 'forbidden' })
    }

    const client = await getTreeImmichClient(app.prisma, params.data.id)
    if (!client) {
      return reply.code(503).send({ error: 'immich_not_configured' })
    }

    try {
      const people = await client.listPeople()
      return reply.send({ people })
    } catch (error) {
      return replyImmichError(request, reply, error)
    }
  })

  // Vignette d'une personne Immich, montrée dans le sélecteur. Passée par l'API : l'adresse
  // d'Immich et sa clé ne quittent jamais le serveur.
  app.get('/trees/:id/immich/thumbnail/:immichPersonId', async (request, reply) => {
    if (!request.actor || request.actor.kind !== 'user') {
      return reply.code(401).send({ error: 'authentication_required' })
    }

    const params = thumbnailParamSchema.safeParse(request.params)
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_immich_person_id' })
    }

    if (!(await requireAdminMembership(app, request.actor.userId, params.data.id))) {
      return reply.code(403).send({ error: 'forbidden' })
    }

    const client = await getTreeImmichClient(app.prisma, params.data.id)
    if (!client) {
      return reply.code(503).send({ error: 'immich_not_configured' })
    }

    let thumbnail: Buffer
    try {
      thumbnail = await client.getPersonThumbnail(params.data.immichPersonId)
    } catch (error) {
      return replyImmichError(request, reply, error)
    }

    if (!thumbnail.length || thumbnail.length > MAX_THUMBNAIL_BYTES) {
      request.log.warn({ size: thumbnail.length }, 'Vignette Immich vide ou trop grande')
      return reply.code(404).send({ error: 'thumbnail_not_found' })
    }

    // Le type se lit dans les octets, pas dans ce qu'Immich déclare : la vignette finit dans une balise <img>.
    const mimeType = sniffMimeType(thumbnail, 'photo') ?? 'image/jpeg'
    reply.header('Content-Type', mimeType)
    reply.header('Cache-Control', 'private, max-age=3600')
    return reply.send(thumbnail)
  })

  app.post('/trees/:id/immich/assign', async (request, reply) => {
    if (!request.actor || request.actor.kind !== 'user') {
      return reply.code(401).send({ error: 'authentication_required' })
    }

    const params = treeParamSchema.safeParse(request.params)
    const payload = assignSchema.safeParse(request.body)
    if (!params.success || !payload.success) {
      return reply.code(400).send({ error: payload.success ? 'invalid_params' : 'invalid_immich_person_id' })
    }

    if (!(await requireAdminMembership(app, request.actor.userId, params.data.id))) {
      return reply.code(403).send({ error: 'forbidden' })
    }

    const client = await getTreeImmichClient(app.prisma, params.data.id)
    if (!client) {
      return reply.code(503).send({ error: 'immich_not_configured' })
    }

    const { personId, immichPersonId } = payload.data
    const treeId = params.data.id

    const person = await app.prisma.person.findFirst({
      where: { id: personId, treeId, deletedAt: null },
      select: { id: true, avatarPath: true },
    })
    if (!person) {
      return reply.code(404).send({ error: 'person_not_found' })
    }

    // La personne Immich doit exister : le 404 de la vignette ne le prouve pas (personne
    // absente ou simple vignette manquante), on la vérifie donc explicitement. Un refus
    // d'authentification ou une erreur serveur ne sont jamais pris pour une absence.
    let immichPerson: ImmichPersonSummary
    try {
      immichPerson = await client.getPerson(immichPersonId)
    } catch (error) {
      return replyImmichError(request, reply, error)
    }

    // Vignette de la personne Immich : absente -> on associe sans toucher au portrait existant.
    // Demandée seulement si Immich en annonce une : sans vignette, l'appel est inutile.
    let thumbnail: Buffer | null = null
    if (immichPerson.hasThumbnail) {
      try {
        thumbnail = await client.getPersonThumbnail(immichPersonId)
      } catch (error) {
        if (!(error instanceof ImmichNotFoundError)) {
          return replyImmichError(request, reply, error)
        }
        // Vignette absente : l'association se fait sans portrait.
      }
    }

    if (!thumbnail) {
      await app.prisma.$transaction([
        app.prisma.person.update({
          where: { id: personId },
          data: { immichPersonId, updatedBy: request.actor.userId },
        }),
        app.prisma.auditLog.create({
          data: {
            treeId,
            actorType: 'user',
            actorId: request.actor.userId,
            action: 'immich_assign',
            entityType: 'person',
            entityId: personId,
            payloadJson: { immichPersonId, avatarUpdated: false },
          },
        }),
      ])

      return reply.send({ ok: true, avatarUpdated: false, immichPersonId })
    }

    // Un portrait déjà en place ne se remplace jamais en silence : sans accord explicite,
    // l'association s'arrête avant d'écrire quoi que ce soit. Le front transforme ce refus
    // en demande de confirmation puis rejoue la requête avec replaceAvatar.
    if (person.avatarPath && !payload.data.replaceAvatar) {
      return reply.code(409).send({ error: 'avatar_exists' })
    }

    // La vignette passe par le même traitement qu'un portrait envoyé : type lu dans les octets,
    // métadonnées retirées, quota de l'arbre respecté.
    let prepared: Awaited<ReturnType<typeof prepareUploadedFile>>
    try {
      prepared = await prepareUploadedFile(thumbnail, 'photo', `immich-${immichPersonId}.jpg`)
    } catch (error) {
      if (error instanceof InvalidMediaError) {
        return reply.code(400).send({ error: 'invalid_avatar_image' })
      }
      throw error
    }

    if (await exceedsStorageQuota(app, treeId, prepared.buffer.length, false)) {
      return reply.code(413).send({ error: 'storage_quota_exceeded' })
    }

    const relativePath = buildAvatarRelativePath(treeId, personId, prepared.extension)
    const storageRoot = getStorageRoot()
    const absolutePath = path.resolve(storageRoot, relativePath)

    // Chemin hors du stockage : refusé, jamais écrit.
    if (!absolutePath.startsWith(storageRoot + path.sep)) {
      return reply.code(400).send({ error: 'invalid_media_path' })
    }

    // Fichier écrit avant la base : si la transaction échoue, on l'efface et rien n'a changé.
    await mkdir(path.dirname(absolutePath), { recursive: true })
    await writeFile(absolutePath, prepared.buffer)

    try {
      await app.prisma.$transaction([
        app.prisma.person.update({
          where: { id: personId },
          data: {
            avatarPath: relativePath,
            avatarMimeType: prepared.mimeType,
            immichPersonId,
            updatedBy: request.actor.userId,
          },
        }),
        app.prisma.auditLog.create({
          data: {
            treeId,
            actorType: 'user',
            actorId: request.actor.userId,
            action: 'immich_assign',
            entityType: 'person',
            entityId: personId,
            payloadJson: { immichPersonId, avatarUpdated: true, avatarPath: relativePath },
          },
        }),
      ])
    } catch (error) {
      await removeStoredFile(storageRoot, relativePath).catch(() => {})
      request.log.error({ err: error }, 'Échec de l’association Immich : fichier de portrait retiré, base inchangée')
      throw error
    }

    // L'ancien portrait ne reste pas sur le disque. Un échec du nettoyage n'invalide pas
    // l'association, qui a déjà réussi : il est journalisé, rien de plus.
    if (person.avatarPath && person.avatarPath !== relativePath) {
      await removeStoredFile(storageRoot, person.avatarPath).catch((cleanupError) => {
        request.log.error(
          { err: cleanupError, oldAvatar: person.avatarPath },
          'Ancien portrait non supprimé après une association Immich',
        )
      })
    }

    return reply.send({ ok: true, avatarUpdated: true, immichPersonId })
  })

  app.post('/trees/:id/immich/unassign', async (request, reply) => {
    if (!request.actor || request.actor.kind !== 'user') {
      return reply.code(401).send({ error: 'authentication_required' })
    }

    const params = treeParamSchema.safeParse(request.params)
    const payload = unassignSchema.safeParse(request.body)
    if (!params.success || !payload.success) {
      return reply.code(400).send({ error: 'invalid_params' })
    }

    if (!(await requireAdminMembership(app, request.actor.userId, params.data.id))) {
      return reply.code(403).send({ error: 'forbidden' })
    }

    // Pas de garde « non configuré » ici : le retrait d'association ne parle jamais à Immich,
    // et c'est le seul moyen de nettoyer des associations passées après une déconnexion.
    const { personId } = payload.data
    const treeId = params.data.id

    const person = await app.prisma.person.findFirst({
      where: { id: personId, treeId, deletedAt: null },
      select: { id: true, avatarPath: true, immichPersonId: true },
    })
    if (!person) {
      return reply.code(404).send({ error: 'person_not_found' })
    }

    // Le graphe ne dit plus qui est associé : le retrait se propose toujours côté front. Sans
    // association en place, il ne fait rien — pas d'écriture, pas d'entrée d'audit.
    if (!person.immichPersonId) {
      return reply.send({ ok: true, avatarRemoved: false })
    }

    // Le portrait vient d'Immich uniquement si son fichier porte notre préfixe. Un portrait
    // envoyé à la main reste en place : seule l'association est retirée.
    const avatarFromImmich = isImmichAvatarPath(person.avatarPath)

    const updateData: {
      immichPersonId: null
      updatedBy: string
      avatarPath?: null
      avatarMimeType?: null
    } = { immichPersonId: null, updatedBy: request.actor.userId }
    if (avatarFromImmich) {
      updateData.avatarPath = null
      updateData.avatarMimeType = null
    }

    // Base d'abord, fichier ensuite : le portrait disparaît seulement une fois la base à jour.
    await app.prisma.$transaction([
      app.prisma.person.update({ where: { id: personId }, data: updateData }),
      app.prisma.auditLog.create({
        data: {
          treeId,
          actorType: 'user',
          actorId: request.actor.userId,
          action: 'immich_unassign',
          entityType: 'person',
          entityId: personId,
          payloadJson: { previousImmichPersonId: person.immichPersonId, avatarRemoved: avatarFromImmich },
        },
      }),
    ])

    if (avatarFromImmich) {
      await removeStoredFile(getStorageRoot(), person.avatarPath).catch((cleanupError) => {
        request.log.error(
          { err: cleanupError, avatarPath: person.avatarPath },
          'Portrait Immich non supprimé après un désassignement (base à jour)',
        )
      })
    }

    return reply.send({ ok: true, avatarRemoved: avatarFromImmich })
  })
}
