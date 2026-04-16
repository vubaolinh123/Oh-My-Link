import * as fs from 'fs';
import * as path from 'path';
import { getSystemRoot, normalizePath, ensureDir } from './state';
import { readJson, writeJsonAtomic } from './helpers';
import { AgentRole, ModelProvider, ModelProviderConfig } from './types';

// ============================================================
// Oh-My-Link — Model Provider System (Ollama + Anthropic + Open)
//
// Manages LLM providers (Anthropic, Ollama, OpenAI-compatible),
// per-agent model routing with provider prefixes, and API key
// fallback chains for token exhaustion scenarios.
//
// Config: ~/.oh-my-link/model-provider.json
// Project override: {cwd}/.oh-my-link/model-provider.json
// ============================================================

// --- Config Path ---

export function getModelProviderConfigPath(): string {
  return normalizePath(path.join(getSystemRoot(), 'model-provider.json'));
}

export function getProjectModelProviderConfigPath(cwd: string): string {
  return normalizePath(path.join(cwd, '.oh-my-link', 'model-provider.json'));
}

// --- Built-in Default Providers ---
// All providers use Ollama Cloud API (https://ollama.com/v1).
// Primary = main API key; Backup = fallback API key when primary is exhausted.

export const DEFAULT_PROVIDERS: ModelProvider[] = [
  {
    id: 'ollama',
    name: 'Ollama Cloud (Primary)',
    description: 'Ollama cloud API — glm-5.1, kimi-k2.5, qwen3-coder, nemotron, deepseek models. Primary API key.',
    base_url: 'https://ollama.com/v1',
    api_key_env: 'ANTHROPIC_API_KEY',
    installed: true,
    type: 'ollama',
    model_prefix: 'ollama',
  },
  {
    id: 'ollama-backup',
    name: 'Ollama Cloud (Backup Key)',
    description: 'Ollama cloud API with backup/fallback API key. Same endpoint & models — used when primary key is exhausted.',
    base_url: 'https://ollama.com/v1',
    api_key_env: 'OML_FALLBACK_API_KEY',
    installed: true,
    type: 'ollama',
    model_prefix: 'ollama',
  },
];

/**
 * Default per-role model bindings using "provider_id:model_name" format.
 * Ollama Cloud models assigned by role based on task characteristics:
 *
 * - Orchestrator/planning roles (master, architect) → glm-5.1 (strongest all-around)
 * - Reasoning/analysis roles (scout, code-reviewer) → kimi-k2.5 (strong reasoning)
 * - Implementation/code roles (worker, executor) → qwen3-coder:480b (best for code)
 * - Fast-lookup roles (fast-scout, explorer) → nemotron-3-super (fast, lightweight)
 * - Verification/review roles (reviewer, verifier) → minimax-m2.7 (balanced)
 * - Security/deep-analysis (security-reviewer) → deepseek-v3.2 (strong code analysis)
 * - Testing (test-engineer) → qwen3.5:397b (code understanding + speed)
 */
const DEFAULT_MODEL_BINDINGS: Partial<Record<AgentRole, string>> = {
  master: 'ollama:glm-5.1',
  scout: 'ollama:kimi-k2.5',
  architect: 'ollama:glm-5.1',
  'code-reviewer': 'ollama:kimi-k2.5',
  worker: 'ollama:qwen3-coder:480b',
  executor: 'ollama:qwen3-coder:480b',
  reviewer: 'ollama:minimax-m2.7',
  verifier: 'ollama:minimax-m2.7',
  'security-reviewer': 'ollama:deepseek-v3.2',
  'test-engineer': 'ollama:qwen3.5:397b',
  'fast-scout': 'ollama:nemotron-3-super',
  explorer: 'ollama:nemotron-3-super',
};

const DEFAULT_FALLBACK_CHAIN: string[] = ['ollama', 'ollama-backup'];

// --- Load / Save ---

export function loadModelProviderConfig(cwd?: string): ModelProviderConfig {
  const globalConfig = readJson<ModelProviderConfig>(getModelProviderConfigPath());
  const projectConfig = cwd ? readJson<ModelProviderConfig>(getProjectModelProviderConfigPath(cwd)) : null;

  const defaults = buildDefaultConfig();
  let merged = defaults;

  // Layer 1: global overrides defaults
  if (globalConfig) {
    merged = mergeConfigs(merged, globalConfig);
  }

  // Layer 2: project overrides global
  if (projectConfig) {
    merged = mergeConfigs(merged, projectConfig);
  }

  return merged;
}

