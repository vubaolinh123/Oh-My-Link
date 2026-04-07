/**
 * BM25/TF-IDF Vector Store — JSON file-backed search index
 *
 * Replaces ChromaDB from MemPalace with a zero-dependency BM25 Okapi
 * implementation. All operations are synchronous (hooks are sync Node.js
 * processes). The index is stored as vector-index.json in the project
 * state directory.
 *
 * API:
 *   tokenize, generateDocId, loadIndex, saveIndex,
 *   addDocument, searchDocuments, getAllDocuments,
 *   deleteDocument, countDocuments
 */

import * as path from 'path';
import * as crypto from 'crypto';
import { VectorDocument, VectorIndex, SearchResult, MemoryDrawer } from '../types';
import { getVectorIndexPath, ensureDir } from '../state';
import { readJson, writeJsonAtomic } from '../helpers';
import { STOP_WORDS } from './aaak-dialect';

// ── BM25 tuning parameters (standard Okapi defaults) ──────────────

const BM25_K1 = 1.5;
const BM25_B = 0.75;

// ── Capacity ───────────────────────────────────────────────────────

/** Maximum documents in the index (LRU eviction above this) */
const MAX_DOCUMENTS = 500;

// ── Tokenizer ──────────────────────────────────────────────────────

/**
 * Tokenize text for BM25 indexing.
 * Lowercase, split on non-word characters, filter stop words, min length 2.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\W+/)
    .filter(t => t.length >= 2 && !STOP_WORDS.has(t));
}

// ── Document ID ────────────────────────────────────────────────────

/**
 * Generate a document ID from raw text (SHA256 first 8 hex chars).
 * Truncates input to first 500 chars for stability.
 */
export function generateDocId(text: string): string {
  return crypto
    .createHash('sha256')
    .update(text.slice(0, 500))
    .digest('hex')
    .slice(0, 8);
}

// ── Index I/O ──────────────────────────────────────────────────────

/**
 * Load the vector index from disk.
 * Returns a valid empty index if the file is missing or corrupted.
 */
export function loadIndex(cwd: string): VectorIndex {
  const indexPath = getVectorIndexPath(cwd);
  const data = readJson<VectorIndex>(indexPath);
  if (!data || data.version !== 1) {
    return { version: 1, documents: [], last_updated: new Date().toISOString() };
  }
  return data;
}

/**
 * Save the vector index to disk atomically.
 */
export function saveIndex(cwd: string, index: VectorIndex): void {
  const indexPath = getVectorIndexPath(cwd);
  ensureDir(path.dirname(indexPath));
  index.last_updated = new Date().toISOString();
  writeJsonAtomic(indexPath, index);
}

// ── CRUD Operations ────────────────────────────────────────────────

/**
 * Add a document to the vector index.
 * Deduplicates by id. Enforces MAX_DOCUMENTS with LRU eviction
 * (removes oldest by added_at). Returns the document id.
 */
export function addDocument(
  cwd: string,
  text: string,
  metadata: Omit<MemoryDrawer, 'id' | 'content'>,
): string {
  const id = generateDocId(text);
  const index = loadIndex(cwd);

  // Dedup: if document already exists, skip
  if (index.documents.some(d => d.id === id)) {
    return id;
  }

  const tokens = tokenize(text);
  const doc: VectorDocument = {
    id,
    text,
    tokens,
    metadata,
    added_at: new Date().toISOString(),
  };

  index.documents.push(doc);

  // LRU eviction: keep newest documents
  if (index.documents.length > MAX_DOCUMENTS) {
    index.documents.sort(
      (a, b) => new Date(a.added_at).getTime() - new Date(b.added_at).getTime(),
    );
    index.documents = index.documents.slice(index.documents.length - MAX_DOCUMENTS);
  }

  saveIndex(cwd, index);
  return id;
}

/**
 * Search the index using BM25 Okapi scoring.
 * Returns top `n` results (default 10), optionally filtered by wing/room.
 */
export function searchDocuments(
  cwd: string,
  query: string,
  n: number = 10,
  filter?: { wing?: string; room?: string },
): SearchResult[] {
  const index = loadIndex(cwd);
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  // Apply optional filter
  let candidates = index.documents;
  if (filter?.wing) {
    candidates = candidates.filter(d => d.metadata.wing === filter.wing);
  }
  if (filter?.room) {
    candidates = candidates.filter(d => d.metadata.room === filter.room);
  }
  if (candidates.length === 0) return [];

  // BM25 scoring
  const N = candidates.length;
  const avgdl =
    candidates.reduce((sum, d) => sum + d.tokens.length, 0) / N;

  // Pre-compute IDF for each query token
  const idfMap = new Map<string, number>();
  for (const qt of queryTokens) {
    if (idfMap.has(qt)) continue;
    const df = candidates.filter(d => d.tokens.includes(qt)).length;
    const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
    idfMap.set(qt, idf);
  }

  // Score each candidate
  const scored: Array<{ doc: VectorDocument; score: number }> = [];
  for (const doc of candidates) {
    let score = 0;
    const dl = doc.tokens.length;

    for (const qt of queryTokens) {
      const tf = doc.tokens.filter(t => t === qt).length;
      if (tf === 0) continue;
      const idf = idfMap.get(qt)!;
      const numerator = tf * (BM25_K1 + 1);
      const denominator = tf + BM25_K1 * (1 - BM25_B + BM25_B * dl / avgdl);
      score += idf * numerator / denominator;
    }

    if (score > 0) {
      scored.push({ doc, score });
    }
  }

  // Sort by score descending, take top n
  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, n).map((item, i) => ({
    document: item.doc,
    score: item.score,
    rank: i + 1,
  }));
}

/**
 * Get all documents, optionally filtered by wing/room.
 * Sorted by importance descending (for Layer1 usage).
 */
export function getAllDocuments(
  cwd: string,
  filter?: { wing?: string; room?: string },
): VectorDocument[] {
  const index = loadIndex(cwd);
  let candidates = index.documents;

  if (filter?.wing) {
    candidates = candidates.filter(d => d.metadata.wing === filter.wing);
  }
  if (filter?.room) {
    candidates = candidates.filter(d => d.metadata.room === filter.room);
  }

  // Sort by importance descending
  candidates.sort((a, b) => (b.metadata.importance ?? 3) - (a.metadata.importance ?? 3));

  return candidates;
}

/**
 * Delete a document by id. Returns true if found and deleted.
 */
export function deleteDocument(cwd: string, id: string): boolean {
  const index = loadIndex(cwd);
  const before = index.documents.length;
  index.documents = index.documents.filter(d => d.id !== id);

  if (index.documents.length < before) {
    saveIndex(cwd, index);
    return true;
  }
  return false;
}

/**
 * Count total documents in the index.
 */
export function countDocuments(cwd: string): number {
  const index = loadIndex(cwd);
  return index.documents.length;
}
