import { AgentRole, OmlConfig } from './types';
import { getConfigPath } from './state';
import { readJson } from './helpers';

// ============================================================
// Oh-My-Link — Configuration System
// ============================================================

/** Default model assignments per agent role */
export const DEFAULT_MODELS: Record<AgentRole, string> = {
  master: 'claude-opus-4-6',
  scout: 'claude-opus-4-6',
  architect: 'claude-opus-4-6',
  worker: 'claude-sonnet-4-6',
  reviewer: 'claude-sonnet-4-6',
  'fast-scout': 'claude-sonnet-4-6',
  executor: 'claude-sonnet-4-6',
  explorer: 'claude-haiku-4-5-20251001',
  verifier: 'claude-sonnet-4-6',
  'code-reviewer': 'claude-opus-4-6',
  'security-reviewer': 'claude-sonnet-4-6',
  'test-engineer': 'claude-sonnet-4-6',
};

/** Default config values */
const DEFAULT_CONFIG: OmlConfig = {
  models: {},
  quiet_level: 0,
};

/**
 * Load user config from ~/.oh-my-link/config.json.
 * Merges with defaults — user values override.
 */
export function loadConfig(): OmlConfig {
  const userConfig = readJson<Partial<OmlConfig>>(getConfigPath());
  if (!userConfig) return { ...DEFAULT_CONFIG };

  return {
    models: { ...DEFAULT_CONFIG.models, ...(userConfig.models || {}) },
    quiet_level: userConfig.quiet_level ?? DEFAULT_CONFIG.quiet_level,
  };
}

/**
 * Get the configured model for a given agent role.
 * User overrides take priority, then defaults.
 */
export function getModelForRole(role: AgentRole): string {
  const config = loadConfig();
  return config.models[role] || DEFAULT_MODELS[role] || DEFAULT_MODELS.worker;
}
