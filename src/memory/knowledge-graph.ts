/**
 * Knowledge Graph — Temporal Entity-Relationship Graph
 *
 * Port of mempalace/knowledge_graph.py to TypeScript.
 * SQLite-backed (better-sqlite3 primary, sql.js WASM fallback).
 *
 * Entities: people, projects, tools, concepts
 * Edges: typed relationship triples with temporal validity
 * Query: entity-first traversal with time filtering
 */

import * as crypto from 'crypto';
import * as path from 'path';
import * as fs from 'fs';
import { KGEntityType, KGQueryResult, KGStats, EntityRegistryData } from '../types';
import { getKnowledgeGraphPath, ensureDir } from '../state';

// ── SQLite adapter interface ────────────────────────────────────────

interface PreparedStatement {
  run(...params: unknown[]): void;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface SqliteAdapter {
  exec(sql: string): void;
  prepare(sql: string): PreparedStatement;
  close(): void;
}

// ── Adapter factory ─────────────────────────────────────────────────

function createAdapter(dbPath: string): SqliteAdapter {
  // Strategy 1: better-sqlite3 (native, preferred)
  let Database: any;
  try {
    Database = require('better-sqlite3');
  } catch {
    // better-sqlite3 not available — will try sql.js below
  }

  if (Database) {
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 10000');
    return {
      exec: (sql: string) => db.exec(sql),
      prepare: (sql: string) => {
        const stmt = db.prepare(sql);
        return {
          run: (...params: unknown[]) => stmt.run(...params),
          get: (...params: unknown[]) => stmt.get(...params),
          all: (...params: unknown[]) => stmt.all(...params),
        };
      },
      close: () => db.close(),
    };
  }

  // Strategy 2: sql.js (WASM fallback)
  let initSqlJs: any;
  try {
    initSqlJs = require('sql.js');
  } catch {
    throw new Error(
      'Knowledge Graph requires better-sqlite3 or sql.js. ' +
      'Install one: npm install better-sqlite3'
    );
  }

  // sql.js requires async init — we handle it synchronously via execSync helper
  // For Phase 2, this is a best-effort fallback
  const { execSync } = require('child_process');
  let sqlJsDb: any;
  try {
    // Try to load existing database file
    const existingData = fs.existsSync(dbPath) ? fs.readFileSync(dbPath) : undefined;
    // sql.js init is async; use a sync wrapper via child_process
    const initScript = `
      const initSqlJs = require('sql.js');
      initSqlJs().then(SQL => {
        const db = ${existingData ? `new SQL.Database(require('fs').readFileSync('${dbPath.replace(/\\/g, '\\\\')}'))` : 'new SQL.Database()'};
        process.stdout.write(JSON.stringify({ ok: true }));
      }).catch(err => {
        process.stdout.write(JSON.stringify({ ok: false, error: err.message }));
      });
    `;
    // Actually for simplicity, use the synchronous constructor if available
    // sql.js v1.x has a sync path via require('sql.js/dist/sql-wasm.js')
    // For now just throw — better-sqlite3 is the primary path
    throw new Error('sql.js fallback not fully implemented — install better-sqlite3');
  } catch (e) {
    throw new Error(
      'Knowledge Graph: sql.js fallback failed. Install better-sqlite3: npm install better-sqlite3. ' +
      `Inner error: ${(e as Error).message}`
    );
  }
}

// ── SQL Schema ──────────────────────────────────────────────────────

const INIT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS entities (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT DEFAULT 'unknown',
    properties TEXT DEFAULT '{}',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS triples (
    id TEXT PRIMARY KEY,
    subject TEXT NOT NULL,
    predicate TEXT NOT NULL,
    object TEXT NOT NULL,
    valid_from TEXT,
    valid_to TEXT,
    confidence REAL DEFAULT 1.0,
    source_closet TEXT,
    source_file TEXT,
    extracted_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (subject) REFERENCES entities(id),
    FOREIGN KEY (object) REFERENCES entities(id)
  );

  CREATE INDEX IF NOT EXISTS idx_triples_subject ON triples(subject);
  CREATE INDEX IF NOT EXISTS idx_triples_object ON triples(object);
  CREATE INDEX IF NOT EXISTS idx_triples_predicate ON triples(predicate);
  CREATE INDEX IF NOT EXISTS idx_triples_valid ON triples(valid_from, valid_to);
`;

// ── KnowledgeGraph class ────────────────────────────────────────────

export class KnowledgeGraph {
  private db: SqliteAdapter;
  private dbPath: string;

  /**
   * Create or open a knowledge graph database.
   * @param dbPath - Full path to the .sqlite3 file.
   *   If you have a cwd, use getKnowledgeGraphPath(cwd).
   */
  constructor(dbPath: string) {
    this.dbPath = dbPath;
    ensureDir(path.dirname(dbPath));
    this.db = createAdapter(dbPath);
    this.db.exec(INIT_SCHEMA);
  }

  // ── ID Helpers ──────────────────────────────────────────────────

  /**
   * Normalize entity name to ID: lowercase, spaces->underscores, strip apostrophes.
   * Example: "Alice O'Brien" -> "alice_obrien"
   */
  private entityId(name: string): string {
    return name.toLowerCase().replace(/ /g, '_').replace(/'/g, '');
  }

  /**
   * Normalize predicate: lowercase, spaces->underscores.
   */
  private normPredicate(predicate: string): string {
    return predicate.toLowerCase().replace(/ /g, '_');
  }

  /**
   * Generate a triple ID: t_{subId}_{pred}_{objId}_{hash8}
   */
  private tripleId(subId: string, pred: string, objId: string, validFrom?: string | null): string {
    const hashInput = `${validFrom || ''}${new Date().toISOString()}`;
    const hash8 = crypto.createHash('md5').update(hashInput).digest('hex').slice(0, 8);
    return `t_${subId}_${pred}_${objId}_${hash8}`;
  }

  // ── Write Operations ────────────────────────────────────────────

  /**
   * Add or update an entity node.
   * Uses INSERT OR REPLACE (upsert).
   * @returns The entity ID
   */
  addEntity(
    name: string,
    entityType: KGEntityType = 'unknown',
    properties?: Record<string, string>,
  ): string {
    const eid = this.entityId(name);
    const props = JSON.stringify(properties || {});
    this.db.prepare(
      'INSERT OR REPLACE INTO entities (id, name, type, properties) VALUES (?, ?, ?, ?)'
    ).run(eid, name, entityType, props);
    return eid;
  }

  /**
   * Add a relationship triple: subject -> predicate -> object.
   *
   * Auto-creates entities if they don't exist.
   * Deduplicates: if an identical open triple exists (valid_to IS NULL), returns existing ID.
   *
   * @returns The triple ID
   */
  addTriple(
    subject: string,
    predicate: string,
    obj: string,
    options?: {
      valid_from?: string | null;
      valid_to?: string | null;
      confidence?: number;
      source_closet?: string | null;
      source_file?: string | null;
    },
  ): string {
    const subId = this.entityId(subject);
    const objId = this.entityId(obj);
    const pred = this.normPredicate(predicate);
    const opts = options || {};

    // Auto-create entities if they don't exist
    this.db.prepare(
      'INSERT OR IGNORE INTO entities (id, name) VALUES (?, ?)'
    ).run(subId, subject);
    this.db.prepare(
      'INSERT OR IGNORE INTO entities (id, name) VALUES (?, ?)'
    ).run(objId, obj);

    // Check for existing identical open triple (dedup)
    const existing = this.db.prepare(
      'SELECT id FROM triples WHERE subject=? AND predicate=? AND object=? AND valid_to IS NULL'
    ).get(subId, pred, objId) as { id: string } | undefined;

    if (existing) {
      return existing.id;
    }

    // Generate triple ID and insert
    const tid = this.tripleId(subId, pred, objId, opts.valid_from);
    this.db.prepare(
      `INSERT INTO triples (id, subject, predicate, object, valid_from, valid_to, confidence, source_closet, source_file)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      tid,
      subId,
      pred,
      objId,
      opts.valid_from ?? null,
      opts.valid_to ?? null,
      opts.confidence ?? 1.0,
      opts.source_closet ?? null,
      opts.source_file ?? null,
    );

