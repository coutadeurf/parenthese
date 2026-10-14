import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { beforeAll, describe, expect, it, vi } from 'vitest'

// Arbre sans connexion Immich : aucune requête vers une instance ne doit partir, chaque route
// qui parle à l'instance répond « non configuré » — sauf le retrait d'association, purement
// local. Les variables d'environnement du serveur, même renseignées, ne servent plus à rien :
// la configuration vit par arbre, en base. Fichier à part : on appelle l'application dans une
// session de test sans configuration Immich pour tree-1.

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
    treeImmichConfig: {
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
  // Même renseignées, ces variables ne donnent accès à rien : elles ne sont plus lues.
  process.env.IMMICH_ENABLED = 'true'
  process.env.IMMICH_API_URL = 'http://immich.example.org'
  process.env.IMMICH_API_KEY = 'global-key'

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

describe('Immich integration: tree without configuration', () => {
  it('reports not configured, never calls Immich, and never falls back to server credentials', async () => {
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
    // Aucune ligne de configuration pour cet arbre : il vient d'être créé.
    prismaMock.treeImmichConfig.findUnique.mockResolvedValue(null)

    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const status = await app.inject({
      method: 'GET',
      url: '/trees/tree-1/immich/status',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(status.statusCode).toBe(200)
    expect(status.json()).toEqual({ available: false, reason: 'not_configured' })

    const config = await app.inject({
      method: 'GET',
      url: '/trees/tree-1/immich/config',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(config.statusCode).toBe(200)
    expect(config.json().config).toEqual({ configured: false, apiUrl: null, updatedAt: null })
    // Aucune instance autorisée par l'opérateur : le menu des adresses est vide.
    expect(config.json().allowedApiUrls).toEqual([])

    const people = await app.inject({
      method: 'GET',
      url: '/trees/tree-1/immich/people',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(people.statusCode).toBe(503)
    expect(people.json()).toEqual({ error: 'immich_not_configured' })

    const thumbnail = await app.inject({
      method: 'GET',
      url: '/trees/tree-1/immich/thumbnail/123e4567-e89b-42d3-a456-426614174000',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(thumbnail.statusCode).toBe(503)
    expect(thumbnail.json()).toEqual({ error: 'immich_not_configured' })

    const assign = await app.inject({
      method: 'POST',
      url: '/trees/tree-1/immich/assign',
      headers: { authorization: `Bearer ${token}` },
      payload: { personId: 'person-1', immichPersonId: '123e4567-e89b-42d3-a456-426614174000' },
    })
    expect(assign.statusCode).toBe(503)
    expect(assign.json()).toEqual({ error: 'immich_not_configured' })

    // Le retrait d'association reste possible sans connexion : il nettoie des associations
    // passées sans jamais parler à Immich.
    prismaMock.person.findFirst.mockResolvedValue({
      id: 'person-1',
      avatarPath: null,
      immichPersonId: '123e4567-e89b-42d3-a456-426614174000',
    })
    const unassign = await app.inject({
      method: 'POST',
      url: '/trees/tree-1/immich/unassign',
      headers: { authorization: `Bearer ${token}` },
      payload: { personId: 'person-1' },
    })
    expect(unassign.statusCode).toBe(200)
    expect(unassign.json()).toEqual({ ok: true, avatarRemoved: false })

    // Un arbre sans configuration ne parle jamais à Immich, ni à celle du serveur.
    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
    await app.close()
  })

  it('refuses any address when the operator has authorized no instance', async () => {
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
    prismaMock.treeImmichConfig.findUnique.mockResolvedValue(null)

    // Liste vide côté opérateur : aucune adresse ne peut être configurée, la fonction reste éteinte.
    const response = await app.inject({
      method: 'PUT',
      url: '/trees/tree-1/immich/config',
      headers: { authorization: `Bearer ${token}` },
      payload: { apiUrl: 'http://immich.example.org', apiKey: 'some-key' },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({ error: 'api_url_not_allowed' })
    await app.close()
  })
})
