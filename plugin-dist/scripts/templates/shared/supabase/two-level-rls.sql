-- two-level-rls.sql — Firm → Client → Document RLS template
-- ------------------------------------------------------------
-- Source: Example Bookkeeping App schema (PENDING_APPROVALS #14, 2026-05-13).
-- Use for any B2B SaaS where an operator (bookkeeper / agency / firm) manages multiple end-clients,
-- and where end-clients have their own user accounts that see only their own data.
--
-- Three roles in this model:
--   1. firm_owner         — sees all clients + documents within the firm
--   2. firm_member        — sees all clients + documents within the firm (read), limited write
--   3. client_user        — sees only their own documents (their client_id)
--
-- Customize {table_name}, {firm_pk}, {client_pk}, etc. before applying.
-- Apply on the DEV project first, then promote to prod per data-protection.md §2.
-- After apply: run `get_advisors` (data-protection.md §4.3) to verify no gaps.

-- ============================================================
-- §1 — Firms (top-level tenant)
-- ============================================================
CREATE TABLE IF NOT EXISTS firms (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    owner_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS firm_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    firm_id UUID NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (firm_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_firm_members_user_firm ON firm_members(user_id, firm_id);

-- ============================================================
-- §2 — Clients (scoped to a firm)
-- ============================================================
CREATE TABLE IF NOT EXISTS clients (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    firm_id UUID NOT NULL REFERENCES firms(id) ON DELETE RESTRICT,
    -- Optional: link a client to an auth.users row if the client logs in directly
    client_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    email TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (firm_id, name)
);

CREATE INDEX IF NOT EXISTS idx_clients_firm ON clients(firm_id);
CREATE INDEX IF NOT EXISTS idx_clients_user ON clients(client_user_id) WHERE client_user_id IS NOT NULL;

-- ============================================================
-- §3 — Documents (scoped to a client within a firm)
-- ============================================================
CREATE TABLE IF NOT EXISTS documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    firm_id UUID NOT NULL REFERENCES firms(id) ON DELETE RESTRICT,
    client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    storage_path TEXT NOT NULL,
    content_hash TEXT NOT NULL,            -- per VIBE Rule 54 — dedup
    document_type TEXT,
    metadata JSONB DEFAULT '{}'::jsonb,
    uploaded_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (firm_id, client_id, content_hash)  -- dedup within client scope
);

CREATE INDEX IF NOT EXISTS idx_documents_client ON documents(client_id);
CREATE INDEX IF NOT EXISTS idx_documents_firm ON documents(firm_id);
CREATE INDEX IF NOT EXISTS idx_documents_uploaded_by ON documents(uploaded_by);

-- ============================================================
-- §4 — Helper functions (used by RLS policies)
-- ============================================================
-- SECURITY DEFINER + explicit search_path prevents the `get_advisors` "mutable search_path" finding.
CREATE OR REPLACE FUNCTION is_firm_member(check_firm_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM firm_members
        WHERE firm_id = check_firm_id AND user_id = auth.uid()
    );
END;
$$;

CREATE OR REPLACE FUNCTION is_firm_owner(check_firm_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM firm_members
        WHERE firm_id = check_firm_id AND user_id = auth.uid() AND role = 'owner'
    );
END;
$$;

CREATE OR REPLACE FUNCTION is_client_user(check_client_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM clients
        WHERE id = check_client_id AND client_user_id = auth.uid()
    );
END;
$$;

-- ============================================================
-- §5 — Enable RLS on every table (data-protection.md §1 + VIBE Rule 5)
-- ============================================================
ALTER TABLE firms ENABLE ROW LEVEL SECURITY;
ALTER TABLE firm_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- §6 — Firm policies
-- ============================================================
CREATE POLICY firms_select_member ON firms
    FOR SELECT USING (is_firm_member(id));

CREATE POLICY firms_update_owner ON firms
    FOR UPDATE USING (is_firm_owner(id)) WITH CHECK (is_firm_owner(id));

CREATE POLICY firms_delete_owner ON firms
    FOR DELETE USING (is_firm_owner(id));

-- INSERT firms is done via a SECURITY DEFINER RPC (create_firm) that also inserts the owner's
-- firm_members row in the same transaction. No direct INSERT policy — prevents orphan firms.

-- ============================================================
-- §7 — Firm_members policies
-- ============================================================
CREATE POLICY firm_members_select_own_firm ON firm_members
    FOR SELECT USING (is_firm_member(firm_id));

CREATE POLICY firm_members_insert_owner ON firm_members
    FOR INSERT WITH CHECK (is_firm_owner(firm_id));

CREATE POLICY firm_members_delete_owner ON firm_members
    FOR DELETE USING (is_firm_owner(firm_id));

-- ============================================================
-- §8 — Client policies
-- ============================================================
-- Firm members see all clients in their firm
CREATE POLICY clients_select_firm_member ON clients
    FOR SELECT USING (is_firm_member(firm_id));

-- Client-users see only their own client record (self-portal)
CREATE POLICY clients_select_client_user ON clients
    FOR SELECT USING (client_user_id = auth.uid());

-- Only firm members write
CREATE POLICY clients_insert_firm_member ON clients
    FOR INSERT WITH CHECK (is_firm_member(firm_id));

CREATE POLICY clients_update_firm_member ON clients
    FOR UPDATE USING (is_firm_member(firm_id)) WITH CHECK (is_firm_member(firm_id));

CREATE POLICY clients_delete_firm_owner ON clients
    FOR DELETE USING (is_firm_owner(firm_id));

-- ============================================================
-- §9 — Document policies (the two-level scoping)
-- ============================================================
-- Firm members see ALL documents within their firm (read)
CREATE POLICY documents_select_firm_member ON documents
    FOR SELECT USING (is_firm_member(firm_id));

-- Client-users see ONLY documents tied to their own client_id
CREATE POLICY documents_select_client_user ON documents
    FOR SELECT USING (is_client_user(client_id));

-- Firm members can write any document in their firm
CREATE POLICY documents_insert_firm_member ON documents
    FOR INSERT WITH CHECK (is_firm_member(firm_id));

CREATE POLICY documents_update_firm_member ON documents
    FOR UPDATE USING (is_firm_member(firm_id)) WITH CHECK (is_firm_member(firm_id));

-- Client-users can insert their OWN documents (e.g., uploading via portal)
CREATE POLICY documents_insert_client_user ON documents
    FOR INSERT WITH CHECK (is_client_user(client_id));

-- Only firm owners can delete documents (audit trail preservation)
CREATE POLICY documents_delete_firm_owner ON documents
    FOR DELETE USING (is_firm_owner(firm_id));

-- ============================================================
-- §10 — Storage bucket policies (companion — apply via Supabase Dashboard or storage SDK)
-- ============================================================
-- Buckets named:
--   firm-documents              — private, accessed via signed URLs only
--
-- Storage RLS policy SQL (apply via Dashboard → Storage → Policies):
--
--   CREATE POLICY firm_docs_select ON storage.objects
--       FOR SELECT TO authenticated USING (
--           bucket_id = 'firm-documents'
--           AND (
--               EXISTS (SELECT 1 FROM documents d WHERE d.storage_path = name AND is_firm_member(d.firm_id))
--               OR
--               EXISTS (SELECT 1 FROM documents d WHERE d.storage_path = name AND is_client_user(d.client_id))
--           )
--       );
--
--   CREATE POLICY firm_docs_insert_firm_member ON storage.objects
--       FOR INSERT TO authenticated WITH CHECK (
--           bucket_id = 'firm-documents'
--           -- enforce a path prefix matching firm + client UUIDs to prevent path traversal
--           AND name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/'
--       );

-- ============================================================
-- §11 — Verification queries (run after apply)
-- ============================================================
-- Check RLS is on for every table in this template:
--   SELECT c.relname, c.relrowsecurity FROM pg_class c
--   JOIN pg_namespace n ON n.oid = c.relnamespace
--   WHERE n.nspname = 'public'
--     AND c.relname IN ('firms', 'firm_members', 'clients', 'documents')
--     AND c.relkind = 'r';
--   -- Every row must show relrowsecurity = true.

-- Count policies on each table:
--   SELECT tablename, COUNT(*) AS policy_count FROM pg_policies
--   WHERE schemaname = 'public'
--     AND tablename IN ('firms', 'firm_members', 'clients', 'documents')
--   GROUP BY tablename;
--   -- Expected: firms=3, firm_members=3, clients=5, documents=5

-- Run the advisor (data-protection.md §4.3):
--   mcp__supabase__get_advisors({type: 'security'})
--   -- Must return zero new findings for any of the four tables above.

-- ============================================================
-- §12 — Things this template intentionally does NOT do
-- ============================================================
-- 1. Audit log of who-read-what — separate concern; see admin_audit_log.sql migration template.
-- 2. Soft delete — use UPDATE clients SET deleted_at IF retention required.
-- 3. Multi-firm membership — this template assumes a user belongs to ONE firm.
--    If a single user belongs to multiple firms (rare in B2B bookkeeping), wrap is_firm_member
--    to check by firm_id parameter (already does this via the function signature).
-- 4. Inter-firm sharing — explicitly out of scope. Cross-firm sharing is a feature, not RLS.
-- 5. Per-document encryption-at-rest — Supabase storage already encrypts; for sensitive client
--    data (bank statements, PII), add app-level envelope encryption before storage.put.
