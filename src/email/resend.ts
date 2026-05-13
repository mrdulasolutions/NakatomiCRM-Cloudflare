/**
 * Resend transport for outbound email.
 *
 * Workspace `email_configs.from_address` controls the verified sender;
 * the API key itself lives in env.RESEND_API_KEY (a Worker secret) so
 * D1 never sees it.
 */

export interface ResendSendArgs {
  apiKey: string
  from: string
  to: string[]
  subject: string
  text?: string
  html?: string
  replyTo?: string
  headers?: Record<string, string>
}

export interface ResendSendResult {
  /** Resend message id (also threaded through Message-Id). */
  id: string
}

export async function resendSend(args: ResendSendArgs): Promise<ResendSendResult> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${args.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: args.from,
      to: args.to,
      subject: args.subject,
      text: args.text,
      html: args.html,
      reply_to: args.replyTo,
      headers: args.headers,
    }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`resend send failed: HTTP ${res.status} ${text.slice(0, 500)}`)
  }
  const body = (await res.json()) as { id?: string }
  if (!body.id) throw new Error('resend response missing id')
  return { id: body.id }
}
