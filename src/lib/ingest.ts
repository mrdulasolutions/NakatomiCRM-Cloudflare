/**
 * Bulk-upsert adapters used by POST /v1/ingest.
 *
 * Each adapter takes a list of rows (Record<string, string|unknown>),
 * upserts by natural key (external_id when present, otherwise the
 * resource-specific tie-breaker), and reports per-row diagnostics.
 */

import { and, eq } from 'drizzle-orm'
import type { DB } from '../db'
import { companies, contacts, deals, pipelines, stages } from '../db/schema'

export type IngestKind = 'contact' | 'company' | 'deal'

export interface IngestDiagnostic {
  index: number
  outcome: 'created' | 'updated' | 'skipped' | 'error'
  id?: string
  external_id?: string
  message?: string
}

export interface IngestResult {
  record_count: number
  created_ids: string[]
  updated_ids: string[]
  error_count: number
  diagnostics: IngestDiagnostic[]
}

function asString(v: unknown): string | null {
  if (v == null) return null
  const s = String(v).trim()
  return s === '' ? null : s
}

function asNumber(v: unknown): number | null {
  const s = asString(v)
  if (s == null) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

function asJsonArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x))
  const s = asString(v)
  if (!s) return []
  // CSV-ish: "a;b;c"
  return s.split(/[;,]/).map((x) => x.trim()).filter(Boolean)
}

