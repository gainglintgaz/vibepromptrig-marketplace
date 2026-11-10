#!/usr/bin/env node
// Native Claude Markdown only. No model calls, executable draft helpers or installation claims.
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { TextDecoder } from 'node:util';
import { readCheckup, inspectProject } from './checkup.mjs';
import { parseProjectJson } from './project-json.mjs';
import { reviewChange, applyChange, undoChange, readBytes, resolveInside, exactHash, inspectSources, screenSecrets, MAX_SOURCES } from './reviewed-edits.mjs';

const LIMIT = 64 * 1024;
const CHECKUP = '.vibepromptrig/checkup.json';
const TOOLS = new Set(['Read', 'Glob', 'Grep', 'AskUserQuestion']);
const fail = message => { throw new Error(message + ' Nothing was changed.'); };
const text = (value, label, max = 2000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) fail('Invalid ' + label);
};
function decode(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { fail('Native Markdown must use valid UTF-8; preserve the original file for review.'); }
}
function passive(value) {
  // These checks reject supported executable interpolation forms; they are not a semantic safety proof.
  if (/!`|\$\([^\n]*\)|<script\b|\b(?:node\s+-e|python\s+-c|(?:powershell|pwsh)\s+-(?:command|encodedcommand))\b|^\s*```\s*(?:bash|sh|shell|powershell|pwsh|javascript|js|python|cmd)\b/im.test(value)) fail('Executable or inline context injection is outside this native Markdown draft');
  if (/\bignore\s+(?:all\s+)?(?:previous|system)\s+instructions|\bbypass\s+(?:permissions|approval)|\b(?:approval|permission)\s+(?:is\s+)?(?:already\s+)?granted\b/i.test(value)) fail('A draft cannot grant permission or override trusted instructions');
}
function scalar(raw) {
  const value = raw.trim();
  if (value.startsWith('"')) { try { const parsed = JSON.parse(value); if (typeof parsed === 'string') return parsed; } catch {} fail('Invalid quoted native metadata'); }
  if (value.startsWith("'")) {
    if (!/^'[^']*'$/.test(value)) fail('Invalid quoted native metadata');
    return value.slice(1, -1);
  }
  if (!value || /^[>|&*!{]/.test(value) || /\s+#/.test(value)) fail('Unsupported native metadata value');
  return value;
}
export function validateNativeDraft(kind, content, name) {
  text(content, 'native draft', LIMIT); passive(content);
  if (!['skill', 'agent', 'instructions'].includes(kind)) fail('Choose one native draft kind');
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name || '')) fail('Invalid native name');
  if (kind === 'instructions') {
    if (/^\ufeff?---(?:\r?\n|$)|<!--\s*vibepromptrig:project-author:/i.test(content)) fail('Instruction section must contain body text without frontmatter or managed markers');
    return { name, tools: [], body: content };
  }
  const match = content.replace(/^\ufeff/, '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]+)$/);
  if (!match || match[2].trim().length < 20) fail('Malformed native frontmatter or missing body');
  const allowed = kind === 'skill' ? ['name', 'description', 'allowed-tools', 'disable-model-invocation'] : ['name', 'description', 'tools', 'model'];
  const fields = {}, lines = match[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].match(/^([a-z][a-z-]*):\s*(.*)$/);
    if (!line || !allowed.includes(line[1]) || Object.hasOwn(fields, line[1])) fail('Unknown, duplicate or malformed native metadata');
    const [, key, raw] = line;
    if (!raw && ['allowed-tools', 'tools'].includes(key)) {
      const values = [];
      while (i + 1 < lines.length && /^  - /.test(lines[i + 1])) values.push(scalar(lines[++i].slice(4)));
      fields[key] = values;
    } else fields[key] = scalar(raw);
  }
  if (allowed.filter(key => key !== 'disable-model-invocation').some(key => !Object.hasOwn(fields, key))) fail('Missing required native metadata');
  if (fields.name !== name) fail('Native metadata name must match the target name');
  text(fields.description, 'activation description', 600);
  if (fields.description.length < 20) fail('Native activation description needs a concrete task and scope');
  if (kind === 'skill' && Object.hasOwn(fields, 'disable-model-invocation') && !['true', 'false'].includes(fields['disable-model-invocation'])) fail('Invalid native model-invocation metadata');
  if (kind === 'agent' && fields.model !== 'inherit') fail('Native agent model must inherit; no paid model choice is granted');
  const raw = fields[kind === 'skill' ? 'allowed-tools' : 'tools'];
  let tools;
  if (Array.isArray(raw)) tools = raw;
  else {
    const value = raw.trim(), bracketed = value.startsWith('[') || value.endsWith(']');
    if (bracketed && !(value.startsWith('[') && value.endsWith(']'))) fail('Unbalanced native tool list brackets');
    const sequence = bracketed ? value.slice(1, -1) : value;
    tools = sequence.split(',').map(value => scalar(value));
  }
  if (!tools.length || tools.length > TOOLS.size || new Set(tools).size !== tools.length || tools.some(tool => !TOOLS.has(tool))) fail('Unknown or expanded native tool permission; supported draft tools are Read, Glob, Grep and AskUserQuestion');
  if (kind === 'agent' && tools.includes('AskUserQuestion')) fail('Native agents cannot use the AskUserQuestion tool');
  return { name, description: fields.description, tools, body: match[2] };
}
function sourcePath(path) {
  if (typeof path !== 'string' || /(?:^|\/)(?:\.env[^/]*|\.git|node_modules|credentials?|secrets?|tokens?|auth(?:\.json)?)(?:\/|$)/i.test(path) || /(?:credentials|private-key|id_rsa|\.pem$)/i.test(path)) fail('Credential or excluded source path');
  if (!/\.(?:md|json|mjs|js|ts|tsx|yaml|yml|toml|txt)$/.test(path) && !['go.mod', 'Gemfile'].includes(path)) fail('Unsupported source path');
}
function cases(values, label) {
  if (!Array.isArray(values) || !values.length || values.length > 8) fail('Provide one to eight ' + label + ' cases');
  values.forEach(value => text(value, label, 400));
  const normalized = values.map(value => value.trim().toLowerCase());
  if (new Set(normalized).size !== values.length) fail('Duplicate activation cases');
  return normalized;
}
function validateInput(input) {
  const required = ['kind', 'name', 'task', 'scope', 'sources', 'should_trigger', 'should_not_trigger', 'content'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || required.some(key => !Object.hasOwn(input, key)) || Object.keys(input).some(key => ![...required, 'replace_existing'].includes(key))) fail('Invalid authoring request fields');
  text(input.task, 'explicit task'); text(input.scope, 'activation scope'); passive(input.task); passive(input.scope);
  if (Object.hasOwn(input, 'replace_existing') && typeof input.replace_existing !== 'boolean') fail('Invalid replacement choice');
  if (!Array.isArray(input.sources) || !input.sources.length || input.sources.length > 12 || new Set(input.sources).size !== input.sources.length) fail('Choose one to twelve distinct source paths');
  input.sources.forEach(sourcePath);
  const yes = cases(input.should_trigger, 'should-trigger'), no = cases(input.should_not_trigger, 'should-not-trigger');
  if (yes.some(value => no.includes(value))) fail('Contradictory activation cases');
  return validateNativeDraft(input.kind, input.content, input.name);
}
function section(prior, name, content) {
  const old = prior === null ? '' : decode(prior);
  const newline = old.includes('\r\n') ? '\r\n' : '\n';
  const start = '<!-- vibepromptrig:project-author:' + name + ':start -->';
  const end = '<!-- vibepromptrig:project-author:' + name + ':end -->';
  const starts = old.split(start).length - 1, ends = old.split(end).length - 1;
  if (starts > 1 || ends > 1 || starts !== ends) fail('Duplicate or incomplete instruction section markers');
  const body = start + newline + content.replace(/\r?\n/g, newline).trimEnd() + newline + end;
  if (!starts) return { content: old + (old && !old.endsWith('\n') ? newline : '') + (old ? newline : '') + body + newline, exists: false };
  const first = old.indexOf(start), last = old.indexOf(end);
  if (last < first || (first && old[first - 1] !== '\n') || (old[last + end.length] && !['\r', '\n'].includes(old[last + end.length]))) fail('Instruction section markers must be unique complete lines');
  return { content: old.slice(0, first) + body + old.slice(last + end.length), exists: true };
}
function candidates(root) {
  const result = [];
  for (const [path, kind] of [['.claude/skills', 'skill'], ['.claude/agents', 'agent']]) {
    const directory = resolveInside(root, path);
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    if (entries.length > 100) fail('Too many native entries for this bounded authoring request; review existing tools manually');
    for (const entry of entries) if ((kind === 'skill' && entry.isDirectory()) || (kind === 'agent' && entry.isFile() && entry.name.endsWith('.md'))) result.push({ kind, name: kind === 'agent' ? entry.name.slice(0, -3) : entry.name });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}
export function draftProjectAuthor(root, input) {
  const metadata = validateInput(input);
  inspectSources(root, input.sources);
  const sourceEvidence = input.sources.map(path => {
    const bytes = readBytes(root, path);
    if (bytes === null) fail('A cited source is missing: ' + path);
    return { path, hash: exactHash(bytes) };
  });
  const checkup = readCheckup(root), findings = checkup.state || inspectProject(root);
  if (checkup.state && checkup.fresh !== true) fail('Saved checkup is stale or has unbound runtime evidence; inspect and reconcile fresh findings first');
  if (findings.observations.some(observation => observation.status === 'WRONG' && input.sources.some(path => observation.location === path || observation.location.startsWith(path + ':')))) fail('Contradictory findings in the cited source require reconciliation first');
  const target = input.kind === 'skill' ? '.claude/skills/' + input.name + '/SKILL.md' : input.kind === 'agent' ? '.claude/agents/' + input.name + '.md' : 'CLAUDE.md';
  const prior = readBytes(root, target);
  screenSecrets(prior, input.content); // Screen before every preview, including early returns.
  const addition = input.kind === 'instructions' ? section(prior, input.name, input.content) : { content: input.content, exists: prior !== null };
  const result = { status: addition.exists && !input.replace_existing ? 'prefer-existing' : 'draft', target, proposal: null,
    task: input.task, scope: input.scope, source_evidence: sourceEvidence, existing_candidates: candidates(root),
    activation: { should_trigger: input.should_trigger, should_not_trigger: input.should_not_trigger, evaluation: 'not_run' },
    metadata, preview: { before: prior === null ? null : decode(prior), after: addition.content },
    limitations: ['Native host loading, trigger relevance and useful behavior are unverified; test with the signed-in host separately.', 'Read-only tool subset; no executable helper, broad shell, settings or approval grants.', 'Native permission controls and action-scoped human approval remain authoritative.'] };
  if (!checkup.state) {
    result.limitations.push('No saved fresh checkup: conversation-only preview. Save reviewed findings first, then regenerate this draft.');
    return result;
  }
  if (result.status === 'prefer-existing') return result;
  const dependencies = [...new Set([CHECKUP, ...input.sources, ...findings.source.scope])].filter(path => path !== target);
  if (dependencies.length > MAX_SOURCES) fail('Checkup scope exceeds this bounded authoring transaction');
  result.proposal = reviewChange(root, { kind: input.kind, target, content: addition.content, dependencies });
  return result;
}
function validateInstructionProposal(root, proposal, bytes) {
  if (proposal.target !== 'CLAUDE.md') fail('Project author supports one CLAUDE.md section');
  const prior = readBytes(root, proposal.target);
  if (exactHash(prior) === proposal.after_hash) return; // A matching repeat cannot mutate this file.
  const after = decode(bytes);
  const matches = [...after.matchAll(/^<!-- vibepromptrig:project-author:([a-z0-9][a-z0-9-]{0,62}):start -->\r?\n([\s\S]*?)\r?\n<!-- vibepromptrig:project-author:\1:end -->/gm)];
  if (!matches.length || matches.length > 32) fail('Review exactly one bounded instruction section');
  let candidates = 0;
  for (const match of matches) {
    try {
      validateNativeDraft('instructions', match[2], match[1]);
      if (Buffer.from(section(prior, match[1], match[2]).content).equals(bytes)) candidates++;
    } catch {} // An unrelated existing section is not an instruction for this save.
  }
  if (candidates !== 1) fail('Save must change exactly one validated instruction section and preserve surrounding text');
}
export function saveProjectAuthor(root, proposal, reviewHash, approved = false) {
  if (approved !== true) fail('Explicit approval is required for the exact reviewed native draft');
  if (!proposal || !['skill', 'agent', 'instructions'].includes(proposal.kind)) fail('Choose one reviewed native authoring proposal');
  const current = readCheckup(root);
  if (!current.state || !proposal.dependencies?.some(dep => dep.path === CHECKUP && dep.hash === current.etag)) fail('A saved fresh reviewed checkup is required');
  if (!current.fresh && exactHash(readBytes(root, proposal.target)) !== proposal.after_hash) fail('Checkup changed or became stale since the authoring review');
  const name = proposal.kind === 'skill' ? proposal.target.split('/')[2] : proposal.kind === 'agent' ? proposal.target.split('/')[2]?.replace(/\.md$/, '') : null;
  const bytes = Buffer.from(proposal.content_base64, 'base64');
  if (name) validateNativeDraft(proposal.kind, decode(bytes), name);
  else validateInstructionProposal(root, proposal, bytes);
  return applyChange(root, proposal, reviewHash, approved);
}
export function main(args, root = process.cwd(), input) {
  const [action = 'draft', ...rest] = args;
  if (action === 'draft' && !rest.length && input) return JSON.stringify(draftProjectAuthor(root, parseProjectJson(input, 'reviewed authoring request')), null, 2) + '\n';
  if (action === 'save' && rest.length === 2 && rest[1] === '--approved' && input) return JSON.stringify(saveProjectAuthor(root, parseProjectJson(input, 'reviewed authoring proposal'), rest[0], true), null, 2) + '\n';
  if (action === 'undo' && rest.length === 3 && rest[2] === '--approved') return JSON.stringify(undoChange(root, rest[0], rest[1], true), null, 2) + '\n';
  fail('Use draft (default) with one authoring request on stdin, save <review-hash> --approved with its exact proposal on stdin, or undo <backup> <undo-hash> --approved');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const chunks = []; let size = 0;
    if (!process.stdin.isTTY && !['undo'].includes(process.argv[2])) for await (const chunk of process.stdin) { size += chunk.length; if (size > LIMIT * 4) fail('Reviewed request is too large'); chunks.push(chunk); }
    process.stdout.write(main(process.argv.slice(2), process.cwd(), chunks.length ? Buffer.concat(chunks) : undefined));
  } catch (error) {
    process.stderr.write('Project author could not continue: ' + (error.code ? 'A project file operation failed. Review the target and recovery record.' : error.message) + '\n');
    process.exitCode = 1;
  }
}




