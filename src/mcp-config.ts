import * as fs from 'fs';
import * as path from 'path';
import { getSystemRoot, normalizePath, ensureDir } from './state';
import { readJson, writeJsonAtomic, logError } from './helpers';
import { AgentRole } from './types';

// ============================================================
// Oh-My-Link — MCP Configuration System (Open Registry)
//
// Users can register ANY MCP server — not just the built-in suggestions.
// Global config: ~/.oh-my-link/mcp-config.json
// Per-project override: {cwd}/.oh-my-link/mcp-config.json
//
// The built-in suggestions (context7, grep_app, etc.) are just defaults
// that ship with OML. Users add their own MCPs via `oml setup` or by
// editing the config file directly.
// ============================================================

// --- Types ---

/**
 * MCP provider entry — represents any MCP server registered by the user.
 * The `id` is a freeform string chosen by the user (e.g. "my-rag-server").
 */
export interface McpProvider {
  id: string;
  name: string;
  description: string;
  /** Whether the user considers this MCP installed & ready */
  installed: boolean;
  /** Usage hint shown to agents — tells the AI when/how to use this MCP */
  usage_hint?: string;
  /** Arbitrary tags for categorization (e.g. "search", "docs", "browser") */
  tags?: string[];
  /** When this entry was last modified */
  updated_at?: string;
}

/**
 * Per-role MCP assignment: which MCPs this role should use, in priority order.
 */
export interface McpRoleMapping {
  /** Ordered list of MCP IDs (first = highest priority). Strings, not a fixed union. */
  mcps: string[];
  /** Per-MCP guidance text for this specific role (overrides the provider's usage_hint) */
  guidance: Record<string, string>;
}

/**
 * Top-level MCP config stored in mcp-config.json.
 */
export interface McpConfig {
  version: 2;
  /** All registered MCP providers (keyed by user-chosen ID) */
  providers: Record<string, McpProvider>;
  /** Per-role MCP mapping — which MCPs each agent role prefers */
  agent_map: Partial<Record<AgentRole | string, McpRoleMapping>>;
  /** Timestamp of last config update */
  updated_at?: string;
}

// --- Built-in Suggestions (shipped with OML, users can remove/modify) ---

export const SUGGESTED_PROVIDERS: McpProvider[] = [
  {
    id: 'context7',
    name: 'Context7',
    description: 'Library documentation lookup — resolve-library-id + query-docs for up-to-date API references',
    installed: false,
    usage_hint: 'Look up library docs BEFORE using unfamiliar APIs. Call resolve-library-id then query-docs.',
    tags: ['docs', 'api-reference'],
  },
  {
    id: 'grep_app',
    name: 'grep.app (GitHub code search)',
    description: 'Search real-world code examples from 1M+ public GitHub repos',
    installed: false,
    usage_hint: 'Find real-world usage examples when implementing with unfamiliar libraries. Search for actual code patterns.',
    tags: ['search', 'examples'],
  },
  {
    id: 'playwright',
    name: 'Playwright MCP',
    description: 'Browser automation for testing, screenshots, form filling, data extraction',
    installed: false,
    usage_hint: 'Use for browser automation, web testing, and screenshot tasks.',
    tags: ['browser', 'testing'],
  },
  {
    id: 'augment-context-engine',
    name: 'Augment Context Engine',
    description: 'Semantic codebase search — retrieves relevant code snippets using embeddings',
    installed: false,
    usage_hint: 'USE FIRST for semantic codebase search. Query with natural language instead of manual Glob+Grep.',
    tags: ['search', 'codebase', 'semantic'],
  },
  {
    id: 'browser-use',
    name: 'Browser Use',
    description: 'AI-powered browser automation agent for web interaction tasks',
    installed: false,
    usage_hint: 'Use for AI-driven browser automation when Playwright is insufficient.',
    tags: ['browser', 'automation'],
  },
];

/**
 * Default agent→MCP mapping. Uses string IDs so it works with both
 * built-in and user-added MCPs.
 */
