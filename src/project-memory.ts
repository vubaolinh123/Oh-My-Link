import * as fs from 'fs';
import * as path from 'path';
import { ProjectMemory, HotPath, UserDirective } from './types';
import { getProjectMemoryPath, ensureDir, normalizePath } from './state';
import { readJson, writeJsonAtomic, logError } from './helpers';

// Max sizes for bounded collections
const MAX_HOT_PATHS = 50;
const MAX_NOTES = 20;
const MAX_DIRECTIVES = 20;
const RESCAN_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h

// Tech stack detection patterns
const TECH_DETECTORS: Array<{
  file: string;
  detect: (content: string) => Record<string, string>;
}> = [
  {
    file: 'package.json',
    detect: (content) => {
      const pkg = JSON.parse(content);
      const stack: Record<string, string> = { runtime: 'node' };
      if (pkg.dependencies?.typescript || pkg.devDependencies?.typescript) stack.language = 'typescript';
      if (pkg.dependencies?.react) stack.framework = 'react';
      if (pkg.dependencies?.next) stack.framework = 'next.js';
      if (pkg.dependencies?.vue) stack.framework = 'vue';
      if (pkg.dependencies?.express) stack.server = 'express';
      if (pkg.dependencies?.fastify) stack.server = 'fastify';
      if (pkg.dependencies?.['@nestjs/core']) stack.server = 'nestjs';
      if (pkg.dependencies?.koa) stack.server = 'koa';
      if (pkg.dependencies?.svelte || pkg.dependencies?.['@sveltejs/kit']) stack.framework = 'svelte';
      if (pkg.dependencies?.['@angular/core']) stack.framework = 'angular';
      if (pkg.dependencies?.tailwindcss || pkg.devDependencies?.tailwindcss) stack.css = 'tailwind';
      if (pkg.dependencies?.prisma || pkg.devDependencies?.prisma) stack.orm = 'prisma';
      if (pkg.dependencies?.['drizzle-orm'] || pkg.devDependencies?.['drizzle-orm']) stack.orm = 'drizzle';
      // Build commands detection
      if (pkg.scripts) {
        if (pkg.scripts.test) stack.cmd_test = pkg.scripts.test.split('&&')[0].trim();
        if (pkg.scripts.build) stack.cmd_build = pkg.scripts.build.split('&&')[0].trim();
        if (pkg.scripts.lint) stack.cmd_lint = pkg.scripts.lint.split('&&')[0].trim();
        if (pkg.scripts.dev) stack.cmd_dev = pkg.scripts.dev.split('&&')[0].trim();
      }
      return stack;
    },
  },
  { file: 'Cargo.toml', detect: () => ({ runtime: 'rust', language: 'rust' }) },
  { file: 'go.mod', detect: () => ({ runtime: 'go', language: 'go' }) },
  { file: 'requirements.txt', detect: () => ({ runtime: 'python', language: 'python' }) },
  { file: 'pyproject.toml', detect: () => ({ runtime: 'python', language: 'python' }) },
  { file: 'Gemfile', detect: () => ({ runtime: 'ruby', language: 'ruby' }) },
  { file: 'composer.json', detect: () => ({ runtime: 'php', language: 'php' }) },
];

/** Detect project tech stack from config files in cwd */
export function detectProjectEnv(cwd: string): Record<string, string> {
  const stack: Record<string, string> = {};
  for (const detector of TECH_DETECTORS) {
    const filePath = normalizePath(path.join(cwd, detector.file));
    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        Object.assign(stack, detector.detect(content));
      } catch { /* ignore */ }
    }
  }

  // Package manager detection (needs cwd for lock file paths)
  if (stack.runtime === 'node' && !stack.pkg) {
    if (fs.existsSync(path.join(cwd, 'pnpm-lock.yaml'))) stack.pkg = 'pnpm';
    else if (fs.existsSync(path.join(cwd, 'yarn.lock'))) stack.pkg = 'yarn';
    else if (fs.existsSync(path.join(cwd, 'bun.lockb')) || fs.existsSync(path.join(cwd, 'bun.lock'))) stack.pkg = 'bun';
    else stack.pkg = 'npm';
  }

  return stack;
}

