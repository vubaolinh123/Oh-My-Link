import * as fs from 'fs';
import * as path from 'path';
import { AgentRole, OmlConfig } from './types';
import { getConfigPath, normalizePath } from './state';
import { readJson } from './helpers';
import { getResolvedModelForRole, parseModelBinding, loadModelProviderConfig } from './model-provider';

// ============================================================
// Oh-My-Link — Configuration System
// ============================================================

/** Default model assignments per agent role (Anthropic-direct fallback).
 *
 * Tiers mirror the Ollama model_bindings in ~/.oh-my-link/model-provider.json:
 * - Strongest reasoning (planning/analysis): Opus 4.7
 * - Balanced (review/verification, fast code execution): Sonnet 4.6
 * - Lightweight (quick lookups, scouting): Haiku 4.5
 */
export const DEFAULT_MODELS: Record<AgentRole, string> = {
  master: 'claude-opus-4-7',
  scout: 'claude-opus-4-7',
  architect: 'claude-opus-4-7',
  'code-reviewer': 'claude-opus-4-7',
  reviewer: 'claude-sonnet-4-6',
  verifier: 'claude-sonnet-4-6',
  'security-reviewer': 'claude-sonnet-4-6',
  worker: 'claude-sonnet-4-6',
  executor: 'claude-sonnet-4-6',
  'test-engineer': 'claude-sonnet-4-6',
  'fast-scout': 'claude-haiku-4-5-20251001',
  explorer: 'claude-haiku-4-5-20251001',
};

/** Default config values */
const DEFAULT_CONFIG: OmlConfig = {
  models: {},
  quiet_level: 0,
  always_on: false,
  debug_mode: false,
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
    always_on: projectConfig?.always_on ?? globalConfig?.always_on ?? DEFAULT_CONFIG.always_on,
    debug_mode: projectConfig?.debug_mode ?? globalConfig?.debug_mode ?? DEFAULT_CONFIG.debug_mode,
  };

  return merged;
}

/**
 * Get the configured model for a given agent role.
 * Resolution priority:
 *   1. Model provider bindings (provider:model format) — highest priority
 *   2. OmlConfig.models overrides (legacy format)
 *   3. DEFAULT_MODELS fallback
 */
export function getModelForRole(role: AgentRole, cwd?: string): string {
  // Try model-provider system first (supports provider-aware routing)
  try {
    const providerConfig = loadModelProviderConfig(cwd);
    const binding = providerConfig.model_bindings[role];
    if (binding) {
      const { modelName } = parseModelBinding(binding);
      return modelName;
    }
  } catch { /* model-provider not available, fall through to legacy */ }

  // Legacy resolution: OmlConfig.models > DEFAULT_MODELS
  const config = loadConfig(cwd);
  return config.models[role] || DEFAULT_MODELS[role] || DEFAULT_MODELS.worker;
}

/**
 * Save a single field to the global config (~/.oh-my-link/config.json).
 * Reads existing config, merges the field, writes back.
 */
export function saveConfigField(field: string, value: unknown): void {
  const configPath = getConfigPath();
  const existing = readJson<Record<string, unknown>>(configPath) || {};
  existing[field] = value;
  
  // Ensure parent dir exists
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(configPath, JSON.stringify(existing, null, 2), 'utf-8');
}

/**
 * Check if always-on mode is enabled (global or project-level).
 */
export function isAlwaysOn(cwd?: string): boolean {
  return loadConfig(cwd).always_on;
}

/**
 * Check if debug mode is enabled (global or project-level).
 */
export function isDebugMode(cwd?: string): boolean {
  return loadConfig(cwd).debug_mode;
}
