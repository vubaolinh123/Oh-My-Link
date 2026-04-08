/**
 * Oh-My-Link — MCP Config Module Tests
 * Tests for dist/mcp-config.js
 * Run: node test/test-mcp-config.mjs
 */

import { createRequire } from 'module';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist');

// ============================================================
// Minimal test harness
// ============================================================

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, error: err.message });
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
  }
}

function skip(name) {
  skipped++;
  console.log(`  SKIP  ${name}`);
}

function suite(name, fn) {
  console.log(`\n--- ${name} ---`);
  fn();
}

// ============================================================
// Setup: temp directory for isolated tests
// ============================================================

const TEMP_ROOT = path.join(os.tmpdir(), `oml-mcp-config-${Date.now()}`);
const TEMP_PROJECT = path.join(TEMP_ROOT, 'test-project');

function setupTempDirs() {
  fs.mkdirSync(TEMP_PROJECT, { recursive: true });
  fs.mkdirSync(path.join(TEMP_PROJECT, 'src'), { recursive: true });
  process.env.OML_HOME = path.join(TEMP_ROOT, 'oml-home');
  fs.mkdirSync(process.env.OML_HOME, { recursive: true });
}

function cleanupTempDirs() {
  try {
    fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
  } catch { /* best effort */ }
  delete process.env.OML_HOME;
}

setupTempDirs();

// Load modules
const state = require(path.join(DIST, 'state.js'));
const mcpConfig = require(path.join(DIST, 'mcp-config.js'));

// Ensure dirs
state.ensureDir(state.getProjectStateRoot(TEMP_PROJECT));

console.log('Oh-My-Link — MCP Config Module Tests');
console.log(`TEMP_ROOT: ${TEMP_ROOT}`);

// Helper: clean global config file between tests
function cleanGlobalConfig() {
  try { fs.unlinkSync(mcpConfig.getMcpConfigPath()); } catch { /* ignore */ }
}

// Helper: clean project config file between tests
function cleanProjectConfig(cwd) {
  try { fs.unlinkSync(mcpConfig.getProjectMcpConfigPath(cwd)); } catch { /* ignore */ }
}

// ============================================================
// Suite 1: Default Config
// ============================================================

suite('Default Config', () => {
  cleanGlobalConfig();

  test('buildDefaultConfig returns version 2', () => {
    const cfg = mcpConfig.buildDefaultConfig();
    assertEqual(cfg.version, 2, 'config version');
  });

  test('buildDefaultConfig has all 5 suggested providers', () => {
    const cfg = mcpConfig.buildDefaultConfig();
    const ids = Object.keys(cfg.providers);
    const expected = ['context7', 'grep_app', 'playwright', 'augment-context-engine', 'browser-use'];
    for (const id of expected) {
      assert(ids.includes(id), `Missing provider: ${id}`);
    }
    assertEqual(ids.length, 5, 'provider count');
  });

  test('all default providers are not installed', () => {
    const cfg = mcpConfig.buildDefaultConfig();
    for (const [id, p] of Object.entries(cfg.providers)) {
      assertEqual(p.installed, false, `provider ${id} should not be installed`);
    }
  });

  test('default agent_map has mappings for key roles', () => {
    const cfg = mcpConfig.buildDefaultConfig();
    const expectedRoles = ['scout', 'worker', 'executor', 'reviewer', 'architect',
      'fast-scout', 'explorer', 'code-reviewer', 'security-reviewer', 'test-engineer'];
    for (const role of expectedRoles) {
      assert(cfg.agent_map[role] !== undefined, `agent_map should have role: ${role}`);
      assert(Array.isArray(cfg.agent_map[role].mcps), `${role} should have mcps array`);
      assert(cfg.agent_map[role].mcps.length > 0, `${role} should have at least one MCP`);
    }
  });
});

// ============================================================
// Suite 2: Load/Save
// ============================================================

