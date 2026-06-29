// TypeScript port of process_registry.py.
//
// Tracks running colab-mcp instances in a small JSON file so a new server can
// detect & clean up stale ones from prior sessions (the "Disconnected from the
// local Colab MCP server" symptom when the browser still points at a dead
// port), and so users can list/kill them for debugging.
//
//   Windows: %LOCALAPPDATA%\colab-mcp\registry.json
//   macOS/Linux: ~/.colab-mcp/registry.json

import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const log = (...a: unknown[]) => console.error('[colab-mcp:registry]', ...a);

export interface ServerEntry {
  pid: number;
  port: number;
  started_at: number; // epoch seconds
  host: string;
}

function registryDir(): string {
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA || homedir(), 'colab-mcp');
  }
  return join(homedir(), '.colab-mcp');
}

function registryPath(): string {
  return join(registryDir(), 'registry.json');
}

function loadRegistry(): ServerEntry[] {
  const p = registryPath();
  if (!existsSync(p)) return [];
  try {
    const data = JSON.parse(readFileSync(p, 'utf8'));
    return Array.isArray(data.servers) ? (data.servers as ServerEntry[]) : [];
  } catch (err) {
    log(`registry at ${p} is corrupt (${err}); ignoring.`);
    return [];
  }
}

function saveRegistry(entries: ServerEntry[]): void {
  mkdirSync(registryDir(), { recursive: true });
  writeFileSync(registryPath(), JSON.stringify({ servers: entries }, null, 2));
}

/** Cross-platform PID liveness check. signal 0 just probes existence/permission. */
export function isProcessAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process. EPERM = exists but not ours (still alive).
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Best-effort terminate a stale colab-mcp process. Returns true if it's gone. */
export async function killProcess(pid: number, force = false): Promise<boolean> {
  if (!isProcessAlive(pid)) return true;
  try {
    process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
  } catch (err) {
    log(`failed to signal pid=${pid}: ${err}`);
    return false;
  }
  for (let i = 0; i < 30; i++) {
    if (!isProcessAlive(pid)) return true;
    await sleep(100);
  }
  if (!force) return killProcess(pid, true);
  return !isProcessAlive(pid);
}

/** Prune dead entries; if kill=true also terminate still-alive ones (--kill-stale). */
export async function cleanupStale(kill = true): Promise<ServerEntry[]> {
  const entries = loadRegistry();
  const removed: ServerEntry[] = [];
  const alive: ServerEntry[] = [];
  for (const e of entries) {
    if (!isProcessAlive(e.pid)) {
      removed.push(e);
      continue;
    }
    if (kill) {
      log(`killing stale colab-mcp pid=${e.pid} port=${e.port}`);
      if (await killProcess(e.pid)) {
        removed.push(e);
        continue;
      }
    }
    alive.push(e);
  }
  saveRegistry(alive);
  return removed;
}

/** Remove only dead entries (leave alive ones). Safe on startup. */
export function pruneDead(): number {
  const entries = loadRegistry();
  const alive = entries.filter((e) => isProcessAlive(e.pid));
  const deadCount = entries.length - alive.length;
  if (deadCount > 0) saveRegistry(alive);
  return deadCount;
}

export function register(port: number, host = 'localhost'): ServerEntry {
  pruneDead();
  const entry: ServerEntry = {
    pid: process.pid,
    port,
    started_at: Math.floor(Date.now() / 1000),
    host,
  };
  const entries = loadRegistry().filter((e) => e.pid !== entry.pid);
  entries.push(entry);
  saveRegistry(entries);
  return entry;
}

export function unregister(pid = process.pid): void {
  saveRegistry(loadRegistry().filter((e) => e.pid !== pid));
}

export function listRunning(): ServerEntry[] {
  return loadRegistry().filter((e) => isProcessAlive(e.pid));
}
