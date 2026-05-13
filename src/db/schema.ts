/**
 * Drizzle SQLite schema for D1. Mirrors legacy/app/models.py.
 *
 * Conventions
 * -----------
 * - Primary keys are UUID v4 strings (TEXT). Generated client-side via
 *   crypto.randomUUID(); the migration also sets a SQL-side default for
 *   raw inserts.
 * - Timestamps are stored as UTC milliseconds (INTEGER), hydrated as Date
 *   by Drizzle's `timestamp_ms` mode. The SQL migration sets a default of
 *   strftime('%s','now')*1000 so raw INSERTs get a value too.
 * - JSON columns are TEXT in storage; Drizzle parses on read.
 * - Money fields are `numeric` (TEXT-backed) to preserve exact precision —
 *   D1/SQLite has no DECIMAL type. Values are strings on read; convert in
 *   the response layer when math is needed.
 * - Enums are declared TypeScript-side and enforced by raw CHECK
 *   constraints in the migration; we keep them off Drizzle for ergonomics.
 * - Polymorphic references use (entity_type, entity_id) without FKs —
 *   intentional, matches legacy.
 */

import { sql } from 'drizzle-orm'
import { index, integer, numeric, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

// ---------------------------------------------------------------------------
// Enums (TS values; SQL CHECK constraints live in the migration)
// ---------------------------------------------------------------------------

export const ENTITY_TYPES = [
  'contact',
  'company',
  'deal',
  'activity',
  'note',
  'task',
  'file',
  'product',
] as const
export type EntityType = (typeof ENTITY_TYPES)[number]

export const MEMBER_ROLES = ['owner', 'admin', 'member', 'readonly'] as const
export type MemberRole = (typeof MEMBER_ROLES)[number]

export const DEAL_STATUSES = ['open', 'won', 'lost'] as const
export type DealStatus = (typeof DEAL_STATUSES)[number]

export const TASK_STATUSES = ['open', 'in_progress', 'done', 'cancelled'] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

// ---------------------------------------------------------------------------
// Shared column helpers
// ---------------------------------------------------------------------------

const uuid = (name: string) => text(name).$defaultFn(() => crypto.randomUUID())
const ts = (name: string) =>
  integer(name, { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date())
const tsNullable = (name: string) => integer(name, { mode: 'timestamp_ms' })
const json = <T>(name: string) =>
  text(name, { mode: 'json' }).$type<T>().notNull().default(sql`'{}'`)
const jsonArray = <T>(name: string) =>
  text(name, { mode: 'json' }).$type<T[]>().notNull().default(sql`'[]'`)

const timestamps = {
  createdAt: ts('created_at'),
  updatedAt: ts('updated_at').$onUpdateFn(() => new Date()),
  deletedAt: tsNullable('deleted_at'),
}

// ---------------------------------------------------------------------------
// Tenancy + auth
// ---------------------------------------------------------------------------

export const workspaces = sqliteTable('workspaces', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  data: json<Record<string, unknown>>('data'),
  ...timestamps,
})

export const users = sqliteTable('users', {
  id: uuid('id').primaryKey(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  displayName: text('display_name'),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  ...timestamps,
})

export const memberships = sqliteTable(
  'memberships',
  {
    id: uuid('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').$type<MemberRole>().notNull().default('member'),
    ...timestamps,
  },
  (t) => ({
    uq_membership_ws_user: uniqueIndex('uq_membership_ws_user').on(t.workspaceId, t.userId),
    ix_membership_user: index('ix_membership_user').on(t.userId),
  }),
)

export const apiKeys = sqliteTable(
  'api_keys',
  {
    id: uuid('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    prefix: text('prefix').notNull(),
    keyHash: text('key_hash').notNull(),
    role: text('role').$type<MemberRole>().notNull().default('member'),
    lastUsedAt: tsNullable('last_used_at'),
    expiresAt: tsNullable('expires_at'),
    revokedAt: tsNullable('revoked_at'),
    rateLimitPerMinute: integer('rate_limit_per_minute'),
    // Legacy fields kept for parity; new stack uses KV `RATE_LIMIT` namespace.
    usageWindowStart: tsNullable('usage_window_start'),
    usageCount: integer('usage_count').notNull().default(0),
    data: json<Record<string, unknown>>('data'),
    ...timestamps,
  },
  (t) => ({
    ix_api_key_workspace: index('ix_api_key_workspace').on(t.workspaceId),
    ix_api_key_prefix: index('ix_api_key_prefix').on(t.prefix),
  }),
)

// ---------------------------------------------------------------------------
// Core CRM entities
// ---------------------------------------------------------------------------

export const companies = sqliteTable(
  'companies',
  {
    id: uuid('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    externalId: text('external_id'),
    name: text('name').notNull(),
    domain: text('domain'),
    website: text('website'),
    industry: text('industry'),
    employeeCount: integer('employee_count'),
    annualRevenue: numeric('annual_revenue'),
    description: text('description'),
    tags: jsonArray<string>('tags'),
    data: json<Record<string, unknown>>('data'),
    ...timestamps,
  },
  (t) => ({
    uq_company_external_id: uniqueIndex('uq_company_external_id').on(t.workspaceId, t.externalId),
    ix_company_workspace_deleted: index('ix_company_workspace_deleted').on(t.workspaceId, t.deletedAt),
    ix_company_domain: index('ix_company_domain').on(t.workspaceId, t.domain),
  }),
)

export const contacts = sqliteTable(
  'contacts',
  {
    id: uuid('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    externalId: text('external_id'),
    firstName: text('first_name'),
    lastName: text('last_name'),
    email: text('email'),
    phone: text('phone'),
    title: text('title'),
    companyId: text('company_id').references(() => companies.id, { onDelete: 'set null' }),
    tags: jsonArray<string>('tags'),
    data: json<Record<string, unknown>>('data'),
    ...timestamps,
  },
  (t) => ({
    uq_contact_external_id: uniqueIndex('uq_contact_external_id').on(t.workspaceId, t.externalId),
    ix_contact_workspace_deleted: index('ix_contact_workspace_deleted').on(t.workspaceId, t.deletedAt),
    ix_contact_email: index('ix_contact_email').on(t.workspaceId, t.email),
    ix_contact_company: index('ix_contact_company').on(t.companyId),
  }),
)

export const pipelines = sqliteTable(
  'pipelines',
  {
    id: uuid('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
    data: json<Record<string, unknown>>('data'),
    ...timestamps,
  },
  (t) => ({
    uq_pipeline_slug: uniqueIndex('uq_pipeline_slug').on(t.workspaceId, t.slug),
  }),
)

export const stages = sqliteTable(
  'stages',
  {
    id: uuid('id').primaryKey(),
    pipelineId: text('pipeline_id')
      .notNull()
      .references(() => pipelines.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    position: integer('position').notNull().default(0),
    probability: numeric('probability').notNull().default('0'),
    isWon: integer('is_won', { mode: 'boolean' }).notNull().default(false),
    isLost: integer('is_lost', { mode: 'boolean' }).notNull().default(false),
    ...timestamps,
  },
  (t) => ({
    uq_stage_slug: uniqueIndex('uq_stage_slug').on(t.pipelineId, t.slug),
    ix_stage_pipeline: index('ix_stage_pipeline').on(t.pipelineId),
  }),
)

export const deals = sqliteTable(
  'deals',
  {
    id: uuid('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    externalId: text('external_id'),
    name: text('name').notNull(),
    pipelineId: text('pipeline_id')
      .notNull()
      .references(() => pipelines.id, { onDelete: 'restrict' }),
    stageId: text('stage_id')
      .notNull()
      .references(() => stages.id, { onDelete: 'restrict' }),
    status: text('status').$type<DealStatus>().notNull().default('open'),
    amount: numeric('amount'),
    currency: text('currency').notNull().default('USD'),
    expectedCloseDate: tsNullable('expected_close_date'),
    closedAt: tsNullable('closed_at'),
    primaryContactId: text('primary_contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    companyId: text('company_id').references(() => companies.id, { onDelete: 'set null' }),
    ownerUserId: text('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
    tags: jsonArray<string>('tags'),
    data: json<Record<string, unknown>>('data'),
    ...timestamps,
  },
  (t) => ({
    uq_deal_external_id: uniqueIndex('uq_deal_external_id').on(t.workspaceId, t.externalId),
    ix_deal_workspace_deleted: index('ix_deal_workspace_deleted').on(t.workspaceId, t.deletedAt),
    ix_deal_pipeline: index('ix_deal_pipeline').on(t.pipelineId),
    ix_deal_stage: index('ix_deal_stage').on(t.stageId),
  }),
)

export const products = sqliteTable(
  'products',
  {
    id: uuid('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    externalId: text('external_id'),
    name: text('name').notNull(),
    sku: text('sku'),
    description: text('description'),
    unitPrice: numeric('unit_price'),
    currency: text('currency').notNull().default('USD'),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    tags: jsonArray<string>('tags'),
    data: json<Record<string, unknown>>('data'),
    ...timestamps,
  },
  (t) => ({
    uq_product_external_id: uniqueIndex('uq_product_external_id').on(t.workspaceId, t.externalId),
    uq_product_sku: uniqueIndex('uq_product_sku').on(t.workspaceId, t.sku),
    ix_product_workspace_deleted: index('ix_product_workspace_deleted').on(t.workspaceId, t.deletedAt),
  }),
)

export const dealLineItems = sqliteTable(
  'deal_line_items',
  {
    id: uuid('id').primaryKey(),
    dealId: text('deal_id')
      .notNull()
      .references(() => deals.id, { onDelete: 'cascade' }),
    productId: text('product_id').references(() => products.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    sku: text('sku'),
    quantity: numeric('quantity').notNull().default('1'),
    unitPrice: numeric('unit_price').notNull().default('0'),
    currency: text('currency').notNull().default('USD'),
    position: integer('position').notNull().default(0),
    data: json<Record<string, unknown>>('data'),
    ...timestamps,
  },
  (t) => ({
    ix_deal_line_items_deal: index('ix_deal_line_items_deal').on(t.dealId),
    ix_deal_line_items_product: index('ix_deal_line_items_product').on(t.productId),
  }),
)

// ---------------------------------------------------------------------------
// Email + calendar integrations
// ---------------------------------------------------------------------------
//
// NOTE: On Workers we will use provider APIs (Resend, Cloudflare Email
// Routing, etc.) rather than raw IMAP/SMTP. The columns mirror legacy for
// migration parity; phase E will repurpose imap_*/smtp_* into adapter
// config (provider, api_key_ref, etc.) or split them out.

export const emailConfigs = sqliteTable(
  'email_configs',
  {
    id: uuid('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    imapHost: text('imap_host'),
    imapPort: integer('imap_port'),
    imapUser: text('imap_user'),
    imapPassword: text('imap_password'),
    imapFolder: text('imap_folder').notNull().default('INBOX'),
    imapUseSsl: integer('imap_use_ssl', { mode: 'boolean' }).notNull().default(true),
    smtpHost: text('smtp_host'),
    smtpPort: integer('smtp_port'),
    smtpUser: text('smtp_user'),
    smtpPassword: text('smtp_password'),
    smtpUseTls: integer('smtp_use_tls', { mode: 'boolean' }).notNull().default(true),
    fromAddress: text('from_address'),
    fromName: text('from_name'),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    lastPolledUid: integer('last_polled_uid'),
    lastPolledAt: tsNullable('last_polled_at'),
    data: json<Record<string, unknown>>('data'),
    ...timestamps,
  },
  (t) => ({
    uq_email_config_workspace: uniqueIndex('uq_email_config_workspace').on(t.workspaceId),
  }),
)

export const calendarFeeds = sqliteTable(
  'calendar_feeds',
  {
    id: uuid('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    icsUrl: text('ics_url').notNull(),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    lastPolledAt: tsNullable('last_polled_at'),
    lastEtag: text('last_etag'),
    seenUids: json<Record<string, string>>('seen_uids'),
    data: json<Record<string, unknown>>('data'),
    ...timestamps,
  },
  (t) => ({
    ix_calendar_feed_workspace: index('ix_calendar_feed_workspace').on(t.workspaceId),
  }),
)

// ---------------------------------------------------------------------------
// Touchpoints
// ---------------------------------------------------------------------------

export const activities = sqliteTable(
  'activities',
  {
    id: uuid('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    externalId: text('external_id'),
    kind: text('kind').notNull(),
    subject: text('subject'),
    body: text('body'),
    occurredAt: ts('occurred_at'),
    entityType: text('entity_type').$type<EntityType>(),
    entityId: text('entity_id'),
    actorUserId: text('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    data: json<Record<string, unknown>>('data'),
    ...timestamps,
  },
  (t) => ({
    uq_activity_external_id: uniqueIndex('uq_activity_external_id').on(t.workspaceId, t.externalId),
    ix_activity_entity: index('ix_activity_entity').on(t.entityType, t.entityId),
    ix_activity_workspace_occurred: index('ix_activity_workspace_occurred').on(t.workspaceId, t.occurredAt),
  }),
)

export const notes = sqliteTable(
  'notes',
  {
    id: uuid('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    entityType: text('entity_type').$type<EntityType>().notNull(),
    entityId: text('entity_id').notNull(),
    body: text('body').notNull(),
    authorUserId: text('author_user_id').references(() => users.id, { onDelete: 'set null' }),
    data: json<Record<string, unknown>>('data'),
    ...timestamps,
  },
  (t) => ({
    ix_note_entity: index('ix_note_entity').on(t.entityType, t.entityId),
    ix_note_workspace: index('ix_note_workspace').on(t.workspaceId),
  }),
)

export const tasks = sqliteTable(
  'tasks',
  {
    id: uuid('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    externalId: text('external_id'),
    title: text('title').notNull(),
    description: text('description'),
    status: text('status').$type<TaskStatus>().notNull().default('open'),
    dueAt: tsNullable('due_at'),
    completedAt: tsNullable('completed_at'),
    entityType: text('entity_type').$type<EntityType>(),
    entityId: text('entity_id'),
    assigneeUserId: text('assignee_user_id').references(() => users.id, { onDelete: 'set null' }),
    data: json<Record<string, unknown>>('data'),
    ...timestamps,
  },
  (t) => ({
    uq_task_external_id: uniqueIndex('uq_task_external_id').on(t.workspaceId, t.externalId),
    ix_task_entity: index('ix_task_entity').on(t.entityType, t.entityId),
    ix_task_due: index('ix_task_due').on(t.workspaceId, t.status, t.dueAt),
  }),
)

// ---------------------------------------------------------------------------
// Relationship graph + timeline
// ---------------------------------------------------------------------------

export const relationships = sqliteTable(
  'relationships',
  {
    id: uuid('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    sourceType: text('source_type').$type<EntityType>().notNull(),
    sourceId: text('source_id').notNull(),
    targetType: text('target_type').$type<EntityType>().notNull(),
    targetId: text('target_id').notNull(),
    relationType: text('relation_type').notNull(),
    strength: numeric('strength').notNull().default('1'),
    data: json<Record<string, unknown>>('data'),
    ...timestamps,
  },
  (t) => ({
    uq_relationship_edge: uniqueIndex('uq_relationship_edge').on(
      t.workspaceId,
      t.sourceType,
      t.sourceId,
      t.targetType,
      t.targetId,
      t.relationType,
    ),
    ix_rel_source: index('ix_rel_source').on(t.workspaceId, t.sourceType, t.sourceId),
    ix_rel_target: index('ix_rel_target').on(t.workspaceId, t.targetType, t.targetId),
    ix_rel_type: index('ix_rel_type').on(t.workspaceId, t.relationType),
  }),
)

export const timelineEvents = sqliteTable(
  'timeline_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    entityType: text('entity_type').$type<EntityType>().notNull(),
    entityId: text('entity_id').notNull(),
    eventType: text('event_type').notNull(),
    occurredAt: ts('occurred_at'),
    actorUserId: text('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    actorApiKeyId: text('actor_api_key_id').references(() => apiKeys.id, { onDelete: 'set null' }),
    payload: json<Record<string, unknown>>('payload'),
  },
  (t) => ({
    ix_tl_entity: index('ix_tl_entity').on(t.workspaceId, t.entityType, t.entityId, t.occurredAt),
    ix_tl_workspace_time: index('ix_tl_workspace_time').on(t.workspaceId, t.occurredAt),
  }),
)

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

export const webhooks = sqliteTable('webhooks', {
  id: uuid('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  url: text('url').notNull(),
  secret: text('secret').notNull(),
  events: jsonArray<string>('events'),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  failureCount: integer('failure_count').notNull().default(0),
  lastDeliveryAt: tsNullable('last_delivery_at'),
  lastError: text('last_error'),
  ...timestamps,
})

/**
 * Webhook delivery audit log. On the new stack, retry is handled by
 * Cloudflare Queues; this table is the durable history (status, response,
 * attempts) that the API surfaces to operators.
 */
export const webhookDeliveries = sqliteTable(
  'webhook_deliveries',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    webhookId: text('webhook_id')
      .notNull()
      .references(() => webhooks.id, { onDelete: 'cascade' }),
    eventType: text('event_type').notNull(),
    payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    status: text('status').notNull().default('pending'),
    nextAttemptAt: tsNullable('next_attempt_at'),
    statusCode: integer('status_code'),
    responseBody: text('response_body'),
    error: text('error'),
    attempts: integer('attempts').notNull().default(0),
    succeeded: integer('succeeded', { mode: 'boolean' }).notNull().default(false),
    createdAt: ts('created_at'),
    updatedAt: ts('updated_at').$onUpdateFn(() => new Date()),
  },
  (t) => ({
    ix_wd_webhook_time: index('ix_wd_webhook_time').on(t.webhookId, t.createdAt),
    ix_wd_status_next: index('ix_wd_status_next').on(t.status, t.nextAttemptAt),
  }),
)

// ---------------------------------------------------------------------------
// Files (R2 metadata; bytes live in the FILES bucket)
// ---------------------------------------------------------------------------

export const files = sqliteTable(
  'files',
  {
    id: uuid('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    filename: text('filename').notNull(),
    contentType: text('content_type').notNull().default('application/octet-stream'),
    sizeBytes: integer('size_bytes').notNull().default(0),
    sha256: text('sha256'),
    /** R2 object key. */
    storageKey: text('storage_key').notNull(),
    entityType: text('entity_type').$type<EntityType>(),
    entityId: text('entity_id'),
    uploadedByUserId: text('uploaded_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    data: json<Record<string, unknown>>('data'),
    ...timestamps,
  },
  (t) => ({
    ix_file_entity: index('ix_file_entity').on(t.entityType, t.entityId),
    ix_file_sha256: index('ix_file_sha256').on(t.sha256),
    ix_file_workspace: index('ix_file_workspace').on(t.workspaceId),
  }),
)

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export const auditLog = sqliteTable(
  'audit_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    workspaceId: text('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    actorUserId: text('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    actorApiKeyId: text('actor_api_key_id').references(() => apiKeys.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    entityType: text('entity_type'),
    entityId: text('entity_id'),
    ipAddress: text('ip_address'),
    payload: json<Record<string, unknown>>('payload'),
    createdAt: ts('created_at'),
  },
  (t) => ({
    ix_audit_ws_time: index('ix_audit_ws_time').on(t.workspaceId, t.createdAt),
  }),
)

// ---------------------------------------------------------------------------
// Custom field registry, memory links, ingest runs
// ---------------------------------------------------------------------------

export const customFieldDefinitions = sqliteTable(
  'custom_field_definitions',
  {
    id: uuid('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    entityType: text('entity_type').$type<EntityType>().notNull(),
    name: text('name').notNull(),
    label: text('label').notNull(),
    /** string | number | bool | date | url | email | select | text */
    fieldType: text('field_type').notNull(),
    required: integer('required', { mode: 'boolean' }).notNull().default(false),
    defaultValue: json<unknown>('default_value'),
    options: jsonArray<string>('options'),
    description: text('description'),
    ...timestamps,
  },
  (t) => ({
    uq_cfd_ws_et_name: uniqueIndex('uq_cfd_ws_et_name').on(t.workspaceId, t.entityType, t.name),
    ix_cfd_ws_et: index('ix_cfd_ws_et').on(t.workspaceId, t.entityType),
  }),
)

export const memoryLinks = sqliteTable(
  'memory_links',
  {
    id: uuid('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    connector: text('connector').notNull(),
    externalId: text('external_id').notNull(),
    crmEntityType: text('crm_entity_type').$type<EntityType>().notNull(),
    crmEntityId: text('crm_entity_id').notNull(),
    note: text('note'),
    data: json<Record<string, unknown>>('data'),
    ...timestamps,
  },
  (t) => ({
    uq_memory_link: uniqueIndex('uq_memory_link').on(
      t.workspaceId,
      t.connector,
      t.externalId,
      t.crmEntityType,
      t.crmEntityId,
    ),
    ix_ml_crm: index('ix_ml_crm').on(t.workspaceId, t.crmEntityType, t.crmEntityId),
    ix_ml_external: index('ix_ml_external').on(t.workspaceId, t.connector, t.externalId),
  }),
)

export const ingestRuns = sqliteTable(
  'ingest_runs',
  {
    id: uuid('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    source: text('source').notNull(),
    format: text('format').notNull(),
    actorUserId: text('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    actorApiKeyId: text('actor_api_key_id').references(() => apiKeys.id, { onDelete: 'set null' }),
    recordCount: integer('record_count').notNull().default(0),
    createdCount: integer('created_count').notNull().default(0),
    updatedCount: integer('updated_count').notNull().default(0),
    errorCount: integer('error_count').notNull().default(0),
    diagnostics: json<Record<string, unknown>>('diagnostics'),
    createdAt: ts('created_at'),
  },
  (t) => ({
    ix_ingest_ws_time: index('ix_ingest_ws_time').on(t.workspaceId, t.createdAt),
  }),
)

// ---------------------------------------------------------------------------
// OAuth (MCP clients)
// ---------------------------------------------------------------------------

export const oauthClients = sqliteTable('oauth_clients', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  redirectUris: jsonArray<string>('redirect_uris'),
  clientSecretHash: text('client_secret_hash'),
  grantTypes: jsonArray<string>('grant_types'),
  responseTypes: jsonArray<string>('response_types'),
  scopes: jsonArray<string>('scopes'),
  data: json<Record<string, unknown>>('data'),
  ...timestamps,
})

export const oauthCodes = sqliteTable(
  'oauth_codes',
  {
    codeHash: text('code_hash').primaryKey(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClients.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    redirectUri: text('redirect_uri').notNull(),
    codeChallenge: text('code_challenge').notNull(),
    codeChallengeMethod: text('code_challenge_method').notNull(),
    scope: text('scope').notNull().default('mcp'),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    usedAt: tsNullable('used_at'),
    createdAt: ts('created_at'),
  },
  (t) => ({
    ix_oauth_code_expires: index('ix_oauth_code_expires').on(t.expiresAt),
    ix_oauth_code_client: index('ix_oauth_code_client').on(t.clientId),
  }),
)

// ---------------------------------------------------------------------------
// Type exports — `$inferSelect` shape per table for use elsewhere.
// ---------------------------------------------------------------------------

export type Workspace = typeof workspaces.$inferSelect
export type NewWorkspace = typeof workspaces.$inferInsert
export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
export type Membership = typeof memberships.$inferSelect
export type NewMembership = typeof memberships.$inferInsert
export type ApiKey = typeof apiKeys.$inferSelect
export type NewApiKey = typeof apiKeys.$inferInsert
export type Contact = typeof contacts.$inferSelect
export type NewContact = typeof contacts.$inferInsert
export type Company = typeof companies.$inferSelect
export type NewCompany = typeof companies.$inferInsert
export type Pipeline = typeof pipelines.$inferSelect
export type Stage = typeof stages.$inferSelect
export type Deal = typeof deals.$inferSelect
export type NewDeal = typeof deals.$inferInsert
export type Product = typeof products.$inferSelect
export type DealLineItem = typeof dealLineItems.$inferSelect
export type Activity = typeof activities.$inferSelect
export type Note = typeof notes.$inferSelect
export type Task = typeof tasks.$inferSelect
export type Relationship = typeof relationships.$inferSelect
export type TimelineEvent = typeof timelineEvents.$inferSelect
export type Webhook = typeof webhooks.$inferSelect
export type WebhookDelivery = typeof webhookDeliveries.$inferSelect
export type FileRecord = typeof files.$inferSelect
export type AuditLog = typeof auditLog.$inferSelect
export type CustomFieldDefinition = typeof customFieldDefinitions.$inferSelect
export type MemoryLink = typeof memoryLinks.$inferSelect
export type IngestRun = typeof ingestRuns.$inferSelect
export type OAuthClient = typeof oauthClients.$inferSelect
export type OAuthCode = typeof oauthCodes.$inferSelect
export type EmailConfig = typeof emailConfigs.$inferSelect
export type CalendarFeed = typeof calendarFeeds.$inferSelect