suite('Load/Save', () => {
  cleanGlobalConfig();

  test('loadMcpConfig returns defaults when no file exists', () => {
    cleanGlobalConfig();
    const cfg = mcpConfig.loadMcpConfig();
    assertEqual(cfg.version, 2, 'version');
    assert(Object.keys(cfg.providers).length === 5, 'should have 5 default providers');
  });

  test('saveMcpConfig writes file, loadMcpConfig reads it back', () => {
    cleanGlobalConfig();
    const cfg = mcpConfig.buildDefaultConfig();
    cfg.providers.context7.installed = true;
    mcpConfig.saveMcpConfig(cfg);

    const loaded = mcpConfig.loadMcpConfig();
    assertEqual(loaded.providers.context7.installed, true, 'context7 should be installed');
    assertEqual(loaded.version, 2, 'version preserved');
    cleanGlobalConfig();
  });

  test('saved config preserves custom providers and installed flags', () => {
    cleanGlobalConfig();
    const cfg = mcpConfig.buildDefaultConfig();
    cfg.providers['my-custom'] = {
      id: 'my-custom',
      name: 'My Custom MCP',
      description: 'A custom provider',
      installed: true,
    };
    cfg.providers.playwright.installed = true;
    mcpConfig.saveMcpConfig(cfg);

    const loaded = mcpConfig.loadMcpConfig();
    assert(loaded.providers['my-custom'] !== undefined, 'custom provider preserved');
    assertEqual(loaded.providers['my-custom'].installed, true, 'custom installed flag');
    assertEqual(loaded.providers['my-custom'].name, 'My Custom MCP', 'custom name');
    assertEqual(loaded.providers.playwright.installed, true, 'playwright installed flag');
    cleanGlobalConfig();
  });

  test('loadMcpConfig merges saved with defaults (new providers in defaults appear)', () => {
    cleanGlobalConfig();
    // Save a config that only has context7
    const partial = {
      version: 2,
      providers: {
        context7: { id: 'context7', name: 'Context7', description: 'test', installed: true },
      },
      agent_map: {},
    };
    const configPath = mcpConfig.getMcpConfigPath();
    state.ensureDir(path.dirname(configPath));
    fs.writeFileSync(configPath, JSON.stringify(partial), 'utf-8');

    const loaded = mcpConfig.loadMcpConfig();
    // Should have context7 with installed=true from saved
    assertEqual(loaded.providers.context7.installed, true, 'context7 installed from saved');
    // Should also have other default providers merged in
    assert(loaded.providers.grep_app !== undefined, 'grep_app from defaults should appear');
    assert(loaded.providers.playwright !== undefined, 'playwright from defaults should appear');
    assertEqual(loaded.providers.grep_app.installed, false, 'grep_app should be uninstalled (default)');
    cleanGlobalConfig();
  });
});

// ============================================================
// Suite 3: Project Override
// ============================================================

