// ============================================================
// memory-extractor.ts — Extract 5 types of memories from text
//
// Port of mempalace/general_extractor.py
// Types: decision, preference, milestone, problem, emotional
// Pure keyword/pattern heuristics — no LLM required.
// ============================================================

import type { ExtractionResult } from '../types';

// =============================================================================
// MARKER SETS — One per memory type
// =============================================================================

const DECISION_MARKERS: string[] = [
  "\\blet'?s (use|go with|try|pick|choose|switch to)\\b",
  "\\bwe (should|decided|chose|went with|picked|settled on)\\b",
  "\\bi'?m going (to|with)\\b",
  "\\bbetter (to|than|approach|option|choice)\\b",
  "\\binstead of\\b",
  "\\brather than\\b",
  "\\bthe reason (is|was|being)\\b",
  "\\bbecause\\b",
  "\\btrade-?off\\b",
  "\\bpros and cons\\b",
  "\\bover\\b.*\\bbecause\\b",
  "\\barchitecture\\b",
  "\\bapproach\\b",
  "\\bstrategy\\b",
  "\\bpattern\\b",
  "\\bstack\\b",
  "\\bframework\\b",
  "\\binfrastructure\\b",
  "\\bset (it |this )?to\\b",
  "\\bconfigure\\b",
  "\\bdefault\\b",
];

const PREFERENCE_MARKERS: string[] = [
  "\\bi prefer\\b",
  "\\balways use\\b",
  "\\bnever use\\b",
  "\\bdon'?t (ever |like to )?(use|do|mock|stub|import)\\b",
  "\\bi like (to|when|how)\\b",
  "\\bi hate (when|how|it when)\\b",
  "\\bplease (always|never|don'?t)\\b",
  "\\bmy (rule|preference|style|convention) is\\b",
  "\\bwe (always|never)\\b",
  "\\bfunctional\\b.*\\bstyle\\b",
  "\\bimperative\\b",
  "\\bsnake_?case\\b",
  "\\bcamel_?case\\b",
  "\\btabs\\b.*\\bspaces\\b",
  "\\bspaces\\b.*\\btabs\\b",
  "\\buse\\b.*\\binstead of\\b",
];

const MILESTONE_MARKERS: string[] = [
  "\\bit works\\b",
  "\\bit worked\\b",
  "\\bgot it working\\b",
  "\\bfixed\\b",
  "\\bsolved\\b",
  "\\bbreakthrough\\b",
  "\\bfigured (it )?out\\b",
  "\\bnailed it\\b",
  "\\bcracked (it|the)\\b",
  "\\bfinally\\b",
  "\\bfirst time\\b",
  "\\bfirst ever\\b",
  "\\bnever (done|been|had) before\\b",
  "\\bdiscovered\\b",
  "\\brealized\\b",
  "\\bfound (out|that)\\b",
  "\\bturns out\\b",
  "\\bthe key (is|was|insight)\\b",
  "\\bthe trick (is|was)\\b",
  "\\bnow i (understand|see|get it)\\b",
  "\\bbuilt\\b",
  "\\bcreated\\b",
  "\\bimplemented\\b",
  "\\bshipped\\b",
  "\\blaunched\\b",
  "\\bdeployed\\b",
  "\\breleased\\b",
  "\\bprototype\\b",
  "\\bproof of concept\\b",
  "\\bdemo\\b",
  "\\bversion \\d",
  "\\bv\\d+\\.\\d+",
  "\\d+x (compression|faster|slower|better|improvement|reduction)",
  "\\d+% (reduction|improvement|faster|better|smaller)",
];

const PROBLEM_MARKERS: string[] = [
  "\\b(bug|error|crash|fail|broke|broken|issue|problem)\\b",
  "\\bdoesn'?t work\\b",
  "\\bnot working\\b",
  "\\bwon'?t\\b.*\\bwork\\b",
  "\\bkeeps? (failing|crashing|breaking|erroring)\\b",
  "\\broot cause\\b",
  "\\bthe (problem|issue|bug) (is|was)\\b",
  "\\bturns out\\b.*\\b(was|because|due to)\\b",
  "\\bthe fix (is|was)\\b",
  "\\bworkaround\\b",
  "\\bthat'?s why\\b",
  "\\bthe reason it\\b",
  "\\bfixed (it |the |by )\\b",
  "\\bsolution (is|was)\\b",
  "\\bresolved\\b",
  "\\bpatched\\b",
  "\\bthe answer (is|was)\\b",
  "\\b(had|need) to\\b.*\\binstead\\b",
];

