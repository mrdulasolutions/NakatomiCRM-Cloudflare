-- Nakatomi CRM — initial schema for D1 / SQLite.
--
-- Consolidates Alembic revisions 0001..0009 from the legacy Postgres app
-- into a single migration. Differences from legacy:
--   - UUIDs are TEXT (SQLite has no native uuid type)
--   - Timestamps are INTEGER milliseconds (UTC)
--   - JSON columns are TEXT with the application enforcing structure
--   - DECIMAL money fields are TEXT-backed `numeric`
--   - Postgres pg_trgm indexes replaced by SQLite FTS5 virtual tables
--   - idempotency_keys table omitted — that role moves to KV `IDEMPOTENCY`
--
-- D1 enables foreign-key enforcement by default.

PRAGMA foreign_keys = ON;

-- ===========================================================================
-- Tenancy + auth
-- ===========================================================================

CREATE TABLE workspaces (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  data        TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  updated_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  deleted_at  INTEGER
);

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name  TEXT,
  is_active     INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  updated_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  deleted_at    INTEGER
);

CREATE TABLE memberships (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          TEXT NOT NULL DEFAULT 'member'
                CHECK (role IN ('owner','admin','member','readonly')),
  created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  updated_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  deleted_at    INTEGER
);
CREATE UNIQUE INDEX uq_membership_ws_user ON memberships(workspace_id, user_id);
CREATE INDEX ix_membership_user ON memberships(user_id);

CREATE TABLE api_keys (
  id                     TEXT PRIMARY KEY,
  workspace_id           TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id                TEXT REFERENCES users(id) ON DELETE SET NULL,
  name                   TEXT NOT NULL,
  prefix                 TEXT NOT NULL,
  key_hash               TEXT NOT NULL,
  role                   TEXT NOT NULL DEFAULT 'member'
                         CHECK (role IN ('owner','admin','member','readonly')),
  last_used_at           INTEGER,
  expires_at             INTEGER,
  revoked_at             INTEGER,
  rate_limit_per_minute  INTEGER,
  usage_window_start     INTEGER,
  usage_count            INTEGER NOT NULL DEFAULT 0,
  data                   TEXT NOT NULL DEFAULT '{}',
  created_at             INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  updated_at             INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  deleted_at             INTEGER
);
CREATE INDEX ix_api_key_workspace ON api_keys(workspace_id);
CREATE INDEX ix_api_key_prefix    ON api_keys(prefix);

-- ===========================================================================
-- Core CRM entities
-- ===========================================================================

CREATE TABLE companies (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  external_id     TEXT,
  name            TEXT NOT NULL,
  domain          TEXT,
  website         TEXT,
  industry        TEXT,
  employee_count  INTEGER,
  annual_revenue  TEXT,
  description     TEXT,
  tags            TEXT NOT NULL DEFAULT '[]',
  data            TEXT NOT NULL DEFAULT '{}',
  created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  deleted_at      INTEGER
);
CREATE UNIQUE INDEX uq_company_external_id      ON companies(workspace_id, external_id);
CREATE INDEX        ix_company_workspace_deleted ON companies(workspace_id, deleted_at);
CREATE INDEX        ix_company_domain            ON companies(workspace_id, domain);

CREATE TABLE contacts (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  external_id   TEXT,
  first_name    TEXT,
  last_name     TEXT,
  email         TEXT,
  phone         TEXT,
  title         TEXT,
  company_id    TEXT REFERENCES companies(id) ON DELETE SET NULL,
  tags          TEXT NOT NULL DEFAULT '[]',
  data          TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  updated_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  deleted_at    INTEGER
);
CREATE UNIQUE INDEX uq_contact_external_id      ON contacts(workspace_id, external_id);
CREATE INDEX        ix_contact_workspace_deleted ON contacts(workspace_id, deleted_at);
CREATE INDEX        ix_contact_email             ON contacts(workspace_id, email);
CREATE INDEX        ix_contact_company           ON contacts(company_id);

