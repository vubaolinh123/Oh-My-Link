import * as fs from 'fs';
import * as path from 'path';
import { parseHookInput, hookOutput, getCwd, getQuietLevel, readJson, debugLog } from '../helpers';
import { getSkillsDir, getSystemRoot, getProjectStateRoot, normalizePath } from '../state';
import { HookInput, LearnedSkill } from '../types';

const MAX_SKILLS = 3;
const SCORE_PER_TRIGGER = 10;
const SCORE_PER_MULTI_WORD_TRIGGER = 15;
const MIN_SCORE_THRESHOLD = 10;
const NEGATIVE_FEEDBACK_THRESHOLD = 3;

function discoverSkills(dir: string): LearnedSkill[] {
  const skills: LearnedSkill[] = [];
  if (!fs.existsSync(dir)) return skills;
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
  } catch { return skills; }
  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(dir, file), 'utf-8');
      const skill = parseFrontmatter(content, file);
      if (skill) skills.push(skill);
    } catch {
      // Skip individual bad files — don't abort discovery
    }
  }
  return skills;
}

function parseFrontmatter(content: string, sourceFile: string): LearnedSkill | null {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) return null;
  const fm = match[1];
  const body = match[2];

  const name = extractField(fm, 'name') || path.basename(sourceFile, '.md');
  const description = extractField(fm, 'description') || '';
  const triggers = parseTriggers(fm);

  return { name, description, triggers, content: body.trim(), source_file: sourceFile };
}

