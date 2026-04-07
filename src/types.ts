// ============================================================
// Oh-My-Link — Shared Types
// ============================================================

// --- Hook I/O ---

export interface HookInput {
  cwd?: string;
  directory?: string;
  session_id?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_output?: string;
  /** Claude Code sends tool output as `tool_response` (object or string), not `tool_output`.
   *  Discovered via raw payload capture: PostToolUse contains tool_response with stdout/stderr fields. */
  tool_response?: string | Record<string, unknown>;
  tool_error?: string;
  // Claude Code SubagentStart fields — both snake_case and camelCase variants
  agent_type?: string;
  agent_id?: string;
  agent_description?: string;
  agent_prompt?: string;
  // Claude Code may also send these alternate field names
  description?: string;
  exit_code?: number;
  role?: string;
}

export interface HookOutput {
  continue: boolean;
  decision?: 'block' | 'allow';
  reason?: string;
  systemMessage?: string;
  hookSpecificOutput?: {
    hookEventName: string;
    additionalContext?: string;
  };
  additionalContext?: string;
}

// --- Session State ---

export type Mode = 'mylink' | 'mylight';

export type MylinkIntent = 'trivial' | 'simple' | 'complex';
export type MylightIntent = 'turbo' | 'standard' | 'complex';

export type Phase =
  | 'bootstrap'
  | 'phase_0_memory'
  | 'phase_1_scout'
  | 'gate_1_pending'
  | 'phase_2_planning'
  | 'gate_2_pending'
  | 'phase_3_decomposition'
  | 'phase_4_validation'
  | 'gate_3_pending'
  | 'phase_5_execution'
  | 'phase_6_review'
  | 'phase_6_5_full_review'
  | 'phase_7_summary'
  | 'light_scout'
  | 'light_turbo'
  | 'light_execution'
  | 'light_complete'
  | 'cancelled'
  | 'complete';

export interface SessionState {
  active: boolean;
  mode: Mode;
  intent?: MylinkIntent | MylightIntent;
  current_phase: Phase;
  started_at: string;
  last_checked_at?: string;
  reinforcement_count: number;
  feature_slug?: string;
  failure_count: number;
  last_failure?: string | { tool: string; error: string; timestamp: string; snippet: string };
  revision_count: number;
  awaiting_confirmation?: boolean;
  cancelled_at?: string;
  is_final_phase?: boolean;
  context_limit_stop?: boolean;
  cancel_requested?: boolean;
  phase_counter?: number;
  session_ended_at?: string;
  deactivated_reason?: string;
  task_engine_error?: boolean;
  // Immutable fields set at session creation — immune to LLM overwriting session.json
  // Used by inferRoleFromSession() for reliable role detection
  locked_mode?: Mode;
  locked_phase?: Phase;
}

// --- Task Engine ---

export type TaskStatus = 'pending' | 'in_progress' | 'done' | 'failed';

export interface TaskAssignment {
  link_id: string;
  title: string;
  description: string;
  acceptance_criteria: string[];
  file_scope: string[];
  locked_decisions: string[];
  depends_on: string[];
  status: TaskStatus;
  assigned_to?: string;
  claimed_at?: string;
  completed_at?: string;
  completion_report?: string;
}

export interface FileLock {
  path: string;
  holder: string;
  acquired_at: string;
  ttl_seconds: number;
  expires_at: string;
}

export interface LockResult {
  success: boolean;
  holder?: string;
  lock?: FileLock;
}

export interface TaskSummary {
  total: number;
  pending: number;
  in_progress: number;
  done: number;
  failed: number;
}

// --- Project Memory ---

export interface HotPath {
  path: string;
  access_count: number;
}

export interface UserDirective {
  directive: string;
  priority: 'high' | 'normal' | 'low';
  added_at: string;
}

export interface ProjectMemory {
  tech_stack: Record<string, string>;
  hot_paths: HotPath[];
  user_directives: UserDirective[];
  notes: string[];
  last_scanned_at: string;
}

// --- Agent Config ---

export type AgentRole =
  | 'master'
  | 'scout'
  | 'fast-scout'
  | 'architect'
  | 'worker'
  | 'reviewer'
  | 'explorer'
  | 'executor'
  | 'verifier'
  | 'code-reviewer'
  | 'security-reviewer'
  | 'test-engineer';