const DEFAULT_AGENT_MAP: Partial<Record<AgentRole, McpRoleMapping>> = {
  scout: {
    mcps: ['augment-context-engine', 'grep_app', 'context7'],
    guidance: {
      'augment-context-engine': 'USE FIRST for semantic codebase search. Query with natural language to find relevant code snippets.',
      grep_app: 'Search GitHub for real-world usage patterns when investigating unfamiliar libraries.',
      context7: 'Look up library docs when you encounter unfamiliar APIs during scouting.',
    },
  },
  'fast-scout': {
    mcps: ['augment-context-engine'],
    guidance: {
      'augment-context-engine': 'USE FIRST for semantic code search instead of manual Glob+Grep.',
    },
  },
  explorer: {
    mcps: ['augment-context-engine', 'grep_app', 'context7'],
    guidance: {
      'augment-context-engine': 'Primary tool for deep-dive exploration. Use natural language queries.',
      grep_app: 'Find real-world code examples when exploring how libraries are typically used.',
      context7: 'Look up official documentation for libraries found during exploration.',
    },
  },
  architect: {
    mcps: ['context7', 'grep_app'],
    guidance: {
      context7: 'Verify API signatures BEFORE specifying them in the plan. Prevents hallucinated APIs.',
      grep_app: 'Find proven implementation patterns from real codebases.',
    },
  },
  worker: {
    mcps: ['context7', 'grep_app', 'augment-context-engine'],
    guidance: {
      context7: 'Look up library docs BEFORE using unfamiliar APIs.',
      grep_app: 'Find real-world usage examples when implementing.',
      'augment-context-engine': 'Understand existing codebase patterns before making changes.',
    },
  },
  executor: {
    mcps: ['context7', 'augment-context-engine'],
    guidance: {
      context7: 'Quick doc lookup for API signatures when implementing fixes.',
      'augment-context-engine': 'Semantic search to understand code context before editing.',
    },
  },
  reviewer: {
    mcps: ['context7', 'grep_app'],
    guidance: {
      context7: 'Verify that implemented APIs match official documentation.',
      grep_app: 'Check if implementation follows common ecosystem patterns.',
    },
  },
  'code-reviewer': {
    mcps: ['context7', 'grep_app'],
    guidance: {
      context7: 'Verify API usage correctness against official docs.',
      grep_app: 'Compare implementation against community best practices.',
    },
  },
  'security-reviewer': {
    mcps: ['context7', 'grep_app'],
    guidance: {
      context7: 'Check security-related API usage against official documentation.',
      grep_app: 'Search for known security patterns and anti-patterns.',
    },
  },
  'test-engineer': {
    mcps: ['context7', 'grep_app'],
    guidance: {
      context7: 'Look up testing framework APIs for correct assertion syntax.',
      grep_app: 'Find real-world test patterns for the framework being used.',
    },
  },
};

// --- Config Path ---

export function getMcpConfigPath(): string {
  return normalizePath(path.join(getSystemRoot(), 'mcp-config.json'));
}

export function getProjectMcpConfigPath(cwd: string): string {
  return normalizePath(path.join(cwd, '.oh-my-link', 'mcp-config.json'));
}

// --- Load / Save ---

/**
 * Load MCP config. Merges: defaults ← global ← project (project wins).
 */
export function loadMcpConfig(cwd?: string): McpConfig {
  const defaults = buildDefaultConfig();
  const globalConfig = readJson<McpConfig>(getMcpConfigPath());
  const projectConfig = cwd ? readJson<McpConfig>(getProjectMcpConfigPath(cwd)) : null;

  let merged = defaults;

  // Layer 1: global overrides defaults
  if (globalConfig && (globalConfig.version === 2 || globalConfig.version === 1 as any)) {
    merged = mergeConfigs(merged, normalizeConfig(globalConfig));
  }

  // Layer 2: project overrides global
  if (projectConfig && (projectConfig.version === 2 || projectConfig.version === 1 as any)) {
    merged = mergeConfigs(merged, normalizeConfig(projectConfig));
  }

  return merged;
}

/**
 * Save MCP config to global path.
 */