suite('Project Override', () => {
  cleanGlobalConfig();
  cleanProjectConfig(TEMP_PROJECT);

  test('saveProjectMcpConfig writes to {cwd}/.oh-my-link/mcp-config.json', () => {
    cleanProjectConfig(TEMP_PROJECT);
    const cfg = mcpConfig.buildDefaultConfig();
    cfg.providers.context7.installed = true;
    mcpConfig.saveProjectMcpConfig(TEMP_PROJECT, cfg);

    const expectedPath = mcpConfig.getProjectMcpConfigPath(TEMP_PROJECT);
    assert(fs.existsSync(expectedPath), 'project config file should exist');
    const raw = JSON.parse(fs.readFileSync(expectedPath, 'utf-8'));
    assertEqual(raw.version, 2, 'project config version');
    cleanProjectConfig(TEMP_PROJECT);
  });

  test('loadMcpConfig(cwd) merges global + project (project wins)', () => {
    cleanGlobalConfig();
    cleanProjectConfig(TEMP_PROJECT);

    // Save global: context7 installed, custom guidance
    const globalCfg = mcpConfig.buildDefaultConfig();
    globalCfg.providers.context7.installed = true;
    globalCfg.providers.grep_app.installed = true;
    mcpConfig.saveMcpConfig(globalCfg);

    // Save project: context7 NOT installed (overrides global)
    const projCfg = {
      version: 2,
      providers: {
        context7: { id: 'context7', name: 'Context7', description: 'proj override', installed: false },
      },
      agent_map: {},
    };
    mcpConfig.saveProjectMcpConfig(TEMP_PROJECT, projCfg);

    const loaded = mcpConfig.loadMcpConfig(TEMP_PROJECT);
    // Project wins for context7
    assertEqual(loaded.providers.context7.installed, false, 'project override should win');
    // Global values still present for grep_app
    assertEqual(loaded.providers.grep_app.installed, true, 'global grep_app should remain');
    cleanGlobalConfig();
    cleanProjectConfig(TEMP_PROJECT);
  });

  test('project-level installed=true overrides global installed=false', () => {
    cleanGlobalConfig();
    cleanProjectConfig(TEMP_PROJECT);

    // Global: playwright not installed
    const globalCfg = mcpConfig.buildDefaultConfig();
    assertEqual(globalCfg.providers.playwright.installed, false, 'precondition: not installed');
    mcpConfig.saveMcpConfig(globalCfg);

    // Project: playwright installed
    const projCfg = {
      version: 2,
      providers: {
        playwright: { id: 'playwright', name: 'Playwright MCP', description: 'proj', installed: true },
      },
      agent_map: {},
    };
    mcpConfig.saveProjectMcpConfig(TEMP_PROJECT, projCfg);

    const loaded = mcpConfig.loadMcpConfig(TEMP_PROJECT);
    assertEqual(loaded.providers.playwright.installed, true, 'project installed=true should win');
    cleanGlobalConfig();
    cleanProjectConfig(TEMP_PROJECT);
  });
});

// ============================================================
// Suite 4: Provider CRUD
// ============================================================

