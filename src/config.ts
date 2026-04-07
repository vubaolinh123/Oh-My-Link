import * as path from 'path';
import { AgentRole, OmlConfig } from './types';
import { getConfigPath, normalizePath } from './state';
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
 * Load project-level config from {cwd}/.oh-my-link/config.json.
 * Returns partial config or null if not found.
 */
export function loadProjectConfig(cwd?: string): Partial<OmlConfig> | null {
  const projectCwd = cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const projectConfigPath = normalizePath(path.join(projectCwd, '.oh-my-link', 'config.json'));
  return readJson<Partial<OmlConfig>>(projectConfigPath) || null;
}

/**
 * Load merged config: global (~/.oh-my-link/config.json) + project ({cwd}/.oh-my-link/config.json).
 * Project-level values override global values.
 */
export function loadConfig(cwd?: string): OmlConfig {
  const globalConfig = readJson<Partial<OmlConfig>>(getConfigPath());
  const projectConfig = loadProjectConfig(cwd);

  const merged: OmlConfig = {
    models: {
      ...(DEFAULT_CONFIG.models),
      ...(globalConfig?.models || {}),
      ...(projectConfig?.models || {}),
    },
    quiet_level: projectConfig?.quiet_level ?? globalConfig?.quiet_level ?? DEFAULT_CONFIG.quiet_level,
  };

  return merged;
}

/**
 * Get the configured model for a given agent role.
 * Project overrides > global overrides > defaults.
 */
export function getModelForRole(role: AgentRole, cwd?: string): string {
  const config = loadConfig(cwd);
  return config.models[role] || DEFAULT_MODELS[role] || DEFAULT_MODELS.worker;
}