export interface OmlConfig {
  models: Partial<Record<AgentRole, string>>;
  quiet_level: 0 | 1 | 2;
  always_on: boolean;
  debug_mode: boolean;
}

// --- Keyword Detection ---

export interface KeywordRule {
  patterns: string[];
  action: string;
}

export type KeywordAction =
  | 'cancel'
  | 'setup'
  | 'doctor'
  | 'update'
  | 'external-context'
  | 'learn'
  | 'invoke-light'
  | 'invoke';

// --- Subagent Tracking ---

export interface SubagentRecord {
  agent_id: string;
  role: AgentRole | string;
  started_at: string;
  stopped_at?: string;
  link_id?: string;
  status: 'running' | 'stopped';
  model?: string;
}

// --- Tool Tracking ---

export interface ToolRecord {
  tool_name: string;
  timestamp: string;
  success: boolean;
  retry_count: number;
}

// --- Checkpoint (PreCompact) ---

export interface Checkpoint {
  session: SessionState;
  active_tasks: TaskAssignment[];
  active_locks: FileLock[];
  active_agents: SubagentRecord[];
  created_at: string;
  trigger: 'pre_compact' | 'context_pressure' | 'circuit_breaker' | 'manual';
}

// --- Skill Injection ---

export interface LearnedSkill {
  name: string;
  description: string;
  triggers: string[];
  content: string;
  source_file: string;
  score?: number;
}

// --- Prompt Leverage ---

export type TaskIntensity = 'light' | 'moderate' | 'heavy' | 'critical';

export interface PromptFramework {
  context: string;
  constraints: string[];
  success_criteria: string[];
  intensity: TaskIntensity;
}

// --- Project Registry ---

export interface ProjectEntry {
  hash: string;
  path: string;
  name: string;
  last_used: string;
  has_active_session: boolean;
}

export interface ProjectRegistry {
  version: 1;
  projects: Record<string, ProjectEntry>;
}

// --- Memory System (Phase 1 — MemPalace deep integration) ---

/** A single stored memory entry in the vector index */
export interface MemoryDrawer {
  id: string;             // SHA256 hash of raw content (8 chars), used for dedup
  content: string;        // AAAK-compressed text
  raw?: string;           // Original text before compression (truncated to 500 chars)
  room: string;           // memory_type tag: 'decision'|'preference'|'milestone'|'problem'|'emotional'|'remember'|'diary'
  source: string;         // Tool name or 'hook'
  importance: number;     // 1-5 score (default 3). Used by Layer1 sorting
  timestamp: string;      // ISO string
  wing?: string;          // Optional topic wing for hierarchical organization
}

/** Configuration constants for the memory system */
export interface MemoryConfig {
  maxL1Drawers: number;   // Max entries in L1 (default 15, from layers.py line 83)
  maxL1Chars: number;     // Hard cap on L1 text (default 3200, ~800 tokens, from layers.py line 84)
  minConfidence: number;  // Min extraction confidence (default 0.3, from general_extractor.py line 363)
  topicWings: string[];   // Wing categories (from config.py lines 14-22)
  hallKeywords: Record<string, string[]>;  // Wing -> keyword list (from config.py lines 24-61)
}

/** Output of Dialect.compress() with stats */
export interface CompressedMemory {
  aaak: string;           // The compressed AAAK string
  originalChars: number;
  compressedChars: number;
  ratio: number;          // originalChars / compressedChars
}

/** Output of extractMemories() — one extracted segment */
export interface ExtractionResult {
  content: string;        // Original paragraph text
  memory_type: 'decision' | 'preference' | 'milestone' | 'problem' | 'emotional';
  chunk_index: number;    // Position in source text (0-based)
  confidence: number;     // 0.0-1.0
}

/** A document stored in the BM25 vector store */
export interface VectorDocument {
  id: string;             // SHA256 of raw content (8 chars), matches MemoryDrawer.id
  text: string;           // AAAK-compressed or raw text (what is indexed + returned)
  tokens: string[];       // Pre-tokenized for BM25 scoring (stop words removed)
  metadata: Omit<MemoryDrawer, 'id' | 'content'>;
  added_at: string;       // ISO string
}

