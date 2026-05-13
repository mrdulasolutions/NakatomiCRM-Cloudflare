/**
 * Per-workspace email config + outbound send.
 *
 * Outbound goes through Resend (env.RESEND_API_KEY). Inbound lands via
 * Cloudflare Email Routing — see the `email` handler in src/index.ts.
 *
 * Legacy IMAP/SMTP fields in email_configs are preserved on the row
 * (schema parity) but unused by the new transport. Treat workspaces'
 * `from_address` as the verified sender envelope.
 */

import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { makeDb } from '../db'
import { activities, contacts, emailConfigs } from '../db/schema'
import { resendSend } from '../email/resend'
import type { Env } from '../env'
import { recordEvent } from '../lib/audit'
import { HTTPError } from '../lib/errors'
import { type AppVars, requireAuth } from '../middleware/auth'

const EmailConfigInput = z.object({
  from_address: z.string().email(),
  from_name: z.string().max(255).optional(),
  is_active: z.boolean().optional(),
})

const SendInput = z.object({
  to: z.union([z.string().email(), z.array(z.string().email()).min(1)]),
  subject: z.string().min(1).max(998),
  text: z.string().optional(),
  html: z.string().optional(),
  reply_to: z.string().email().optional(),
  /** When set, persist an activity attached to this contact. */
  contact_id: z.string().uuid().optional(),
})

export const emailRouter = new Hono<{ Bindings: Env; Variables: AppVars }>()
emailRouter.use('*', requireAuth)

emailRouter.get('/config', async (c) => {
  const db = makeDb(c.env.DB)
  const row = await db
    .select()
    .from(emailConfigs)
    .where(eq(emailConfigs.workspaceId, c.var.principal.workspace.id))
    .get()
  if (!row) {
    return c.json({
      configured: false,
      provider: 'resend',
      from_address: null,
      from_name: null,
    })
  }
  return c.json({
    configured: true,
    provider: 'resend',
    from_address: row.fromAddress,
    from_name: row.fromName,
    is_active: row.isActive,
  })
})

emailRouter.put('/config', async (c) => {
  const body = EmailConfigInput.parse(await c.req.json())
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id

  const existing = await db.select().from(emailConfigs).where(eq(emailConfigs.workspaceId, wsId)).get()
  const values = {
    fromAddress: body.from_address,
    fromName: body.from_name ?? null,
    isActive: body.is_active ?? true,
  }
  if (existing) {
    await db.update(emailConfigs).set(values).where(eq(emailConfigs.id, existing.id)).run()
  } else {
    await db.insert(emailConfigs).values({ workspaceId: wsId, ...values }).run()
  }
  return c.json({ ok: true, ...values })
})

emailRouter.post('/send', async (c) => {
  if (!c.env.RESEND_API_KEY) {
    throw new HTTPError(503, 'RESEND_API_KEY not configured for this deployment')
  }
  const body = SendInput.parse(await c.req.json())
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id

  const cfg = await db.select().from(emailConfigs).where(eq(emailConfigs.workspaceId, wsId)).get()
  if (!cfg?.fromAddress) throw new HTTPError(400, 'workspace email_config has no from_address — PUT /v1/email/config first')

  const fromHeader = cfg.fromName ? `${cfg.fromName} <${cfg.fromAddress}>` : cfg.fromAddress
  const toList = Array.isArray(body.to) ? body.to : [body.to]

  const result = await resendSend({
    apiKey: c.env.RESEND_API_KEY,
    from: fromHeader,
    to: toList,
    subject: body.subject,
    text: body.text,
    html: body.html,
    replyTo: body.reply_to,
  })

  // Log as an activity. If contact_id is provided, attach it; otherwise
  // try to match the first recipient to an existing contact by email.
  let contactId = body.contact_id ?? null
  if (!contactId && toList[0]) {
    const found = await db
      .select()
      .from(contacts)
      .where(and(eq(contacts.workspaceId, wsId), eq(contacts.email, toList[0])))
      .get()
    if (found) contactId = found.id
  }

  const activity = await db
    .insert(activities)
    .values({
      workspaceId: wsId,
      externalId: result.id,
      kind: 'email_outbound',
      subject: body.subject,
      body: body.text ?? body.html ?? null,
      occurredAt: new Date(),
      entityType: contactId ? 'contact' : null,
      entityId: contactId,
      actorUserId: c.var.principal.user?.id ?? null,
      data: {
        provider: 'resend',
        message_id: result.id,
        to: toList,
        from: fromHeader,
      },
    })
    .returning()
    .get()

  if (contactId) {
    await recordEvent(c, {
      eventType: 'email.sent',
      entityType: 'contact',
      entityId: contactId,
      payload: { subject: body.subject, message_id: result.id, to: toList },
    })
  }

  return c.json({
    message_id: result.id,
    activity_id: activity.id,
    contact_id: contactId,
  })
})