export function saveModelProviderConfig(config: ModelProviderConfig): void {
  config.updated_at = new Date().toISOString();
  const configPath = getModelProviderConfigPath();
  ensureDir(path.dirname(configPath));
  writeJsonAtomic(configPath, config);
}

export function buildDefaultConfig(): ModelProviderConfig {
  const providers: Record<string, ModelProvider> = {};
  for (const p of DEFAULT_PROVIDERS) {
    providers[p.id] = { ...p };
  }
  return {
    version: 1,
    providers,
    model_bindings: { ...DEFAULT_MODEL_BINDINGS },
    fallback_chain: [...DEFAULT_FALLBACK_CHAIN],
    active_provider_id: 'ollama',
  };
}

// --- Merge ---

function mergeConfigs(base: ModelProviderConfig, overlay: ModelProviderConfig): ModelProviderConfig {
  const providers = { ...base.providers };
  for (const [id, p] of Object.entries(overlay.providers || {})) {
    if (p) {
      providers[id] = { ...providers[id], ...p };
    }
  }

  const modelBindings = { ...base.model_bindings };
  for (const [role, binding] of Object.entries(overlay.model_bindings || {})) {
    if (binding !== undefined) {
      modelBindings[role] = binding;
    }
  }

  return {
    version: 1,
    providers,
    model_bindings: modelBindings,
    fallback_chain: overlay.fallback_chain || base.fallback_chain,
    active_provider_id: overlay.active_provider_id || base.active_provider_id,
    last_fallback_at: overlay.last_fallback_at || base.last_fallback_at,
    updated_at: overlay.updated_at || base.updated_at,
  };
}

// --- Model Resolution ---

/**
 * Parse a model binding string "provider_id:model_name" into components.
 * If no provider prefix, assumes 'anthropic'.
 */
export function parseModelBinding(binding: string): { providerId: string; modelName: string } {
  const colonIndex = binding.indexOf(':');
  if (colonIndex === -1) {
    return { providerId: 'ollama', modelName: binding };
  }
  return {
    providerId: binding.slice(0, colonIndex),
    modelName: binding.slice(colonIndex + 1),
  };
}

/**
 * Get the resolved model for a role, considering provider bindings.
 * Returns { providerId, modelName, fullName, provider } with fallback chain.
 */
export function getResolvedModelForRole(
  role: AgentRole,
  cwd?: string,
): { providerId: string; modelName: string; fullName: string; provider: ModelProvider | null } {
  const config = loadModelProviderConfig(cwd);
  const binding = config.model_bindings[role];

  if (binding) {
    const { providerId, modelName } = parseModelBinding(binding);
    const provider = config.providers[providerId] || null;
    return { providerId, modelName, fullName: `${providerId}:${modelName}`, provider };
  }

  // Fallback: use the first provider in the fallback chain
  for (const providerId of config.fallback_chain) {
    const provider = config.providers[providerId];
    if (provider && provider.installed) {
      return { providerId, modelName: 'default', fullName: `${providerId}:default`, provider };
    }
  }

  // Last resort: ollama primary
  return { providerId: 'ollama', modelName: 'glm-5.1', fullName: 'ollama:glm-5.1', provider: null };
}

/**
 * Build a model instruction string for imperative prompts.
 * Includes provider information and API routing hints for Claude Code.
 */
export function buildProviderAwareModelInstruction(role: string, cwd?: string): string {
  try {
    const resolved = getResolvedModelForRole(role as AgentRole, cwd);
    const { providerId, modelName, provider } = resolved;

    let instruction = `\nIMPORTANT: When spawning this agent, set model to: ${modelName}\n`;

    // Add provider-specific context for routing
    if (provider && providerId !== 'anthropic') {
      instruction += `MODEL PROVIDER: ${provider.name} (${providerId})\n`;
      instruction += `API ENDPOINT: ${provider.base_url}\n`;

      if (provider.type === 'ollama') {
        instruction += `NOTE: This model uses Ollama's Anthropic-compatible API at ${provider.base_url}\n`;
        instruction += `Set ANTHROPIC_BASE_URL=${provider.base_url} and ANTHROPIC_AUTH_TOKEN=ollama when using this model.\n`;
      }
    }

    return instruction;
  } catch {
    return '';
  }
}

