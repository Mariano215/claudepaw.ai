import { getDb } from './db.js'

// ── Types ──────────────────────────────────────────────────────────────────

export interface Entity {
  id: number
  name: string
  type: string
  summary: string | null
  project_id: string | null
  created_at: number
  updated_at: number
}

export interface Observation {
  id: number
  entity_id: number
  content: string
  valid_from: number
  valid_until: number | null
  source: 'authored' | 'extracted' | 'feedback'
  confidence: number
  created_at: number
}

export interface Relation {
  id: number
  from_entity_id: number
  to_entity_id: number
  relation_type: string
  fact: string | null
  valid_from: number
  valid_until: number | null
  created_at: number
}

// ── Entity CRUD ────────────────────────────────────────────────────────────

/** Insert or update an entity by name. Returns the entity id. */
export function upsertEntity(params: {
  name: string
  type: string
  summary: string | null
  projectId: string | null
}): number {
  const db = getDb()
  const now = Date.now()
  db.prepare(`
    INSERT INTO entities (name, type, summary, project_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      summary = excluded.summary,
      updated_at = excluded.updated_at
  `).run(params.name, params.type, params.summary, params.projectId, now, now)

  return (db.prepare('SELECT id FROM entities WHERE name = ?').get(params.name) as { id: number }).id
}

/** Get entity by exact name. Returns null if not found. */
export function getEntityByName(name: string): Entity | null {
  return (
    (getDb().prepare('SELECT * FROM entities WHERE name = ?').get(name) as Entity | undefined) ?? null
  )
}

/** Get entity by id. Returns null if not found. */
export function getEntityById(id: number): Entity | null {
  return (
    (getDb().prepare('SELECT * FROM entities WHERE id = ?').get(id) as Entity | undefined) ?? null
  )
}

/** FTS5 search over entity names and summaries. Returns up to `limit` entities. */
export function searchEntities(query: string, limit = 5): Entity[] {
  const ftsQuery = sanitizeForFts(query)
  if (!ftsQuery) return []
  return getDb().prepare(`
    SELECT e.* FROM entities e
    JOIN entities_fts f ON f.rowid = e.id
    WHERE entities_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `).all(ftsQuery, limit) as Entity[]
}

// ── Observation CRUD ───────────────────────────────────────────────────────

/** Add a new observation. Returns the observation id. */
export function addObservation(params: {
  entityId: number
  content: string
  source: 'authored' | 'extracted' | 'feedback'
  confidence: number
}): number {
  const now = Date.now()
  const result = getDb().prepare(`
    INSERT INTO observations (entity_id, content, valid_from, valid_until, source, confidence, created_at)
    VALUES (?, ?, ?, NULL, ?, ?, ?)
  `).run(params.entityId, params.content, now, params.source, params.confidence, now)
  return result.lastInsertRowid as number
}

/** Close an observation by setting valid_until = now. */
export function closeObservation(observationId: number): void {
  getDb().prepare('UPDATE observations SET valid_until = ? WHERE id = ?').run(Date.now(), observationId)
}

/** Get all currently-valid observations for an entity (valid_until IS NULL). */
export function getCurrentObservations(entityId: number): Observation[] {
  return getDb().prepare(`
    SELECT * FROM observations
    WHERE entity_id = ? AND valid_until IS NULL
    ORDER BY created_at DESC
  `).all(entityId) as Observation[]
}

/** FTS5 search over observation content. Returns observations with entity_name. */
export function searchObservations(query: string, limit = 10): Array<Observation & { entity_name: string }> {
  const ftsQuery = sanitizeForFts(query)
  if (!ftsQuery) return []
  return getDb().prepare(`
    SELECT o.*, e.name as entity_name FROM observations o
    JOIN observations_fts f ON f.rowid = o.id
    JOIN entities e ON e.id = o.entity_id
    WHERE observations_fts MATCH ?
      AND o.valid_until IS NULL
    ORDER BY rank
    LIMIT ?
  `).all(ftsQuery, limit) as Array<Observation & { entity_name: string }>
}

// ── Relation CRUD ──────────────────────────────────────────────────────────

/** Add a relation. Skips if identical open relation already exists. */
export function addRelation(params: {
  fromEntityId: number
  toEntityId: number
  relationType: string
  fact: string | null
}): void {
  const db = getDb()
  const existing = db.prepare(`
    SELECT id FROM relations
    WHERE from_entity_id = ? AND to_entity_id = ? AND relation_type = ? AND valid_until IS NULL
  `).get(params.fromEntityId, params.toEntityId, params.relationType)
  if (existing) return

  const now = Date.now()
  db.prepare(`
    INSERT INTO relations (from_entity_id, to_entity_id, relation_type, fact, valid_from, valid_until, created_at)
    VALUES (?, ?, ?, ?, ?, NULL, ?)
  `).run(params.fromEntityId, params.toEntityId, params.relationType, params.fact, now, now)
}

// ── Project-scoped retrieval helpers (Memory v2 Layer 4) ──────────────────

/** FTS5 search over entity names/summaries scoped to project (includes NULL project entities). */
export function searchEntitiesByProject(query: string, projectId: string, limit: number): Entity[] {
  const sanitized = sanitizeForFts(query)
  if (!sanitized) return []
  try {
    return getDb().prepare(`
      SELECT e.* FROM entities e JOIN entities_fts f ON f.rowid = e.id
      WHERE entities_fts MATCH ? AND (e.project_id = ? OR e.project_id IS NULL)
      ORDER BY rank LIMIT ?
    `).all(sanitized, projectId, limit) as Entity[]
  } catch {
    return []
  }
}

/** FTS5 search over observation content scoped to project (includes NULL project observations). */
export function searchObservationsByProject(
  query: string,
  projectId: string,
  limit: number,
): Array<Observation & { entity_name: string }> {
  const sanitized = sanitizeForFts(query)
  if (!sanitized) return []
  try {
    return getDb().prepare(`
      SELECT o.*, e.name as entity_name FROM observations o
      JOIN observations_fts f ON f.rowid = o.id
      JOIN entities e ON e.id = o.entity_id
      WHERE observations_fts MATCH ? AND (o.project_id = ? OR o.project_id IS NULL)
      ORDER BY rank LIMIT ?
    `).all(sanitized, projectId, limit) as Array<Observation & { entity_name: string }>
  } catch {
    return []
  }
}

/** Walk one hop of the relation graph both inbound and outbound, return distinct related entities. */
export function getRelatedEntities(entityId: number): Entity[] {
  return getDb().prepare(`
    SELECT DISTINCT e.* FROM entities e
    WHERE e.id IN (
      SELECT to_entity_id FROM relations WHERE from_entity_id = ?
      UNION SELECT from_entity_id FROM relations WHERE to_entity_id = ?
    )
  `).all(entityId, entityId) as Entity[]
}

// ── Helpers ────────────────────────────────────────────────────────────────

function sanitizeForFts(text: string): string {
  return text
    .replace(/[^a-zA-Z0-9\s]/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => `${w}*`)
    .join(' ')
}