CREATE TABLE pipelines (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL,
  is_default    INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
  data          TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  updated_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  deleted_at    INTEGER
);
CREATE UNIQUE INDEX uq_pipeline_slug ON pipelines(workspace_id, slug);

CREATE TABLE stages (
  id           TEXT PRIMARY KEY,
  pipeline_id  TEXT NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  slug         TEXT NOT NULL,
  position     INTEGER NOT NULL DEFAULT 0,
  probability  TEXT NOT NULL DEFAULT '0',
  is_won       INTEGER NOT NULL DEFAULT 0 CHECK (is_won  IN (0,1)),
  is_lost      INTEGER NOT NULL DEFAULT 0 CHECK (is_lost IN (0,1)),
  created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  updated_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  deleted_at   INTEGER
);
CREATE UNIQUE INDEX uq_stage_slug     ON stages(pipeline_id, slug);
CREATE INDEX        ix_stage_pipeline ON stages(pipeline_id);

CREATE TABLE deals (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  external_id           TEXT,
  name                  TEXT NOT NULL,
  pipeline_id           TEXT NOT NULL REFERENCES pipelines(id) ON DELETE RESTRICT,
  stage_id              TEXT NOT NULL REFERENCES stages(id)    ON DELETE RESTRICT,
  status                TEXT NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open','won','lost')),
  amount                TEXT,
  currency              TEXT NOT NULL DEFAULT 'USD',
  expected_close_date   INTEGER,
  closed_at             INTEGER,
  primary_contact_id    TEXT REFERENCES contacts(id)  ON DELETE SET NULL,
  company_id            TEXT REFERENCES companies(id) ON DELETE SET NULL,
  owner_user_id         TEXT REFERENCES users(id)     ON DELETE SET NULL,
  tags                  TEXT NOT NULL DEFAULT '[]',
  data                  TEXT NOT NULL DEFAULT '{}',
  created_at            INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  updated_at            INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  deleted_at            INTEGER
);
CREATE UNIQUE INDEX uq_deal_external_id       ON deals(workspace_id, external_id);
CREATE INDEX        ix_deal_workspace_deleted ON deals(workspace_id, deleted_at);
CREATE INDEX        ix_deal_pipeline          ON deals(pipeline_id);
CREATE INDEX        ix_deal_stage             ON deals(stage_id);

CREATE TABLE products (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  external_id   TEXT,
  name          TEXT NOT NULL,
  sku           TEXT,
  description   TEXT,
  unit_price    TEXT,
  currency      TEXT NOT NULL DEFAULT 'USD',
  is_active     INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  tags          TEXT NOT NULL DEFAULT '[]',
  data          TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  updated_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  deleted_at    INTEGER
);
CREATE UNIQUE INDEX uq_product_external_id      ON products(workspace_id, external_id);
CREATE UNIQUE INDEX uq_product_sku              ON products(workspace_id, sku);
CREATE INDEX        ix_product_workspace_deleted ON products(workspace_id, deleted_at);

CREATE TABLE deal_line_items (
  id          TEXT PRIMARY KEY,
  deal_id     TEXT NOT NULL REFERENCES deals(id)    ON DELETE CASCADE,
  product_id  TEXT REFERENCES products(id)          ON DELETE SET NULL,
  name        TEXT NOT NULL,
  sku         TEXT,
  quantity    TEXT NOT NULL DEFAULT '1',
  unit_price  TEXT NOT NULL DEFAULT '0',
  currency    TEXT NOT NULL DEFAULT 'USD',
  position    INTEGER NOT NULL DEFAULT 0,
  data        TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  updated_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  deleted_at  INTEGER
);
CREATE INDEX ix_deal_line_items_deal    ON deal_line_items(deal_id);
CREATE INDEX ix_deal_line_items_product ON deal_line_items(product_id);

-- ===========================================================================
-- Email + calendar adapters (phase E will rewire to provider APIs)
-- ===========================================================================