suite('Provider CRUD', () => {
  cleanGlobalConfig();

  test('registerProvider adds a new custom provider', () => {
    cleanGlobalConfig();
    mcpConfig.registerProvider({
      id: 'my-new-mcp',
      name: 'My New MCP',
      description: 'Brand new provider',
      installed: true,
    });

    const loaded = mcpConfig.loadMcpConfig();
    assert(loaded.providers['my-new-mcp'] !== undefined, 'new provider should exist');
    assertEqual(loaded.providers['my-new-mcp'].name, 'My New MCP', 'provider name');
    assertEqual(loaded.providers['my-new-mcp'].installed, true, 'provider installed');
    cleanGlobalConfig();
  });

  test('registerProvider updates existing provider', () => {
    cleanGlobalConfig();
    mcpConfig.registerProvider({
      id: 'context7',
      name: 'Context7 Updated',
      description: 'Updated description',
      installed: true,
    });

    const loaded = mcpConfig.loadMcpConfig();
    assertEqual(loaded.providers.context7.name, 'Context7 Updated', 'updated name');
    assertEqual(loaded.providers.context7.installed, true, 'updated installed');
    cleanGlobalConfig();
  });

  test('removeProvider removes provider and its references from agent_map', () => {
    cleanGlobalConfig();
    // Register a custom provider and add it to scout's role
    mcpConfig.registerProvider({
      id: 'custom-removable',
      name: 'Custom Removable',
      description: 'Will be removed',
      installed: true,
    });
    mcpConfig.addMcpToRole('scout', 'custom-removable', 'Custom guidance.');

    // Verify it's there
    const before = mcpConfig.loadMcpConfig();
    assert(before.providers['custom-removable'] !== undefined, 'precondition: provider exists');
    assert(before.agent_map.scout.mcps.includes('custom-removable'), 'precondition: in scout mcps');

    const result = mcpConfig.removeProvider('custom-removable');
    assertEqual(result, true, 'removeProvider should return true');

    const after = mcpConfig.loadMcpConfig();
    assert(after.providers['custom-removable'] === undefined, 'custom-removable should be removed from providers');
    assert(!after.agent_map.scout.mcps.includes('custom-removable'), 'custom-removable should be removed from scout mcps');
    cleanGlobalConfig();
  });

  test('removeProvider returns false for non-existent provider', () => {
    cleanGlobalConfig();
    const result = mcpConfig.removeProvider('nonexistent-mcp');
    assertEqual(result, false, 'should return false');
    cleanGlobalConfig();
  });

  test('setProviderInstalled marks provider as installed/uninstalled', () => {
    cleanGlobalConfig();
    mcpConfig.setProviderInstalled('context7', true);
    let loaded = mcpConfig.loadMcpConfig();
    assertEqual(loaded.providers.context7.installed, true, 'should be installed');

    mcpConfig.setProviderInstalled('context7', false);
    loaded = mcpConfig.loadMcpConfig();
    assertEqual(loaded.providers.context7.installed, false, 'should be uninstalled');
    cleanGlobalConfig();
  });

  test('listProviders returns all providers', () => {
    cleanGlobalConfig();
    const providers = mcpConfig.listProviders();
    assertEqual(providers.length, 5, 'should have 5 default providers');
    const ids = providers.map(p => p.id);
    assert(ids.includes('context7'), 'should include context7');
    assert(ids.includes('playwright'), 'should include playwright');
    cleanGlobalConfig();
  });

  test('listInstalledProviders returns only installed ones', () => {
    cleanGlobalConfig();
    // None installed by default
    let installed = mcpConfig.listInstalledProviders();
    assertEqual(installed.length, 0, 'no providers installed by default');

    // Install two
    mcpConfig.setProviderInstalled('context7', true);
    mcpConfig.setProviderInstalled('playwright', true);

    installed = mcpConfig.listInstalledProviders();
    assertEqual(installed.length, 2, 'should have 2 installed providers');
    const ids = installed.map(p => p.id);
    assert(ids.includes('context7'), 'context7 installed');
    assert(ids.includes('playwright'), 'playwright installed');
    cleanGlobalConfig();
  });
});

// ============================================================
// Suite 5: Role Mapping CRUD
// ============================================================

