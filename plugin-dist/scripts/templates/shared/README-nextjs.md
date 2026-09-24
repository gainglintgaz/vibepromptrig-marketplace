# {{PROJECT_NAME}}

Scaffolded by VibePromptRig AI OS.

## Setup
```bash
npm install
cp .env.example .env.local
# Fill in your API keys in .env.local
npm run dev
```

## Development
```bash
cd {{PROJECT_PATH}} && claude
```
Claude Code loads the compact VibePromptRig context from `.claude/CLAUDE.md`; run `node scripts/forge/context.mjs resolve --intent <intent> --path <path>` to select the task-specific rule cards.

## Tech Stack
- Next.js 16 (App Router)
- Tailwind CSS 4 + shadcn/ui
- Supabase (database + auth)