async function upsertContact(
  db: DB,
  workspaceId: string,
  rows: Array<Record<string, unknown>>,
): Promise<IngestResult> {
  const out: IngestResult = {
    record_count: rows.length,
    created_ids: [],
    updated_ids: [],
    error_count: 0,
    diagnostics: [],
  }
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!
    try {
      const externalId = asString(r.external_id ?? r['external_id'])
      const email = asString(r.email)
      let existing = null
      if (externalId) {
        existing = await db
          .select()
          .from(contacts)
          .where(and(eq(contacts.workspaceId, workspaceId), eq(contacts.externalId, externalId)))
          .get()
      } else if (email) {
        existing = await db
          .select()
          .from(contacts)
          .where(and(eq(contacts.workspaceId, workspaceId), eq(contacts.email, email)))
          .get()
      }
      const values = {
        externalId,
        firstName: asString(r.first_name),
        lastName: asString(r.last_name),
        email,
        phone: asString(r.phone),
        title: asString(r.title),
        tags: asJsonArray(r.tags),
      }
      if (existing) {
        await db
          .update(contacts)
          .set({
            externalId: values.externalId ?? existing.externalId,
            firstName: values.firstName ?? existing.firstName,
            lastName: values.lastName ?? existing.lastName,
            email: values.email ?? existing.email,
            phone: values.phone ?? existing.phone,
            title: values.title ?? existing.title,
            tags: values.tags.length ? values.tags : existing.tags,
          })
          .where(eq(contacts.id, existing.id))
          .run()
        out.updated_ids.push(existing.id)
        out.diagnostics.push({
          index: i,
          outcome: 'updated',
          id: existing.id,
          external_id: externalId ?? undefined,
        })
      } else {
        const created = await db
          .insert(contacts)
          .values({ workspaceId, ...values })
          .returning()
          .get()
        out.created_ids.push(created.id)
        out.diagnostics.push({
          index: i,
          outcome: 'created',
          id: created.id,
          external_id: externalId ?? undefined,
        })
      }
    } catch (err) {
      out.error_count++
      out.diagnostics.push({
        index: i,
        outcome: 'error',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return out
}

async function upsertCompany(
  db: DB,
  workspaceId: string,
  rows: Array<Record<string, unknown>>,
): Promise<IngestResult> {
  const out: IngestResult = {
    record_count: rows.length,
    created_ids: [],
    updated_ids: [],
    error_count: 0,
    diagnostics: [],
  }
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!
    try {
      const externalId = asString(r.external_id)
      const domain = asString(r.domain)
      let existing = null
      if (externalId) {
        existing = await db
          .select()
          .from(companies)
          .where(and(eq(companies.workspaceId, workspaceId), eq(companies.externalId, externalId)))
          .get()
      } else if (domain) {
        existing = await db
          .select()
          .from(companies)
          .where(and(eq(companies.workspaceId, workspaceId), eq(companies.domain, domain)))
          .get()
      }
      const name = asString(r.name)
      if (!existing && !name) {
        out.error_count++
        out.diagnostics.push({ index: i, outcome: 'error', message: 'name is required for new companies' })
        continue
      }
      const values = {
        externalId,
        name: name ?? existing?.name ?? 'Unnamed',
        domain,
        website: asString(r.website),
        industry: asString(r.industry),
        employeeCount: asNumber(r.employee_count),
        annualRevenue: asString(r.annual_revenue),
        description: asString(r.description),
        tags: asJsonArray(r.tags),
      }
      if (existing) {
        await db
          .update(companies)
          .set({
            externalId: values.externalId ?? existing.externalId,
            name: values.name,
            domain: values.domain ?? existing.domain,
            website: values.website ?? existing.website,
            industry: values.industry ?? existing.industry,
            employeeCount: values.employeeCount ?? existing.employeeCount,
            annualRevenue: values.annualRevenue ?? existing.annualRevenue,
            description: values.description ?? existing.description,
            tags: values.tags.length ? values.tags : existing.tags,
          })
          .where(eq(companies.id, existing.id))
          .run()
        out.updated_ids.push(existing.id)
        out.diagnostics.push({
          index: i,
          outcome: 'updated',
          id: existing.id,
          external_id: externalId ?? undefined,
        })
      } else {
        const created = await db
          .insert(companies)
          .values({ workspaceId, ...values })
          .returning()
          .get()
        out.created_ids.push(created.id)
        out.diagnostics.push({
          index: i,
          outcome: 'created',
          id: created.id,
          external_id: externalId ?? undefined,
        })
      }
    } catch (err) {
      out.error_count++
      out.diagnostics.push({
        index: i,
        outcome: 'error',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return out
}

async function upsertDeal(
  db: DB,
  workspaceId: string,
  rows: Array<Record<string, unknown>>,
): Promise<IngestResult> {
  const out: IngestResult = {
    record_count: rows.length,
    created_ids: [],
    updated_ids: [],
    error_count: 0,
    diagnostics: [],
  }

  // Resolve a default pipeline + stage once for the whole batch.
  const defaultPipeline = await db
    .select()
    .from(pipelines)
    .where(and(eq(pipelines.workspaceId, workspaceId), eq(pipelines.isDefault, true)))
    .get()
  if (!defaultPipeline) {
    out.error_count = rows.length
    for (let i = 0; i < rows.length; i++) {
      out.diagnostics.push({
        index: i,
        outcome: 'error',
        message: 'no default pipeline configured for workspace; create one first',
      })
    }
    return out
  }
  const defaultStage = await db
    .select()
    .from(stages)
    .where(eq(stages.pipelineId, defaultPipeline.id))
    .get()
  if (!defaultStage) {
    out.error_count = rows.length
    for (let i = 0; i < rows.length; i++) {
      out.diagnostics.push({
        index: i,
        outcome: 'error',
        message: 'default pipeline has no stages',
      })
    }
    return out
  }

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!
    try {
      const externalId = asString(r.external_id)
      const name = asString(r.name)
      let existing = null
      if (externalId) {
        existing = await db
          .select()
          .from(deals)
          .where(and(eq(deals.workspaceId, workspaceId), eq(deals.externalId, externalId)))
          .get()
      }
      if (!existing && !name) {
        out.error_count++
        out.diagnostics.push({ index: i, outcome: 'error', message: 'name required for new deals' })
        continue
      }

      // Optional stage_slug routing
      let stageId = existing?.stageId ?? defaultStage.id
      const stageSlug = asString(r.stage_slug)
      if (stageSlug) {
        const s = await db
          .select()
          .from(stages)
          .where(and(eq(stages.pipelineId, defaultPipeline.id), eq(stages.slug, stageSlug)))
          .get()
        if (s) stageId = s.id
      }

      if (existing) {
        await db
          .update(deals)
          .set({
            externalId: externalId ?? existing.externalId,
            name: name ?? existing.name,
            stageId,
            amount: asString(r.amount) ?? existing.amount,
            currency: asString(r.currency) ?? existing.currency,
            tags: asJsonArray(r.tags).length ? asJsonArray(r.tags) : existing.tags,
          })
          .where(eq(deals.id, existing.id))
          .run()
        out.updated_ids.push(existing.id)
        out.diagnostics.push({ index: i, outcome: 'updated', id: existing.id })
      } else {
        const created = await db
          .insert(deals)
          .values({
            workspaceId,
            externalId,
            name: name!,
            pipelineId: defaultPipeline.id,
            stageId,
            status: 'open',
            amount: asString(r.amount),
            currency: asString(r.currency) ?? 'USD',
            tags: asJsonArray(r.tags),
          })
          .returning()
          .get()
        out.created_ids.push(created.id)
        out.diagnostics.push({ index: i, outcome: 'created', id: created.id })
      }
    } catch (err) {
      out.error_count++
      out.diagnostics.push({
        index: i,
        outcome: 'error',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return out
}

export async function runIngest(
  db: DB,
  workspaceId: string,
  kind: IngestKind,
  rows: Array<Record<string, unknown>>,
): Promise<IngestResult> {
  switch (kind) {
    case 'contact':
      return upsertContact(db, workspaceId, rows)
    case 'company':
      return upsertCompany(db, workspaceId, rows)
    case 'deal':
      return upsertDeal(db, workspaceId, rows)
  }
}