export function saveMcpConfig(config: McpConfig): void {
  config.updated_at = new Date().toISOString();
  const configPath = getMcpConfigPath();
  ensureDir(path.dirname(configPath));
  writeJsonAtomic(configPath, config);
}

/**
 * Save MCP config to project-level path.
 */
export function saveProjectMcpConfig(cwd: string, config: McpConfig): void {
  config.updated_at = new Date().toISOString();
  const configPath = getProjectMcpConfigPath(cwd);
  ensureDir(path.dirname(configPath));
  writeJsonAtomic(configPath, config);
}

/**
 * Build default config from SUGGESTED_PROVIDERS + DEFAULT_AGENT_MAP.
 */
export function buildDefaultConfig(): McpConfig {
  const providers: Record<string, McpProvider> = {};
  for (const p of SUGGESTED_PROVIDERS) {
    providers[p.id] = { ...p };
  }
  return {
    version: 2,
    providers,
    agent_map: JSON.parse(JSON.stringify(DEFAULT_AGENT_MAP)),
  };
}

/**
 * Normalize a v1 config to v2 format (backwards compat).
 */
function normalizeConfig(raw: any): McpConfig {
  if (raw.version === 2) return raw as McpConfig;
  // v1 had typed McpId keys — convert to open string keys
  const config: McpConfig = {
    version: 2,
    providers: {},
    agent_map: raw.agent_map || {},
    updated_at: raw.last_setup || raw.updated_at,
  };
  if (raw.providers) {
    for (const [id, p] of Object.entries(raw.providers)) {
      if (p && typeof p === 'object') {
        config.providers[id] = { id, ...(p as any) };
      }
    }
  }
  return config;
}

/**
 * Merge two configs: `overlay` values win over `base`.
 * Providers and agent_map entries from overlay are added/overridden.
 */
function mergeConfigs(base: McpConfig, overlay: McpConfig): McpConfig {
  const providers = { ...base.providers };
  for (const [id, p] of Object.entries(overlay.providers || {})) {
    if (p) {
      providers[id] = { ...providers[id], ...p };
    }
  }

  const agentMap = { ...base.agent_map };
  for (const [role, mapping] of Object.entries(overlay.agent_map || {})) {
    if (mapping) {
      agentMap[role as AgentRole] = mapping;
    }
  }

  return {
    version: 2,
    providers,
    agent_map: agentMap,
    updated_at: overlay.updated_at || base.updated_at,
  };
}

// --- CRUD for Providers ---

/**
 * Register (add or update) an MCP provider.
 */
export function registerProvider(provider: McpProvider): void {
  const config = loadMcpConfig();
  config.providers[provider.id] = {
    ...config.providers[provider.id],
    ...provider,
    updated_at: new Date().toISOString(),
  };
  saveMcpConfig(config);
}

/**
 * Remove an MCP provider and all references to it in agent_map.
 */
export function removeProvider(id: string): boolean {
  const config = loadMcpConfig();
  if (!config.providers[id]) return false;

  delete config.providers[id];

  // Remove from all role mappings
  for (const mapping of Object.values(config.agent_map)) {
    if (!mapping) continue;
    mapping.mcps = mapping.mcps.filter(m => m !== id);
    delete mapping.guidance[id];
  }

  saveMcpConfig(config);
  return true;
}

/**
 * Mark a provider as installed/uninstalled.
 */
export function setProviderInstalled(id: string, installed: boolean): void {
  const config = loadMcpConfig();
  const provider = config.providers[id];
  if (provider) {
    provider.installed = installed;
    provider.updated_at = new Date().toISOString();
  }
  saveMcpConfig(config);
}

/**
 * List all registered providers.
 */
export function listProviders(cwd?: string): McpProvider[] {
  const config = loadMcpConfig(cwd);
  return Object.values(config.providers);
}

/**
 * List only installed providers.
 */
export function listInstalledProviders(cwd?: string): McpProvider[] {
  return listProviders(cwd).filter(p => p.installed);
}

// --- CRUD for Role Mappings ---

