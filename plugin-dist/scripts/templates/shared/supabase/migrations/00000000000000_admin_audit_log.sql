-- admin_audit_log — Required by data-protection.md §4.4
-- Logs every DDL/DML invoked via Supabase MCP from any AI session.
-- Apply once per Supabase project (dev + prod independently).
-- Idempotent: safe to re-run.

create table if not exists public.admin_audit_log (
    id                 uuid        primary key default gen_random_uuid(),
    operation          text        not null,
    sql_hash           text        not null,
    sql_preview        text        not null,  -- first 200 chars of SQL
    project_id         text        not null,
    token_fingerprint  text        not null,  -- last 6 chars of token, never full value
    invoked_at         timestamptz not null default now()
);

create index if not exists idx_admin_audit_log_invoked_at
    on public.admin_audit_log (invoked_at desc);

create index if not exists idx_admin_audit_log_project_id
    on public.admin_audit_log (project_id, invoked_at desc);

-- RLS: append-only via service role; authenticated users cannot read or write.
alter table public.admin_audit_log enable row level security;

-- No SELECT policy for authenticated/anon = no read access by default.
-- Service role bypasses RLS; that's the only writer.

comment on table public.admin_audit_log is
    'Audit trail of every DDL/DML invoked via Supabase MCP. Append-only. Service-role write, no client read.';