CREATE TABLE email_configs (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  imap_host       TEXT,
  imap_port       INTEGER,
  imap_user       TEXT,
  imap_password   TEXT,
  imap_folder     TEXT NOT NULL DEFAULT 'INBOX',
  imap_use_ssl    INTEGER NOT NULL DEFAULT 1 CHECK (imap_use_ssl IN (0,1)),
  smtp_host       TEXT,
  smtp_port       INTEGER,
  smtp_user       TEXT,
  smtp_password   TEXT,
  smtp_use_tls    INTEGER NOT NULL DEFAULT 1 CHECK (smtp_use_tls IN (0,1)),
  from_address    TEXT,
  from_name       TEXT,
  is_active       INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  last_polled_uid INTEGER,
  last_polled_at  INTEGER,
  data            TEXT NOT NULL DEFAULT '{}',
  created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  deleted_at      INTEGER
);
CREATE UNIQUE INDEX uq_email_config_workspace ON email_configs(workspace_id);

CREATE TABLE calendar_feeds (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  ics_url         TEXT NOT NULL,
  is_active       INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  last_polled_at  INTEGER,
  last_etag       TEXT,
  seen_uids       TEXT NOT NULL DEFAULT '{}',
  data            TEXT NOT NULL DEFAULT '{}',
  created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  deleted_at      INTEGER
);
CREATE INDEX ix_calendar_feed_workspace ON calendar_feeds(workspace_id);

-- ===========================================================================
-- Touchpoints
-- ===========================================================================

CREATE TABLE activities (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  external_id    TEXT,
  kind           TEXT NOT NULL,
  subject        TEXT,
  body           TEXT,
  occurred_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  entity_type    TEXT CHECK (entity_type IN
                  ('contact','company','deal','activity','note','task','file','product')),
  entity_id      TEXT,
  actor_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  data           TEXT NOT NULL DEFAULT '{}',
  created_at     INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  updated_at     INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  deleted_at     INTEGER
);
CREATE UNIQUE INDEX uq_activity_external_id        ON activities(workspace_id, external_id);
CREATE INDEX        ix_activity_entity              ON activities(entity_type, entity_id);
CREATE INDEX        ix_activity_workspace_occurred  ON activities(workspace_id, occurred_at);

CREATE TABLE notes (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_type     TEXT NOT NULL CHECK (entity_type IN
                  ('contact','company','deal','activity','note','task','file','product')),
  entity_id       TEXT NOT NULL,
  body            TEXT NOT NULL,
  author_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  data            TEXT NOT NULL DEFAULT '{}',
  created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  deleted_at      INTEGER
);
CREATE INDEX ix_note_entity    ON notes(entity_type, entity_id);
CREATE INDEX ix_note_workspace ON notes(workspace_id);

CREATE TABLE tasks (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  external_id        TEXT,
  title              TEXT NOT NULL,
  description        TEXT,
  status             TEXT NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open','in_progress','done','cancelled')),
  due_at             INTEGER,
  completed_at       INTEGER,
  entity_type        TEXT CHECK (entity_type IN
                     ('contact','company','deal','activity','note','task','file','product')),
  entity_id          TEXT,
  assignee_user_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  data               TEXT NOT NULL DEFAULT '{}',
  created_at         INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  updated_at         INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  deleted_at         INTEGER
);
CREATE UNIQUE INDEX uq_task_external_id ON tasks(workspace_id, external_id);
CREATE INDEX        ix_task_entity       ON tasks(entity_type, entity_id);
CREATE INDEX        ix_task_due          ON tasks(workspace_id, status, due_at);

-- ===========================================================================
-- Relationship graph + timeline
-- ===========================================================================

