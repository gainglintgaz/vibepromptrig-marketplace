export const meta = {
  name: 'factory-audit',
  description: 'Whole-factory health + drift sweep. Fans out forge doctor (= verify-factory drift checks), the auditor agent (SS9.2), and a wired-not-orphaned commit scan; returns one PASS/HOLD verdict. Orchestrates existing agents only -- reuses forge doctor, does not re-implement it.',
  phases: [
    { title: 'Probe' },
    { title: 'Synthesize' },
  ],
}

// args may arrive as a JSON string (verified via convention probe 2026-06-02) -- parse defensively.
function parseArgs(a) {
  if (a == null) return {}
  if (typeof a === 'object') return a
  try { return JSON.parse(a) } catch (e) {
    log('factory-audit: WARNING -- args string was not valid JSON; using default factoryRoot.')
    return {}
  }
}
const opts = parseArgs(args)
const factoryRoot = opts.factoryRoot || process.env.VIBE_ROOT || process.cwd()

const PROBE = {
  type: 'object',
  required: ['check', 'status', 'summary'],
  properties: {
    check:   { type: 'string', description: 'short probe name' },
    status:  { type: 'string', enum: ['pass', 'fail', 'warn', 'skip'] },
    summary: { type: 'string', description: 'one-line plain-English result, ASCII only, no secret values' },
    fixes:   { type: 'array', items: { type: 'string' }, description: 'concrete fix per finding; empty if none' },
  },
}

phase('Probe')
const probes = await parallel([
  // Probe A: forge doctor. verify-factory already covers rules-list, agents-list, skills-list,
  // mirror-freshness, scripts-list, version-citations -- so this single probe IS the registry/mirror/
  // drift check. (Architect/Engineer conflict resolved to reuse, per the workflow-library arch doc.)
  () => agent(
    [
      'Run the factory health check from the factory root and report its verdict.',
      'Step 1 (Bash): powershell -NoProfile -ExecutionPolicy Bypass -File scripts/forge.ps1 doctor --json',
      '  If --json output is hard to parse, re-run without --json and read the verdict line.',
      'Step 2: parse the four counts -- pass / warn / skip / fail.',
      'Return status=pass ONLY if fail==0 AND warn==0 AND skip==0 (the 12/0/0/0 bar);',
      'status=warn if fail==0 but warn or skip > 0; status=fail if any fail > 0.',
      'summary = the verdict line verbatim (e.g. "12 pass / 0 warn / 0 skip / 0 fail").',
      'fixes = the name + message of each non-pass check (empty array if all pass).',
      'This probe IS the registry/mirror/drift check -- do NOT separately re-implement verify-factory.',
      'check = "forge-doctor".',
    ].join('\n'),
    { agentType: 'general-purpose', label: 'doctor+drift', phase: 'Probe', schema: PROBE }
  ),
  // Probe B: auditor agent -- the SS9.2 app-code audit gate, run against the factory root.
  () => agent(
    [
      'Audit the FACTORY ROOT itself as the target (not a customer product).',
      'The factory root has no package.json/src, so the build + test gates SKIP -- that is expected and',
      'honest, NOT a failure. Focus your SS9.2 checklist on: tripwire greps over scripts/ and .claude/,',
      'registry freshness (DECISIONS.md / data-flow if present), and the privacy spot-checks.',
      'Return status=pass if nothing actionable; status=fail ONLY for a real violation; status=skip if',
      'the audit cannot meaningfully run. summary = one line. fixes = one per real finding.',
      'check = "auditor".',
    ].join('\n'),
    { agentType: 'auditor', label: 'auditor', phase: 'Probe', schema: PROBE }
  ),
  // Probe C: wired-not-orphaned scan -- proof-language commits lacking a Wiring-tracked marker.
  () => agent(
    [
      'Scan for proven-not-wired debt per wired-not-orphaned.md SS5.',
      'Step 1 (Bash): git log -100 --format="===%n%H %s%n%b"',
      'Step 2: find commits whose subject OR body contains proof-language:',
      '  "proof of concept", "POC", "MVP", "proven on", "first <N>", "pattern established".',
      'Step 3: for each such commit, check whether its body contains the literal "Wiring-tracked:".',
      '  A proof-language commit lacking "Wiring-tracked:" is wiring-debt.',
      'Return status=pass if zero wiring-debt commits (say so honestly), status=warn if 1-2, status=fail',
      'if 3 or more. summary = count + the short SHAs. fixes = "track fan-out for <SHA> (cockpit',
      'proven-not-wired milestone or directive)" per debt commit. Include NO secret-shaped strings.',
      'check = "wired-not-orphaned".',
    ].join('\n'),
    { agentType: 'general-purpose', label: 'wired-not-orphaned', phase: 'Probe', schema: PROBE }
  ),
])

phase('Synthesize')
const found = probes.filter(Boolean)
const errored = probes.length - found.length          // null => that agent errored
const failed = found.filter(p => p.status === 'fail')
const warned = found.filter(p => p.status === 'warn')
const skipped = found.filter(p => p.status === 'skip')
// Distinguish a real clean-green from a vacuous all-skip green so a caller reading only the verdict
// is not misled (review-gate LOW). skippedAll = every probe returned, none failed, all skipped.
const skippedAll = found.length === probes.length && failed.length === 0 && skipped.length === found.length && found.length > 0
const verdict = (failed.length > 0 || errored > 0) ? 'HOLD' : (skippedAll ? 'PASS-SKIPPED' : 'PASS')

const lines = [`FACTORY AUDIT -- verdict: ${verdict}  (factoryRoot=${factoryRoot})`]
for (const p of found) {
  lines.push(`  [${String(p.status).toUpperCase()}] ${p.check}: ${p.summary}`)
  for (const f of (p.fixes || [])) lines.push(`        fix: ${f}`)
}
if (errored > 0) lines.push(`  [ERROR] ${errored} probe(s) failed to return -- treated as HOLD`)
if (found.length === probes.length && failed.length === 0) lines.push('  (no blocking findings)')
log(lines.join('\n'))

return {
  verdict,
  skippedAll,
  probeCount: found.length,
  errored,
  failed: failed.map(p => p.check),
  warned: warned.map(p => p.check),
  skipped: skipped.map(p => p.check),
  probes: found,
}
