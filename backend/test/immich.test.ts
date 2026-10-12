import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile, stat, readdir } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import sharp from 'sharp'

import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    user: {
      count: vi.fn(),
    },
    person: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    treeMembership: {
      findUnique: vi.fn(),
    },
    mediaItem: {
      aggregate: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
    $transaction: vi.fn(),
    $disconnect: vi.fn(),
  },
}))

vi.mock('../src/lib/prisma.js', () => ({
  prisma: prismaMock,
}))

let createApp: () => FastifyInstance
let storageRoot: string
let jpegBytes: Buffer
const immichPersonId = '123e4567-e89b-42d3-a456-426614174000'
const otherImmichId = '123e4567-e89b-42d3-a456-426614174111'

const fetchMock = vi.fn()

async function jsonResponse(payload: unknown, status = 200): Promise<Response> {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}

// Association : deux appels Immich possibles, la personne (JSON) puis sa vignette (image).
// Le 404 de /api/people/{id} dit que la personne n'existe pas ; celui de /thumbnail seul
// ne dit rien (personne absente ou vignette manquante).
function mockImmichPerson(options: { thumbnailPath?: string; thumbnailStatus?: number } = {}): void {
  const { thumbnailPath = '/thumb/a.jpg', thumbnailStatus = 200 } = options
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/thumbnail')) {
      return new Response(new Uint8Array(jpegBytes), { status: thumbnailStatus })
    }
    return jsonResponse({ id: immichPersonId, name: 'Jean Dupont', thumbnailPath, isHidden: false, birthDate: null })
  })
}

async function createUserToken(app: FastifyInstance, userId = 'user-1'): Promise<string> {
  await app.ready()
  return (app as any).jwt.sign(
    { kind: 'user', sub: userId, jti: randomUUID(), userId, email: 'user@example.com' },
    { expiresIn: '1h' },
  )
}

async function absStoragePath(relativePath: string): Promise<string> {
  return path.resolve(storageRoot, relativePath)
}

async function fsExists(absolutePath: string): Promise<boolean> {
  try {
    await stat(absolutePath)
    return true
  } catch {
    return false
  }
}

async function fsListDir(absolutePath: string): Promise<string[]> {
  try {
    return await readdir(absolutePath)
  } catch {
    return []
  }
}

beforeAll(async () => {
  process.env.NODE_ENV = 'test'
  process.env.PORT = '4000'
  process.env.DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/genealogy'
  process.env.JWT_SECRET = 'test-secret-with-sufficient-length'
  process.env.JWT_EXPIRES_IN = '7d'
  process.env.JWT_TREE_ACCESS_EXPIRES_IN = '24h'
  process.env.CORS_ORIGIN = 'http://localhost:5173'
  process.env.IMMICH_ENABLED = 'true'
  process.env.IMMICH_API_URL = 'http://immich.test'
  process.env.IMMICH_API_KEY = 'test-key'

  storageRoot = await mkdtemp(path.join(os.tmpdir(), 'parenthese-immich-'))
  process.env.MEDIA_STORAGE_PATH = storageRoot
  // Quota serré pour le tester : le disque est mesuré en vrai (taille du dossier de l'arbre).
  process.env.MEDIA_QUOTA_PER_TREE_MB = '1'

  jpegBytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#aabbcc' } }).jpeg().toBuffer()

  const module = await import('../src/app.js')
  createApp = module.createApp

  vi.stubGlobal('fetch', fetchMock)
})

