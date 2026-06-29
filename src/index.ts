#!/usr/bin/env node
// Colab MCP server (TypeScript).
//
//   MCP tool call (Claude) ──stdio──> this server ──ws──> the open Colab tab
//
// All notebook tools are pre-registered up front so clients that snapshot the
// tool list at startup (Claude Code, Codex, Kiro) see them immediately. Until a
// Colab tab is connected via open_colab_browser_connection they return a
// "not connected" message; once connected, calls are forwarded to the tab's
// own MCP server over the localhost WebSocket.

import { spawn } from 'node:child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { z } from 'zod';
import {
  COLAB,
  SCRATCH_PATH,
  ColabWebSocketServer,
  ColabSocketTransport,
} from './colabSocket.js';
import * as registry from './processRegistry.js';
import { ColabClient, type Accelerator } from './colabClient.js';
import { getColabAuthClient } from './auth.js';

const log = (...a: unknown[]) => console.error('[colab-mcp]', ...a);

const UI_CONNECTION_TIMEOUT_MS = 60_000;

const NOT_CONNECTED_MSG =
  'Not connected to a Google Colab browser session. Please call ' +
  'open_colab_browser_connection first to establish a connection, then retry this tool.';

// ---- CLI args ----
interface CliArgs {
  listRunning: boolean;
  killStale: boolean;
  clientOAuthConfig?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { listRunning: false, killStale: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list-running') args.listRunning = true;
    else if (a === '--kill-stale') args.killStale = true;
    else if (a === '--client-oauth-config') args.clientOAuthConfig = argv[++i];
    else if (a.startsWith('--client-oauth-config=')) args.clientOAuthConfig = a.split('=', 2)[1];
  }
  return args;
}

const cli = parseArgs(process.argv.slice(2));

// ---- bridge state ----
const wss = new ColabWebSocketServer();
let browser: Client | null = null;
let colabClient: ColabClient | null = null; // runtime API (change_runtime); lazy

function isConnected(): boolean {
  return wss.isConnected() && browser != null;
}

function openBrowser(url: string): void {
  const platform = process.platform;
  const [cmd, args] =
    platform === 'darwin'
      ? ['open', [url]]
      : platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    spawn(cmd as string, args as string[], { detached: true, stdio: 'ignore' }).unref();
  } catch (err) {
    log('failed to open browser:', err);
  }
}

/** Forward a tool call to the connected Colab tab, or return the stub message. */
async function forwardOrStub(toolName: string, args: Record<string, unknown>): Promise<string> {
  if (!isConnected()) return NOT_CONNECTED_MSG;
  try {
    const result = await browser!.callTool({ name: toolName, arguments: args });
    const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
    return content
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n');
  } catch (err) {
    return `Error calling ${toolName}: ${err}. Try calling open_colab_browser_connection to reconnect.`;
  }
}

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

// ---- MCP server ----
const server = new McpServer({ name: 'ColabMCP', version: '0.1.0-ts' });

server.tool(
  'open_colab_browser_connection',
  'Opens a connection to a Google Colab browser session and unlocks notebook editing tools. Returns whether the connection attempt succeeded.',
  {},
  async () => {
    if (isConnected()) return text('Already connected to Colab.');

    // `?p=<port>` forces a unique URL per server instance so Chrome opens a
    // fresh tab instead of reusing a stale one pointed at a dead port. The
    // fragment carries the token + port the tab's JS uses to dial back in.
    openBrowser(
      `${COLAB}${SCRATCH_PATH}?p=${wss.port}#mcpProxyToken=${wss.token}&mcpProxyPort=${wss.port}`,
    );

    let ws;
    try {
      ws = await wss.waitForConnection(UI_CONNECTION_TIMEOUT_MS);
    } catch {
      return text(
        `Connection timed out. This server is on port ${wss.port}. Close any stale ` +
          'colab.research.google.com tabs and retry, and make sure you clicked "Allow" on ' +
          "Chrome's Local Network Access prompt.",
      );
    }

    // The tab is an MCP server; attach a client and run the MCP initialize handshake.
    const client = new Client({ name: 'colab-mcp-proxy', version: '0.1.0-ts' });
    await client.connect(new ColabSocketTransport(ws));
    browser = client;
    ws.on('close', () => {
      if (browser === client) browser = null;
    });

    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    const toolsText = names.length ? names.join(', ') : 'none discovered';
    return text(
      `Connection successful. Available notebook tools: ${toolsText}. ` +
        'You can now create, edit, and execute cells in the Colab notebook.',
    );
  },
);

server.tool(
  'add_code_cell',
  'Add a new code cell to the Colab notebook. Requires an active browser connection via open_colab_browser_connection.',
  {
    code: z.string().default(''),
    cellIndex: z.number().int().default(0),
    language: z.string().default('python'),
  },
  async (args) => text(await forwardOrStub('add_code_cell', args)),
);