// --- CRUD for Providers ---

export function registerModelProvider(provider: ModelProvider): void {
  const config = loadModelProviderConfig();
  config.providers[provider.id] = {
    ...config.providers[provider.id],
    ...provider,
    updated_at: new Date().toISOString(),
  };
  saveModelProviderConfig(config);
}

export function removeModelProvider(id: string): boolean {
  const config = loadModelProviderConfig();
  if (!config.providers[id]) return false;

  delete config.providers[id];

  // Remove from fallback chain
  config.fallback_chain = config.fallback_chain.filter(p => p !== id);

  // Remove bindings that reference this provider
  for (const [role, binding] of Object.entries(config.model_bindings)) {
    if (binding && binding.startsWith(`${id}:`)) {
      delete config.model_bindings[role];
    }
  }

  saveModelProviderConfig(config);
  return true;
}

export function listModelProviders(cwd?: string): ModelProvider[] {
  const config = loadModelProviderConfig(cwd);
  return Object.values(config.providers);
}

export function listInstalledModelProviders(cwd?: string): ModelProvider[] {
  return listModelProviders(cwd).filter(p => p.installed);
}

// --- CRUD for Role Bindings ---

export function setRoleModelBinding(role: AgentRole, binding: string): void {
  const config = loadModelProviderConfig();
  config.model_bindings[role] = binding;
  saveModelProviderConfig(config);
}

export function getRoleModelBinding(role: AgentRole, cwd?: string): string | undefined {
  const config = loadModelProviderConfig(cwd);
  return config.model_bindings[role];
}

// --- Fallback Chain ---

export function setFallbackChain(chain: string[]): void {
  const config = loadModelProviderConfig();
  config.fallback_chain = chain;
  saveModelProviderConfig(config);
}

/**
 * Get the API key for a provider, considering fallback keys.
 * Returns the primary key, falling back to the fallback key if the
 * primary is over quota (tracked via env var OML_PROVIDER_OVERQUOTA).
 */
export function getApiKeyForProvider(providerId: string, cwd?: string): string | null {
  const config = loadModelProviderConfig(cwd);
  const provider = config.providers[providerId];
  if (!provider) return null;

  // Check if primary key is over quota
  const overquotaProviders = (process.env.OML_PROVIDER_OVERQUOTA || '').split(',').filter(Boolean);
  if (overquotaProviders.includes(providerId) && provider.fallback_api_key) {
    return provider.fallback_api_key;
  }

  // Try env var first, then stored key
  if (provider.api_key_env && process.env[provider.api_key_env]) {
    return process.env[provider.api_key_env]!;
  }
  if (provider.api_key) {
    return provider.api_key;
  }
  return null;
}

// --- Auto-Detection ---

/**
 * Check if Ollama is available by testing the API endpoint.
 * Tries HTTP GET to {base_url}/api/tags (local) or Anthropic-compatible endpoint (cloud).
 */
export function detectOllamaProvider(provider: ModelProvider): boolean {
  try {
    // For cloud Ollama (https://ollama.com/v1), check if ANTHROPIC_API_KEY is set
    // The cloud endpoint requires authentication
    if (provider.base_url.includes('ollama.com')) {
      return !!(process.env.ANTHROPIC_API_KEY || provider.api_key);
    }
    // For local Ollama, try to reach the API
    // (Cannot use fetch in Node without async; mark installed if URL reachable pattern matches)
    return provider.base_url.includes('localhost') || provider.base_url.includes('127.0.0.1');
  } catch {
    return false;
  }
}

/**
 * Auto-sync: check all providers and update installed status.
 * Returns list of providers whose status changed.
 */