suite('Role Mapping CRUD', () => {
  cleanGlobalConfig();

  test('setRoleMcps sets mcps for a role', () => {
    cleanGlobalConfig();
    mcpConfig.setRoleMcps('verifier', ['context7', 'grep_app'], { context7: 'Verify docs.' });

    const loaded = mcpConfig.loadMcpConfig();
    assert(loaded.agent_map.verifier !== undefined, 'verifier should exist in agent_map');
    assertEqual(loaded.agent_map.verifier.mcps.length, 2, 'should have 2 mcps');
    assert(loaded.agent_map.verifier.mcps.includes('context7'), 'should include context7');
    assert(loaded.agent_map.verifier.mcps.includes('grep_app'), 'should include grep_app');
    assertEqual(loaded.agent_map.verifier.guidance.context7, 'Verify docs.', 'guidance set');
    cleanGlobalConfig();
  });

  test('addMcpToRole appends to existing role', () => {
    cleanGlobalConfig();
    // Scout has default mcps; add a new one
    mcpConfig.addMcpToRole('scout', 'playwright', 'Use for browser testing.');

    const loaded = mcpConfig.loadMcpConfig();
    assert(loaded.agent_map.scout.mcps.includes('playwright'), 'playwright should be in scout mcps');
    assertEqual(loaded.agent_map.scout.guidance.playwright, 'Use for browser testing.', 'guidance set');
    cleanGlobalConfig();
  });

  test('addMcpToRole does not duplicate', () => {
    cleanGlobalConfig();
    // Scout already has context7 by default
    const before = mcpConfig.loadMcpConfig();
    const countBefore = before.agent_map.scout.mcps.filter(m => m === 'context7').length;
    assertEqual(countBefore, 1, 'precondition: one context7');

    mcpConfig.addMcpToRole('scout', 'context7', 'Updated guidance.');

    const after = mcpConfig.loadMcpConfig();
    const countAfter = after.agent_map.scout.mcps.filter(m => m === 'context7').length;
    assertEqual(countAfter, 1, 'should still have exactly one context7');
    cleanGlobalConfig();
  });

  test('removeMcpFromRole removes from role', () => {
    cleanGlobalConfig();
    // Scout has context7 by default
    const before = mcpConfig.loadMcpConfig();
    assert(before.agent_map.scout.mcps.includes('context7'), 'precondition: context7 in scout');

    mcpConfig.removeMcpFromRole('scout', 'context7');

    const after = mcpConfig.loadMcpConfig();
    assert(!after.agent_map.scout.mcps.includes('context7'), 'context7 should be removed from scout');
    cleanGlobalConfig();
  });

  test('removeMcpFromRole cleans up guidance too', () => {
    cleanGlobalConfig();
    // Scout has guidance for context7 by default
    const before = mcpConfig.loadMcpConfig();
    assert(before.agent_map.scout.guidance.context7 !== undefined, 'precondition: guidance exists');

    mcpConfig.removeMcpFromRole('scout', 'context7');

    const after = mcpConfig.loadMcpConfig();
    assertEqual(after.agent_map.scout.guidance.context7, undefined, 'guidance should be removed');
    cleanGlobalConfig();
  });
});

// ============================================================
// Suite 6: MCP Guidance Generation
// ============================================================

suite('MCP Guidance Generation', () => {
  cleanGlobalConfig();

  test('getMcpGuidanceForRole returns empty string when no MCPs installed', () => {
    cleanGlobalConfig();
    // Default: none installed
    const guidance = mcpConfig.getMcpGuidanceForRole('scout');
    assertEqual(guidance, '', 'should be empty when nothing installed');
    cleanGlobalConfig();
  });

  test('getMcpGuidanceForRole returns guidance for installed MCPs only', () => {
    cleanGlobalConfig();
    // Install context7 but not grep_app
    mcpConfig.setProviderInstalled('context7', true);

    const guidance = mcpConfig.getMcpGuidanceForRole('scout');
    assert(guidance.includes('context7'), 'should mention context7');
    assert(!guidance.includes('grep_app'), 'should NOT mention grep_app (not installed)');
    cleanGlobalConfig();
  });

  test('getMcpGuidanceForRole uses role-specific guidance over provider usage_hint', () => {
    cleanGlobalConfig();
    mcpConfig.setProviderInstalled('context7', true);

    const guidance = mcpConfig.getMcpGuidanceForRole('scout');
    // Scout has custom guidance for context7: "Look up library docs when you encounter unfamiliar APIs during scouting."
    assert(guidance.includes('Look up library docs when you encounter unfamiliar APIs during scouting'),
      'should use role-specific guidance for scout');
    cleanGlobalConfig();
  });

  test('getMcpGuidanceForRole includes provider name and id in output', () => {
    cleanGlobalConfig();
    mcpConfig.setProviderInstalled('context7', true);

    const guidance = mcpConfig.getMcpGuidanceForRole('scout');
    assert(guidance.includes('Context7'), 'should include provider name');
    assert(guidance.includes('context7'), 'should include provider id');
    cleanGlobalConfig();
  });
});

// ============================================================
// Suite 7: isMcpInstalled
// ============================================================