function parseTriggers(fm: string): string[] {
  // Try YAML list format first: triggers:\n  - keyword1\n  - keyword2
  const listMatch = fm.match(/^triggers:\s*\n((?:\s+-\s+.+\n?)+)/m);
  if (listMatch) {
    return listMatch[1]
      .split('\n')
      .map(line => line.replace(/^\s*-\s*/, '').trim())
      .filter(Boolean)
      .map(t => t.replace(/^["']|["']$/g, ''));
  }
  // Try inline array format: triggers: [a, b, c]
  const inlineMatch = fm.match(/^triggers:\s*\[([^\]]*)\]/m);
  if (inlineMatch) {
    return inlineMatch[1].split(',').map(t => t.trim()).filter(Boolean).map(t => t.replace(/^["']|["']$/g, ''));
  }
  // Fallback: comma-separated on same line: triggers: a, b, c
  const rawTriggers = extractField(fm, 'triggers') || '';
  return rawTriggers.split(',').map(t => t.trim()).filter(Boolean);
}

function extractField(fm: string, field: string): string | null {
  const match = fm.match(new RegExp(`^${field}:\\s*(.+)$`, 'm'));
  return match ? match[1].trim().replace(/^["']|["']$/g, '') : null;
}

function matchScore(skill: LearnedSkill, prompt: string): number {
  let score = 0;
  for (const trigger of skill.triggers) {
    const lowerTrigger = trigger.toLowerCase();
    const isMultiWord = lowerTrigger.includes(' ');
    try {
      const pattern = new RegExp(`\\b${lowerTrigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (pattern.test(prompt)) {
        score += isMultiWord ? SCORE_PER_MULTI_WORD_TRIGGER : SCORE_PER_TRIGGER;
      }
    } catch {
      if (prompt.includes(lowerTrigger)) {
        score += isMultiWord ? SCORE_PER_MULTI_WORD_TRIGGER : SCORE_PER_TRIGGER;
      }
    }
  }
  return score;
}

interface SkillFeedbackEntry {
  negativeCount: number;
  lastNegative: string | null;
  reason: string;
}

function loadSkillFeedback(stateDir: string): Record<string, SkillFeedbackEntry> {
  const feedbackPath = normalizePath(path.join(stateDir, 'skill-feedback.json'));
  return readJson<Record<string, SkillFeedbackEntry>>(feedbackPath) || {};
}

function isSkillSuppressed(feedback: Record<string, SkillFeedbackEntry>, skillName: string): boolean {
  const entry = feedback[skillName];
  if (!entry) return false;
  let count = entry.negativeCount || 0;

  // Time-based decay: halve negativeCount if last negative was >14 days ago
  if (entry.lastNegative && count >= NEGATIVE_FEEDBACK_THRESHOLD) {
    const lastNeg = new Date(entry.lastNegative).getTime();
    const fourteenDaysMs = 14 * 24 * 60 * 60 * 1000;
    if (Date.now() - lastNeg > fourteenDaysMs) {
      count = Math.floor(count / 2);
    }
  }

  return count >= NEGATIVE_FEEDBACK_THRESHOLD;
}

async function main(): Promise<void> {
  const input = await parseHookInput() as HookInput;
  const prompt = (input.prompt || '').trim().toLowerCase();
  if (!prompt) { hookOutput('UserPromptSubmit'); return; }

  const cwd = getCwd(input as Record<string, unknown>);
  const quiet = getQuietLevel();

  // Discover skills from project-level and global-level
  const projectSkills = discoverSkills(getSkillsDir(cwd));
  const globalSkills = discoverSkills(normalizePath(path.join(getSystemRoot(), 'skills')));

  // Merge — project overrides global by name
  const skillMap = new Map<string, LearnedSkill>();
  for (const s of globalSkills) skillMap.set(s.name, s);
  for (const s of projectSkills) skillMap.set(s.name, s);

  if (skillMap.size === 0) { hookOutput('UserPromptSubmit'); return; }

  // Score skills against prompt using triggers
  const scored: LearnedSkill[] = [];
  for (const skill of skillMap.values()) {
    const score = matchScore(skill, prompt);
    if (score >= MIN_SCORE_THRESHOLD) {
      skill.score = score;
      scored.push(skill);
    }
  }

  if (scored.length === 0) { hookOutput('UserPromptSubmit'); return; }

  debugLog(cwd, 'skill-inject', `matched=${scored.length} skills: ${scored.map(s=>s.name).join(',')}`);

  // Sort by score descending, then project skills before global
  scored.sort((a, b) => {
    const scoreDiff = (b.score || 0) - (a.score || 0);
    if (scoreDiff !== 0) return scoreDiff;
    // Project skills (from cwd) have priority over global skills
    const aIsProject = a.source_file.includes('.oh-my-link');
    const bIsProject = b.source_file.includes('.oh-my-link');
    if (aIsProject && !bIsProject) return -1;
    if (!aIsProject && bIsProject) return 1;
    return 0;
  });

  // Session dedup: filter out already-injected skills
  const stateDir = getProjectStateRoot(cwd);
  const sessionTrackPath = normalizePath(path.join(stateDir, 'injected-skills.json'));
  const injectedData = readJson<{ skills?: string[]; session_started_at?: string }>(sessionTrackPath);

  // Session-scoped dedup: check if the current session matches
  const sessionPath = normalizePath(path.join(stateDir, 'session.json'));
  const sessionState = readJson<{ started_at?: string }>(sessionPath);
  let injected: string[] = [];
  if (injectedData?.skills) {
    // Reset dedup if session changed
    if (sessionState?.started_at && injectedData.session_started_at
        && sessionState.started_at !== injectedData.session_started_at) {
      injected = [];
    } else {
      injected = injectedData.skills;
    }
  }

  const newSkills = scored.filter(s => !injected.includes(s.name));
  if (newSkills.length === 0) { hookOutput('UserPromptSubmit'); return; }

  // Feedback-based suppression: skip skills with too much negative feedback
  const feedback = loadSkillFeedback(stateDir);
  const unsuppressed = newSkills.filter(s => !isSkillSuppressed(feedback, s.name));
  if (unsuppressed.length === 0) { hookOutput('UserPromptSubmit'); return; }

  // Cap at MAX_SKILLS
  const toInject = unsuppressed.slice(0, MAX_SKILLS);

  if (toInject.length > 0) {
    debugLog(cwd, 'skill-inject', `injecting=${toInject.length}: ${toInject.map(s => s.name).join(', ')} (${unsuppressed.length} unsuppressed, ${newSkills.length} new)`);
  }

  // Track injected skills with session_started_at
  const updatedInjected = [...injected, ...toInject.map(s => s.name)];
  try {
    fs.mkdirSync(path.dirname(sessionTrackPath), { recursive: true });
    fs.writeFileSync(sessionTrackPath, JSON.stringify({
      skills: updatedInjected,
      session_started_at: sessionState?.started_at || null,
      updated_at: new Date().toISOString(),
    }, null, 2));
  } catch { /* ignore */ }

  // Format injection with skill body content and feedback hint
  if (quiet >= 2) { hookOutput('UserPromptSubmit'); return; }

  const injectionParts = toInject.map(s => {
    let section = `### ${s.name}`;
    if (s.description) section += `\n${s.description}`;
    if (s.content) section += `\n\n${s.content}`;
    section += `\n\n_(Report issues: \`<skill-feedback name="${s.name}" useful="false">reason</skill-feedback>\`)_`;
    return section;
  });

  const injection = `<oml-learned-skills>\n${injectionParts.join('\n\n---\n\n')}\n</oml-learned-skills>`;
  const skillNames = toInject.map(s => s.name).join(', ');

  hookOutput('UserPromptSubmit',
    `[oh-my-link] Injected ${toInject.length} learned skill(s): ${skillNames}\n\n${injection}`
  );
}

main().catch(() => hookOutput('UserPromptSubmit'));