export function autoSyncModelProviders(): string[] {
  const config = loadModelProviderConfig();
  const synced: string[] = [];

  for (const [id, provider] of Object.entries(config.providers)) {
    if (!provider) continue;
    const wasInstalled = provider.installed;

    if (provider.type === 'ollama') {
      provider.installed = detectOllamaProvider(provider);
    }

    if (provider.installed !== wasInstalled) {
      provider.updated_at = new Date().toISOString();
      synced.push(id);
    }
  }

  // Also detect from Claude Code settings.json env vars
  try {
    const homedir = require('os').homedir();
    const settingsPath = normalizePath(path.join(homedir, '.claude', 'settings.json'));
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      const env = settings.env || {};
      // If ANTHROPIC_BASE_URL is set to a non-Anthropic endpoint, Ollama is configured
      if (env.ANTHROPIC_BASE_URL && !env.ANTHROPIC_BASE_URL.includes('anthropic.com')) {
        const ollamaProvider = config.providers['ollama'];
        if (ollamaProvider && !ollamaProvider.installed) {
          ollamaProvider.installed = true;
          ollamaProvider.updated_at = new Date().toISOString();
          synced.push('ollama');
        }
      }
    }
  } catch { /* best effort */ }

  if (synced.length > 0) {
    saveModelProviderConfig(config);
  }
  return synced;
}

// ============================================================
// Auto-Fallback: Switch provider + update settings.json when
// primary provider's API key is exhausted or returns auth errors.
//
// When triggered, this:
//   1. Walks the fallback_chain to find the next installed provider
//   2. Updates model-provider.json → active_provider_id
//   3. Updates ~/.claude/settings.json env vars:
//      - ANTHROPIC_BASE_URL  → new provider's base_url
//      - ANTHROPIC_API_KEY   → new provider's key
//      - ANTHROPIC_AUTH_TOKEN → "ollama" or provider-specific value
//      - Model name env vars (ANTHROPIC_DEFAULT_OPUS_MODEL, etc.)
//   4. Returns info about the switch for logging/display
// ============================================================

/** Claude Code settings.json path */
function getClaudeSettingsPath(): string {
  const homedir = require('os').homedir();
  return normalizePath(path.join(homedir, '.claude', 'settings.json'));
}

/** Read Claude Code settings.json */
function readClaudeSettings(): Record<string, unknown> | null {
  try {
    const settingsPath = getClaudeSettingsPath();
    if (fs.existsSync(settingsPath)) {
      return JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
    }
  } catch { /* best effort */ }
  return null;
}