/** A search result from the vector store */
export interface SearchResult {
  document: VectorDocument;
  score: number;          // BM25 score (higher = more relevant)
  rank: number;           // 1-based rank in results
}

/** The full vector index file: vector-index.json */
export interface VectorIndex {
  version: 1;
  documents: VectorDocument[];
  last_updated: string;   // ISO string
}

// --- Knowledge Graph (Phase 2) ---

/** Entity node in the knowledge graph */
export interface KGEntity {
  id: string;              // Normalized: lowercase, spaces->underscores, no apostrophes
  name: string;            // Display name (original casing)
  type: KGEntityType;      // person | project | tool | concept | unknown
  properties: Record<string, string>;  // Arbitrary k/v (gender, birthday, etc.)
  created_at: string;      // ISO string
}

export type KGEntityType = 'person' | 'project' | 'tool' | 'concept' | 'unknown';

/** A single relationship triple in the knowledge graph */
export interface KGTriple {
  id: string;              // t_{subject}_{predicate}_{object}_{hash8}
  subject: string;         // Entity ID (FK)
  predicate: string;       // Relationship verb: child_of, works_on, loves, uses, etc.
  object: string;          // Entity ID (FK)
  valid_from: string | null;  // ISO date when fact became true
  valid_to: string | null;    // ISO date when fact ceased (null = still true)
  confidence: number;      // 0.0-1.0 (default 1.0)
  source_closet: string | null;  // Memory drawer ID that sourced this fact
  source_file: string | null;    // File path that sourced this fact
  extracted_at: string;    // ISO string
}

/** Query result from knowledge graph entity lookup */
export interface KGQueryResult {
  direction: 'outgoing' | 'incoming';
  subject: string;         // Display name
  predicate: string;
  object: string;          // Display name
  valid_from: string | null;
  valid_to: string | null;
  confidence: number;
  source_closet: string | null;
  current: boolean;        // true if valid_to is null
}

/** Knowledge graph statistics */
export interface KGStats {
  entities: number;
  triples: number;
  current_facts: number;
  expired_facts: number;
  relationship_types: string[];
}

// --- Entity Registry (Phase 2) ---

/** A registered person in the entity registry */
export interface RegisteredPerson {
  source: 'onboarding' | 'learned' | 'wiki';
  contexts: string[];           // e.g. ['personal'], ['work'], ['personal', 'work']
  aliases: string[];            // Alternative names/nicknames
  relationship: string;         // daughter, partner, colleague, etc.
  confidence: number;           // 0.0-1.0
  canonical?: string;           // Points to the main name if this is an alias entry
  seen_count?: number;          // How many times detected (for learned entities)
}

/** The full entity registry data structure (stored as JSON) */
export interface EntityRegistryData {
  version: 1;
  mode: 'personal' | 'work' | 'combo';
  people: Record<string, RegisteredPerson>;
  projects: string[];
  ambiguous_flags: string[];
  wiki_cache: Record<string, WikiCacheEntry>;
}

/** Cached Wikipedia lookup result */
export interface WikiCacheEntry {
  inferred_type: 'person' | 'place' | 'concept' | 'ambiguous' | 'unknown';
  confidence: number;
  wiki_summary: string | null;
  wiki_title: string | null;
  confirmed: boolean;
  confirmed_type?: string;
  word?: string;
  note?: string;
}

/** Result of an entity lookup */
export interface EntityLookupResult {
  type: 'person' | 'project' | 'concept' | 'unknown';
  confidence: number;
  source: 'onboarding' | 'learned' | 'wiki' | 'context_disambiguated' | 'inferred' | 'none';
  name: string;
  context?: string[];
  needs_disambiguation: boolean;
  disambiguated_by?: string;
}

// --- Entity Detector (Phase 2) ---

/** Scoring result for a single entity candidate */
export interface EntityScores {
  person_score: number;
  project_score: number;
  person_signals: string[];
  project_signals: string[];
}

/** A classified entity from the detector */
export interface DetectedEntity {
  name: string;
  type: 'person' | 'project' | 'uncertain';
  confidence: number;
  frequency: number;
  signals: string[];
}

/** Output of detectEntities() */
export interface DetectionResult {
  people: DetectedEntity[];
  projects: DetectedEntity[];
  uncertain: DetectedEntity[];
}