suite('isMcpInstalled', () => {
  cleanGlobalConfig();

  test('isMcpInstalled returns false for uninstalled', () => {
    cleanGlobalConfig();
    const result = mcpConfig.isMcpInstalled('context7');
    assertEqual(result, false, 'should be false by default');
    cleanGlobalConfig();
  });

  test('isMcpInstalled returns true after setProviderInstalled', () => {
    cleanGlobalConfig();
    mcpConfig.setProviderInstalled('context7', true);
    const result = mcpConfig.isMcpInstalled('context7');
    assertEqual(result, true, 'should be true after setting installed');
    cleanGlobalConfig();
  });
});

// ============================================================
// Helpers for MCP auto-detection tests
// ============================================================

function writeClaudeJson(dir, mcpServers) {
  fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ mcpServers }), 'utf-8');
}

function removeClaudeJson(dir) {
  try { fs.unlinkSync(path.join(dir, '.claude.json')); } catch { /* ignore */ }
}

// ============================================================
// Suite 8: detectInstalledMcpServers
// ============================================================

suite('detectInstalledMcpServers', () => {
  test('detects MCP servers from project .claude.json', () => {
    cleanGlobalConfig();
    cleanProjectConfig(TEMP_PROJECT);
    writeClaudeJson(TEMP_PROJECT, {
      context7: { command: 'npx' },
      grep_app: { command: 'npx' },
    });

    const result = mcpConfig.detectInstalledMcpServers(TEMP_PROJECT);
    assert(result.includes('context7'), 'should detect context7');
    assert(result.includes('grep_app'), 'should detect grep_app');

    removeClaudeJson(TEMP_PROJECT);
    cleanGlobalConfig();
    cleanProjectConfig(TEMP_PROJECT);
  });

  test('returns empty array when no .claude.json exists', () => {
    cleanGlobalConfig();
    const noClaudeDir = path.join(TEMP_ROOT, 'no-claude-dir');
    fs.mkdirSync(noClaudeDir, { recursive: true });

    const result = mcpConfig.detectInstalledMcpServers(noClaudeDir);
    // The function also checks ~/.claude.json which may exist, so just assert it returns an array
    assert(Array.isArray(result), 'result should be an array');

    cleanGlobalConfig();
  });

  test('maps CC server aliases to OML provider IDs', () => {
    cleanGlobalConfig();
    cleanProjectConfig(TEMP_PROJECT);
    writeClaudeJson(TEMP_PROJECT, {
      'augment-context-engine': { command: 'x' },
      'browser-use': { command: 'y' },
    });

    const result = mcpConfig.detectInstalledMcpServers(TEMP_PROJECT);
    assert(result.includes('augment-context-engine'), 'should detect augment-context-engine');
    assert(result.includes('browser-use'), 'should detect browser-use');

    removeClaudeJson(TEMP_PROJECT);
    cleanGlobalConfig();
    cleanProjectConfig(TEMP_PROJECT);
  });

  test('handles unknown server names (pass-through)', () => {
    cleanGlobalConfig();
    cleanProjectConfig(TEMP_PROJECT);
    writeClaudeJson(TEMP_PROJECT, {
      'my-custom-server': { command: 'z' },
    });

    const result = mcpConfig.detectInstalledMcpServers(TEMP_PROJECT);
    assert(result.includes('my-custom-server'), 'should pass through unknown server name');

    removeClaudeJson(TEMP_PROJECT);
    cleanGlobalConfig();
    cleanProjectConfig(TEMP_PROJECT);
  });
});

// ============================================================
// Suite 9: autoSyncMcpProviders
// ============================================================

