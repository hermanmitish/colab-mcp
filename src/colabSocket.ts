// TypeScript port of websocket_server.py + session.py's ColabTransport.
//
// A localhost WebSocket server that the Google Colab browser tab dials INTO.
// The tab is itself an MCP server, so once it connects we attach an MCP
// `Client` to the socket (via ColabSocketTransport) and forward tool calls.
//
// The two Colab-specific subtleties (vs a same-origin localhost bridge):
//   1. Chrome Private Network Access (PNA): a public origin
//      (colab.research.google.com) connecting to ws://localhost is a
//      "private network request". Chrome stalls the upgrade until the server
//      answers the OPTIONS preflight AND the 101 response with
//      `Access-Control-Allow-Private-Network: true`. Miss either and the tab
//      shows "Disconnected from the local Colab MCP server".
//   2. IPv4-only bind. With host "localhost" + port 0, Node/OS may bind IPv4
//      and IPv6 on different ephemeral ports; the tab reaches only one. Bind
//      127.0.0.1 so there's a single socket on a single port.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

export const COLAB = 'https://colab.research.google.com';
export const COLAB_ALT_DOMAIN = 'https://colab.google.com';
export const SCRATCH_PATH = '/notebooks/empty.ipynb';

const ALLOWED_ORIGINS = [COLAB, COLAB_ALT_DOMAIN];
const SUBPROTOCOL = 'mcp';

const log = (...a: unknown[]) => console.error('[colab-mcp:ws]', ...a);

/** CORS / Private Network Access headers, applied to BOTH the OPTIONS
 *  preflight (204) and the 101 upgrade response. Mirrors
 *  websocket_server.py:_cors_preflight_headers. */
function pnaHeaders(): Array<[string, string]> {
  return [
    ['Access-Control-Allow-Origin', COLAB],
    ['Access-Control-Allow-Methods', 'GET, OPTIONS'],
    [
      'Access-Control-Allow-Headers',
      'authorization,content-type,sec-websocket-protocol,' +
        'sec-websocket-key,sec-websocket-version,sec-websocket-extensions',
    ],
    ['Access-Control-Allow-Private-Network', 'true'],
    ['Access-Control-Allow-Credentials', 'true'],
    ['Access-Control-Max-Age', '86400'],
  ];
}

export class ColabWebSocketServer {
  readonly host = '127.0.0.1';
  port = 0;
  readonly token = randomBytes(16).toString('base64url');

  private http: Server;
  private wss: WebSocketServer;
  private live: WebSocket | null = null;
  private connectionWaiters: Array<(ws: WebSocket) => void> = [];

  constructor() {
    this.http = createServer((req, res) => this.handlePlainRequest(req, res));
    this.wss = new WebSocketServer({
      noServer: true,
      handleProtocols: (protocols) => (protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false),
    });

    // Inject PNA headers onto the 101 Switching Protocols response. Chrome
    // re-checks PNA on the actual upgrade response, not just the preflight.
    this.wss.on('headers', (headers) => {
      for (const [name, value] of pnaHeaders()) headers.push(`${name}: ${value}`);
    });

    this.http.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket as Socket, head));
  }

  /** Non-WebSocket requests (the OPTIONS preflight) get a 204 + PNA headers. */
  private handlePlainRequest(req: IncomingMessage, res: ServerResponse): void {
    log(`preflight: ${req.method} ${req.url} origin=${req.headers.origin ?? '<none>'}`);
    for (const [name, value] of pnaHeaders()) res.setHeader(name, value);
    res.writeHead(204);
    res.end();
  }

  private rejectUpgrade(socket: Socket, code: number, reason: string): void {
    socket.write(`HTTP/1.1 ${code} ${reason}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  }

  private handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    // Origin allow-list (Colab only).
    const origin = req.headers.origin;
    if (!origin || !ALLOWED_ORIGINS.includes(origin)) {
      log(`rejected upgrade: bad origin ${origin}`);
      return this.rejectUpgrade(socket, 403, 'Forbidden origin');
    }

    // Token auth: accept either ?access_token=<token> in the path or an
    // Authorization: Bearer <token> header.
    if (!this.isAuthorized(req)) {
      log('rejected upgrade: bad/missing token');
      return this.rejectUpgrade(socket, 401, 'Unauthorized');
    }

    // Single-client exclusivity — one Colab tab at a time.
    if (this.live && this.live.readyState === this.live.OPEN) {
      log('rejected upgrade: a client is already connected');
      return this.rejectUpgrade(socket, 409, 'Server is busy');
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      log('Colab tab connected');
      this.live = ws;
      ws.on('close', () => {
        if (this.live === ws) this.live = null;
        log('Colab tab disconnected');
      });
      const waiters = this.connectionWaiters;
      this.connectionWaiters = [];
      for (const resolve of waiters) resolve(ws);
    });
  }

  private isAuthorized(req: IncomingMessage): boolean {
    if ((req.url ?? '').includes(`access_token=${this.token}`)) return true;
    const auth = req.headers.authorization;
    if (!auth) return false;
    const [scheme, value] = auth.split(/\s+/, 2);
    return scheme?.toLowerCase() === 'bearer' && value === this.token;
  }

  isConnected(): boolean {
    return this.live != null && this.live.readyState === this.live.OPEN;
  }

  /** Resolves with the live socket once a Colab tab connects, or rejects on timeout. */
  waitForConnection(timeoutMs: number): Promise<WebSocket> {
    if (this.isConnected()) return Promise.resolve(this.live!);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.connectionWaiters = this.connectionWaiters.filter((w) => w !== onConn);
        reject(new Error('Timed out waiting for the Colab tab to connect'));
      }, timeoutMs);
      const onConn = (ws: WebSocket) => {
        clearTimeout(timer);
        resolve(ws);
      };
      this.connectionWaiters.push(onConn);
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.http.once('error', reject);
      // host 127.0.0.1 => single IPv4 socket on one ephemeral port.
      this.http.listen(0, this.host, () => {
        const addr = this.http.address();
        if (addr && typeof addr === 'object') this.port = addr.port;
        log(`listening on ws://${this.host}:${this.port} (tab connects via ws://localhost:${this.port})`);
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    this.live?.close();
    this.wss.close();
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }
}

/** MCP Client transport bound to a single live Colab WebSocket. Mirrors
 *  session.py's ColabTransport: the browser tab is an MCP server, this is the
 *  client end. JSON-RPC messages are sent/received as JSON text frames. */
export class ColabSocketTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(private ws: WebSocket) {}

  async start(): Promise<void> {
    this.ws.on('message', (data) => {
      let parsed: JSONRPCMessage;
      try {
        parsed = JSON.parse(data.toString());
      } catch (err) {
        this.onerror?.(err as Error);
        return;
      }
      this.onmessage?.(parsed);
    });
    this.ws.on('close', () => this.onclose?.());
    this.ws.on('error', (err) => this.onerror?.(err));
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.ws.send(JSON.stringify(message));
  }

  async close(): Promise<void> {
    this.ws.close();
  }
}