/** Write Claude Code settings.json atomically */
function writeClaudeSettings(settings: Record<string, unknown>): boolean {
  try {
    const settingsPath = getClaudeSettingsPath();
    ensureDir(path.dirname(settingsPath));
    const tmpPath = settingsPath + '.tmp.' + process.pid;
    fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
    fs.renameSync(tmpPath, settingsPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Model name mappings for fallback: since both providers are Ollama Cloud,
 * model names stay the same — no re-mapping needed across fallback.
 * Only kept for edge cases where someone adds a non-Ollama provider.
 */
const FALLBACK_MODEL_MAP: Record<string, Record<string, string>> = {
  ollama_to_ollama: {
    // Same provider type — models stay the same (identity mapping)
  },
  ollama_to_anthropic: {
    'glm-5.1': 'claude-opus-4-6',
    'kimi-k2.5': 'claude-opus-4-6',
    'qwen3-coder:480b': 'claude-sonnet-4-6',
    'qwen3.5:397b': 'claude-sonnet-4-6',
    'nemotron-3-super': 'claude-haiku-4-5-20251001',
    'minimax-m2.7': 'claude-sonnet-4-6',
    'deepseek-v3.2': 'claude-opus-4-6',
  },
  anthropic_to_ollama: {
    'claude-opus-4-6': 'glm-5.1',
    'claude-sonnet-4-6': 'qwen3-coder:480b',
    'claude-haiku-4-5-20251001': 'nemotron-3-super',
  },
};

/**
 * Map a model name from one provider to its equivalent on another provider.
 */
export function mapModelName(model: string, fromProviderType: string, toProviderType: string): string {
  const mapKey = `${fromProviderType}_to_${toProviderType}`;
  const map = FALLBACK_MODEL_MAP[mapKey];
  if (map && map[model]) return map[model];
  return model;
}

/**
 * Get the current active provider ID from config.
 */
export function getActiveProviderId(cwd?: string): string {
  const config = loadModelProviderConfig(cwd);
  return config.active_provider_id || config.fallback_chain[0] || 'ollama';
}

/**
 * Execute an automatic fallback to the next provider in the chain.
 * Updates both model-provider.json AND settings.json.
 *
 * @param reason - Why the fallback is happening (e.g., '401_unauthorized', 'quota_exceeded')
 * @returns Object with fallback details, or null if no fallback available
 */
export function executeProviderFallback(reason: string, cwd?: string): {
  fromProvider: string;
  toProvider: string;
  toProviderConfig: ModelProvider;
  reason: string;
} | null {
  const config = loadModelProviderConfig(cwd);
  const currentProviderId = config.active_provider_id || config.fallback_chain[0];
  const currentIdx = config.fallback_chain.indexOf(currentProviderId);

  // Find next provider in chain
  let nextProviderId: string | null = null;
  let nextProvider: ModelProvider | null = null;

  for (let i = currentIdx + 1; i < config.fallback_chain.length; i++) {
    const candidateId = config.fallback_chain[i];
    const candidate = config.providers[candidateId];
    if (candidate && candidate.installed) {
      nextProviderId = candidateId;
      nextProvider = candidate;
      break;
    }
  }

  if (!nextProviderId || !nextProvider) return null;

  // 1. Update model-provider.json
  config.active_provider_id = nextProviderId;
  config.last_fallback_at = new Date().toISOString();
  saveModelProviderConfig(config);

  // 2. Get the API key for the new provider
  const newApiKey = getApiKeyForProvider(nextProviderId, cwd);
  if (!newApiKey) return null;

  // 3. Update Claude Code settings.json
  const settings = readClaudeSettings();
  if (settings) {
    const env = (settings.env || {}) as Record<string, string>;

    env['ANTHROPIC_BASE_URL'] = nextProvider.base_url;

    // Provider-specific auth token
    if (nextProvider.type === 'ollama') {
      env['ANTHROPIC_AUTH_TOKEN'] = 'ollama';
    } else {
      env['ANTHROPIC_AUTH_TOKEN'] = newApiKey;
    }

    env['ANTHROPIC_API_KEY'] = newApiKey;
    env['OML_PRIMARY_PROVIDER'] = nextProviderId;

    // Map model names to the new provider's models
    const currentOpus = env['ANTHROPIC_DEFAULT_OPUS_MODEL'] || 'glm-5.1';
    const currentSonnet = env['ANTHROPIC_DEFAULT_SONNET_MODEL'] || 'qwen3-coder:480b';
    const currentHaiku = env['ANTHROPIC_DEFAULT_HAIKU_MODEL'] || 'nemotron-3-super';
    const currentSubagent = env['CLAUDE_CODE_SUBAGENT_MODEL'] || 'qwen3-coder:480b';

    const fromType = config.providers[currentProviderId]?.type || 'ollama';
    env['ANTHROPIC_DEFAULT_OPUS_MODEL'] = mapModelName(currentOpus, fromType, nextProvider.type);
    env['ANTHROPIC_DEFAULT_SONNET_MODEL'] = mapModelName(currentSonnet, fromType, nextProvider.type);
    env['ANTHROPIC_DEFAULT_HAIKU_MODEL'] = mapModelName(currentHaiku, fromType, nextProvider.type);
    env['CLAUDE_CODE_SUBAGENT_MODEL'] = mapModelName(currentSubagent, fromType, nextProvider.type);

    settings.env = env;

    // Update model field if present
    if (settings.model && typeof settings.model === 'string') {
      settings.model = mapModelName(settings.model as string, fromType, nextProvider.type);
    }

    writeClaudeSettings(settings);
  }

  return {
    fromProvider: currentProviderId,
    toProvider: nextProviderId,
    toProviderConfig: nextProvider,
    reason,
  };
}

/**
 * Restore the primary provider (e.g., after user refreshes their API key).
 * Resets active_provider_id back to the first in the chain.
 */
export function restorePrimaryProvider(cwd?: string): boolean {
  const config = loadModelProviderConfig(cwd);
  const primaryId = config.fallback_chain[0];
  if (!primaryId || config.active_provider_id === primaryId) return false;

  const primaryProvider = config.providers[primaryId];
  if (!primaryProvider || !primaryProvider.installed) return false;

  // Capture the CURRENT (fallback) provider type BEFORE updating
  const previousProviderId = config.active_provider_id || '';
  const previousProvider = previousProviderId ? config.providers[previousProviderId] : null;
  const fromType = previousProvider?.type || 'anthropic';

  config.active_provider_id = primaryId;
  config.last_fallback_at = new Date().toISOString();
  saveModelProviderConfig(config);

  // Update settings.json back to primary
  const settings = readClaudeSettings();
  if (settings) {
    const env = (settings.env || {}) as Record<string, string>;
    const apiKey = getApiKeyForProvider(primaryId, cwd);
    if (apiKey) {
      env['ANTHROPIC_BASE_URL'] = primaryProvider.base_url;
      env['ANTHROPIC_AUTH_TOKEN'] = 'ollama';
      env['ANTHROPIC_API_KEY'] = apiKey;
      env['OML_PRIMARY_PROVIDER'] = primaryId;

      // Map models back from fallback provider type to primary provider type
      const currentOpus = env['ANTHROPIC_DEFAULT_OPUS_MODEL'] || 'glm-5.1';
      const currentSonnet = env['ANTHROPIC_DEFAULT_SONNET_MODEL'] || 'qwen3-coder:480b';
      const currentHaiku = env['ANTHROPIC_DEFAULT_HAIKU_MODEL'] || 'nemotron-3-super';
      const currentSubagent = env['CLAUDE_CODE_SUBAGENT_MODEL'] || 'qwen3-coder:480b';

      env['ANTHROPIC_DEFAULT_OPUS_MODEL'] = mapModelName(currentOpus, fromType, primaryProvider.type);
      env['ANTHROPIC_DEFAULT_SONNET_MODEL'] = mapModelName(currentSonnet, fromType, primaryProvider.type);
      env['ANTHROPIC_DEFAULT_HAIKU_MODEL'] = mapModelName(currentHaiku, fromType, primaryProvider.type);
      env['CLAUDE_CODE_SUBAGENT_MODEL'] = mapModelName(currentSubagent, fromType, primaryProvider.type);

      settings.env = env;
      if (settings.model && typeof settings.model === 'string') {
        settings.model = mapModelName(settings.model as string, fromType, primaryProvider.type);
      }

      writeClaudeSettings(settings);
    }
  }

  return true;
}

/**
 * Check if we're currently running on a fallback provider.
 */
export function isOnFallbackProvider(cwd?: string): boolean {
  const config = loadModelProviderConfig(cwd);
  const active = config.active_provider_id || config.fallback_chain[0];
  return active !== config.fallback_chain[0];
}

// --- Build Model Config Section ---

/**
 * Build a human-readable section showing current model provider configuration.
 * Used by keyword-detector to inject into imperative prompts.
 */
export function buildModelProviderConfigSection(cwd?: string): string {
  try {
    const config = loadModelProviderConfig(cwd);
    const lines: string[] = [];

    // Show installed providers
    const installed = Object.values(config.providers).filter(p => p.installed);
    if (installed.length > 0) {
      lines.push('## Model Providers');
      for (const p of installed) {
        lines.push(`  - ${p.name} (${p.id}): ${p.base_url} [${p.type}]`);
      }
    }

    // Show non-default bindings
    const defaults = buildDefaultConfig();
    const customBindings: string[] = [];
    for (const [role, binding] of Object.entries(config.model_bindings)) {
      if (binding && binding !== defaults.model_bindings[role as AgentRole]) {
        const { providerId, modelName } = parseModelBinding(binding);
        customBindings.push(`  - ${role}: ${modelName} via ${providerId}`);
      }
    }
    if (customBindings.length > 0) {
      lines.push('');
      lines.push('## Custom Model Bindings');
      lines.push(...customBindings);
    }

    // Show fallback chain
    if (config.fallback_chain.length > 0) {
      lines.push('');
      lines.push(`## Fallback Chain: ${config.fallback_chain.join(' → ')}`);
    }

    // Show active provider
    const activeId = config.active_provider_id || config.fallback_chain[0];
    if (activeId) {
      lines.push(`## Active Provider: ${activeId}${isOnFallbackProvider() ? ' (FALLBACK)' : ''}`);
    }

    return lines.length > 0 ? '\n\n' + lines.join('\n') + '\n' : '';
  } catch {
    return '';
  }
}