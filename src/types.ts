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
