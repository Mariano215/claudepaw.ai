import { describe, it, expect, beforeAll } from 'vitest'
import { initDatabase, getDb } from './db.js'

beforeAll(() => {
  initDatabase()
})

describe('knowledge graph tables', () => {
  it('creates entities table', () => {
    const db = getDb()
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='entities'")
      .get()
    expect(row).toBeTruthy()
  })

  it('creates observations table', () => {
    const db = getDb()
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='observations'")
      .get()
    expect(row).toBeTruthy()
  })

  it('creates relations table', () => {
    const db = getDb()
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='relations'")
      .get()
    expect(row).toBeTruthy()
  })

  it('creates kv_settings table', () => {
    const db = getDb()
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='kv_settings'")
      .get()
    expect(row).toBeTruthy()
  })
})

import {
  upsertEntity,
  getEntityByName,
  addObservation,
  closeObservation,
  getCurrentObservations,
  addRelation,
} from './knowledge.js'

describe('upsertEntity', () => {
  it('creates a new entity and returns its id', () => {
    const id = upsertEntity({ name: 'ExampleApp', type: 'project', summary: 'iOS SSH app', projectId: null })
    expect(typeof id).toBe('number')
    expect(id).toBeGreaterThan(0)
  })

  it('returns same id on duplicate name (upsert)', () => {
    const id1 = upsertEntity({ name: 'ExampleNotes', type: 'project', summary: 'iOS notes', projectId: null })
    const id2 = upsertEntity({ name: 'ExampleNotes', type: 'project', summary: 'iOS notes updated', projectId: null })
    expect(id1).toBe(id2)
  })
})

describe('getEntityByName', () => {
  it('returns entity by exact name', () => {
    upsertEntity({ name: 'Jane Doe', type: 'person', summary: 'Co-director', projectId: null })
    const entity = getEntityByName('Jane Doe')
    expect(entity).not.toBeNull()
    expect(entity!.type).toBe('person')
  })

  it('returns null for unknown entity', () => {
    expect(getEntityByName('NonExistentPerson99999')).toBeNull()
  })
})

describe('addObservation + getCurrentObservations', () => {
  it('stores and retrieves current observations', () => {
    const entityId = upsertEntity({ name: 'TestProjectObs', type: 'project', summary: null, projectId: null })
    addObservation({ entityId, content: 'in active development', source: 'authored', confidence: 1.0 })
    const obs = getCurrentObservations(entityId)
    expect(obs.some((o) => o.content === 'in active development')).toBe(true)
  })
})

describe('closeObservation', () => {
  it('sets valid_until so observation no longer appears as current', () => {
    const entityId = upsertEntity({ name: 'ClosableProject', type: 'project', summary: null, projectId: null })
    const obsId = addObservation({ entityId, content: 'in review', source: 'extracted', confidence: 0.9 })
    const before = getCurrentObservations(entityId)
    expect(before.some((o) => o.id === obsId)).toBe(true)
    closeObservation(obsId)
    const after = getCurrentObservations(entityId)
    expect(after.some((o) => o.id === obsId)).toBe(false)
  })
})

describe('addRelation', () => {
  it('stores a relation between two entities without throwing', () => {
    const fromId = upsertEntity({ name: 'RelOwner', type: 'person', summary: null, projectId: null })
    const toId = upsertEntity({ name: 'RelProject', type: 'project', summary: null, projectId: null })
    expect(() =>
      addRelation({ fromEntityId: fromId, toEntityId: toId, relationType: 'owns', fact: 'RelOwner owns RelProject' })
    ).not.toThrow()
  })

  it('does not duplicate existing open relations', () => {
    const fromId = upsertEntity({ name: 'DedupOwner', type: 'person', summary: null, projectId: null })
    const toId = upsertEntity({ name: 'DedupProject', type: 'project', summary: null, projectId: null })
    addRelation({ fromEntityId: fromId, toEntityId: toId, relationType: 'uses', fact: null })
    addRelation({ fromEntityId: fromId, toEntityId: toId, relationType: 'uses', fact: null })
    const db = getDb()
    const count = (db.prepare('SELECT COUNT(*) as n FROM relations WHERE from_entity_id = ? AND to_entity_id = ? AND relation_type = ? AND valid_until IS NULL').get(fromId, toId, 'uses') as { n: number }).n
    expect(count).toBe(1)
  })
})