/** Load project memory from state dir */
export function loadMemory(cwd: string): ProjectMemory {
  const existing = readJson<ProjectMemory>(getProjectMemoryPath(cwd));
  if (existing) return existing;
  return {
    tech_stack: {},
    hot_paths: [],
    user_directives: [],
    notes: [],
    last_scanned_at: '',
  };
}

/** Save project memory */
export function saveMemory(cwd: string, memory: ProjectMemory): void {
  ensureDir(path.dirname(getProjectMemoryPath(cwd)));
  writeJsonAtomic(getProjectMemoryPath(cwd), memory);
}

/** Rescan tech stack while preserving user data (hot_paths, directives, notes) */
export function rescan(cwd: string, memory: ProjectMemory): void {
  const freshStack = detectProjectEnv(cwd);
  memory.tech_stack = freshStack;
  memory.last_scanned_at = new Date().toISOString();
  saveMemory(cwd, memory);
}

/** Check if memory needs a tech stack rescan */
export function needsRescan(memory: ProjectMemory): boolean {
  if (!memory.last_scanned_at) return true;
  const ts = new Date(memory.last_scanned_at).getTime();
  if (isNaN(ts)) return true; // Corrupt timestamp → force rescan
  return Date.now() - ts > RESCAN_INTERVAL_MS;
}

/** Format memory as a brief summary for context injection (budget ~650 chars) */
export function formatSummary(memory: ProjectMemory, budget: number = 650): string {
  const parts: string[] = [];

  // Tech stack
  if (Object.keys(memory.tech_stack).length > 0) {
    const stack = Object.entries(memory.tech_stack).map(([k, v]) => `${k}:${v}`).join(' ');
    parts.push(`Stack: ${stack}`);
  }

  // Top hot paths (limit 5)
  if (memory.hot_paths.length > 0) {
    const top = memory.hot_paths.slice(0, 5).map(h => h.path).join(', ');
    parts.push(`Hot: ${top}`);
  }

  // Active directives
  const highPri = memory.user_directives.filter(d => d.priority === 'high');
  if (highPri.length > 0) {
    parts.push(`Directives: ${highPri.map(d => d.directive).join('; ')}`);
  }

  if (highPri.length === 0 && memory.user_directives.length > 0) {
    const normalDirs = memory.user_directives.slice(0, 3).map(d => d.directive).join('; ');
    parts.push(`Directives: ${normalDirs}`);
  }

  let result = parts.join(' | ');
  if (result.length > budget) result = result.slice(0, budget - 3) + '...';
  return result;
}

/** Record a file access in hot paths */
export function recordHotPath(memory: ProjectMemory, filePath: string): void {
  const existing = memory.hot_paths.find(h => h.path === filePath);
  if (existing) {
    existing.access_count++;
  } else {
    memory.hot_paths.push({ path: filePath, access_count: 1 });
  }
  // Sort by access count, trim to max
  memory.hot_paths.sort((a, b) => b.access_count - a.access_count);
  if (memory.hot_paths.length > MAX_HOT_PATHS) {
    memory.hot_paths = memory.hot_paths.slice(0, MAX_HOT_PATHS);
  }
}

/** Add a user directive */
export function addDirective(memory: ProjectMemory, directive: string, priority: 'high' | 'normal' | 'low' = 'normal'): void {
  // Dedup
  if (memory.user_directives.some(d => d.directive === directive)) return;
  memory.user_directives.push({
    directive,
    priority,
    added_at: new Date().toISOString(),
  });
  if (memory.user_directives.length > MAX_DIRECTIVES) {
    memory.user_directives = memory.user_directives.slice(-MAX_DIRECTIVES);
  }
}

/** Add a note */
export function addNote(memory: ProjectMemory, note: string): void {
  if (memory.notes.includes(note)) return;
  memory.notes.push(note);
  if (memory.notes.length > MAX_NOTES) {
    memory.notes = memory.notes.slice(-MAX_NOTES);
  }
}