    return tid;
  }

  /**
   * Mark a relationship as no longer valid (set valid_to date).
   * Targets open triples (valid_to IS NULL) matching subject+predicate+object.
   *
   * @param ended - ISO date string. Defaults to today.
   * @returns true if any row was updated
   */
  invalidate(
    subject: string,
    predicate: string,
    obj: string,
    ended?: string,
  ): boolean {
    const subId = this.entityId(subject);
    const objId = this.entityId(obj);
    const pred = this.normPredicate(predicate);
    const endDate = ended || new Date().toISOString().slice(0, 10);

    this.db.prepare(
      'UPDATE triples SET valid_to=? WHERE subject=? AND predicate=? AND object=? AND valid_to IS NULL'
    ).run(endDate, subId, pred, objId);

    // Check if update affected any rows
    // better-sqlite3's run() returns { changes: number } but our adapter doesn't expose it.
    // Instead, verify by querying:
    const check = this.db.prepare(
      'SELECT COUNT(*) as cnt FROM triples WHERE subject=? AND predicate=? AND object=? AND valid_to=?'
    ).get(subId, pred, objId, endDate) as { cnt: number } | undefined;

    return (check?.cnt ?? 0) > 0;
  }

  // ── Query Operations ────────────────────────────────────────────

  /**
   * Get all relationships for an entity.
   *
   * @param name - Entity display name
   * @param asOf - Optional date filter (only facts valid at this date)
   * @param direction - 'outgoing' (entity->?), 'incoming' (?->entity), 'both'
   */
  queryEntity(
    name: string,
    asOf?: string,
    direction: 'outgoing' | 'incoming' | 'both' = 'outgoing',
  ): KGQueryResult[] {
    const eid = this.entityId(name);
    const results: KGQueryResult[] = [];

    if (direction === 'outgoing' || direction === 'both') {
      let query = 'SELECT t.*, e.name as obj_name FROM triples t JOIN entities e ON t.object = e.id WHERE t.subject = ?';
      const params: unknown[] = [eid];
      if (asOf) {
        query += ' AND (t.valid_from IS NULL OR t.valid_from <= ?) AND (t.valid_to IS NULL OR t.valid_to >= ?)';
        params.push(asOf, asOf);
      }
      const rows = this.db.prepare(query).all(...params) as any[];
      for (const row of rows) {
        results.push({
          direction: 'outgoing',
          subject: name,
          predicate: row.predicate,
          object: row.obj_name,
          valid_from: row.valid_from,
          valid_to: row.valid_to,
          confidence: row.confidence,
          source_closet: row.source_closet,
          current: row.valid_to === null,
        });
      }
    }

    if (direction === 'incoming' || direction === 'both') {
      let query = 'SELECT t.*, e.name as sub_name FROM triples t JOIN entities e ON t.subject = e.id WHERE t.object = ?';
      const params: unknown[] = [eid];
      if (asOf) {
        query += ' AND (t.valid_from IS NULL OR t.valid_from <= ?) AND (t.valid_to IS NULL OR t.valid_to >= ?)';
        params.push(asOf, asOf);
      }
      const rows = this.db.prepare(query).all(...params) as any[];
      for (const row of rows) {
        results.push({
          direction: 'incoming',
          subject: row.sub_name,
          predicate: row.predicate,
          object: name,
          valid_from: row.valid_from,
          valid_to: row.valid_to,
          confidence: row.confidence,
          source_closet: row.source_closet,
          current: row.valid_to === null,
        });
      }
    }

    return results;
  }

  /**
   * Get all triples with a given relationship type.
   */
  queryRelationship(
    predicate: string,
    asOf?: string,
  ): KGQueryResult[] {
    const pred = this.normPredicate(predicate);
    let query = `
      SELECT t.*, s.name as sub_name, o.name as obj_name
      FROM triples t
      JOIN entities s ON t.subject = s.id
      JOIN entities o ON t.object = o.id
      WHERE t.predicate = ?
    `;
    const params: unknown[] = [pred];
    if (asOf) {
      query += ' AND (t.valid_from IS NULL OR t.valid_from <= ?) AND (t.valid_to IS NULL OR t.valid_to >= ?)';
      params.push(asOf, asOf);
    }

    const rows = this.db.prepare(query).all(...params) as any[];
    return rows.map(row => ({
      direction: 'outgoing' as const,
      subject: row.sub_name,
      predicate: pred,
      object: row.obj_name,
      valid_from: row.valid_from,
      valid_to: row.valid_to,
      confidence: row.confidence,
      source_closet: row.source_closet,
      current: row.valid_to === null,
    }));
  }

  /**
   * Get all facts in chronological order, optionally filtered by entity.
   * Returns up to 100 results.
   */
  timeline(entityName?: string): KGQueryResult[] {
    let query: string;
    let params: unknown[];

    if (entityName) {
      const eid = this.entityId(entityName);
      query = `
        SELECT t.*, s.name as sub_name, o.name as obj_name
        FROM triples t
        JOIN entities s ON t.subject = s.id
        JOIN entities o ON t.object = o.id
        WHERE (t.subject = ? OR t.object = ?)
        ORDER BY t.valid_from ASC NULLS LAST
      `;
      params = [eid, eid];
    } else {
      query = `
        SELECT t.*, s.name as sub_name, o.name as obj_name
        FROM triples t
        JOIN entities s ON t.subject = s.id
        JOIN entities o ON t.object = o.id
        ORDER BY t.valid_from ASC NULLS LAST
        LIMIT 100
      `;
      params = [];
    }

    const rows = this.db.prepare(query).all(...params) as any[];
    return rows.map(row => ({
      direction: 'outgoing' as const,
      subject: row.sub_name,
      predicate: row.predicate,
      object: row.obj_name,
      valid_from: row.valid_from,
      valid_to: row.valid_to,
      confidence: row.confidence,
      source_closet: row.source_closet,
      current: row.valid_to === null,
    }));
  }

  // ── Stats ───────────────────────────────────────────────────────

  /**
   * Get knowledge graph statistics.
   */
  stats(): KGStats {
    const entities = (this.db.prepare('SELECT COUNT(*) as cnt FROM entities').get() as { cnt: number }).cnt;
    const triples = (this.db.prepare('SELECT COUNT(*) as cnt FROM triples').get() as { cnt: number }).cnt;
    const current = (this.db.prepare('SELECT COUNT(*) as cnt FROM triples WHERE valid_to IS NULL').get() as { cnt: number }).cnt;
    const expired = triples - current;
    const predRows = this.db.prepare('SELECT DISTINCT predicate FROM triples ORDER BY predicate').all() as { predicate: string }[];
    const relationship_types = predRows.map(r => r.predicate);

    return {
      entities,
      triples,
      current_facts: current,
      expired_facts: expired,
      relationship_types,
    };
  }

  // ── Seed Operations ─────────────────────────────────────────────

  /**
   * Seed the knowledge graph from structured fact data.
   * Port of seed_from_entity_facts from knowledge_graph.py.
   */
  seedFromEntityFacts(entityFacts: Record<string, Record<string, unknown>>): void {
    for (const [key, facts] of Object.entries(entityFacts)) {
      const name = (facts.full_name as string) || key.charAt(0).toUpperCase() + key.slice(1);
      const etype = (facts.type as KGEntityType) || 'person';
      this.addEntity(name, etype, {
        gender: (facts.gender as string) || '',
        birthday: (facts.birthday as string) || '',
      });

      // Relationships
      const parent = facts.parent as string | undefined;
      if (parent) {
        this.addTriple(
          name, 'child_of',
          parent.charAt(0).toUpperCase() + parent.slice(1),
          { valid_from: (facts.birthday as string) || null },
        );
      }

      const partner = facts.partner as string | undefined;
      if (partner) {
        this.addTriple(name, 'married_to', partner.charAt(0).toUpperCase() + partner.slice(1));
      }

      const relationship = (facts.relationship as string) || '';
      if (relationship === 'daughter') {
        const parentName = (facts.parent as string) || '';
        this.addTriple(
          name, 'is_child_of',
          parentName ? parentName.charAt(0).toUpperCase() + parentName.slice(1) : name,
          { valid_from: (facts.birthday as string) || null },
        );
      } else if (relationship === 'husband') {
        const partnerName = (facts.partner as string) || name;
        this.addTriple(name, 'is_partner_of', partnerName.charAt(0).toUpperCase() + partnerName.slice(1));
      } else if (relationship === 'brother') {
        const sibling = (facts.sibling as string) || name;
        this.addTriple(name, 'is_sibling_of', sibling.charAt(0).toUpperCase() + sibling.slice(1));
      } else if (relationship === 'dog') {
        const owner = (facts.owner as string) || name;
        this.addTriple(name, 'is_pet_of', owner.charAt(0).toUpperCase() + owner.slice(1));
        this.addEntity(name, 'unknown'); // animal type not in KGEntityType; use unknown
      }

      // Interests
      const interests = (facts.interests as string[]) || [];
      for (const interest of interests) {
        this.addTriple(
          name, 'loves',
          interest.charAt(0).toUpperCase() + interest.slice(1),
          { valid_from: '2025-01-01' },
        );
      }
    }
  }

  /**
   * Seed from entity registry data.
   * Converts people/projects from the registry into KG entities and basic triples.
   */
  seedFromRegistry(registry: EntityRegistryData): void {
    // Add people as person entities
    for (const [name, info] of Object.entries(registry.people)) {
      this.addEntity(name, 'person', {
        relationship: info.relationship || '',
        source: info.source || '',
      });

      // If canonical is set, create an alias relationship
      if (info.canonical) {
        this.addTriple(name, 'alias_of', info.canonical);
      }
    }

    // Add projects as project entities
    for (const proj of registry.projects) {
      this.addEntity(proj, 'project');
    }
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  /**
   * Close the database connection.
   * Idempotent (safe to call multiple times).
   */
  close(): void {
    try {
      this.db.close();
    } catch {
      // Already closed or invalid — ignore
    }
  }
}