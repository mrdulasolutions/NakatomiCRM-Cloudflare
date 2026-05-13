/**
 * MCP server (Model Context Protocol) over streamable HTTP. JSON-RPC
 * 2.0 messages flow through POST /mcp. Auth is the same as the REST
 * surface: `Authorization: Bearer nk_...` (workspace API key). Tools
 * dispatch through the same Hono app so they inherit auth + audit +
 * webhook fanout.
 */

import type { Hono } from 'hono'
import type { AppEnv } from '../app'
import { TOOLS, TOOLS_BY_NAME } from './tools'

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number | string | null
  method: string
  params?: Record<string, unknown>
}

interface JsonRpcSuccess {
  jsonrpc: '2.0'
  id: number | string | null
  result: unknown
}

interface JsonRpcError {
  jsonrpc: '2.0'
  id: number | string | null
  error: { code: number; message: string; data?: unknown }
}

const PROTOCOL_VERSION = '2024-11-05'
const SERVER_INFO = { name: 'nakatomi-crm', version: '0.1.0' }

function rpcResult(id: JsonRpcRequest['id'], result: unknown): JsonRpcSuccess {
  return { jsonrpc: '2.0', id, result }
}
function rpcError(id: JsonRpcRequest['id'], code: number, message: string, data?: unknown): JsonRpcError {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } }
}

/** Build the MCP endpoint as a sub-app that the parent passes itself to. */
export function makeMcpEndpoint(app: Hono<AppEnv>) {
  return async (
    request: Request,
    env: AppEnv['Bindings'],
    ctx: ExecutionContext,
  ): Promise<Response> => {
    if (request.method === 'GET') {
      // Streamable-HTTP GET probe — return server info for discovery.
      return Response.json({
        protocolVersion: PROTOCOL_VERSION,
        serverInfo: SERVER_INFO,
        tools: TOOLS.length,
      })
    }
    if (request.method !== 'POST') {
      return new Response('method not allowed', { status: 405 })
    }

    const authorization = request.headers.get('authorization')
    if (!authorization) {
      return Response.json(
        rpcError(null, -32001, 'missing Authorization: Bearer <api-key> header'),
        { status: 401 },
      )
    }

    let body: JsonRpcRequest | JsonRpcRequest[]
    try {
      body = (await request.json()) as JsonRpcRequest | JsonRpcRequest[]
    } catch {
      return Response.json(rpcError(null, -32700, 'parse error: invalid JSON'), { status: 400 })
    }

    const batch = Array.isArray(body) ? body : [body]
    const responses = await Promise.all(
      batch.map((msg) => handleRpc(msg, app, env, ctx, authorization)),
    )
    return Response.json(Array.isArray(body) ? responses : responses[0])
  }
}

async function handleRpc(
  msg: JsonRpcRequest,
  app: Hono<AppEnv>,
  env: AppEnv['Bindings'],
  ctx: ExecutionContext,
  authorization: string,
): Promise<JsonRpcSuccess | JsonRpcError> {
  if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return rpcError(msg.id ?? null, -32600, 'invalid request')
  }

  switch (msg.method) {
    case 'initialize':
      return rpcResult(msg.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      })
    case 'notifications/initialized':
      // Spec: notifications don't get a response, but for HTTP transport
      // we return an empty result.
      return rpcResult(msg.id, {})
    case 'tools/list':
      return rpcResult(msg.id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      })
    case 'tools/call': {
      const params = (msg.params ?? {}) as { name?: string; arguments?: Record<string, unknown> }
      const tool = params.name ? TOOLS_BY_NAME.get(params.name) : undefined
      if (!tool) {
        return rpcError(msg.id, -32601, `tool not found: ${params.name}`)
      }
      try {
        const result = await tool.handler(app, env, ctx, authorization, params.arguments ?? {})
        return rpcResult(msg.id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          isError: false,
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return rpcResult(msg.id, {
          content: [{ type: 'text', text: message }],
          isError: true,
        })
      }
    }
    default:
      return rpcError(msg.id, -32601, `method not found: ${msg.method}`)
  }
}
