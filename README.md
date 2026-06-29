# Colab MCP (TypeScript, zero-install)

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-Node-3178c6.svg)](package.json)
[![MCP](https://img.shields.io/badge/protocol-MCP-purple.svg)](https://modelcontextprotocol.io)
[![Stars](https://img.shields.io/github/stars/hermanmitish/colab-mcp?style=social)](https://github.com/hermanmitish/colab-mcp)

An MCP server for controlling **Google Colab** from any AI client (Claude Desktop, Claude Code, Cursor, …). Drive a live notebook — create, edit, run, and read cells — and switch GPU runtimes, all from tool calls.

This is a **full TypeScript rewrite** that ships as a single **zero-install `.mcpb`**: it runs on the Node runtime already bundled with Claude Desktop, so there's **nothing to install** — no Python, no `uv`, no dependencies. One file, every platform.

### Lineage

- Forked from [**SebastianGilPinzon/colab-mcp**](https://github.com/SebastianGilPinzon/colab-mcp) (`main`), which fixes the day-to-day bugs in the official [`googlecolab/colab-mcp`](https://github.com/googlecolab/colab-mcp).
- This fork keeps all of those fixes and **rewrites the server in TypeScript** to make installation a single double-click.

## Install for Claude (one click, nothing to install)

The fastest way — no config files, no runtime to set up.

1. **Download `colab-mcp.mcpb`** from the [latest release](https://github.com/hermanmitish/colab-mcp/releases/latest).
2. **Install it in Claude Desktop:** open **Settings → Extensions** and drag the `.mcpb` file in (or double-click it), then click **Install**.
3. **Use it:** in any chat, ask Claude to "connect to Colab" (`open_colab_browser_connection`). A Colab tab opens in your browser; click **Allow** on Chrome's Local Network Access prompt, and all 9 tools become available.

That's it — the bundle runs on Claude Desktop's built-in Node, so there are no prerequisites.

> **Want to use a notebook you already have open** instead of the fresh `empty.ipynb` tab? In the Colab connection prompt, open the **"Connect separate tabs"** dropdown and follow the instructions there to point the connection at your existing tab.

> Using **Claude Code** or another CLI client? See [CLI clients](#cli-clients-claude-code-cursor-) below.

## Why this fork?

Three concrete problems the official `googlecolab/colab-mcp` doesn't solve — fixed in the upstream fork and carried forward here:

1. **Invisible tools** ([#54](https://github.com/googlecolab/colab-mcp/discussions/54), [#67](https://github.com/googlecolab/colab-mcp/discussions/67), [#69](https://github.com/googlecolab/colab-mcp/discussions/69)) — only `open_colab_browser_connection` appears in most MCP clients (Claude Code, Codex, Kiro IDE). The notebook tools rely on `notifications/tools/list_changed`, which these clients ignore. Without `get_cells` in particular, the bridge is effectively write-only.
2. **"Disconnected from the local Colab MCP server"** ([#84](https://github.com/googlecolab/colab-mcp/discussions/84)) — orphaned servers from prior sessions hold ports that your browser tab still points at, so reconnecting silently fails.
3. **No programmatic GPU control** — Google [removed](https://github.com/googlecolab/colab-mcp/discussions/41) the runtime feature. You can't assign T4 / L4 / A100 without clicking in the browser.

All 9 tools (1 connection + 7 notebook + 1 GPU control) appear immediately, stale servers are auto-detected and clean-uppable, and GPUs are assignable from a single tool call.

**On top of that, this fork adds:**

- **Pure-TypeScript rewrite** — runs on Claude Desktop's bundled Node; no Python/`uv`.
- **Zero-install `.mcpb`** — one ~480 KB cross-platform bundle, double-click to install.

## What's different

| Feature | Official | This fork |
|---|---|---|
| Notebook tools visible at startup | No (needs browser + `list_changed`) | Yes (pre-registered, works with any client) |
| `change_runtime` (GPU control) | Removed | Working via OAuth |
| OAuth token caching | N/A | Yes (authorize once, cached + auto-refreshed) |
| Stale-server detection / cleanup | None — silent "Disconnected" | `--list-running` + `--kill-stale`, registry pruning on startup |
| IPv4/IPv6 dual-stack bind bug | Present | Fixed (IPv4-only bind, single port) |
| Runtime / install | Python + `uv` | TypeScript on bundled Node — **nothing to install** |
| Distribution | clone + config JSON | one-click `.mcpb` |

## Available tools

| Tool | Requires browser | Requires OAuth | Description |
|---|:---:|:---:|---|
| `open_colab_browser_connection` | yes | | Connect to a Colab notebook in your browser |
| `add_code_cell` | yes | | Add a code cell to the notebook |
| `add_text_cell` | yes | | Add a markdown cell |
| `get_cells` | yes | | Read current notebook state (cells, IDs, contents, outputs) |
| `run_code_cell` | yes | | Execute a code cell by `cellId` |
| `update_cell` | yes | | Edit an existing cell by `cellId` |
| `delete_cell` | yes | | Delete a cell by `cellId` |
| `move_cell` | yes | | Move a cell to a new position by `cellId` |
| `change_runtime` | | yes | Assign GPU: T4, L4, A100, or NONE |

## CLI clients (Claude Code, Cursor, …)

The `.mcpb` is for Claude Desktop. For CLI/editor clients that use `.mcp.json`, build from source and point at the bundled entry file.

```bash
git clone https://github.com/hermanmitish/colab-mcp.git
cd colab-mcp
npm install
npm run build      # produces dist/index.mjs
```

Then add to your `.mcp.json` (Claude Code, Cursor, etc.):

```json
{
  "mcpServers": {
    "colab": {
      "command": "node",
      "args": ["/absolute/path/to/colab-mcp/dist/index.mjs"]
    }
  }
}
```

Restart your editor / reload the window. All 9 tools appear immediately. Call `open_colab_browser_connection` — a Colab notebook opens in your browser — then use `add_code_cell`, `run_code_cell`, `get_cells`, etc.

> The only prerequisite for the from-source path is **Node 18+** (for building and running). The Claude Desktop `.mcpb` needs nothing.

## GPU control (`change_runtime`) — optional OAuth setup

`change_runtime` lets your agent assign GPUs without you touching the browser. It needs Google OAuth credentials.

### 1. Create OAuth credentials (one-time, ~5 min)

1. **Create / pick a GCP project:**
   ```bash
   gcloud projects create colab-mcp-oauth --name="Colab MCP OAuth"
   ```
2. **Configure the OAuth consent screen** at [console](https://console.cloud.google.com/apis/credentials/consent): "External" → app name `Colab MCP`, add your email as support + developer contact.
3. **Add yourself as a test user** (consent screen → "Test users").
4. **Create an OAuth client ID** at [Credentials](https://console.cloud.google.com/apis/credentials): "Create Credentials → OAuth client ID → **Desktop app**", download the JSON (e.g. `~/.config/colab-oauth.json`).

> OAuth client IDs can only be created in the Cloud Console web UI — there's no CLI for it. Use the **Desktop app** type so the loopback redirect on `localhost` is allowed.

### 2. Pass the credentials to the server

**Claude Desktop (`.mcpb`):** open **Settings → Extensions → Colab MCP**, and in the extension's settings set **"OAuth client-secrets JSON"** to the file you downloaded. That's it — restart the extension and `change_runtime` is enabled. (Leave it empty and only the notebook tools are active.)

**CLI clients (`.mcp.json`):** add the flag to your args:

```json
{
  "mcpServers": {
    "colab": {
      "command": "node",
      "args": [
        "/absolute/path/to/colab-mcp/dist/index.mjs",
        "--client-oauth-config", "/path/to/colab-oauth.json"
      ]
    }
  }
}
```

### 3. Authorize (first time only)

The first time `change_runtime` runs, the server opens your browser for Google consent. Sign in, click Allow. The refresh token is cached at `~/.colab-mcp-auth-token.json` and auto-refreshes — you won't be asked again.

```
Agent: change_runtime(accelerator="T4")
> Runtime changed to T4. Endpoint: gpu-t4-s-xxx

Agent: open_colab_browser_connection()
> Connection successful. Available notebook tools: add_code_cell, …

Agent: add_code_cell(code="!nvidia-smi")
> {"newCellId":"abc123"}

Agent: run_code_cell(cellId="abc123")
> Tesla T4, 15GB memory…
```

## CLI reference

The entry point (`node dist/index.mjs`) supports:

| Flag | Description |
|---|---|
| _(none)_ | Start the MCP server (reads/writes JSON-RPC on stdin/stdout) |
| `--client-oauth-config PATH` | Path to OAuth client-secrets JSON. Enables `change_runtime` |
| `--list-running` | Print every currently-running `colab-mcp` server (pid, port, host, start time) and exit |
| `--kill-stale` | Terminate every running `colab-mcp` server, clear its registry entry, and exit. Run from a regular shell, **not** from inside Claude Code |

The server keeps a tiny registry at `%LOCALAPPDATA%\colab-mcp\registry.json` (Windows) or `~/.colab-mcp/registry.json` (macOS/Linux). Each instance writes a `{pid, port, host, started_at}` entry on startup and removes it on clean shutdown; dead entries are pruned automatically on the next start. Logs go to **stderr** (captured by your MCP client / Claude Desktop logs).

```bash
# From a regular shell (not inside Claude Code):
node /path/to/colab-mcp/dist/index.mjs --list-running
node /path/to/colab-mcp/dist/index.mjs --kill-stale
```

## Troubleshooting

### Tools don't appear after setup
- Define the server in only **one** `.mcp.json` (not both global and project — dual definitions spawn two instances and one dies silently).
- Restart your editor after changing `.mcp.json`.

### `change_runtime` returns "Runtime API not initialized" / "not enabled on this server"
This is expected until you provide OAuth credentials — the notebook tools work without them.
- **Claude Desktop:** Settings → Extensions → Colab MCP → set the **OAuth client-secrets JSON** file, then restart the extension.
- **CLI:** make sure `--client-oauth-config` is in your args and the JSON path exists.
- Check the server's stderr (Claude Desktop logs). A healthy start logs `Colab runtime API client ready`; a failure logs `failed to initialize Colab API client: …`.

### OAuth says "Access denied"
Add your Google email as a test user in Cloud Console → OAuth consent screen → Test users.

### Browser opens but connection times out
Make sure a Colab notebook is open in the tab that opened, and click **Connect** if prompted. See the Chrome Local Network Access note below — it's the most common cause.

### Chrome asks for "Permission to access other services and apps on this device" (or Colab says "Disconnected")

When the Colab tab loads, Chrome shows:

> **colab.research.google.com wants — Permission to access other services and apps on this device**

**Click _Allow_.** If you block it, the WebSocket from the Colab tab to your local server is blocked, the tab shows "Disconnected from the local Colab MCP server", and `open_colab_browser_connection` times out.

This is Chrome's **Local Network Access** policy: a public site (`https://colab.research.google.com`) asking to talk to `ws://localhost:<port>` where this server listens. The "other service" is **your own colab-mcp server on your machine** — not external access. The connection is scoped to a one-time token in the URL fragment (`#mcpProxyToken=…`). The server answers the required Private Network Access preflight and adds `Access-Control-Allow-Private-Network: true` to the upgrade response. Chrome remembers the choice per-site, so you allow it once.

### Chrome silently blocks every attempt after a previous "Block"

If Chrome shows "Disconnected" on *every* attempt with no prompt, and the server logs a TCP open-then-close with no HTTP request, you previously clicked **Block** on the Local Network Access prompt for `colab.research.google.com`. Chrome remembers that per-site and never re-asks.

**Fix:** open the **lock icon** next to the Colab URL → **Reset permissions**, reload, and accept the prompt. (Or `chrome://settings/content/siteDetails?site=https%3A%2F%2Fcolab.research.google.com` → "Access other devices on the network" → change **Block** to **Ask**.)

### Chrome reused an old Colab tab pointing at a dead port

Chrome dedupes tabs by URL ignoring the `#fragment`, so an old Colab tab can be focused instead of a fresh one — it shows "Disconnected" and the new server times out. This server appends the current port as `?p=<port>` so each instance has a unique URL Chrome can't dedupe. If you still hit it: close every `colab.research.google.com` tab and retry `open_colab_browser_connection`.

### "Disconnected" — IPv4/IPv6 dual-stack bind (root cause on upstream)

On the official server, binding `host="localhost"` + `port=0` creates **two sockets on different ephemeral ports** (IPv6 `::1` and IPv4 `127.0.0.1`) but reports only one; the Colab tab reaches a dead port ~50% of the time. This server forces **IPv4-only** (`127.0.0.1`) so there's exactly one socket on one port. See [`src/colabSocket.ts`](src/colabSocket.ts).

### Orphaned colab-mcp processes

If a tab shows "Disconnected" and re-clicking *Connect* doesn't help, an orphaned server from a prior session may hold the port your tab remembers. From a regular shell:

```bash
node /path/to/colab-mcp/dist/index.mjs --list-running
node /path/to/colab-mcp/dist/index.mjs --kill-stale
```

Then re-run `open_colab_browser_connection` — it opens a fresh tab pointed at the live server. Fixes [upstream #84](https://github.com/googlecolab/colab-mcp/discussions/84).

## Development

```bash
npm install
npm run typecheck      # tsc --noEmit
npm run build          # esbuild → dist/index.mjs (single bundled file)
npm run pack:mcpb      # build + pack dist/colab-mcp.mcpb
node scripts/live-test.mjs   # end-to-end test against a real Colab tab
```

Source layout (`src/`):

- `index.ts` — stdio MCP server: pre-registers the 9 tools, opens the browser, forwards calls.
- `colabSocket.ts` — the localhost WebSocket server (PNA/CORS handshake, IPv4 bind, token auth) + the MCP-client transport over the socket.
- `processRegistry.ts` — stale-server registry (`--list-running` / `--kill-stale`).
- `colabClient.ts` — Colab runtime REST API (assign/unassign GPU).
- `auth.ts` — Google OAuth installed-app flow for `change_runtime`.

## Compatibility

- **Claude Desktop** (via the `.mcpb`) — nothing to install.
- **Claude Code**, Cursor, Windsurf, Codex, and any standard MCP client (via `.mcp.json`, needs Node 18+).
- Platforms: macOS, Windows 10/11, Linux.

## License

Apache 2.0 (same as upstream).

---

⭐ **If this saved you time, a star helps others find it.**