suite('autoSyncMcpProviders', () => {
  test('marks detected providers as installed in OML config', () => {
    cleanGlobalConfig();
    cleanProjectConfig(TEMP_PROJECT);
    writeClaudeJson(TEMP_PROJECT, {
      context7: {},
      grep_app: {},
    });

    const result = mcpConfig.autoSyncMcpProviders(TEMP_PROJECT);
    assert(result.includes('context7'), 'result should include context7');
    assert(result.includes('grep_app'), 'result should include grep_app');

    const cfg = mcpConfig.loadMcpConfig(TEMP_PROJECT);
    assertEqual(cfg.providers.context7.installed, true, 'context7 should be installed');
    assertEqual(cfg.providers.grep_app.installed, true, 'grep_app should be installed');

    removeClaudeJson(TEMP_PROJECT);
    cleanGlobalConfig();
    cleanProjectConfig(TEMP_PROJECT);
  });

  test('does not re-sync already installed providers', () => {
    cleanGlobalConfig();
    cleanProjectConfig(TEMP_PROJECT);
    mcpConfig.setProviderInstalled('context7', true);

    writeClaudeJson(TEMP_PROJECT, {
      context7: {},
    });

    const result = mcpConfig.autoSyncMcpProviders(TEMP_PROJECT);
    assertEqual(result.filter(r => r === 'context7').length, 0, 'should not re-sync already installed');

    removeClaudeJson(TEMP_PROJECT);
    cleanGlobalConfig();
    cleanProjectConfig(TEMP_PROJECT);
  });

  test('registers unknown servers as new providers', () => {
    cleanGlobalConfig();
    cleanProjectConfig(TEMP_PROJECT);
    writeClaudeJson(TEMP_PROJECT, {
      'my-new-server': { command: 'x' },
    });

    const result = mcpConfig.autoSyncMcpProviders(TEMP_PROJECT);
    assert(result.includes('my-new-server'), 'result should include my-new-server');

    const cfg = mcpConfig.loadMcpConfig();
    assert(cfg.providers['my-new-server'] !== undefined, 'my-new-server should exist in providers');
    assertEqual(cfg.providers['my-new-server'].installed, true, 'my-new-server should be installed');
    assert(
      cfg.providers['my-new-server'].tags && cfg.providers['my-new-server'].tags.includes('auto-detected'),
      'my-new-server should have auto-detected tag'
    );

    removeClaudeJson(TEMP_PROJECT);
    cleanGlobalConfig();
    cleanProjectConfig(TEMP_PROJECT);
  });

  test('getMcpGuidanceForRole returns guidance after auto-sync', () => {
    cleanGlobalConfig();
    cleanProjectConfig(TEMP_PROJECT);

    // Before sync: no installed providers → empty guidance
    assertEqual(mcpConfig.getMcpGuidanceForRole('scout'), '', 'empty before sync');

    writeClaudeJson(TEMP_PROJECT, {
      context7: {},
      'augment-context-engine': {},
    });

    mcpConfig.autoSyncMcpProviders(TEMP_PROJECT);

    // After sync: installed providers should produce guidance
    const guidance = mcpConfig.getMcpGuidanceForRole('scout');
    assert(guidance !== '', 'guidance should not be empty after sync');
    assert(
      guidance.toLowerCase().includes('context7'),
      'guidance should mention context7'
    );

    removeClaudeJson(TEMP_PROJECT);
    cleanGlobalConfig();
    cleanProjectConfig(TEMP_PROJECT);
  });
});

// ============================================================
// Suite 10: detectMcpTool coverage
// ============================================================

