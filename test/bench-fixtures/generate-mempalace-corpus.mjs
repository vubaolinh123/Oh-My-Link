/**
 * Generator for the MemPalace Comparison Corpus
 *
 * Produces 120 sessions + 120 questions across 6 LME categories.
 * Designed for realistic developer conversations with temporal progression,
 * diverse topics, people names, preferences, and technical decisions.
 *
 * Run: node test/bench-fixtures/generate-mempalace-corpus.mjs
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT = path.join(__dirname, 'mempalace-comparison-corpus.json');

// ── Deterministic seeded random ─────────────────────────────────
let seed = 42;
function rand() {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
}
function pick(arr) { return arr[Math.floor(rand() * arr.length)]; }
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── Session templates ───────────────────────────────────────────
// Each template produces a session with conversation text and metadata.

const PEOPLE = [
  'Alice Chen', 'Marcus Johnson', 'Priya Sharma', 'David Kim',
  'Sofia Rodriguez', 'James Wilson', 'Yuki Tanaka', 'Elena Popova',
  'Carlos Mendez', 'Sarah Thompson', 'Raj Patel', 'Liam O\'Brien',
  'Mia Zhang', 'Nathan Brooks', 'Fatima Hassan', 'Oliver Scott',
  'Ava Williams', 'Leo Nakamura', 'Zara Ahmed', 'Ethan Clark',
];

const DATABASES = ['PostgreSQL', 'MongoDB', 'MySQL', 'DynamoDB', 'CockroachDB', 'Redis', 'Cassandra', 'SQLite'];
const FRAMEWORKS = ['React', 'Vue', 'Svelte', 'Angular', 'Next.js', 'Nuxt', 'Remix', 'Astro', 'SolidJS'];
const LANGUAGES = ['TypeScript', 'Python', 'Rust', 'Go', 'Java', 'Kotlin', 'Elixir', 'C#'];
const CLOUD = ['AWS', 'GCP', 'Azure', 'Vercel', 'Cloudflare', 'Fly.io', 'Railway', 'Heroku'];
const TOOLS = ['Docker', 'Kubernetes', 'Terraform', 'Ansible', 'Grafana', 'Prometheus', 'Jenkins', 'ArgoCD'];
const BUGS = ['memory leak', 'race condition', 'deadlock', 'null pointer', 'off-by-one error', 'stack overflow', 'buffer overflow', 'segfault'];
const FEATURES = ['authentication', 'real-time notifications', 'file upload', 'search', 'dashboard', 'billing', 'API rate limiting', 'caching layer'];

function dateStr(yearMonth) {
  const day = Math.floor(rand() * 28) + 1;
  return `${yearMonth}-${String(day).padStart(2, '0')}`;
}

// Generate dates from 2025-01 to 2026-03 (15 months)
const MONTHS = [];
for (let y = 2025; y <= 2026; y++) {
  const maxM = y === 2026 ? 3 : 12;
  for (let m = 1; m <= maxM; m++) {
    MONTHS.push(`${y}-${String(m).padStart(2, '0')}`);
  }
}

// ── Session generators ─────────────────────────────────────────

function genDatabaseDecision(idx) {
  const db1 = pick(DATABASES);
  let db2 = pick(DATABASES);
  while (db2 === db1) db2 = pick(DATABASES);
  const person = pick(PEOPLE);
  const month = MONTHS[idx % MONTHS.length];
  const reason = pick([
    'better write performance under high concurrency',
    'native JSON support and flexible schema',
    'strong consistency guarantees for financial data',
    'lower operational cost at our scale',
    'better tooling and ecosystem maturity',
    'built-in replication and sharding support',
  ]);
  return {
    topic: 'database-migration',
    content: `User: We need to decide on the database for the new service. ${person} suggested ${db1} but I'm not sure.\n\nAssistant: Both ${db1} and ${db2} are solid choices. What are your primary concerns?\n\nUser: ${person} says ${db1} has ${reason}. We've been using ${db2} for the legacy system and it's been painful.\n\nAssistant: Given your need for ${reason}, ${db1} makes sense. The migration path from ${db2} to ${db1} is well-documented.\n\nUser: Let's go with ${db1}. ${person} will lead the migration effort starting next week. We decided ${db1} because of ${reason}.`,
    date: dateStr(month),
    people: [person],
    db: db1,
    reason,
  };
}

function genFrameworkChoice(idx) {
  const fw = pick(FRAMEWORKS);
  const person = pick(PEOPLE);
  const month = MONTHS[(idx + 3) % MONTHS.length];
  const app = pick(['admin dashboard', 'customer portal', 'internal tool', 'marketing site', 'analytics platform']);
  return {
    topic: 'framework-selection',
    content: `User: ${person} and I have been evaluating frameworks for the ${app}. We narrowed it down to ${fw}.\n\nAssistant: ${fw} is a great choice for a ${app}. What specific features attracted you?\n\nUser: The developer experience is excellent, and ${person} has production experience with it. We prefer ${fw} for new frontend projects going forward.\n\nAssistant: That's a sound decision. ${fw} has good community support and the learning curve is manageable for your team.\n\nUser: Yes, ${person} will set up the boilerplate this sprint. We're standardizing on ${fw} for all new frontend work.`,
    date: dateStr(month),
    people: [person],
    framework: fw,
  };
}

function genBugReport(idx) {
  const bug = pick(BUGS);
  const person = pick(PEOPLE);
  const lang = pick(LANGUAGES);
  const month = MONTHS[(idx + 5) % MONTHS.length];
  const fix = pick([
    'adding proper mutex locks around the shared resource',
    'implementing a connection pool with timeout limits',
    'switching to an immutable data structure',
    'adding bounds checking on the array access',
    'using weak references to break the circular dependency',
    'implementing proper error boundaries',
  ]);
  return {
    topic: 'bug-investigation',
    content: `User: We found a critical ${bug} in the ${lang} service. ${person} has been debugging it all day.\n\nAssistant: A ${bug} can be tricky. What symptoms are you seeing?\n\nUser: The service crashes every 4 hours in production. ${person} traced it to the connection handling code. The root cause was a ${bug} in the event loop.\n\nAssistant: That's a common pattern with ${lang} services under load. The fix would typically involve ${fix}.\n\nUser: Yes! ${person} fixed it by ${fix}. The service has been stable for 48 hours now. The root cause of the ${bug} was improper resource cleanup.`,
    date: dateStr(month),
    people: [person],
    bug,
    lang,
    fix,
  };
}

function genPreference(idx) {
  const person = pick(PEOPLE);
  const month = MONTHS[(idx + 7) % MONTHS.length];
  const prefs = [
    { pref: 'tabs over spaces', detail: 'I always use tabs. 2-space indentation feels cramped and 4-space wastes horizontal space.' },
    { pref: 'functional programming style', detail: 'I prefer pure functions and immutable data. Side effects should be pushed to the edges.' },
    { pref: 'dark mode everywhere', detail: 'I use dark mode in every editor and terminal. Light themes strain my eyes after long sessions.' },
    { pref: 'Vim keybindings in VS Code', detail: 'I use the Vim extension in VS Code. Modal editing is faster once you learn it.' },
    { pref: 'TDD approach', detail: 'I always write tests first. It forces better API design and catches regressions early.' },
    { pref: 'monorepo structure', detail: 'I prefer monorepos over polyrepos. Shared code and atomic commits across packages.' },
    { pref: 'conventional commits', detail: 'I always use conventional commit messages. feat:, fix:, chore:. Makes changelogs automatic.' },
    { pref: 'snake_case for variables', detail: 'I prefer snake_case in Python and camelCase in TypeScript. Consistency within a language matters.' },
    { pref: 'minimal dependencies', detail: 'I never add a dependency for something I can write in 50 lines. Dependencies are liabilities.' },
    { pref: 'comprehensive error messages', detail: 'Error messages should always include the context: what failed, why, and how to fix it.' },
  ];
  const p = prefs[idx % prefs.length];
  return {
    topic: 'personal-preference',
    content: `User: ${person} mentioned their coding preferences today.\n\nAssistant: What did they share?\n\nUser: ${person} said they strongly prefer ${p.pref}. ${p.detail}\n\nAssistant: That's a valid preference. Many experienced developers share similar views.\n\nUser: I agree with ${person}. I also prefer ${p.pref}. It's become a team convention now.`,
    date: dateStr(month),
    people: [person],
    preference: p.pref,
  };
}

function genArchDecision(idx) {
  const person = pick(PEOPLE);
  const month = MONTHS[(idx + 2) % MONTHS.length];
  const decisions = [
    { arch: 'microservices', detail: 'We split the monolith into 8 microservices. Each owns its data. Communication via async events through RabbitMQ.' },
    { arch: 'event sourcing', detail: 'All state changes are stored as events. The current state is derived by replaying events. This gives us a complete audit trail.' },
    { arch: 'CQRS pattern', detail: 'Read and write models are separated. Writes go to the event store, reads come from denormalized projections in Elasticsearch.' },
    { arch: 'serverless architecture', detail: 'All business logic runs in Lambda functions. API Gateway handles routing. DynamoDB for persistence. No servers to manage.' },
    { arch: 'hexagonal architecture', detail: 'Business logic is in the center with ports and adapters. Infrastructure is pluggable. Makes testing trivial.' },
    { arch: 'domain-driven design', detail: 'We defined bounded contexts for billing, inventory, and shipping. Each context has its own ubiquitous language and models.' },
    { arch: 'strangler fig migration', detail: 'We\'re gradually replacing the legacy system by routing traffic through a facade. New features go to the new system, old ones get migrated incrementally.' },
    { arch: 'GraphQL federation', detail: 'Each team owns a subgraph. Apollo Router stitches them together. Teams deploy independently.' },
  ];
  const d = decisions[idx % decisions.length];
  return {
    topic: 'architecture-decision',
    content: `User: We had an architecture review today. ${person} presented the proposal for ${d.arch}.\n\nAssistant: That's a significant architectural decision. What drove it?\n\nUser: ${d.detail} ${person} convinced the team this was the right approach.\n\nAssistant: ${d.arch} is well-suited for your use case. The key is to define clear boundaries.\n\nUser: Agreed. We're going with ${d.arch}. ${person} will document the ADR and share it with the team by end of week.`,
    date: dateStr(month),
    people: [person],
    architecture: d.arch,
  };
}

function genDeployment(idx) {
  const person = pick(PEOPLE);
  const cloud = pick(CLOUD);
  const tool = pick(TOOLS);
  const month = MONTHS[(idx + 4) % MONTHS.length];
  return {
    topic: 'deployment-infrastructure',
    content: `User: ${person} finished setting up our deployment pipeline on ${cloud}.\n\nAssistant: Great! What's the setup like?\n\nUser: We're using ${tool} for orchestration on ${cloud}. ${person} configured blue-green deployments with automated rollbacks. The pipeline runs lint, test, build, and deploy stages.\n\nAssistant: Solid setup. Blue-green deployments minimize downtime risk.\n\nUser: ${person} also set up monitoring with alerts for error rate spikes. Our deployment frequency went from weekly to multiple times per day after ${person} automated the ${cloud} pipeline with ${tool}.`,
    date: dateStr(month),
    people: [person],
    cloud,
    tool,
  };
}

function genFeatureDiscussion(idx) {
  const person = pick(PEOPLE);
  const feature = pick(FEATURES);
  const month = MONTHS[(idx + 6) % MONTHS.length];
  const approach = pick([
    'building it from scratch with WebSockets',
    'using a third-party service and wrapping it with our API',
    'implementing it as a separate microservice',
    'adding it as a module to the existing monolith',
    'using a managed cloud service to reduce maintenance burden',
  ]);
  return {
    topic: 'feature-planning',
    content: `User: ${person} and the team discussed implementing ${feature} today.\n\nAssistant: How are you planning to approach it?\n\nUser: We're ${approach}. ${person} estimated it would take about 3 sprints. The main risk is the integration with the existing payment system.\n\nAssistant: That's a reasonable timeline. Have you considered the edge cases?\n\nUser: ${person} identified several edge cases during the planning session. We'll handle them in sprint 2. The ${feature} implementation will follow ${person}'s design document.`,
    date: dateStr(month),
    people: [person],
    feature,
    approach,
  };
}

function genPerformanceWork(idx) {
  const person = pick(PEOPLE);
  const month = MONTHS[(idx + 8) % MONTHS.length];
  const metrics = [
    { area: 'API response time', before: '2.3 seconds', after: '180ms', technique: 'adding database connection pooling and query optimization' },
    { area: 'page load time', before: '5.2 seconds', after: '1.1 seconds', technique: 'lazy loading components and implementing code splitting' },
    { area: 'memory usage', before: '4.2GB', after: '800MB', technique: 'fixing memory leaks in the WebSocket handler and implementing proper garbage collection' },
    { area: 'build time', before: '12 minutes', after: '2 minutes', technique: 'switching to esbuild and implementing incremental compilation' },
    { area: 'test suite runtime', before: '45 minutes', after: '8 minutes', technique: 'parallelizing test execution and using in-memory databases' },
    { area: 'database query latency', before: '1.8 seconds', after: '50ms', technique: 'adding composite indexes and rewriting the N+1 queries' },
  ];
  const m = metrics[idx % metrics.length];
  return {
    topic: 'performance-optimization',
    content: `User: ${person} just completed a major performance optimization. The ${m.area} improved dramatically.\n\nAssistant: What were the numbers?\n\nUser: ${m.area} went from ${m.before} to ${m.after}. ${person} achieved this by ${m.technique}.\n\nAssistant: That's an impressive improvement. Was there any trade-off?\n\nUser: Minor increase in code complexity, but ${person} added good documentation. The team agreed the ${m.area} improvement from ${m.before} to ${m.after} was worth it.`,
    date: dateStr(month),
    people: [person],
    area: m.area,
    before: m.before,
    after: m.after,
    technique: m.technique,
  };
}

function genSecurityIncident(idx) {
  const person = pick(PEOPLE);
  const month = MONTHS[(idx + 9) % MONTHS.length];
  const incidents = [
    { type: 'SQL injection vulnerability', detail: 'Found in the search endpoint. User input was concatenated directly into queries. Fixed with parameterized queries.' },
    { type: 'exposed API key in git history', detail: 'A Stripe API key was committed 6 months ago. Rotated all keys and added git-secrets to prevent future leaks.' },
    { type: 'XSS vulnerability in comments', detail: 'User-generated HTML in comments was not sanitized. Added DOMPurify for input sanitization and Content-Security-Policy headers.' },
    { type: 'broken access control', detail: 'Regular users could access admin endpoints by changing the URL. Implemented proper RBAC middleware on all routes.' },
    { type: 'CSRF attack vector', detail: 'The API accepted requests without CSRF tokens. Added SameSite cookies and double-submit cookie pattern.' },
    { type: 'insecure deserialization', detail: 'The session store used pickle for serialization. Switched to JSON-based serialization with schema validation.' },
  ];
  const inc = incidents[idx % incidents.length];
  return {
    topic: 'security-incident',
    content: `User: ${person} discovered a ${inc.type} during the security audit.\n\nAssistant: That's serious. What's the impact?\n\nUser: ${inc.detail} ${person} patched it immediately and submitted a postmortem.\n\nAssistant: Good response. Was there any evidence of exploitation?\n\nUser: No evidence of active exploitation, thankfully. ${person} added automated security scanning to the CI pipeline to catch similar issues. The ${inc.type} has been fully remediated.`,
    date: dateStr(month),
    people: [person],
    securityType: inc.type,
    detail: inc.detail,
  };
}

function genTeamDiscussion(idx) {
  const p1 = pick(PEOPLE);
  let p2 = pick(PEOPLE);
  while (p2 === p1) p2 = pick(PEOPLE);
  const month = MONTHS[(idx + 10) % MONTHS.length];
  const topics = [
    { subject: 'code review process', detail: `${p1} proposed requiring two approvals for PRs touching core modules. ${p2} agreed but suggested auto-approve for documentation-only changes.` },
    { subject: 'on-call rotation', detail: `${p1} and ${p2} redesigned the on-call schedule. Each person does one week every 6 weeks. Escalation goes to the team lead after 30 minutes.` },
    { subject: 'tech debt sprint', detail: `${p1} pushed for a dedicated tech debt sprint every quarter. ${p2} suggested allocating 20% of each sprint instead. The team went with ${p2}'s approach.` },
    { subject: 'API versioning strategy', detail: `${p1} wanted URL-based versioning (/v1/, /v2/). ${p2} preferred header-based versioning. After debate, they chose URL-based for simplicity.` },
    { subject: 'documentation standards', detail: `${p1} created a documentation template. ${p2} added automated doc generation from TypeScript types. Every endpoint now has auto-generated OpenAPI docs.` },
    { subject: 'hiring priorities', detail: `${p1} wanted to hire a senior backend engineer. ${p2} argued for a DevOps specialist. They compromised and opened both positions.` },
  ];
  const t = topics[idx % topics.length];
  return {
    topic: 'team-process',
    content: `User: ${p1} and ${p2} had a productive discussion about ${t.subject} today.\n\nAssistant: What did they decide?\n\nUser: ${t.detail}\n\nAssistant: That sounds like a good compromise. Team alignment on processes is important.\n\nUser: Yes, both ${p1} and ${p2} were happy with the outcome. We'll start implementing the new ${t.subject} policy next week.`,
    date: dateStr(month),
    people: [p1, p2],
    subject: t.subject,
  };
}

function genKnowledgeUpdate(idx) {
  const person = pick(PEOPLE);
  const month1 = MONTHS[idx % (MONTHS.length - 3)];
  const month2 = MONTHS[(idx % (MONTHS.length - 3)) + 3];
  const updates = [
    { v1: 'REST API', v2: 'GraphQL', reason: 'client teams needed flexible queries and REST was causing over-fetching' },
    { v1: 'Jenkins', v2: 'GitHub Actions', reason: 'Jenkins required too much maintenance and GitHub Actions integrates better with our workflow' },
    { v1: 'Enzyme', v2: 'React Testing Library', reason: 'RTL encourages testing user behavior instead of implementation details' },
    { v1: 'Redux', v2: 'Zustand', reason: 'Redux boilerplate was slowing development and Zustand is simpler for our use case' },
    { v1: 'Express.js', v2: 'Fastify', reason: 'Fastify has better performance benchmarks and built-in schema validation' },
    { v1: 'npm', v2: 'pnpm', reason: 'pnpm saves disk space with hard links and has stricter dependency resolution' },
    { v1: 'Moment.js', v2: 'date-fns', reason: 'Moment is unmaintained and tree-shaking doesn\'t work with it' },
    { v1: 'Styled Components', v2: 'Tailwind CSS', reason: 'Tailwind reduces CSS bundle size and speeds up development with utility classes' },
  ];
  const u = updates[idx % updates.length];
  return {
    topic: 'knowledge-update',
    content: `User: ${person} proposed we switch from ${u.v1} to ${u.v2}.\n\nAssistant: What's the motivation?\n\nUser: ${u.reason}. ${person} did a proof of concept and the results were convincing.\n\nAssistant: Migrations like this need careful planning. Do you have a timeline?\n\nUser: ${person} created a migration plan. We'll run ${u.v1} and ${u.v2} in parallel for one month, then fully switch to ${u.v2}. The switch from ${u.v1} to ${u.v2} is scheduled for completion by end of quarter.`,
    date: dateStr(month2),
    datePrev: dateStr(month1),
    people: [person],
    oldTech: u.v1,
    newTech: u.v2,
    reason: u.reason,
  };
}

function genMultiSessionProject(idx) {
  const person = pick(PEOPLE);
  const baseMonthIdx = idx % (MONTHS.length - 4);
  return {
    topic: 'multi-session-project',
    sessions: [
      {
        content: `User: ${person} started the data pipeline redesign today. The current ETL process takes 6 hours and frequently fails.\n\nAssistant: What's the plan?\n\nUser: ${person} wants to switch from batch processing to stream processing using Apache Kafka. Phase 1 is setting up Kafka clusters.`,
        date: dateStr(MONTHS[baseMonthIdx]),
      },
      {
        content: `User: Update on the pipeline project. ${person} has Kafka running in staging. Initial tests show 10x throughput improvement.\n\nAssistant: That's promising. Any issues?\n\nUser: ${person} found that some legacy consumers can't handle the new event format. Building an adapter layer this week.`,
        date: dateStr(MONTHS[baseMonthIdx + 1]),
      },
      {
        content: `User: The data pipeline migration is complete! ${person} deployed the Kafka-based pipeline to production.\n\nAssistant: Congratulations! What are the final numbers?\n\nUser: Processing time went from 6 hours to 12 minutes. ${person} also added dead letter queues for failed events. Zero data loss during the transition.`,
        date: dateStr(MONTHS[baseMonthIdx + 2]),
      },
    ],
    people: [person],
  };
}

// ── Generate all sessions ──────────────────────────────────────

const sessions = [];
let sid = 1;

function addSession(data) {
  const s = {
    session_id: `s${String(sid).padStart(3, '0')}`,
    timestamp: data.date,
    topic: data.topic,
    participants: ['user', 'assistant'],
    content: data.content,
    _meta: { ...data },
  };
  delete s._meta.content;
  delete s._meta.date;
  delete s._meta.topic;
  sessions.push(s);
  sid++;
  return s.session_id;
}

// Generate 12 of each type = 120 sessions total (+ multi-session bonus)
const generators = [
  genDatabaseDecision,
  genFrameworkChoice,
  genBugReport,
  genPreference,
  genArchDecision,
  genDeployment,
  genFeatureDiscussion,
  genPerformanceWork,
  genSecurityIncident,
  genTeamDiscussion,
  genKnowledgeUpdate,
];

const sessionMeta = []; // track metadata for question generation

for (const gen of generators) {
  for (let i = 0; i < 12; i++) {
    const data = gen(i);
    if (data.sessions) {
      // Multi-session project — add each sub-session
      const ids = data.sessions.map(sub => {
        const s = { ...sub, topic: data.topic, people: data.people };
        return addSession(s);
      });
      sessionMeta.push({ type: 'multi-session-project', ids, people: data.people });
    } else {
      const id = addSession(data);
      sessionMeta.push({ type: data.topic, id, ...data });
    }
  }
}

console.log(`Generated ${sessions.length} sessions`);

// ── Generate questions ──────────────────────────────────────────

const questions = [];
let qid = 1;

function addQ(question, groundTruthId, category, difficulty) {
  questions.push({
    id: `q${String(qid).padStart(3, '0')}`,
    question,
    ground_truth_session_id: groundTruthId,
    category,
    difficulty,
  });
  qid++;
}

// Walk through sessions and generate category-appropriate questions
for (const s of sessions) {
  const m = s._meta;

  // Category 1: knowledge-update (for knowledge-update sessions)
  if (s.topic === 'knowledge-update' && m.oldTech && m.newTech) {
    addQ(
      `What technology did we switch from ${m.oldTech} to?`,
      s.session_id, 'knowledge-update', 'easy'
    );
  }

  // Category 2: single-session-user (what did the user say)
  if (s.topic === 'database-migration' && m.db) {
    addQ(
      `Which database was chosen for the new service and why?`,
      s.session_id, 'single-session-user', 'medium'
    );
  }

  // Category 3: single-session-preference
  if (s.topic === 'personal-preference' && m.preference) {
    addQ(
      `What coding preference was discussed about ${m.preference.split(' ')[0]}?`,
      s.session_id, 'single-session-preference', 'medium'
    );
  }

  // Category 4: single-session-assistant (what the assistant said)
  if (s.topic === 'architecture-decision' && m.architecture) {
    addQ(
      `What did the assistant recommend about ${m.architecture}?`,
      s.session_id, 'single-session-assistant', 'medium'
    );
  }

  // Category 5: temporal-reasoning
  if (s.topic === 'bug-investigation' && m.bug) {
    addQ(
      `What bug was found around ${s.timestamp} and how was it fixed?`,
      s.session_id, 'temporal-reasoning', 'hard'
    );
  }

  // Category 6: multi-session
  if (s.topic === 'performance-optimization' && m.area) {
    addQ(
      `What was the improvement in ${m.area}?`,
      s.session_id, 'multi-session', 'easy'
    );
  }

  // Additional questions for coverage
  if (s.topic === 'deployment-infrastructure' && m.cloud) {
    addQ(
      `Which cloud provider did we deploy to using ${m.tool}?`,
      s.session_id, 'single-session-user', 'easy'
    );
  }

  if (s.topic === 'security-incident' && m.securityType) {
    addQ(
      `What security vulnerability was discovered and who found it?`,
      s.session_id, 'single-session-user', 'medium'
    );
  }

  if (s.topic === 'feature-planning' && m.feature) {
    addQ(
      `How is the team planning to implement ${m.feature}?`,
      s.session_id, 'single-session-assistant', 'medium'
    );
  }

  if (s.topic === 'team-process' && m.subject) {
    addQ(
      `What was decided about ${m.subject}?`,
      s.session_id, 'knowledge-update', 'easy'
    );
  }
}

// Add harder cross-session questions that need temporal reasoning
const dbSessions = sessions.filter(s => s.topic === 'database-migration');
if (dbSessions.length >= 2) {
  // Which was the MOST RECENT database decision?
  const sorted = [...dbSessions].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  addQ(
    'What was the most recent database migration decision?',
    sorted[0].session_id, 'temporal-reasoning', 'hard'
  );
  addQ(
    'What was the earliest database decision made this year?',
    sorted[sorted.length - 1].session_id, 'temporal-reasoning', 'hard'
  );
}

const perfSessions = sessions.filter(s => s.topic === 'performance-optimization');
if (perfSessions.length >= 2) {
  const sorted = [...perfSessions].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  addQ(
    'What performance improvement was made most recently?',
    sorted[0].session_id, 'temporal-reasoning', 'hard'
  );
}

// Multi-session questions
for (const meta of sessionMeta) {
  if (meta.type === 'multi-session-project' && meta.ids) {
    addQ(
      `What was the final result of the data pipeline redesign that ${meta.people[0]} led?`,
      meta.ids[meta.ids.length - 1], 'multi-session', 'hard'
    );
    addQ(
      `When did ${meta.people[0]} start the data pipeline project?`,
      meta.ids[0], 'temporal-reasoning', 'hard'
    );
  }
}

// Person-specific questions
const personSessions = {};
for (const s of sessions) {
  for (const p of s._meta.people || []) {
    if (!personSessions[p]) personSessions[p] = [];
    personSessions[p].push(s);
  }
}

const popularPeople = Object.entries(personSessions)
  .sort((a, b) => b[1].length - a[1].length)
  .slice(0, 8);

for (const [person, pSessions] of popularPeople) {
  if (pSessions.length >= 2) {
    // Pick the first session for the person
    addQ(
      `What was ${person}'s first contribution that we discussed?`,
      pSessions[0].session_id, 'temporal-reasoning', 'hard'
    );
    // Pick a random session for "what did X work on"
    const rndSession = pSessions[Math.floor(rand() * pSessions.length)];
    addQ(
      `What project or task did ${person} work on?`,
      rndSession.session_id, 'multi-session', 'medium'
    );
  }
}

// Preference aggregate questions (hard — need to find the right preference)
const prefSessions = sessions.filter(s => s.topic === 'personal-preference');
for (let i = 0; i < Math.min(6, prefSessions.length); i++) {
  const s = prefSessions[i];
  addQ(
    `Who expressed a preference about ${s._meta.preference}?`,
    s.session_id, 'single-session-preference', 'hard'
  );
}

console.log(`Generated ${questions.length} questions`);

// ── Category counts ─────────────────────────────────────────────

const catCounts = {};
for (const q of questions) {
  catCounts[q.category] = (catCounts[q.category] || 0) + 1;
}
console.log('Category distribution:', catCounts);

// ── Clean up _meta from sessions before output ──────────────────

const cleanSessions = sessions.map(s => {
  const { _meta, ...rest } = s;
  return rest;
});

// ── Write output ────────────────────────────────────────────────

const corpus = {
  metadata: {
    generated: new Date().toISOString(),
    description: 'Synthetic corpus for OML vs MemPalace comparison benchmark',
    methodology: 'Follows LongMemEval structure with 6 question categories',
    sessions_count: cleanSessions.length,
    questions_count: questions.length,
    categories: Object.keys(catCounts),
  },
  sessions: cleanSessions,
  questions,
};

fs.writeFileSync(OUTPUT, JSON.stringify(corpus, null, 2));
console.log(`\nWritten to: ${OUTPUT}`);
console.log(`File size: ${(fs.statSync(OUTPUT).size / 1024).toFixed(1)} KB`);
