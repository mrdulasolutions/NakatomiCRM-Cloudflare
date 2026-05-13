/**
 * Thrown anywhere in a request handler to produce a structured JSON
 * error response with a specific HTTP status. Caught centrally by the
 * `onError` handler in app.ts.
 */
export class HTTPError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly headers: Record<string, string> = {},
    public readonly extra: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'HTTPError'
  }
}