server.tool(
  'add_text_cell',
  'Add a new text/markdown cell to the Colab notebook. Requires an active browser connection via open_colab_browser_connection.',
  { content: z.string().default(''), cellIndex: z.number().int().default(-1) },
  async (args) => text(await forwardOrStub('add_text_cell', args)),
);

server.tool(
  'get_cells',
  'Read the current notebook state: list of cells with their IDs, contents, and outputs. Essential for iterative work (write -> run -> read -> adjust). Requires an active browser connection via open_colab_browser_connection.',
  {},
  async () => text(await forwardOrStub('get_cells', {})),
);

server.tool(
  'run_code_cell',
  'Execute a code cell in the Colab notebook by cellId (from add_code_cell or get_cells). Requires an active browser connection via open_colab_browser_connection.',
  { cellId: z.string().default('') },
  async (args) => text(await forwardOrStub('run_code_cell', args)),
);

server.tool(
  'update_cell',
  'Update the contents of an existing cell in the Colab notebook. Requires an active browser connection via open_colab_browser_connection.',
  { cellId: z.string().default(''), content: z.string().default('') },
  async (args) => text(await forwardOrStub('update_cell', args)),
);

server.tool(
  'delete_cell',
  'Delete a cell from the Colab notebook by cellId. Requires an active browser connection via open_colab_browser_connection.',
  { cellId: z.string().default('') },
  async (args) => text(await forwardOrStub('delete_cell', args)),
);

server.tool(
  'move_cell',
  'Move a cell to a new position in the Colab notebook by cellId and target index. Requires an active browser connection via open_colab_browser_connection.',
  { cellId: z.string().default(''), cellIndex: z.number().int().default(0) },
  async (args) => text(await forwardOrStub('move_cell', args)),
);

server.tool(
  'change_runtime',
  'Change the Colab runtime to use a specific GPU accelerator. Valid values: NONE, T4, L4, A100. Requires OAuth setup (start the server with --client-oauth-config; first use opens a browser for consent).',
  { accelerator: z.enum(['NONE', 'T4', 'L4', 'A100']).default('T4') },
  async ({ accelerator }) => {
    if (!colabClient) {
      return text(
        'Runtime API not initialized. Start the server with --client-oauth-config ' +
          'pointing to your Google OAuth client-secrets JSON to enable change_runtime.',
      );
    }
    try {
      // Unassign any current VM first, then assign the requested accelerator.
      try {
        for (const a of await colabClient.listAssignments()) await colabClient.unassign(a.endpoint);
      } catch {
        /* best-effort cleanup */
      }
      const res = await colabClient.assign(accelerator as Accelerator);
      return text(
        `Runtime changed to ${accelerator}. Endpoint: ${res.endpoint}. ` +
          'Use open_colab_browser_connection to connect to the new runtime.',
      );
    } catch (err) {
      return text(`Failed to change runtime: ${err}`);
    }
  },
);

// ---- startup ----

// Diagnostic / cleanup flags exit early (run these from a regular shell).
if (cli.listRunning) {
  const entries = registry.listRunning();
  if (!entries.length) {
    console.log('No colab-mcp servers currently registered as running.');
  } else {
    console.log(`Found ${entries.length} running colab-mcp server(s):`);
    for (const e of entries) {
      const started = new Date(e.started_at * 1000).toISOString();
      console.log(`  pid=${e.pid}  port=${e.port}  host=${e.host}  started=${started}`);
    }
  }
  process.exit(0);
}
if (cli.killStale) {
  const removed = await registry.cleanupStale(true);
  if (!removed.length) console.log('No stale colab-mcp servers found.');
  else {
    console.log(`Terminated ${removed.length} stale colab-mcp server(s):`);
    for (const e of removed) console.log(`  pid=${e.pid} port=${e.port}`);
  }
  process.exit(0);
}

// Prune dead entries from prior crashed runs before binding our port.
registry.pruneDead();

await wss.start();

// Register ourselves now that we have a port.
try {
  const entry = registry.register(wss.port, wss.host);
  log(`registered pid=${entry.pid} port=${entry.port}`);
} catch (err) {
  log(`could not register process: ${err}`);
}

// Optional: initialize the Colab runtime API client (enables change_runtime).
if (cli.clientOAuthConfig) {
  try {
    const auth = await getColabAuthClient(cli.clientOAuthConfig);
    colabClient = new ColabClient(auth);
    log('Colab runtime API client ready');
  } catch (err) {
    log(`failed to initialize Colab API client: ${err}`);
  }
}

await server.connect(new StdioServerTransport());
log(`MCP server ready (stdio); WebSocket on port ${wss.port}`);

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    registry.unregister();
  } catch {
    /* ignore */
  }
  void wss.close().finally(() => process.exit(0));
};
process.stdin.on('end', shutdown);
process.stdin.on('close', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