afterAll(async () => {
  await rm(storageRoot, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

beforeEach(async () => {
  vi.clearAllMocks()

  prismaMock.user.count.mockResolvedValue(1)

  // La transaction de l'API prend un tableau d'opérations ; les autres tests du dépôt utilisent la forme callback.
  prismaMock.$transaction.mockImplementation(async (input: unknown) => {
    if (Array.isArray(input)) {
      return Promise.all(input)
    }
    return (input as (tx: typeof prismaMock) => Promise<unknown>)(prismaMock)
  })

  prismaMock.treeMembership.findUnique.mockResolvedValue({
    treeId: 'tree-1',
    userId: 'user-1',
    role: 'owner',
    tree: { deletedAt: null },
  })

  prismaMock.person.findFirst.mockResolvedValue(null)
  prismaMock.person.update.mockResolvedValue({ id: 'person-1' })
  prismaMock.auditLog.create.mockResolvedValue({ id: 'audit-1' })
  prismaMock.mediaItem.aggregate.mockResolvedValue({ _sum: { sizeBytes: 0 } })

  fetchMock.mockReset()
  fetchMock.mockResolvedValue(await jsonResponse({ res: 'pong' }))
})

describe('Immich integration: status and people', () => {
  it('reports Immich available when ping answers pong', async () => {
    const app = createApp()
    const token = await createUserToken(app)
    fetchMock.mockResolvedValue(await jsonResponse({ res: 'pong' }))

    const response = await app.inject({
      method: 'GET',
      url: '/trees/tree-1/immich/status',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ available: true, reason: null })
    await app.close()
  })

  it('reports Immich unreachable when ping fails', async () => {
    const app = createApp()
    const token = await createUserToken(app)
    fetchMock.mockRejectedValue(new Error('network down'))

    const response = await app.inject({
      method: 'GET',
      url: '/trees/tree-1/immich/status',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ available: false, reason: 'unreachable' })
    await app.close()
  })

  it('rejects unauthenticated and non-admin requests on status', async () => {
    const app = createApp()

    const anonymous = await app.inject({ method: 'GET', url: '/trees/tree-1/immich/status' })
    expect(anonymous.statusCode).toBe(401)

    const token = await createUserToken(app)
    prismaMock.treeMembership.findUnique.mockResolvedValue({
      treeId: 'tree-1',
      userId: 'user-1',
      role: 'member',
      tree: { deletedAt: null },
    })
    const member = await app.inject({
      method: 'GET',
      url: '/trees/tree-1/immich/status',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(member.statusCode).toBe(403)
    await app.close()
  })

  it('lists people across Immich pages', async () => {
    const app = createApp()
    const token = await createUserToken(app)
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/people?')) {
        const page = url.includes('page=2') ? 2 : 1
        if (page === 1) {
          return jsonResponse({
            people: [{ id: immichPersonId, name: 'Jean Dupont', thumbnailPath: '/thumb/a.jpg', isHidden: false, birthDate: null }],
            total: 2,
            hasNextPage: true,
            hidden: 0,
          })
        }
        return jsonResponse({
          people: [{ id: otherImmichId, name: 'Marie Martin', thumbnailPath: '', isHidden: false, birthDate: null }],
          total: 2,
          hasNextPage: false,
          hidden: 0,
        })
      }
      return jsonResponse({ res: 'pong' })
    })

    const response = await app.inject({
      method: 'GET',
      url: '/trees/tree-1/immich/people',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().people).toEqual([
      { id: immichPersonId, name: 'Jean Dupont', hasThumbnail: true },
      { id: otherImmichId, name: 'Marie Martin', hasThumbnail: false },
    ])
    await app.close()
  })

  it('maps an Immich auth failure to 502 and a malformed response to 503', async () => {
    const app = createApp()
    const token = await createUserToken(app)
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ message: 'Invalid API key' }), { status: 401 }))

    const authFailure = await app.inject({
      method: 'GET',
      url: '/trees/tree-1/immich/people',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(authFailure.statusCode).toBe(502)
    expect(authFailure.json()).toEqual({ error: 'immich_auth_failed' })

    fetchMock.mockResolvedValue(await jsonResponse({ total: 0, hasNextPage: false }))
    const malformed = await app.inject({
      method: 'GET',
      url: '/trees/tree-1/immich/people',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(malformed.statusCode).toBe(503)
    expect(malformed.json()).toEqual({ error: 'immich_unreachable' })
    await app.close()
  })
})

describe('Immich integration: thumbnail proxy', () => {
  it('proxies a thumbnail with its sniffed content type', async () => {
    const app = createApp()
    const token = await createUserToken(app)
    fetchMock.mockResolvedValue(new Response(new Uint8Array(jpegBytes), { status: 200 }))

    const response = await app.inject({
      method: 'GET',
      url: `/trees/tree-1/immich/thumbnail/${immichPersonId}`,
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('image/jpeg')
    expect(Buffer.from(response.rawPayload).equals(jpegBytes)).toBe(true)
    await app.close()
  })

  it('returns 404 when the thumbnail is missing and 400 for a malformed identifier', async () => {
    const app = createApp()
    const token = await createUserToken(app)
    fetchMock.mockResolvedValue(new Response('', { status: 404 }))

    const missing = await app.inject({
      method: 'GET',
      url: `/trees/tree-1/immich/thumbnail/${immichPersonId}`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(missing.statusCode).toBe(404)
    expect(missing.json()).toEqual({ error: 'immich_person_not_found' })

    const invalid = await app.inject({
      method: 'GET',
      url: '/trees/tree-1/immich/thumbnail/not-a-uuid',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(invalid.statusCode).toBe(400)
    await app.close()
  })
})

describe('Immich integration: assign', () => {
  it('downloads the thumbnail, replaces the avatar and audits the change', async () => {
    const app = createApp()
    const token = await createUserToken(app)

    // Portrait manuel en place : il doit être supprimé une fois la base à jour.
    const oldAvatarRelative = 'tree-1/person-1/avatar-old.jpg'
    await mkdir(path.dirname(await absStoragePath(oldAvatarRelative)), { recursive: true })
    await writeFile(await absStoragePath(oldAvatarRelative), 'old avatar')

    prismaMock.person.findFirst.mockResolvedValue({ id: 'person-1', avatarPath: oldAvatarRelative })
    mockImmichPerson()

    const response = await app.inject({
      method: 'POST',
      url: '/trees/tree-1/immich/assign',
      headers: { authorization: `Bearer ${token}` },
      payload: { personId: 'person-1', immichPersonId },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ ok: true, avatarUpdated: true, immichPersonId })

    const updateData = prismaMock.person.update.mock.calls[0][0].data
    expect(updateData.immichPersonId).toBe(immichPersonId)
    expect(updateData.avatarMimeType).toBe('image/jpeg')
    expect(typeof updateData.avatarPath).toBe('string')

    // Le nouveau portrait existe sur le disque, l'ancien a été retiré.
    const newAvatar = await absStoragePath(updateData.avatarPath)
    await expect(fsExists(newAvatar)).resolves.toBe(true)
    await expect(fsExists(await absStoragePath(oldAvatarRelative))).resolves.toBe(false)

    expect(prismaMock.auditLog.create).toHaveBeenCalledWith({
      data: {
        treeId: 'tree-1',
        actorType: 'user',
        actorId: 'user-1',
        action: 'immich_assign',
        entityType: 'person',
        entityId: 'person-1',
        payloadJson: { immichPersonId, avatarUpdated: true, avatarPath: updateData.avatarPath },
      },
    })
    await app.close()
  })

  it('assigns without touching the avatar when Immich has no thumbnail', async () => {
    const app = createApp()
    const token = await createUserToken(app)

    prismaMock.person.findFirst.mockResolvedValue({ id: 'person-1', avatarPath: 'tree-1/person-1/avatar-keep.jpg' })
    mockImmichPerson({ thumbnailPath: '' })

    const response = await app.inject({
      method: 'POST',
      url: '/trees/tree-1/immich/assign',
      headers: { authorization: `Bearer ${token}` },
      payload: { personId: 'person-1', immichPersonId },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ ok: true, avatarUpdated: false, immichPersonId })

    // Sans vignette annoncée, l'appel de vignette n'a même pas lieu.
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const updateData = prismaMock.person.update.mock.calls[0][0].data
    expect(updateData.immichPersonId).toBe(immichPersonId)
    expect(updateData).not.toHaveProperty('avatarPath')
    expect(updateData).not.toHaveProperty('avatarMimeType')
    await app.close()
  })

  it('still assigns without the avatar when the thumbnail vanishes after the person was found', async () => {
    const app = createApp()
    const token = await createUserToken(app)

    // Immich annonce une vignette qui répond pourtant 404 : la personne existe,
    // l'association se fait sans portrait.
    prismaMock.person.findFirst.mockResolvedValue({ id: 'person-1', avatarPath: null })
    mockImmichPerson({ thumbnailStatus: 404 })

    const response = await app.inject({
      method: 'POST',
      url: '/trees/tree-1/immich/assign',
      headers: { authorization: `Bearer ${token}` },
      payload: { personId: 'person-1', immichPersonId },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ ok: true, avatarUpdated: false, immichPersonId })

    const updateData = prismaMock.person.update.mock.calls[0][0].data
    expect(updateData.immichPersonId).toBe(immichPersonId)
    expect(updateData).not.toHaveProperty('avatarPath')
    expect(updateData).not.toHaveProperty('avatarMimeType')
    await app.close()
  })

  it('refuses the assignment when the Immich person does not exist', async () => {
    const app = createApp()
    const token = await createUserToken(app)

    // Portrait en place : un refus ne doit rien changer.
    // Dossier dédié : les autres tests laissent leurs portraits dans tree-1/person-1.
    const avatarRelative = 'tree-1/person-missing/avatar-keep.jpg'
    await mkdir(path.dirname(await absStoragePath(avatarRelative)), { recursive: true })
    await writeFile(await absStoragePath(avatarRelative), 'existing avatar')

    prismaMock.person.findFirst.mockResolvedValue({ id: 'person-missing', avatarPath: avatarRelative })
    // GET /api/people/{id} : la personne n'existe pas. Un 404 sur la vignette ne suffirait
    // pas à le distinguer d'une simple vignette manquante.
    fetchMock.mockResolvedValue(new Response('', { status: 404 }))

    const response = await app.inject({
      method: 'POST',
      url: '/trees/tree-1/immich/assign',
      headers: { authorization: `Bearer ${token}` },
      payload: { personId: 'person-missing', immichPersonId },
    })

    expect(response.statusCode).toBe(404)
    expect(response.json()).toEqual({ error: 'immich_person_not_found' })

    // Base, journal d'audit et fichiers : rien n'a bougé.
    expect(prismaMock.person.update).not.toHaveBeenCalled()
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled()
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
    await expect(fsExists(await absStoragePath(avatarRelative))).resolves.toBe(true)

    const files = await fsListDir(path.join(storageRoot, 'tree-1', 'person-missing'))
    expect(files.filter((name) => name.startsWith('immich-'))).toEqual([])
    await app.close()
  })

  it('maps an Immich auth failure during assignment to 502 without touching the database', async () => {
    const app = createApp()
    const token = await createUserToken(app)

    prismaMock.person.findFirst.mockResolvedValue({ id: 'person-1', avatarPath: null })
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ message: 'Invalid API key' }), { status: 401 }))

    const response = await app.inject({
      method: 'POST',
      url: '/trees/tree-1/immich/assign',
      headers: { authorization: `Bearer ${token}` },
      payload: { personId: 'person-1', immichPersonId },
    })

    // Un refus d'authentification n'est jamais pris pour une personne manquante.
    expect(response.statusCode).toBe(502)
    expect(response.json()).toEqual({ error: 'immich_auth_failed' })
    expect(prismaMock.person.update).not.toHaveBeenCalled()
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled()
    await app.close()
  })

  it('rejects invalid identifiers, unauthenticated, non-admin and unknown person', async () => {
    const app = createApp()
    const token = await createUserToken(app)

    const invalidId = await app.inject({
      method: 'POST',
      url: '/trees/tree-1/immich/assign',
      headers: { authorization: `Bearer ${token}` },
      payload: { personId: 'person-1', immichPersonId: '../etc/passwd' },
    })
    expect(invalidId.statusCode).toBe(400)
    expect(invalidId.json()).toEqual({ error: 'invalid_immich_person_id' })

    const anonymous = await app.inject({
      method: 'POST',
      url: '/trees/tree-1/immich/assign',
      payload: { personId: 'person-1', immichPersonId },
    })
    expect(anonymous.statusCode).toBe(401)

    prismaMock.treeMembership.findUnique.mockResolvedValue({
      treeId: 'tree-1',
      userId: 'user-1',
      role: 'member',
      tree: { deletedAt: null },
    })
    const member = await app.inject({
      method: 'POST',
      url: '/trees/tree-1/immich/assign',
      headers: { authorization: `Bearer ${token}` },
      payload: { personId: 'person-1', immichPersonId },
    })
    expect(member.statusCode).toBe(403)

    prismaMock.treeMembership.findUnique.mockResolvedValue({
      treeId: 'tree-1',
      userId: 'user-1',
      role: 'owner',
      tree: { deletedAt: null },
    })
    prismaMock.person.findFirst.mockResolvedValue(null)
    const unknown = await app.inject({
      method: 'POST',
      url: '/trees/tree-1/immich/assign',
      headers: { authorization: `Bearer ${token}` },
      payload: { personId: 'person-x', immichPersonId },
    })
    expect(unknown.statusCode).toBe(404)
    expect(unknown.json()).toEqual({ error: 'person_not_found' })
    await app.close()
  })

  it('refuses the assignment when the tree quota is exceeded', async () => {
    const app = createApp()
    const token = await createUserToken(app)

    // L'arbre est déjà plein : 1 Mo sur le disque, un quota de 1 Mo.
    await mkdir(path.join(storageRoot, 'tree-quota'), { recursive: true })
    await writeFile(path.join(storageRoot, 'tree-quota', 'big.bin'), Buffer.alloc(1024 * 1024))

    prismaMock.person.findFirst.mockResolvedValue({ id: 'person-quota', avatarPath: null })
    mockImmichPerson()

    const response = await app.inject({
      method: 'POST',
      url: '/trees/tree-quota/immich/assign',
      headers: { authorization: `Bearer ${token}` },
      payload: { personId: 'person-quota', immichPersonId },
    })

    expect(response.statusCode).toBe(413)
    expect(response.json()).toEqual({ error: 'storage_quota_exceeded' })
    await app.close()
  })

  it('removes the new file and keeps the old avatar when the database update fails', async () => {
    const app = createApp()
    const token = await createUserToken(app)

    const oldAvatarRelative = 'tree-1/person-tx/avatar-kept.jpg'
    await mkdir(path.dirname(await absStoragePath(oldAvatarRelative)), { recursive: true })
    await writeFile(await absStoragePath(oldAvatarRelative), 'old avatar')

    prismaMock.person.findFirst.mockResolvedValue({ id: 'person-tx', avatarPath: oldAvatarRelative })
    mockImmichPerson()
    prismaMock.$transaction.mockRejectedValue(new Error('db down'))

    const response = await app.inject({
      method: 'POST',
      url: '/trees/tree-1/immich/assign',
      headers: { authorization: `Bearer ${token}` },
      payload: { personId: 'person-tx', immichPersonId },
    })

    expect(response.statusCode).toBe(500)

    // La base n'a pas changé : l'ancien portrait est là, le nouveau a été nettoyé.
    await expect(fsExists(await absStoragePath(oldAvatarRelative))).resolves.toBe(true)

    const writtenFiles = await fsListDir(path.join(storageRoot, 'tree-1', 'person-tx'))
    expect(writtenFiles.filter((name) => name.startsWith('immich-'))).toEqual([])
    await app.close()
  })
})

describe('Immich integration: unassign', () => {
  it('clears an Immich avatar after the database update', async () => {
    const app = createApp()
    const token = await createUserToken(app)

    const immichAvatarRelative = `tree-1/person-1/immich-${randomUUID()}.jpg`
    await mkdir(path.dirname(await absStoragePath(immichAvatarRelative)), { recursive: true })
    await writeFile(await absStoragePath(immichAvatarRelative), 'immich avatar')

    prismaMock.person.findFirst.mockResolvedValue({ id: 'person-1', avatarPath: immichAvatarRelative, immichPersonId })

    const response = await app.inject({
      method: 'POST',
      url: '/trees/tree-1/immich/unassign',
      headers: { authorization: `Bearer ${token}` },
      payload: { personId: 'person-1' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ ok: true, avatarRemoved: true })

    const updateData = prismaMock.person.update.mock.calls[0][0].data
    expect(updateData).toMatchObject({ immichPersonId: null, avatarPath: null, avatarMimeType: null })

    expect(prismaMock.auditLog.create).toHaveBeenCalledWith({
      data: {
        treeId: 'tree-1',
        actorType: 'user',
        actorId: 'user-1',
        action: 'immich_unassign',
        entityType: 'person',
        entityId: 'person-1',
        payloadJson: { previousImmichPersonId: immichPersonId, avatarRemoved: true },
      },
    })

    await expect(fsExists(await absStoragePath(immichAvatarRelative))).resolves.toBe(false)
    await app.close()
  })

  it('preserves a manually uploaded avatar when unassigning', async () => {
    const app = createApp()
    const token = await createUserToken(app)

    const manualAvatarRelative = `tree-1/person-1/avatar-${randomUUID()}.jpg`
    await mkdir(path.dirname(await absStoragePath(manualAvatarRelative)), { recursive: true })
    await writeFile(await absStoragePath(manualAvatarRelative), 'manual avatar')

    prismaMock.person.findFirst.mockResolvedValue({ id: 'person-1', avatarPath: manualAvatarRelative, immichPersonId })

    const response = await app.inject({
      method: 'POST',
      url: '/trees/tree-1/immich/unassign',
      headers: { authorization: `Bearer ${token}` },
      payload: { personId: 'person-1' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ ok: true, avatarRemoved: false })

    const updateData = prismaMock.person.update.mock.calls[0][0].data
    expect(updateData.immichPersonId).toBeNull()
    expect(updateData).not.toHaveProperty('avatarPath')
    expect(updateData).not.toHaveProperty('avatarMimeType')

    await expect(fsExists(await absStoragePath(manualAvatarRelative))).resolves.toBe(true)
    await app.close()
  })

  it('rejects unknown persons and non-admin members', async () => {
    const app = createApp()
    const token = await createUserToken(app)

    prismaMock.person.findFirst.mockResolvedValue(null)
    const unknown = await app.inject({
      method: 'POST',
      url: '/trees/tree-1/immich/unassign',
      headers: { authorization: `Bearer ${token}` },
      payload: { personId: 'person-x' },
    })
    expect(unknown.statusCode).toBe(404)

    prismaMock.treeMembership.findUnique.mockResolvedValue({
      treeId: 'tree-1',
      userId: 'user-1',
      role: 'member',
      tree: { deletedAt: null },
    })
    prismaMock.person.findFirst.mockResolvedValue({ id: 'person-1', avatarPath: null, immichPersonId })
    const member = await app.inject({
      method: 'POST',
      url: '/trees/tree-1/immich/unassign',
      headers: { authorization: `Bearer ${token}` },
      payload: { personId: 'person-1' },
    })
    expect(member.statusCode).toBe(403)
    await app.close()
  })
})
