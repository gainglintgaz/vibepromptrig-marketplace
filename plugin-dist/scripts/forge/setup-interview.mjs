#!/usr/bin/env node
// Read-only setup interview: shared questions, answer normalization and consent cards.
// No project writes, network calls, connector startup or installation.
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readProjectJson, checkSetupProjectJson, ProjectJsonError } from './project-json.mjs';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const option = (value, label, description) => ({ value, label, description });
const unsure = (description) => option('unsure', "I'm not sure", description);

export function questionGroups(detected = []) {
  return [
    { id: 'goal', question: 'What do you want to make, and what would be a useful first result?',
    why: 'Your goal comes before frameworks, hosting or tool connections. Making money alone does not mean bookkeeping.',
    pages: [{ options: [option('describe', 'Describe your idea', 'For example, a physical product, an app, a shop, or a mix; explain what you want to make.'), unsure('Ask for examples and keep the goal unknown until you can describe a first result.')] }] },
    { id: 'framework', question: detected.length
      ? 'We found signs of ' + detected.join(', ') + '. Does that look right?'
      : 'We could not identify what your project is built with yet. Can you help?',
    why: 'This helps us suggest tools that fit your project.',
    pages: [{ options: [
      ...(detected.length ? [option('yes', 'Yes, that looks right', 'Confirm only if you recognize what we found.')] : []),
      option('no', "No, I'll explain", 'Tell us what you use; we will not keep a wrong guess.'),
      unsure('Use the file evidence as unconfirmed; do not guess what is missing.'),
    ] }] },
    { id: 'domain', question: 'What is this project for?',
    why: 'Different projects need different guidance.',
    pages: [{ options: [
      option('ecommerce', 'An online shop', 'Sell products or services online.'),
      option('saas', 'A business or customer app', 'Help people do work or use a service.'),
      option('finance', 'Financial records or bookkeeping', 'Choose only when the product manages financial records; wanting to earn money is not this category.'),
      option('more', 'More choices / not sure', 'See website, developer-tool and unsure choices.'),
    ] }, { when: 'more', options: [
      option('content', 'A website or marketing project', 'Publish articles, information or marketing pages.'),
      option('devtools', 'A tool for developers', 'Help people build or maintain software.'),
      option('unknown', 'Something else', 'Describe it in your own words; no category is assumed.'),
      unsure('Keep the purpose unknown; use general guidance.'),
    ] }] },
    { id: 'sharing', question: 'Who needs access to the information in your app?',
    why: "This tells us whether different people must be kept from seeing each other's information. You can build it alone and still have customers with private accounts.",
    pages: [{ options: [
      option('only-me', 'Only me', 'You are the only person who will use the information.'),
      option('shared', 'People sharing the same information', 'A group sees the same records.'),
      option('separate', 'Separate people or customers', "Each person or customer needs their own private information."),
      unsure('Keep this unknown and suggest extra privacy guidance; do not assume only you use it.'),
    ] }] },
    { id: 'help_mode', question: 'Would you like tool connections, project guidance, or help deciding?',
    why: 'Choose one starting point. Nothing is connected or installed by choosing it.',
    pages: [{ options: [
      option('connections', 'Suggest useful connections', 'Then choose only the areas relevant to your goal.'),
      option('guidance', 'Project guidance only', 'No external connections; explain a useful next step.'),
      unsure('Explain the choices before asking me to decide; no connections are assumed.'),
    ] }] },
    { id: 'help', when: 'connections', multiSelect: true, uncertainty: "If you're not sure, go back to the starting choice and choose help deciding. Clear earlier areas first.", question: 'Which connection areas would help your goal?',
    why: 'Ask this only after you choose connections. You may select several relevant areas, or go back.',
    pages: [{ options: [
      option('data', 'Storing information', 'Work with the database your app uses.'),
      option('hosting', 'Putting the app online', 'Work with your website hosting service.'),
      option('payments', 'Accepting payments', 'Work with your payment service.'),
      option('testing', 'Checking work automatically', 'Get help with tests and code review.'),
    ] }] },
    { id: 'sensitive', question: 'Will it handle money or personal information, such as names, emails, addresses, health details or ID numbers?',
    why: 'These need extra care.',
    pages: [{ options: [
      option('yes', 'Yes', 'Suggest extra care for money and private information.'),
      option('no', 'No', 'Do not assume that kind of information is present.'),
      unsure('Suggest extra protective guidance, while keeping the answer unknown.'),
    ] }] },
  ];
}

function choice(value, allowed, name, fallback = 'unsure') {
  const answer = value ?? fallback;
  if (!allowed.includes(answer)) throw new Error('Unsupported answer for ' + name + '; choose a listed option or unsure.');
  return answer;
}

