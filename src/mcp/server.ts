/**
 * The `archmap mcp` server: the query and proposal surface over stdio.
 *
 * Stdio is the only transport — no listener, no port, no network, no auth surface. The query
 * tools never write; the only write is `apply_proposal`, which reuses the CLI's guarded
 * transaction, carries no approval channel, and answers from the same validated tracked model
 * the CLI reads. stdout is the JSON-RPC channel and nothing but protocol messages may ever be
 * written to it.
 *
 * Failures are isolated by kind: an unknown tool or rejected arguments become a JSON-RPC
 * invalid-params error, an unusable repository becomes a structured tool error carrying the
 * CLI's own message, and malformed input on the wire is dropped by the transport without
 * killing the session.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type ListToolsResult,
} from '@modelcontextprotocol/sdk/types.js';
import { toCanonicalJson } from '../model/canonical.js';
import { callTool, type QueryContext } from './handlers.js';
import { MCP_TOOLS, ToolInputError } from './tools.js';

/** Kept in step with the package version by release, not read from disk at runtime. */
export const MCP_SERVER_INFO = { name: 'archmap', version: '0.0.0' };

function text(value: unknown): CallToolResult['content'] {
  return [{ type: 'text', text: toCanonicalJson(value) }];
}

export function createMcpServer(ctx: QueryContext): Server {
  const server = new Server(MCP_SERVER_INFO, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, (): ListToolsResult => ({
    tools: MCP_TOOLS as ListToolsResult['tools'],
  }));

  server.setRequestHandler(CallToolRequestSchema, (request): CallToolResult => {
    try {
      const result = callTool(request.params.name, request.params.arguments, ctx);
      if (!result.ok) {
        return { isError: true, content: text({ schema_version: 1, error: result.error }) };
      }
      return { content: text(result.payload) };
    } catch (err) {
      if (err instanceof ToolInputError) throw new McpError(ErrorCode.InvalidParams, err.message);
      // Any other failure is still an answer, not a crash: the session stays usable.
      const message = err instanceof Error ? err.message : String(err);
      return { isError: true, content: text({ schema_version: 1, error: message }) };
    }
  });

  return server;
}

/** Serve on stdio until the client disconnects (transport close or stdin EOF). */
export async function serveMcpStdio(ctx: QueryContext): Promise<void> {
  const server = createMcpServer(ctx);
  const transport = new StdioServerTransport();
  const closed = new Promise<void>((resolve) => {
    server.onclose = (): void => resolve();
  });
  await server.connect(transport);
  // EOF ends the session deterministically instead of leaving the process to drain.
  process.stdin.once('end', () => void server.close());
  await closed;
}
