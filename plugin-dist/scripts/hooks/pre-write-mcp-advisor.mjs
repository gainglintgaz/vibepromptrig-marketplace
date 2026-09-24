#!/usr/bin/env node
// pre-write-mcp-advisor.mjs
//
// PreToolUse(Write) hook -- VIBE Rule 24 enforcer. Before writing a new utility file in
// scripts/, src/lib/, lib/, .claude/agents/, or .claude/skills/, runs a deterministic
// (no-LLM) check for patterns overlapping known MCP/Skill marketplace offerings.
// Node twin of pre-write-mcp-advisor.ps1 (cross-platform port P2, T1a). Byte-identical:
// exit 0 = allow, exit 2 = block (stderr). Override: a `Justified: <reason>` line in the
// content. Fail-open on error. Dependency-free (Node stdlib only), Node >= 18.

import process from 'node:process';

if (process.env.VIBE_HOOKS_DISABLE) process.exit(0);

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    let done = false;
    const finish = () => { if (done) return; done = true; resolve(Buffer.concat(chunks)); };
    try {
      process.stdin.on('data', (c) => chunks.push(c));
      process.stdin.on('end', finish);
      process.stdin.on('error', finish);
      if (process.stdin.isTTY) finish();
    } catch { finish(); }
  });
}

const raw = await readStdin();
let text = raw.toString('utf8');
if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
text = text.trim();
if (!text) process.exit(0);

let hook;
try { hook = JSON.parse(text); } catch { process.exit(0); }
if (!hook || hook.tool_name !== 'Write') process.exit(0);

const ti = hook.tool_input || {};
const path = typeof ti.file_path === 'string' ? ti.file_path : '';
const content = typeof ti.content === 'string' ? ti.content : '';
if (!path || !content) process.exit(0);

const normPath = path.replace(/\\/g, '/');

const guarded = ['scripts/', '/src/lib/', '/lib/', '.claude/agents/', '.claude/skills/'];
let isGuarded = false;
for (const g of guarded) { if (normPath.includes(g)) { isGuarded = true; break; } }
if (!isGuarded) process.exit(0);

// Override: a Justified: line anywhere (comment-prefixed or bare).
if (/^\s*[#/*]+\s*justified:/im.test(content)) process.exit(0);
if (/Justified:\s+\S/m.test(content)) process.exit(0);

// Trivial files (< 20 non-blank lines) -- not a "new utility"; let pass.
const nonBlank = content.split('\n').filter((l) => l.trim().length > 0).length;
if (nonBlank < 20) process.exit(0);

// Heuristic patterns -- each names the existing MCP/Skill that should be considered.
const patterns = [
  { regex: /\b(pdf-?parse|pdf-?lib|pypdf|pdfminer|extract.*from.*pdf)\b/i, tip: 'anthropic-skills:pdf already handles PDF read/write/OCR.' },
  { regex: /\b(receipt|invoice).*\b(ocr|parse|extract)\b/i, tip: 'Gemini Vision via MCP already extracts receipts/invoices (Anthropic-official path).' },
  { regex: /\b(slack(_| )?(api|webhook|client|send-?message))\b/i, tip: 'Slack MCP already exists (Anthropic-official).' },
  { regex: /\b(discord(_| )?(api|webhook|bot))\b/i, tip: 'Discord MCP / claude-in-chrome can post to Discord webhooks.' },
  { regex: /\b(github.*(api|rest|graphql)|octokit)\b/i, tip: 'github MCP is already wired (search: github__*).' },
  { regex: /\b(stripe|invoice|charge|subscription).*\b(api|webhook|sdk)\b/i, tip: 'Stripe MCP is an Anthropic-official integration (per VIBE Rule 24 cite).' },
  { regex: /\b(sentry|posthog|datadog).*\b(api|capture|track)\b/i, tip: 'Sentry / Posthog / Datadog MCPs are off-the-shelf -- use those.' },
  { regex: /\b(xlsx|excel|spreadsheet).*\b(parse|write|generate|read)\b/i, tip: 'anthropic-skills:xlsx already handles xlsx/csv read+write.' },
  { regex: /\b(figma.*(parse|extract|design)|figma.*api)\b/i, tip: 'figma MCP is already wired (figma:* skills + use_figma tool).' },
  { regex: /\b(rss|atom).*\b(parse|reader|feed)\b/i, tip: 'rss-parser is a one-line npm; only build if no marketplace MCP is suitable.' },
  { regex: /\b(web.*scrape|scrape.*page|html.*extract|puppeteer|playwright.*navigate)\b/i, tip: 'firecrawl:firecrawl-scrape + firecrawl:firecrawl-agent already exist.' },
  { regex: /\bdoc(s|umentation).*search\b/i, tip: 'firecrawl:firecrawl-search / mcp-registry:search MCP cover doc-search.' },
  { regex: /\b(diagram|mermaid|chart).*generate\b/i, tip: 'figma-generate-diagram + data:create-viz already exist.' },
  { regex: /\bgoogle.*calendar.*(create|delete|update)\b/i, tip: 'Google Calendar MCP (Anthropic-official).' },
  { regex: /\b(gmail|outlook).*\b(send|draft|search)\b/i, tip: 'Gmail MCP is already wired.' },
];

const hits = [];
for (const p of patterns) {
  try { if (p.regex.test(content)) hits.push(p.tip); } catch { continue; }
}

if (hits.length === 0) process.exit(0);

process.stderr.write('[BLOCKED] mcp-advisor: this file may duplicate existing MCP/Skill marketplace functionality.\n');
process.stderr.write('          VIBE Rule 24 -- MCP/Skill First, never reinvent.\n');
process.stderr.write(`          File: ${path} (${nonBlank} non-blank lines)\n`);
process.stderr.write('          Overlap candidates:\n');
for (const tip of hits) process.stderr.write(`            - ${tip}\n`);
process.stderr.write('\n');
process.stderr.write('          To proceed, either:\n');
process.stderr.write('            1. Use the existing MCP/Skill (preferred)\n');
process.stderr.write('            2. Add a comment line near the top: `Justified: <reason>` explaining why this is different\n');
process.stderr.write("               (e.g., `Justified: anthropic-skills:pdf doesn't support fillable form export`)\n");
process.exit(2);