const EMOTION_MARKERS: string[] = [
  "\\blove\\b",
  "\\bscared\\b",
  "\\bafraid\\b",
  "\\bproud\\b",
  "\\bhurt\\b",
  "\\bhappy\\b",
  "\\bsad\\b",
  "\\bcry\\b",
  "\\bcrying\\b",
  "\\bmiss\\b",
  "\\bsorry\\b",
  "\\bgrateful\\b",
  "\\bangry\\b",
  "\\bworried\\b",
  "\\blonely\\b",
  "\\bbeautiful\\b",
  "\\bamazing\\b",
  "\\bwonderful\\b",
  "i feel",
  "i'm scared",
  "i love you",
  "i'm sorry",
  "i can't",
  "i wish",
  "i miss",
  "i need",
  "never told anyone",
  "nobody knows",
  "\\*[^*]+\\*",
];

const ALL_MARKERS: Record<string, string[]> = {
  decision: DECISION_MARKERS,
  preference: PREFERENCE_MARKERS,
  milestone: MILESTONE_MARKERS,
  problem: PROBLEM_MARKERS,
  emotional: EMOTION_MARKERS,
};

// =============================================================================
// SENTIMENT — for disambiguation
// =============================================================================

const POSITIVE_WORDS = new Set([
  'pride', 'proud', 'joy', 'happy', 'love', 'loving', 'beautiful',
  'amazing', 'wonderful', 'incredible', 'fantastic', 'brilliant',
  'perfect', 'excited', 'thrilled', 'grateful', 'warm', 'breakthrough',
  'success', 'works', 'working', 'solved', 'fixed', 'nailed',
  'heart', 'hug', 'precious', 'adore',
]);

const NEGATIVE_WORDS = new Set([
  'bug', 'error', 'crash', 'crashing', 'crashed',
  'fail', 'failed', 'failing', 'failure',
  'broken', 'broke', 'breaking', 'breaks',
  'issue', 'problem', 'wrong', 'stuck', 'blocked',
  'unable', 'impossible', 'missing',
  'terrible', 'horrible', 'awful',
  'worse', 'worst', 'panic', 'disaster', 'mess',
]);

// =============================================================================
// CODE LINE FILTERING
// =============================================================================

