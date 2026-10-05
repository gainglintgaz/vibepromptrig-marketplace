export const meta = {
  name: 'security-sweep',
  description: 'Pre-launch security + privacy gate. Fans out secrets tripwires + schema-auditor (RLS/advisor) + auditor (verify_jwt/buckets) + hostile-architect (boundary + AI-recommendation attacks); returns a severity-ranked findings table + go/no-go. Orchestrates existing agents only.',
  phases: [
    { title: 'Sweep' },
    { title: 'Rank' },
  ],
}

function parseArgs(a) {
  if (a == null) return {}
  if (typeof a === 'object') return a
  try { return JSON.parse(a) } catch (e) {
    log('security-sweep: WARNING -- args string was not valid JSON; using default projectPath.')
    return {}
  }
}
const opts = parseArgs(args)
const projectPath = opts.projectPath || process.env.VIBE_ROOT || process.cwd()

// Belt-and-suspenders (the secrets contract is agent-enforced; this is a deterministic backstop):
// redact any secret-shaped token before it is printed, since workflow output may be logged.
function redact(s) {
  return String(s)
    .replace(/sbp_[A-Za-z0-9]{8,}/g, 'sbp_[REDACTED]')
    .replace(/sk-ant-[A-Za-z0-9-]{8,}/g, 'sk-ant-[REDACTED]')
    .replace(/sk-proj-[A-Za-z0-9-]{8,}/g, 'sk-proj-[REDACTED]')
    .replace(/sk-[A-Za-z0-9]{16,}/g, 'sk-[REDACTED]')
    .replace(/AKIA[A-Z0-9]{16}/g, 'AKIA[REDACTED]')
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, 'eyJ[REDACTED-JWT]')
    .replace(/npg_[A-Za-z0-9]{8,}/g, 'npg_[REDACTED]')
}

const FINDINGS = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'title', 'where'],
        properties: {
          severity: { type: 'string', enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'] },
          title:    { type: 'string', description: 'ASCII only. For a secret hit, use pattern-name + file:line ONLY -- NEVER the secret value.' },
          where:    { type: 'string', description: 'file:line or surface name' },
          fix:      { type: 'string', description: 'concrete remediation' },
        },
      },
    },
    note: { type: 'string', description: 'one-line context, e.g. "no app surface present" or "no supabase"' },
  },
}

phase('Sweep')
const probes = await parallel([
  // Secrets / privacy tripwires. CRITICAL: never echo a matched secret value into output.
  () => agent(
    [
      `Target: ${projectPath}. Run secrets + privacy tripwire greps over source, scripts, and config.`,
      'Patterns to grep:',
      '  - VITE_-prefixed secret-shaped names:  VITE_[A-Z_]*(SECRET|KEY|TOKEN|PRIVATE)',
      '  - dangerouslyAllowBrowser: true',
      '  - hardcoded secret shapes:  sbp_   sk-ant-   sk-proj-   AKIA[A-Z0-9]{16}   eyJhbGci (JWT)',
      '  - .env reads in code:  Get-Content .env ,  cat .env ,  Read tool on *.env files',
      'ABSOLUTE RULE (secrets-handling.md SS2.3): report ONLY the pattern name + file:line. NEVER include',
      'the matched secret value, not even partially. If a real secret value is present, report',
      '"secret-shaped string present (rotate)" + its location -- do NOT transcribe the value.',
      'Severity map: hardcoded live-secret shape = CRITICAL; VITE_ secret or dangerouslyAllowBrowser = HIGH;',
      '.env read inside code = MEDIUM. If clean, return findings=[] and set note to say so.',
    ].join('\n'),
    { agentType: 'general-purpose', label: 'secrets-tripwire', phase: 'Sweep', schema: FINDINGS }
  ),
  // schema-auditor -- RLS on every table + Supabase advisor (security).
  () => agent(
    [
      `Target: ${projectPath}. Run RLS-on-every-table + Supabase advisor (security) scan. If there is no`,
      'supabase/ directory OR the Supabase MCP is unavailable, return findings=[] with note "no supabase',
      'surface" -- do NOT fabricate. Map advisor ERROR -> CRITICAL or HIGH, WARN -> MEDIUM. where = the',
      'table or function name.',
    ].join('\n'),
    { agentType: 'schema-auditor', label: 'schema-security', phase: 'Sweep', schema: FINDINGS }
  ),
  // auditor -- verify_jwt on destructive Edge Functions + storage-bucket privacy.
  () => agent(
    [
      `Target: ${projectPath}. Check two things: (1) every destructive Edge Function (write/update/delete)`,
      'has verify_jwt:true -- verify_jwt:false on a destructive function = CRITICAL (lessons-critical #81);',
      '(2) storage buckets holding user content are private -- a public user-content bucket = HIGH.',
      'If there are no supabase/functions and no buckets, return findings=[] with a note. where = the',
      'function or bucket name.',
    ].join('\n'),
    { agentType: 'auditor', label: 'jwt-bucket', phase: 'Sweep', schema: FINDINGS }
  ),
  // hostile-architect -- Phase 5 (system boundary) + Phase 1.6 (AI-recommendation attacks).
  () => agent(
    [
      `Target: ${projectPath}. Run hostile-architect Phase 5 (system boundary: RLS reachability, Edge cold`,
      'starts/timeouts, AI API response-format changes, external rate limits) AND Phase 1.6 (AI purchase-',
      'research / recommendation attacks: hallucinated URLs, retailer 403 vs 404, citation/body mismatch,',
      'double-rating inflation, structured-output schema drift, stale blocklist, uncapped scrape budget,',
      'deal-score with <3 price points). Assess ONLY surfaces the target actually has -- if a surface is',
      'absent, do NOT invent a finding. Severity per your standard protocol. where = the surface.',
    ].join('\n'),
    { agentType: 'hostile-architect', label: 'boundary+ai-attack', phase: 'Sweep', schema: FINDINGS }
  ),
])

phase('Rank')
const live = probes.filter(Boolean)
const errored = probes.length - live.length
const notes = live.map(p => p.note).filter(Boolean)
const all = live.flatMap(p => (p.findings || []))
const order = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, INFO: 4 }
all.sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9))
const critical = all.filter(f => f.severity === 'CRITICAL').length
const high = all.filter(f => f.severity === 'HIGH').length
const goNoGo = (critical > 0 || high > 0 || errored > 0) ? 'NO-GO' : 'GO'

const lines = [`SECURITY SWEEP -- ${goNoGo}  (target=${projectPath})  ${all.length} finding(s): ${critical} CRITICAL / ${high} HIGH`]
for (const f of all) lines.push(`  [${f.severity}] ${f.title} -- ${f.where}${f.fix ? '  fix: ' + f.fix : ''}`)
for (const n of notes) lines.push(`  note: ${n}`)
if (errored > 0) lines.push(`  [ERROR] ${errored} probe(s) failed to return -- treated as NO-GO`)
if (all.length === 0 && errored === 0) lines.push('  (no findings -- clean for the surfaces present)')
log(redact(lines.join('\n')))

return {
  goNoGo,
  critical,
  high,
  total: all.length,
  errored,
  notes,
  findings: all,
}
