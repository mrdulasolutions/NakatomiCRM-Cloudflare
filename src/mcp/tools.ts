/**
 * MCP tool registry. Each tool wraps an existing CRM operation so an
 * agent can invoke it without learning the REST surface. Tools dispatch
 * through the same Hono app that serves /v1/* — so auth, validation,
 * rate-limiting, audit/timeline events, and webhook fanout all behave
 * identically to a direct REST call.
 */

import type { Hono } from 'hono'
import type { AppEnv } from '../app'

export interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  handler: (
    app: Hono<AppEnv>,
    env: AppEnv['Bindings'],
    ctx: ExecutionContext,
    authorization: string,
    args: Record<string, unknown>,
  ) => Promise<unknown>
}

function obj(properties: Record<string, unknown>, required: string[] = []) {
  return { type: 'object', properties, required } as const
}

const strProp = (description: string) => ({ type: 'string', description })
const numProp = (description: string) => ({ type: 'number', description })
const arrProp = (item: unknown, description: string) => ({
  type: 'array',
  items: item,
  description,
})

async function call(
  app: Hono<AppEnv>,
  env: AppEnv['Bindings'],
  ctx: ExecutionContext,
  authorization: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const headers: Record<string, string> = { authorization }
  if (body !== undefined) headers['content-type'] = 'application/json'
  const url = `http://internal${path}`
  const res = await app.fetch(
    new Request(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
    env,
    ctx,
  )
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${JSON.stringify(json)}`)
  }
  return json
}

function qs(args: Record<string, unknown>, keys: string[]): string {
  const params = new URLSearchParams()
  for (const k of keys) {
    const v = args[k]
    if (v !== undefined && v !== null) params.set(k, String(v))
  }
  const s = params.toString()
  return s ? `?${s}` : ''
}

export const TOOLS: McpTool[] = [
  {
    name: 'search_contacts',
    description: 'Search contacts by free-text query (matches name/email/title) and optional filters.',
    inputSchema: obj({
      q: strProp('search query'),
      email: strProp('exact email match'),
      limit: numProp('max results (1..500)'),
    }),
    handler: (app, env, ctx, auth, args) =>
      call(app, env, ctx, auth, 'GET', `/v1/contacts${qs(args, ['q', 'email', 'limit'])}`),
  },
  {
    name: 'get_contact',
    description: 'Fetch one contact by id.',
    inputSchema: obj({ contact_id: strProp('contact uuid') }, ['contact_id']),
    handler: (app, env, ctx, auth, args) =>
      call(app, env, ctx, auth, 'GET', `/v1/contacts/${args.contact_id}`),
  },
  {
    name: 'create_contact',
    description: 'Create a new contact. Returns the created row including its id.',
    inputSchema: obj({
      first_name: strProp(''),
      last_name: strProp(''),
      email: strProp(''),
      phone: strProp(''),
      title: strProp(''),
      company_id: strProp('uuid'),
      external_id: strProp('your system id'),
      tags: arrProp({ type: 'string' }, ''),
    }),
    handler: (app, env, ctx, auth, args) => call(app, env, ctx, auth, 'POST', '/v1/contacts', args),
  },
  {
    name: 'update_contact',
    description: 'Partial-update a contact.',
    inputSchema: obj(
      {
        contact_id: strProp('contact uuid'),
        updates: { type: 'object', description: 'fields to set' },
      },
      ['contact_id', 'updates'],
    ),
    handler: (app, env, ctx, auth, args) =>
      call(app, env, ctx, auth, 'PATCH', `/v1/contacts/${args.contact_id}`, args.updates),
  },
  {
    name: 'search_companies',
    description: 'Search companies by free-text query (name/domain/industry) and optional filters.',
    inputSchema: obj({ q: strProp(''), domain: strProp(''), limit: numProp('') }),
    handler: (app, env, ctx, auth, args) =>
      call(app, env, ctx, auth, 'GET', `/v1/companies${qs(args, ['q', 'domain', 'limit'])}`),
  },
  {
    name: 'create_company',
    description: 'Create a new company.',
    inputSchema: obj(
      {
        name: strProp(''),
        domain: strProp(''),
        website: strProp(''),
        industry: strProp(''),
        employee_count: numProp(''),
      },
      ['name'],
    ),
    handler: (app, env, ctx, auth, args) => call(app, env, ctx, auth, 'POST', '/v1/companies', args),
  },
  {
    name: 'list_pipelines',
    description: 'List all pipelines + their stages for the current workspace.',
    inputSchema: obj({}),
    handler: (app, env, ctx, auth) => call(app, env, ctx, auth, 'GET', '/v1/pipelines'),
  },
  {
    name: 'create_deal',
    description:
      'Create a deal. Pipeline + stage resolve from pipeline_slug/stage_slug or default to the workspace default pipeline.',
    inputSchema: obj(
      {
        name: strProp(''),
        amount: strProp('decimal as string, e.g. "5000.00"'),
        currency: strProp('ISO 4217 code'),
        pipeline_slug: strProp(''),
        stage_slug: strProp(''),
        primary_contact_id: strProp(''),
        company_id: strProp(''),
      },
      ['name'],
    ),
    handler: (app, env, ctx, auth, args) => call(app, env, ctx, auth, 'POST', '/v1/deals', args),
  },
  {
    name: 'move_deal_stage',
    description: 'Move a deal to a different stage. Status auto-updates based on the destination stage.',
    inputSchema: obj(
      { deal_id: strProp(''), stage_slug: strProp('') },
      ['deal_id', 'stage_slug'],
    ),
    handler: (app, env, ctx, auth, args) =>
      call(app, env, ctx, auth, 'POST', `/v1/deals/${args.deal_id}/move`, {
        stage_slug: args.stage_slug,
      }),
  },
  {
    name: 'log_activity',
    description:
      'Log a touchpoint (call, meeting, email_log, ...) optionally attached to an entity.',
    inputSchema: obj(
      {
        kind: strProp('call | meeting | email_log | ...'),
        subject: strProp(''),
        body: strProp(''),
        entity_type: strProp('contact | company | deal | ...'),
        entity_id: strProp('uuid'),
      },
      ['kind'],
    ),
    handler: (app, env, ctx, auth, args) => call(app, env, ctx, auth, 'POST', '/v1/activities', args),
  },
  {
    name: 'add_note',
    description: 'Attach a markdown note to an entity.',
    inputSchema: obj(
      {
        entity_type: strProp(''),
        entity_id: strProp(''),
        body: strProp('markdown'),
      },
      ['entity_type', 'entity_id', 'body'],
    ),
    handler: (app, env, ctx, auth, args) => call(app, env, ctx, auth, 'POST', '/v1/notes', args),
  },
  {
    name: 'create_task',
    description: 'Create a task, optionally attached to an entity and assigned to a user.',
    inputSchema: obj(
      {
        title: strProp(''),
        description: strProp(''),
        due_at: strProp('ISO 8601'),
        entity_type: strProp(''),
        entity_id: strProp(''),
        assignee_user_id: strProp(''),
      },
      ['title'],
    ),
    handler: (app, env, ctx, auth, args) => call(app, env, ctx, auth, 'POST', '/v1/tasks', args),
  },
  {
    name: 'list_tasks',
    description: 'List tasks with status / assignee / overdue filters.',
    inputSchema: obj({
      status: strProp('open | in_progress | done | cancelled'),
      assignee_user_id: strProp(''),
      overdue: { type: 'boolean', description: 'only tasks past due_at and not done' },
      limit: numProp(''),
    }),
    handler: (app, env, ctx, auth, args) =>
      call(app, env, ctx, auth, 'GET', `/v1/tasks${qs(args, ['status', 'assignee_user_id', 'overdue', 'limit'])}`),
  },
  {
    name: 'relate',
    description: 'Create a typed edge between two entities (e.g. contact—WORKS_AT—company).',
    inputSchema: obj(
      {
        source_type: strProp(''),
        source_id: strProp(''),
        target_type: strProp(''),
        target_id: strProp(''),
        relation_type: strProp('lowercase verb'),
      },
      ['source_type', 'source_id', 'target_type', 'target_id', 'relation_type'],
    ),
    handler: (app, env, ctx, auth, args) =>
      call(app, env, ctx, auth, 'POST', '/v1/relationships', args),
  },
  {
    name: 'timeline',
    description: 'Read the append-only event log for an entity (creates, updates, moves, …).',
    inputSchema: obj(
      { entity_type: strProp(''), entity_id: strProp(''), limit: numProp('') },
      ['entity_type', 'entity_id'],
    ),
    handler: (app, env, ctx, auth, args) =>
      call(app, env, ctx, auth, 'GET', `/v1/timeline${qs(args, ['entity_type', 'entity_id', 'limit'])}`),
  },
  {
    name: 'memory_list_connectors',
    description: 'List enabled external memory connectors (DocDeploy, Supermemory, GBrain, ...).',
    inputSchema: obj({}),
    handler: (app, env, ctx, auth) => call(app, env, ctx, auth, 'GET', '/v1/memory/connectors'),
  },
  {
    name: 'memory_recall',
    description: 'Query enabled connectors for semantic memory hits related to the CRM context.',
    inputSchema: obj(
      {
        query: strProp(''),
        entity_type: strProp(''),
        entity_id: strProp(''),
        limit: numProp(''),
      },
      ['query'],
    ),
    handler: (app, env, ctx, auth, args) => call(app, env, ctx, auth, 'POST', '/v1/memory/recall', args),
  },
  {
    name: 'memory_link',
    description:
      'Cross-link a CRM entity with an external memory record so future recalls surface it inline.',
    inputSchema: obj(
      {
        connector: strProp(''),
        external_id: strProp(''),
        crm_entity_type: strProp(''),
        crm_entity_id: strProp(''),
        note: strProp(''),
      },
      ['connector', 'external_id', 'crm_entity_type', 'crm_entity_id'],
    ),
    handler: (app, env, ctx, auth, args) => call(app, env, ctx, auth, 'POST', '/v1/memory/link', args),
  },
  {
    name: 'memory_trace',
    description: 'List all memory cross-links for one CRM entity.',
    inputSchema: obj(
      { entity_type: strProp(''), entity_id: strProp('') },
      ['entity_type', 'entity_id'],
    ),
    handler: (app, env, ctx, auth, args) =>
      call(app, env, ctx, auth, 'GET', `/v1/memory/trace/${args.entity_type}/${args.entity_id}`),
  },
  {
    name: 'send_email',
    description: 'Send an email through the workspace email config (Resend). Logs an activity.',
    inputSchema: obj(
      {
        to: strProp('recipient email'),
        subject: strProp(''),
        text: strProp(''),
        html: strProp(''),
        contact_id: strProp(''),
      },
      ['to', 'subject'],
    ),
    handler: (app, env, ctx, auth, args) => call(app, env, ctx, auth, 'POST', '/v1/email/send', args),
  },
  {
    name: 'sync_calendar_feed',
    description: 'On-demand sync of a calendar feed by id. Returns counts of created/updated meetings.',
    inputSchema: obj({ feed_id: strProp('') }, ['feed_id']),
    handler: (app, env, ctx, auth, args) =>
      call(app, env, ctx, auth, 'POST', `/v1/calendar/feeds/${args.feed_id}/sync`, {}),
  },
  {
    name: 'dashboard_summary',
    description: 'Workspace-wide counts and amounts — contacts, companies, deals (open/won/lost), tasks.',
    inputSchema: obj({}),
    handler: (app, env, ctx, auth) => call(app, env, ctx, auth, 'GET', '/v1/dashboard/summary'),
  },
]

export const TOOLS_BY_NAME: Map<string, McpTool> = new Map(TOOLS.map((t) => [t.name, t]))