const CODE_LINE_PATTERNS: RegExp[] = [
  /^\s*[$#]\s/,
  /^\s*(cd|source|echo|export|pip|npm|git|python|bash|curl|wget|mkdir|rm|cp|mv|ls|cat|grep|find|chmod|sudo|brew|docker)\s/,
  /^\s*```/,
  /^\s*(import|from|def|class|function|const|let|var|return)\s/,
  /^\s*[A-Z_]{2,}=/,
  /^\s*\|/,
  /^\s*-{2,}/,
  /^\s*[{}\[\]]\s*$/,
  /^\s*(if|for|while|try|except|elif|else:)\b/,
  /^\s*\w+\.\w+\(/,
  /^\s*\w+ = \w+\.\w+/,
];

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function getSentiment(text: string): 'positive' | 'negative' | 'neutral' {
  const words = new Set(
    (text.match(/\b\w+\b/g) || []).map((w) => w.toLowerCase()),
  );
  let pos = 0;
  let neg = 0;
  for (const w of words) {
    if (POSITIVE_WORDS.has(w)) pos++;
    if (NEGATIVE_WORDS.has(w)) neg++;
  }
  if (pos > neg) return 'positive';
  if (neg > pos) return 'negative';
  return 'neutral';
}

function hasResolution(text: string): boolean {
  const textLower = text.toLowerCase();
  const patterns = [
    /\bfixed\b/,
    /\bsolved\b/,
    /\bresolved\b/,
    /\bpatched\b/,
    /\bgot it working\b/,
    /\bit works\b/,
    /\bnailed it\b/,
    /\bfigured (it )?out\b/,
    /\bthe (fix|answer|solution)\b/,
  ];
  return patterns.some((p) => p.test(textLower));
}

function disambiguate(
  memoryType: string,
  text: string,
  scores: Record<string, number>,
): string {
  const sentiment = getSentiment(text);

  // Resolved problems are milestones
  if (memoryType === 'problem' && hasResolution(text)) {
    if ((scores['emotional'] || 0) > 0 && sentiment === 'positive') {
      return 'emotional';
    }
    return 'milestone';
  }

  // Problem + positive sentiment => milestone or emotional
  if (memoryType === 'problem' && sentiment === 'positive') {
    if ((scores['milestone'] || 0) > 0) {
      return 'milestone';
    }
    if ((scores['emotional'] || 0) > 0) {
      return 'emotional';
    }
  }

  return memoryType;
}

function isCodeLine(line: string): boolean {
  const stripped = line.trim();
  if (!stripped) return false;
  for (const pattern of CODE_LINE_PATTERNS) {
    if (pattern.test(stripped)) return true;
  }
  let alphaCount = 0;
  for (const c of stripped) {
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) alphaCount++;
  }
  const alphaRatio = alphaCount / Math.max(stripped.length, 1);
  if (alphaRatio < 0.4 && stripped.length > 10) return true;
  return false;
}

function extractProse(text: string): string {
  const lines = text.split('\n');
  const prose: string[] = [];
  let inCode = false;
  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    if (!isCodeLine(line)) {
      prose.push(line);
    }
  }
  const result = prose.join('\n').trim();
  return result || text;
}

function scoreMarkers(
  text: string,
  markers: string[],
): [number, string[]] {
  const textLower = text.toLowerCase();
  let score = 0;
  const keywords: string[] = [];
  for (const marker of markers) {
    const regex = new RegExp(marker, 'gi');
    const matches = textLower.match(regex);
    if (matches) {
      score += matches.length;
      keywords.push(...matches);
    }
  }
  return [score, [...new Set(keywords)]];
}

// =============================================================================
// SEGMENTATION
// =============================================================================

function splitIntoSegments(text: string): string[] {
  const lines = text.split('\n');

  const turnPatterns = [
    /^>\s/,
    /^(Human|User|Q)\s*:/i,
    /^(Assistant|AI|A|Claude|ChatGPT)\s*:/i,
  ];

  let turnCount = 0;
  for (const line of lines) {
    const stripped = line.trim();
    for (const pat of turnPatterns) {
      if (pat.test(stripped)) {
        turnCount++;
        break;
      }
    }
  }

  // If enough turn markers, split by turns
  if (turnCount >= 3) {
    return splitByTurns(lines, turnPatterns);
  }

  // Fallback: paragraph splitting
  const paragraphs = text
    .split('\n\n')
    .map((p) => p.trim())
    .filter(Boolean);

  // If single giant block, chunk by line groups
  if (paragraphs.length <= 1 && lines.length > 20) {
    const segments: string[] = [];
    for (let i = 0; i < lines.length; i += 25) {
      const group = lines.slice(i, i + 25).join('\n').trim();
      if (group) segments.push(group);
    }
    return segments;
  }

  return paragraphs;
}

function splitByTurns(lines: string[], turnPatterns: RegExp[]): string[] {
  const segments: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    const stripped = line.trim();
    const isTurn = turnPatterns.some((pat) => pat.test(stripped));

    if (isTurn && current.length > 0) {
      segments.push(current.join('\n'));
      current = [line];
    } else {
      current.push(line);
    }
  }

  if (current.length > 0) {
    segments.push(current.join('\n'));
  }

  return segments;
}

// =============================================================================
// MAIN EXTRACTION — exported
// =============================================================================

export function extractMemories(
  text: string,
  minConfidence?: number,
): ExtractionResult[] {
  const threshold = minConfidence ?? 0.3;
  const paragraphs = splitIntoSegments(text);
  const memories: ExtractionResult[] = [];

  for (const para of paragraphs) {
    if (para.trim().length < 20) continue;

    const prose = extractProse(para);

    // Score against all types
    const scores: Record<string, number> = {};
    for (const [memType, markers] of Object.entries(ALL_MARKERS)) {
      const [score] = scoreMarkers(prose, markers);
      if (score > 0) scores[memType] = score;
    }

    if (Object.keys(scores).length === 0) continue;

    // Length bonus
    let lengthBonus = 0;
    if (para.length > 500) lengthBonus = 2;
    else if (para.length > 200) lengthBonus = 1;

    let maxType = Object.keys(scores).reduce((a, b) =>
      scores[a] >= scores[b] ? a : b,
    );
    const maxScore = scores[maxType] + lengthBonus;

    // Disambiguate
    maxType = disambiguate(maxType, prose, scores);

    // Confidence
    const confidence = Math.min(1.0, maxScore / 5.0);
    if (confidence < threshold) continue;

    memories.push({
      content: para.trim(),
      memory_type: maxType as ExtractionResult['memory_type'],
      chunk_index: memories.length,
      confidence,
    });
  }

  return memories;
}