CREATE TABLE relationships (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_type    TEXT NOT NULL CHECK (source_type IN
                 ('contact','company','deal','activity','note','task','file','product')),
  source_id      TEXT NOT NULL,
  target_type    TEXT NOT NULL CHECK (target_type IN
                 ('contact','company','deal','activity','note','task','file','product')),
  target_id      TEXT NOT NULL,
  relation_type  TEXT NOT NULL,
  strength       TEXT NOT NULL DEFAULT '1',
  data           TEXT NOT NULL DEFAULT '{}',
  created_at     INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  updated_at     INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  deleted_at     INTEGER
);
CREATE UNIQUE INDEX uq_relationship_edge ON relationships(
  workspace_id, source_type, source_id, target_type, target_id, relation_type
);
CREATE INDEX ix_rel_source ON relationships(workspace_id, source_type, source_id);
CREATE INDEX ix_rel_target ON relationships(workspace_id, target_type, target_id);
CREATE INDEX ix_rel_type   ON relationships(workspace_id, relation_type);

CREATE TABLE timeline_events (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_type        TEXT NOT NULL CHECK (entity_type IN
                     ('contact','company','deal','activity','note','task','file','product')),
  entity_id          TEXT NOT NULL,
  event_type         TEXT NOT NULL,
  occurred_at        INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  actor_user_id      TEXT REFERENCES users(id)    ON DELETE SET NULL,
  actor_api_key_id   TEXT REFERENCES api_keys(id) ON DELETE SET NULL,
  payload            TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX ix_tl_entity         ON timeline_events(workspace_id, entity_type, entity_id, occurred_at);
CREATE INDEX ix_tl_workspace_time ON timeline_events(workspace_id, occurred_at);

-- ===========================================================================
-- Webhooks
-- ===========================================================================

CREATE TABLE webhooks (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  url               TEXT NOT NULL,
  secret            TEXT NOT NULL,
  events            TEXT NOT NULL DEFAULT '[]',
  is_active         INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  failure_count     INTEGER NOT NULL DEFAULT 0,
  last_delivery_at  INTEGER,
  last_error        TEXT,
  created_at        INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  updated_at        INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  deleted_at        INTEGER
);
CREATE INDEX ix_webhook_workspace ON webhooks(workspace_id);

CREATE TABLE webhook_deliveries (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  webhook_id       TEXT NOT NULL REFERENCES webhooks(id)   ON DELETE CASCADE,
  event_type       TEXT NOT NULL,
  payload          TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending',
  next_attempt_at  INTEGER,
  status_code      INTEGER,
  response_body    TEXT,
  error            TEXT,
  attempts         INTEGER NOT NULL DEFAULT 0,
  succeeded        INTEGER NOT NULL DEFAULT 0 CHECK (succeeded IN (0,1)),
  created_at       INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  updated_at       INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000)
);
CREATE INDEX ix_wd_webhook_time ON webhook_deliveries(webhook_id, created_at);
CREATE INDEX ix_wd_status_next  ON webhook_deliveries(status, next_attempt_at);

-- ===========================================================================
-- Files (R2 metadata)
-- ===========================================================================

CREATE TABLE files (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  filename              TEXT NOT NULL,
  content_type          TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes            INTEGER NOT NULL DEFAULT 0,
  sha256                TEXT,
  storage_key           TEXT NOT NULL,
  entity_type           TEXT CHECK (entity_type IN
                        ('contact','company','deal','activity','note','task','file','product')),
  entity_id             TEXT,
  uploaded_by_user_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  data                  TEXT NOT NULL DEFAULT '{}',
  created_at            INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  updated_at            INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  deleted_at            INTEGER
);
CREATE INDEX ix_file_entity    ON files(entity_type, entity_id);
CREATE INDEX ix_file_sha256    ON files(sha256);
CREATE INDEX ix_file_workspace ON files(workspace_id);

-- ===========================================================================
-- Audit log
-- ===========================================================================

CREATE TABLE audit_log (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id       TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_user_id      TEXT REFERENCES users(id)      ON DELETE SET NULL,
  actor_api_key_id   TEXT REFERENCES api_keys(id)   ON DELETE SET NULL,
  action             TEXT NOT NULL,
  entity_type        TEXT,
  entity_id          TEXT,
  ip_address         TEXT,
  payload            TEXT NOT NULL DEFAULT '{}',
  created_at         INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000)
);
CREATE INDEX ix_audit_ws_time ON audit_log(workspace_id, created_at);