/**
 * Set the MCP list for a role (replaces existing).
 */
export function setRoleMcps(role: AgentRole, mcpIds: string[], guidance?: Record<string, string>): void {
  const config = loadMcpConfig();
  config.agent_map[role] = {
    mcps: mcpIds,
    guidance: guidance || config.agent_map[role]?.guidance || {},
  };
  saveMcpConfig(config);
}

/**
 * Add an MCP to a role's priority list (appends if not present).
 */
export function addMcpToRole(role: AgentRole, mcpId: string, guidanceText?: string): void {
  const config = loadMcpConfig();
  const mapping = config.agent_map[role] || { mcps: [], guidance: {} };
  if (!mapping.mcps.includes(mcpId)) {
    mapping.mcps.push(mcpId);
  }
  if (guidanceText) {
    mapping.guidance[mcpId] = guidanceText;
  }
  config.agent_map[role] = mapping;
  saveMcpConfig(config);
}

/**
 * Remove an MCP from a role's priority list.
 */
export function removeMcpFromRole(role: AgentRole, mcpId: string): void {
  const config = loadMcpConfig();
  const mapping = config.agent_map[role];
  if (!mapping) return;
  mapping.mcps = mapping.mcps.filter(m => m !== mcpId);
  delete mapping.guidance[mcpId];
  saveMcpConfig(config);
}

// --- Agent Guidance Generation ---

/**
 * Get MCP guidance text for a specific role.
 * Used by skill-injector to build dynamic MCP instructions for subagents.
 * Returns empty string if no installed MCPs are mapped to this role.
 */
export function getMcpGuidanceForRole(role: AgentRole, cwd?: string): string {
  const config = loadMcpConfig(cwd);
  const mapping = config.agent_map[role];
  if (!mapping || mapping.mcps.length === 0) return '';

  const lines: string[] = [];

  for (const mcpId of mapping.mcps) {
    const provider = config.providers[mcpId];
    if (!provider || !provider.installed) continue;

    // Role-specific guidance wins over provider-level usage_hint
    const guidance = mapping.guidance[mcpId] || provider.usage_hint || provider.description;
    lines.push(`- \`${provider.name}\` (${mcpId}) — ${guidance}`);
  }

  if (lines.length === 0) return '';

  let text = '\n**MCP Tools (use automatically when available):**\n';
  text += lines.join('\n');
  text += '\n';
  return text;
}

/**
 * Check if a specific MCP is installed.
 */
export function isMcpInstalled(id: string, cwd?: string): boolean {
  const config = loadMcpConfig(cwd);
  return config.providers[id]?.installed === true;
}

/**
 * Detect if a tool_name belongs to an MCP provider.
 * MCP tools in Claude Code are named like "providerId_methodName".
 * Returns { providerId, method, providerName } if detected, null otherwise.
 */
export function detectMcpTool(toolName: string, cwd?: string): { providerId: string; method: string; providerName: string } | null {
  if (!toolName || !toolName.includes('_')) return null;

  // Try matching provider IDs from config
  try {
    const config = loadMcpConfig(cwd);
    for (const [id, provider] of Object.entries(config.providers)) {
      if (!provider) continue;
      // Check if toolName starts with providerId_ (handles "context7_query-docs", "grep_app_searchGitHub")
      // Also handle hyphenated IDs like "augment-context-engine" → tool "augment-context-engine_codebase-retrieval"
      const prefix = id + '_';
      if (toolName.startsWith(prefix)) {
        return {
          providerId: id,
          method: toolName.slice(prefix.length),
          providerName: provider.name,
        };
      }
    }
  } catch { /* config read failure — silent */ }

  // Fallback: common known prefixes even without config
  const knownPrefixes = ['context7', 'grep_app', 'playwright', 'augment-context-engine', 'browser-use'];
  for (const prefix of knownPrefixes) {
    const p = prefix + '_';
    if (toolName.startsWith(p)) {
      return {
        providerId: prefix,
        method: toolName.slice(p.length),
        providerName: prefix,
      };
    }
  }

  return null;
}
