/**
 * First-run welcome flow.
 *
 * GET  /welcome     If the deployment has zero workspaces, render an
 *                   onboarding form. Once a workspace exists the page
 *                   permanently 404s — bootstrap is single-use by design.
 * POST /welcome     Create user + workspace + owner membership + one
 *                   API key, return the key plaintext exactly once.
 *
 * Mirrors the legacy welcome page semantically; HTML is inline rather
 * than templated since Hono JSX would just bring its own runtime weight
 * for one page.
 */

import { count } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { generateApiKey } from '../auth/api-key'
import { hashPassword } from '../auth/password'
import { makeDb } from '../db'
import { apiKeys, memberships, users, workspaces } from '../db/schema'
import type { Env } from '../env'
import { HTTPError } from '../lib/errors'

const WelcomeSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(256),
  workspace_name: z.string().min(1).max(255),
  workspace_slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/, 'workspace_slug must be lowercase, alphanumeric, dashes only'),
  display_name: z.string().max(255).optional(),
})

async function workspaceCount(env: Env): Promise<number> {
  const db = makeDb(env.DB)
  const r = await db.select({ n: count() }).from(workspaces).get()
  return r?.n ?? 0
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function pageShell(inner: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<title>Welcome · Nakatomi</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  :root { color-scheme: dark; }
  body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #0b0d10; color: #e6e8ea; margin: 0; display: flex; min-height: 100vh; align-items: center; justify-content: center; }
  .card { background: #11151a; border: 1px solid #20242a; border-radius: 12px; padding: 32px; width: 420px; max-width: 92vw; }
  h1 { font-size: 14px; letter-spacing: 2px; text-transform: uppercase; color: #6cf; margin: 0 0 6px 0; }
  p { color: #9ab; font-size: 12px; line-height: 1.55; margin: 0 0 20px 0; }
  label { display: block; font-size: 11px; color: #9ab; margin-bottom: 6px; letter-spacing: 0.5px; text-transform: uppercase; margin-top: 14px; }
  input, button { font: inherit; width: 100%; padding: 10px 12px; background: #0b0d10; color: #e6e8ea; border: 1px solid #20242a; border-radius: 6px; box-sizing: border-box; }
  button { background: #1a2a3a; color: #6cf; cursor: pointer; margin-top: 20px; border-color: #2d3540; }
  button:hover { background: #223140; }
  .key { background: #0e1216; border: 1px solid #2d3540; border-radius: 6px; padding: 12px; word-break: break-all; color: #7ee787; font-size: 12px; margin: 14px 0; }
  .ft { color: #7a8590; font-size: 10px; margin-top: 18px; text-align: center; }
  .warn { color: #ffd273; font-size: 11px; margin-top: 10px; }
</style></head>
<body>${inner}</body></html>`
}

function renderForm(error?: string): string {
  const err = error ? `<div class="warn">${esc(error)}</div>` : ''
  return pageShell(`
<form class="card" method="post" action="/welcome">
  <h1>Welcome</h1>
  <p>Bootstrap your first workspace. This form only works on a fresh deployment — once a workspace exists the page disappears.</p>
  <label>your email</label>
  <input name="email" type="email" required autofocus />
  <label>password</label>
  <input name="password" type="password" required minlength="8" />
  <label>display name (optional)</label>
  <input name="display_name" type="text" />
  <label>workspace name</label>
  <input name="workspace_name" type="text" required />
  <label>workspace slug</label>
  <input name="workspace_slug" type="text" required pattern="[a-z0-9-]+" />
  ${err}
  <button type="submit">Create workspace</button>
  <div class="ft">Nakatomi CRM · Cloudflare Workers</div>
</form>
`)
}

function renderSuccess(key: string, slug: string): string {
  return pageShell(`
<div class="card">
  <h1>Workspace created</h1>
  <p>Your API key — copy it now, this is the only time you'll see it:</p>
  <div class="key">${esc(key)}</div>
  <div class="warn">Save this somewhere safe. If you lose it, mint a new one via POST /workspace/api-keys.</div>
  <p style="margin-top:18px;">
    Workspace slug: <code>${esc(slug)}</code><br/>
    Send requests with <code>Authorization: Bearer &lt;your-key&gt;</code> to <code>/v1/*</code>.
  </p>
  <div class="ft">/healthz · /mcp · /v1</div>
</div>
`)
}

export const welcomeRouter = new Hono<{ Bindings: Env }>()

welcomeRouter.get('/welcome', async (c) => {
  if ((await workspaceCount(c.env)) > 0) {
    return c.notFound()
  }
  return c.html(renderForm())
})

welcomeRouter.post('/welcome', async (c) => {
  if ((await workspaceCount(c.env)) > 0) {
    throw new HTTPError(409, 'workspace already exists — bootstrap is single-use')
  }

  const form = await c.req.parseBody()
  const parsed = WelcomeSchema.safeParse({
    email: form.email,
    password: form.password,
    workspace_name: form.workspace_name,
    workspace_slug: form.workspace_slug,
    display_name: form.display_name || undefined,
  })
  if (!parsed.success) {
    return c.html(renderForm(parsed.error.issues.map((i) => i.message).join('; ')), 400)
  }
  const body = parsed.data

  const db = makeDb(c.env.DB)
  const passwordHash = await hashPassword(body.password)
  const user = await db
    .insert(users)
    .values({ email: body.email.toLowerCase(), passwordHash, displayName: body.display_name })
    .returning()
    .get()
  const ws = await db
    .insert(workspaces)
    .values({ name: body.workspace_name, slug: body.workspace_slug })
    .returning()
    .get()
  await db
    .insert(memberships)
    .values({ workspaceId: ws.id, userId: user.id, role: 'owner' })
    .run()

  const apiKey = await generateApiKey()
  await db
    .insert(apiKeys)
    .values({
      workspaceId: ws.id,
      userId: user.id,
      name: 'welcome',
      prefix: apiKey.prefix,
      keyHash: apiKey.hash,
      role: 'owner',
    })
    .run()

  return c.html(renderSuccess(apiKey.full, ws.slug))
})
