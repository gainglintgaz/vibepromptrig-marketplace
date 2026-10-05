<#
.SYNOPSIS
    VIBE Rule 24 enforcer -- PreToolUse hook on Write tool.
    Before writing a new utility file in scripts/, src/lib/, lib/, .claude/agents/,
    or .claude/skills/, runs a deterministic check for patterns that overlap with
    known MCP/Skill marketplace offerings. Exit 2 = block with stderr; the agent
    can retry after either using an existing MCP/Skill or adding a Justified: line.

.NOTES
    PowerShell 5.1 compatible. ASCII only. Reads stdin per Claude Code hook spec.
    Heuristic-only: does NOT invoke an LLM. Cheap, fast, deterministic.

    Override: include the line ``Justified: <reason>`` anywhere in the file content
    (e.g., as a comment near the top). The hook will then emit a warning but allow.

    Patterns this catches:
      pdf/ocr        -> anthropic-skills:pdf already covers this
      receipt/invoice -> Gemini Vision MCP already covers
      slack/discord  -> Slack/Discord MCPs already exist
      github          -> github MCP already wired
      stripe          -> Stripe MCP exists
      sentry/posthog -> off-the-shelf integrations available
      excel/xlsx     -> anthropic-skills:xlsx
      figma          -> figma MCP wired
      diagram/chart  -> figma-generate-diagram + data:create-viz exist
      rss-parser     -> Use claude-in-chrome MCP or firecrawl
      web-scrape     -> firecrawl:* skills cover
      docs-site-search -> firecrawl:firecrawl-search wraps perplexity equivalents
#>

param()
$ErrorActionPreference = "SilentlyContinue"

# UTF-8 stdin
try {
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    [Console]::InputEncoding  = $utf8NoBom
    [Console]::OutputEncoding = $utf8NoBom
} catch { }

$stdin = $null
try { $stdin = [Console]::In.ReadToEnd() } catch { exit 0 }
if (-not $stdin -or $stdin.Trim().Length -eq 0) { exit 0 }

$hook = $null
try { $hook = $stdin | ConvertFrom-Json } catch { exit 0 }
if (-not $hook -or $hook.tool_name -ne "Write") { exit 0 }

$path = [string]$hook.tool_input.file_path
$content = [string]$hook.tool_input.content
if (-not $path -or -not $content) { exit 0 }

# Normalize path for matching
$normPath = $path -replace '\\', '/'

# Only fire on guarded directories
$guarded = @(
    'scripts/', '/src/lib/', '/lib/', '.claude/agents/', '.claude/skills/'
)
$isGuarded = $false
foreach ($g in $guarded) {
    if ($normPath -like "*$g*") { $isGuarded = $true; break }
}
if (-not $isGuarded) { exit 0 }

# Allow override
if ($content -match '(?im)^\s*[#/*]+\s*justified:') { exit 0 }
if ($content -match '(?m)Justified:\s+\S') { exit 0 }

# Trivial files (< 20 non-blank lines) -- not a "new utility"; let it pass
$nonBlank = ($content -split "`n" | Where-Object { $_.Trim().Length -gt 0 }).Count
if ($nonBlank -lt 20) { exit 0 }

# Heuristic patterns -- each names the existing MCP/Skill that should be considered
$patterns = @(
    @{ regex='(?i)\b(pdf-?parse|pdf-?lib|pypdf|pdfminer|extract.*from.*pdf)\b';                                         tip='anthropic-skills:pdf already handles PDF read/write/OCR.' },
    @{ regex='(?i)\b(receipt|invoice).*\b(ocr|parse|extract)\b';                                                          tip='Gemini Vision via MCP already extracts receipts/invoices (Anthropic-official path).' },
    @{ regex='(?i)\b(slack(_| )?(api|webhook|client|send-?message))\b';                                                   tip='Slack MCP already exists (Anthropic-official).' },
    @{ regex='(?i)\b(discord(_| )?(api|webhook|bot))\b';                                                                  tip='Discord MCP / claude-in-chrome can post to Discord webhooks.' },
    @{ regex='(?i)\b(github.*(api|rest|graphql)|octokit)\b';                                                              tip='github MCP is already wired (search: github__*).' },
    @{ regex='(?i)\b(stripe|invoice|charge|subscription).*\b(api|webhook|sdk)\b';                                         tip='Stripe MCP is an Anthropic-official integration (per VIBE Rule 24 cite).' },
    @{ regex='(?i)\b(sentry|posthog|datadog).*\b(api|capture|track)\b';                                                   tip='Sentry / Posthog / Datadog MCPs are off-the-shelf -- use those.' },
    @{ regex='(?i)\b(xlsx|excel|spreadsheet).*\b(parse|write|generate|read)\b';                                           tip='anthropic-skills:xlsx already handles xlsx/csv read+write.' },
    @{ regex='(?i)\b(figma.*(parse|extract|design)|figma.*api)\b';                                                        tip='figma MCP is already wired (figma:* skills + use_figma tool).' },
    @{ regex='(?i)\b(rss|atom).*\b(parse|reader|feed)\b';                                                                 tip='rss-parser is a one-line npm; only build if no marketplace MCP is suitable.' },
    @{ regex='(?i)\b(web.*scrape|scrape.*page|html.*extract|puppeteer|playwright.*navigate)\b';                           tip='firecrawl:firecrawl-scrape + firecrawl:firecrawl-agent already exist.' },
    @{ regex='(?i)\bdoc(s|umentation).*search\b';                                                                          tip='firecrawl:firecrawl-search / mcp-registry:search MCP cover doc-search.' },
    @{ regex='(?i)\b(diagram|mermaid|chart).*generate\b';                                                                  tip='figma-generate-diagram + data:create-viz already exist.' },
    @{ regex='(?i)\bgoogle.*calendar.*(create|delete|update)\b';                                                           tip='Google Calendar MCP (Anthropic-official).' },
    @{ regex='(?i)\b(gmail|outlook).*\b(send|draft|search)\b';                                                             tip='Gmail MCP is already wired.' }
)

$hits = [System.Collections.Generic.List[object]]::new()
foreach ($p in $patterns) {
    try {
        if ($content -match $p.regex) {
            $hits.Add(@{ pattern=$p.regex; tip=$p.tip })
        }
    } catch { continue }
}

if ($hits.Count -eq 0) { exit 0 }

[Console]::Error.WriteLine("[BLOCKED] mcp-advisor: this file may duplicate existing MCP/Skill marketplace functionality.")
[Console]::Error.WriteLine("          VIBE Rule 24 -- MCP/Skill First, never reinvent.")
[Console]::Error.WriteLine("          File: $path ($nonBlank non-blank lines)")
[Console]::Error.WriteLine("          Overlap candidates:")
foreach ($h in $hits) {
    [Console]::Error.WriteLine("            - $($h.tip)")
}
[Console]::Error.WriteLine("")
[Console]::Error.WriteLine("          To proceed, either:")
[Console]::Error.WriteLine("            1. Use the existing MCP/Skill (preferred)")
[Console]::Error.WriteLine("            2. Add a comment line near the top: ``Justified: <reason>`` explaining why this is different")
[Console]::Error.WriteLine("               (e.g., ``Justified: anthropic-skills:pdf doesn't support fillable form export``)")
exit 2