export function normalizeAnswers(input = {}, detected = []) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Unsupported answers.');
  for (const key of Object.keys(input)) if (!['goal', 'framework', 'domain', 'sharing', 'help_mode', 'help', 'sensitive'].includes(key)) throw new Error('Unsupported answer field: ' + key);
  if (input.goal !== undefined && (typeof input.goal !== 'string' || !input.goal.trim() || input.goal.length > 2000 || /[\x00-\x1f]/.test(input.goal))) throw new Error('Describe a short goal without private details.');
  const framework = choice(input.framework, ['yes', 'no', 'unsure'], 'framework');
  if (framework === 'yes' && !detected.length) throw new Error('Cannot confirm a framework without detected evidence.');
  const domain = choice(input.domain, ['finance', 'bookkeeping', 'saas', 'ecommerce', 'content', 'devtools', 'unknown', 'unsure'], 'domain');
  const sharing = choice(input.sharing, ['only-me', 'shared', 'separate', 'unsure'], 'sharing');
  const sensitive = choice(input.sensitive, ['yes', 'no', 'unsure'], 'sensitive');
  const rawHelp = input.help ?? [];
  if (!Array.isArray(rawHelp)) throw new Error('Help answers must be a list.');
  const help = [...new Set(rawHelp.map(value => choice(value, ['data', 'hosting', 'payments', 'testing', 'instructions', 'unsure'], 'help')))];
  if (help.some(value => ['instructions', 'unsure'].includes(value)) && help.length > 1) throw new Error('Choose help areas OR instructions only/unsure; do not combine them.');
  const selectedHelp = help.filter(value => !['instructions', 'unsure'].includes(value));
  // Preserve the old CLI/record format, but new interviews ask this exclusive choice first.
  const mode = choice(input.help_mode, ['connections', 'guidance', 'unsure'], 'connection preference', selectedHelp.length ? 'connections' : help.includes('instructions') ? 'guidance' : 'unsure');
  if (mode !== 'connections' && selectedHelp.length) throw new Error('Choose connections before selecting connection areas; do not combine guidance or unsure with areas.');
  return {
    goal: input.goal?.trim() ?? null,
    goal_status: input.goal ? 'provided-needs-confirmation' : 'needs-clarification',
    framework: { status: framework === 'yes' ? 'confirmed' : framework === 'no' ? 'rejected' : 'unconfirmed', detected: framework === 'no' ? [] : [...detected] },
    domain: domain === 'unsure' ? 'unknown' : domain,
    sharing: sharing === 'unsure' ? 'unknown' : sharing,
    sensitive: sensitive === 'unsure' ? 'unknown' : sensitive,
    protective_guidance: sensitive !== 'no' || sharing === 'separate' || sharing === 'unsure',
    help: selectedHelp,
    help_mode: mode,
    allow_connectors: mode === 'connections' && selectedHelp.length > 0,
  };
}

// This is an additional filter, not a replacement for stack matching, tombstones,
// installed-item checks, factory special-case handling or the five-item cap.
export function entryEligible(entry, answers) {
  if (entry.tombstoned) return false;
  if (entry.id === 'rule-finance-primer-reference-v2' && !['finance', 'bookkeeping'].includes(answers.domain)) return false;
  if (entry.id === 'rule-customer-information-reference-v1') return answers.protective_guidance === true;
  if (entry.kind !== 'mcp') return true;
  if (!answers.allow_connectors) return false;
  const surface = { 'mcp-supabase': 'data', 'mcp-vercel': 'hosting', 'mcp-stripe': 'payments', 'mcp-github': 'testing', 'mcp-cloudflare-docs': 'hosting' }[entry.id];
  return Boolean(surface && answers.help.includes(surface));
}

export function renderQuestions(groups, platform = process.platform, manual = false) {
  const lines = [
    'VibePromptRig setup',
    manual ? "I'll ask about your project without using the unreadable files." : "I'll look at your project and suggest a few useful tools and project instructions.",
    'You can skip any suggestion. Before adding anything, I will show which files would change and how to undo it.',
    manual ? 'This questions-only run writes nothing, including setup records. You can review suggestions, but no additions will be applied.'
      : platform === 'win32' ? 'Questions and suggestions write nothing. Before saving a local run record or adding anything, I will ask you.'
      : 'On this computer, setup provides a manual checklist and writes nothing.',
    'Needs Claude Code with your project open, Node.js (runs the helper tools), and Git (tracks file changes).',
    'Project instructions guide Claude; they do not guarantee that mistakes are prevented.',
  ];
  for (const [index, group] of groups.entries()) {
    if (group.when) lines.push('', 'Only if you chose ' + group.when + ':');
    lines.push('', (index + 1) + '. ' + group.question, 'Why we ask: ' + group.why);
    if (group.uncertainty) lines.push(group.uncertainty);
    for (const page of group.pages) {
      if (page.when) lines.push('  More choices (only when you request them):');
      for (const item of page.options) lines.push('  - ' + item.label + ': ' + item.description);
    }
  }
  lines.push('', 'No suggested answer is submitted for you.');
  return lines.join('\n') + '\n';
}