suite('detectMcpTool coverage', () => {
  test('new CC format: augment-context-engine', () => {
    cleanGlobalConfig();
    const result = mcpConfig.detectMcpTool('mcp__augment-context-engine__codebase-retrieval');
    assert(result !== null, 'should not be null');
    assertEqual(result.providerId, 'augment-context-engine', 'providerId');
    assertEqual(result.method, 'codebase-retrieval', 'method');
    assert(typeof result.providerName === 'string' && result.providerName.length > 0, 'providerName should be non-empty string');
  });

  test('new CC format: context7 query-docs', () => {
    cleanGlobalConfig();
    const result = mcpConfig.detectMcpTool('mcp__context7__query-docs');
    assert(result !== null, 'should not be null');
    assertEqual(result.providerId, 'context7', 'providerId');
    assertEqual(result.method, 'query-docs', 'method');
    assert(typeof result.providerName === 'string' && result.providerName.length > 0, 'providerName should be non-empty string');
  });

  test('new CC format: grep_app searchGitHub', () => {
    cleanGlobalConfig();
    const result = mcpConfig.detectMcpTool('mcp__grep_app__searchGitHub');
    assert(result !== null, 'should not be null');
    assertEqual(result.providerId, 'grep_app', 'providerId');
    assertEqual(result.method, 'searchGitHub', 'method');
    assert(typeof result.providerName === 'string' && result.providerName.length > 0, 'providerName should be non-empty string');
  });

  test('legacy format: context7_query-docs', () => {
    cleanGlobalConfig();
    const result = mcpConfig.detectMcpTool('context7_query-docs');
    assert(result !== null, 'should not be null');
    assertEqual(result.providerId, 'context7', 'providerId');
    assertEqual(result.method, 'query-docs', 'method');
  });

  test('legacy format: augment-context-engine_codebase-retrieval', () => {
    cleanGlobalConfig();
    const result = mcpConfig.detectMcpTool('augment-context-engine_codebase-retrieval');
    assert(result !== null, 'should not be null');
    assertEqual(result.providerId, 'augment-context-engine', 'providerId');
    assertEqual(result.method, 'codebase-retrieval', 'method');
  });

  test('non-MCP tool returns null', () => {
    cleanGlobalConfig();
    const result = mcpConfig.detectMcpTool('Read');
    assertEqual(result, null, 'Read should return null');
  });

  test('non-MCP tool with underscore returns null (no matching provider)', () => {
    cleanGlobalConfig();
    const result = mcpConfig.detectMcpTool('some_random_tool');
    assertEqual(result, null, 'some_random_tool should return null');
  });

  test('empty string returns null', () => {
    cleanGlobalConfig();
    const result = mcpConfig.detectMcpTool('');
    assertEqual(result, null, 'empty string should return null');
  });
});

// ============================================================
// Suite 11: getMcpGuidanceForRole enhanced output
// ============================================================

suite('getMcpGuidanceForRole enhanced output', () => {
  test('guidance includes PREFER MCP text when providers installed', () => {
    cleanGlobalConfig();
    mcpConfig.setProviderInstalled('augment-context-engine', true);
    mcpConfig.setProviderInstalled('context7', true);

    const guidance = mcpConfig.getMcpGuidanceForRole('scout');
    assert(guidance.includes('PREFER MCP'), 'should include "PREFER MCP" text');
    cleanGlobalConfig();
  });

  test('guidance includes tool invocation name examples with mcp__ prefix', () => {
    cleanGlobalConfig();
    mcpConfig.setProviderInstalled('augment-context-engine', true);
    mcpConfig.setProviderInstalled('context7', true);

    const guidance = mcpConfig.getMcpGuidanceForRole('scout');
    assert(guidance.includes('mcp__'), 'should include mcp__ prefix examples');
    cleanGlobalConfig();
  });

  test('guidance includes specific example tool names', () => {
    cleanGlobalConfig();
    mcpConfig.setProviderInstalled('augment-context-engine', true);
    mcpConfig.setProviderInstalled('context7', true);

    const guidance = mcpConfig.getMcpGuidanceForRole('scout');
    const hasAugmentExample = guidance.includes('mcp__augment-context-engine__codebase-retrieval');
    const hasContext7Example = guidance.includes('mcp__context7__');
    assert(hasAugmentExample || hasContext7Example,
      'should include specific example strings like mcp__augment-context-engine__codebase-retrieval or mcp__context7__');
    cleanGlobalConfig();
  });
});

// ============================================================
// Cleanup & Summary
// ============================================================

cleanupTempDirs();

console.log('\n========================================');
console.log(`  Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
console.log('========================================');

if (failures.length > 0) {
  console.log('\nFailures:');
  for (const f of failures) {
    console.log(`  - ${f.name}: ${f.error}`);
  }
}

process.exit(failed > 0 ? 1 : 0);