-- ===========================================================================
-- Custom field registry, memory links, ingest runs
-- ===========================================================================

CREATE TABLE custom_field_definitions (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_type     TEXT NOT NULL CHECK (entity_type IN
                  ('contact','company','deal','activity','note','task','file','product')),
  name            TEXT NOT NULL,
  label           TEXT NOT NULL,
  field_type      TEXT NOT NULL,
  required        INTEGER NOT NULL DEFAULT 0 CHECK (required IN (0,1)),
  default_value   TEXT NOT NULL DEFAULT '{}',
  options         TEXT NOT NULL DEFAULT '[]',
  description     TEXT,
  created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  deleted_at      INTEGER
);
CREATE UNIQUE INDEX uq_cfd_ws_et_name ON custom_field_definitions(workspace_id, entity_type, name);
CREATE INDEX        ix_cfd_ws_et      ON custom_field_definitions(workspace_id, entity_type);

CREATE TABLE memory_links (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connector          TEXT NOT NULL,
  external_id        TEXT NOT NULL,
  crm_entity_type    TEXT NOT NULL CHECK (crm_entity_type IN
                     ('contact','company','deal','activity','note','task','file','product')),
  crm_entity_id      TEXT NOT NULL,
  note               TEXT,
  data               TEXT NOT NULL DEFAULT '{}',
  created_at         INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  updated_at         INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  deleted_at         INTEGER
);
CREATE UNIQUE INDEX uq_memory_link ON memory_links(
  workspace_id, connector, external_id, crm_entity_type, crm_entity_id
);
CREATE INDEX ix_ml_crm      ON memory_links(workspace_id, crm_entity_type, crm_entity_id);
CREATE INDEX ix_ml_external ON memory_links(workspace_id, connector, external_id);

CREATE TABLE ingest_runs (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source             TEXT NOT NULL,
  format             TEXT NOT NULL,
  actor_user_id      TEXT REFERENCES users(id)    ON DELETE SET NULL,
  actor_api_key_id   TEXT REFERENCES api_keys(id) ON DELETE SET NULL,
  record_count       INTEGER NOT NULL DEFAULT 0,
  created_count      INTEGER NOT NULL DEFAULT 0,
  updated_count      INTEGER NOT NULL DEFAULT 0,
  error_count        INTEGER NOT NULL DEFAULT 0,
  diagnostics        TEXT NOT NULL DEFAULT '{}',
  created_at         INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000)
);
CREATE INDEX ix_ingest_ws_time ON ingest_runs(workspace_id, created_at);

-- ===========================================================================
-- OAuth (MCP clients)
-- ===========================================================================

CREATE TABLE oauth_clients (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  redirect_uris       TEXT NOT NULL DEFAULT '[]',
  client_secret_hash  TEXT,
  grant_types         TEXT NOT NULL DEFAULT '[]',
  response_types      TEXT NOT NULL DEFAULT '[]',
  scopes              TEXT NOT NULL DEFAULT '[]',
  data                TEXT NOT NULL DEFAULT '{}',
  created_at          INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  updated_at          INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  deleted_at          INTEGER
);

CREATE TABLE oauth_codes (
  code_hash              TEXT PRIMARY KEY,
  client_id              TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  user_id                TEXT NOT NULL REFERENCES users(id)         ON DELETE CASCADE,
  workspace_id           TEXT NOT NULL REFERENCES workspaces(id)    ON DELETE CASCADE,
  redirect_uri           TEXT NOT NULL,
  code_challenge         TEXT NOT NULL,
  code_challenge_method  TEXT NOT NULL,
  scope                  TEXT NOT NULL DEFAULT 'mcp',
  expires_at             INTEGER NOT NULL,
  used_at                INTEGER,
  created_at             INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000)
);
CREATE INDEX ix_oauth_code_expires ON oauth_codes(expires_at);
CREATE INDEX ix_oauth_code_client  ON oauth_codes(client_id);