export function renderProposal(entry) {
  if (!entry || entry.tombstoned) throw new Error('Unknown or retired proposal.');
  const isConnection = entry.kind === 'mcp';
  const changes = isConnection
    ? 'After approval, add connection settings to .mcp.json in this project. No service is started. Existing connections are kept.'
    : entry.kind === 'hook'
      ? 'After approval, copy automated checks to .githooks/ and the listed helper files, and set this project to run them before commits. They can block a commit. Existing checks are kept or skipped on conflict.'
      : 'After approval, copy project instructions to ' + entry.install.target + '. Existing customized files are skipped.';
  return [
    entry.plain_name || entry.name,
    'What it does: ' + entry.plain_summary,
    'Why it fits: ' + entry.plain_when + ' This card explains the option; file evidence or your answer must match before setup recommends it.',
    'Access: ' + entry.plain_access,
    'Needed account: ' + entry.plain_account,
    'Our advice: Optional. Skip it if you do not need it. ' + (entry.publisher_verified ? 'The source was reviewed by VibePromptRig; it is not run or tested in your project.' : 'This configuration is not personally tested by VibePromptRig; it is not connected or tested in your project.'),
    'Changes and undo: ' + changes + ' Setup records how to undo approved changes before making them.',
    'Details:',
    '  Exact change: ' + (entry.install.command || JSON.stringify(entry.install)),
    '  Setup writes project settings; a command shown with user scope is a catalog reference, not permission for a global change.',
    '  Source: ' + entry.source_url,
    '  Review record: ' + entry.verified_against + '; last checked ' + entry.last_vetted + '; publisher_verified=' + entry.publisher_verified,
    '  Declared technical permissions: ' + JSON.stringify(entry.known_permissions),
    'Select / Skip - selecting a card is not approval to install it.',
  ].join('\n') + '\n';
}

function detectFramework(cwd) {
  const path = join(cwd, 'package.json');
  if (!existsSync(path)) return [];
  const data = readProjectJson(path, 'package.json');
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ProjectJsonError('package.json');
  const dependencies = { ...data.dependencies, ...data.devDependencies };
  if (dependencies.next) return ['Next.js (a tool for building websites)'];
  if (dependencies.react) return ['React (a tool for building app screens)'];
  if (dependencies.vue) return ['Vue (a tool for building app screens)'];
  return [];
}

export function main(args, cwd = process.cwd()) {
  const action = args.shift();
  const manual = ['questions', 'answers'].includes(action) && args[0] === '--manual';
  if (manual) args.shift();
  if (['check-project', 'questions', 'answers'].includes(action) && !manual) checkSetupProjectJson(cwd);
  if (action === 'check-project' && !args.length) return 'Project files can be read. Nothing was changed.\n';
  if (action === 'questions' && !args.length) return renderQuestions(questionGroups(manual ? [] : detectFramework(cwd)), process.platform, manual);
  if (action === 'proposal' && args.length === 1) {
    const catalogPath = existsSync(join(root, 'catalog.json')) ? join(root, 'catalog.json') : join(root, '.claude-plugin/catalog.json');
    const catalog = readProjectJson(catalogPath);
    return renderProposal(catalog.entries.find(entry => entry.id === args[0]));
  }
  if (action === 'answers') {
    const input = {};
    for (let index = 0; index < args.length; index += 2) {
      const key = args[index]?.replace(/^--/, '');
      if (!['goal', 'framework', 'domain', 'sharing', 'help_mode', 'help', 'sensitive'].includes(key) || !args[index + 1] || args[index + 1].startsWith('--') || Object.hasOwn(input, key)) throw new Error('Unsupported or missing answer option.');
      input[key] = key === 'help' ? args[index + 1].split(',') : args[index + 1];
    }
    const answers = normalizeAnswers(input, manual ? [] : detectFramework(cwd));
    const catalogPath = existsSync(join(root, 'catalog.json')) ? join(root, 'catalog.json') : join(root, '.claude-plugin/catalog.json');
    const catalog = readProjectJson(catalogPath);
    return JSON.stringify({ ...answers, eligible_catalog_ids: catalog.entries.filter(entry => entryEligible(entry, answers)).map(entry => entry.id) }, null, 2) + '\n';
  }
  throw new Error('Use questions, proposal <catalog-id>, or answers --goal <what-you-want-to-make> --framework <yes|no|unsure> --domain <purpose> --sharing <choice> --help <comma-separated choices> --sensitive <yes|no|unsure>.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(main(process.argv.slice(2))); }
  catch (error) { process.stderr.write('Setup could not prepare this answer: ' + error.message + '\n'); process.exitCode = 1; }
}
