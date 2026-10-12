import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { beforeAll, describe, expect, it, vi } from 'vitest'

// Immich désactivé : aucune requête vers l'instance ne doit partir, chaque route répond « non configuré ».
// Fichier à part : la configuration est lue au démarrage de l'application, impossible à changer à chaud.

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    user: {
      count: vi.fn().mockResolvedValue(1),
    },
    person: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    treeMembership: {
      findUnique: vi.fn(),
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

beforeAll(async () => {
  delete process.env.IMMICH_ENABLED
  delete process.env.IMMICH_API_URL
  delete process.env.IMMICH_API_KEY

  process.env.NODE_ENV = 'test'
  process.env.PORT = '4000'
  process.env.DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/genealogy'
  process.env.JWT_SECRET = 'test-secret-with-sufficient-length'
  process.env.JWT_EXPIRES_IN = '7d'
  process.env.JWT_TREE_ACCESS_EXPIRES_IN = '24h'
  process.env.CORS_ORIGIN = 'http://localhost:5173'

  const module = await import('../src/app.js')
  createApp = module.createApp
})

describe('Immich integration: disabled server', () => {
  it('reports not configured and never calls Immich', async () => {
    const app = createApp()
    await app.ready()
    const token = (app as any).jwt.sign(
      { kind: 'user', sub: 'user-1', jti: randomUUID(), userId: 'user-1', email: 'user@example.com' },
      { expiresIn: '1h' },
    )

    prismaMock.treeMembership.findUnique.mockResolvedValue({
      treeId: 'tree-1',
      userId: 'user-1',
      role: 'owner',
      tree: { deletedAt: null },
    })

    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const status = await app.inject({
      method: 'GET',
      url: '/trees/tree-1/immich/status',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(status.statusCode).toBe(200)
    expect(status.json()).toEqual({ available: false, reason: 'not_configured' })

    const people = await app.inject({
      method: 'GET',
      url: '/trees/tree-1/immich/people',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(people.statusCode).toBe(503)
    expect(people.json()).toEqual({ error: 'immich_not_configured' })

    const assign = await app.inject({
      method: 'POST',
      url: '/trees/tree-1/immich/assign',
      headers: { authorization: `Bearer ${token}` },
      payload: { personId: 'person-1', immichPersonId: '123e4567-e89b-42d3-a456-426614174000' },
    })
    expect(assign.statusCode).toBe(503)
    expect(assign.json()).toEqual({ error: 'immich_not_configured' })

    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
    await app.close()
  })
})
