// TypeScript port of auth.py.
//
// Google OAuth installed-app flow for the Colab runtime API (change_runtime).
// First run opens a browser for consent; the resulting refresh token is cached
// to ~/.colab-mcp-auth-token.json so later runs are non-interactive.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { OAuth2Client } from 'google-auth-library';
import { authenticate } from '@google-cloud/local-auth';
import type { ColabAuth } from './colabClient.js';

const SCOPES = [
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/colaboratory',
  'openid',
];

const TOKEN_CONFIG_PATH = join(homedir(), '.colab-mcp-auth-token.json');

interface CachedToken {
  client_id: string;
  client_secret: string;
  refresh_token?: string;
  access_token?: string;
  token_uri?: string;
}

function readClientSecrets(configPath: string): { client_id: string; client_secret: string; token_uri: string } {
  const raw = JSON.parse(readFileSync(configPath, 'utf8'));
  const c = raw.installed ?? raw.web ?? raw;
  return {
    client_id: c.client_id,
    client_secret: c.client_secret,
    token_uri: c.token_uri ?? 'https://oauth2.googleapis.com/token',
  };
}

function loadCached(): CachedToken | null {
  if (!existsSync(TOKEN_CONFIG_PATH)) return null;
  try {
    return JSON.parse(readFileSync(TOKEN_CONFIG_PATH, 'utf8')) as CachedToken;
  } catch {
    return null;
  }
}

function saveCached(t: CachedToken): void {
  writeFileSync(TOKEN_CONFIG_PATH, JSON.stringify(t, null, 2));
}

/**
 * Returns an OAuth2Client authorized for the Colab API. Uses a cached refresh
 * token if present, otherwise runs the interactive consent flow against the
 * given client-secrets JSON. Mirrors auth.get_credentials.
 */
export async function getColabAuthClient(clientSecretsPath: string): Promise<ColabAuth> {
  const cached = loadCached();
  if (cached?.refresh_token) {
    const client = new OAuth2Client({
      clientId: cached.client_id,
      clientSecret: cached.client_secret,
    });
    client.setCredentials({ refresh_token: cached.refresh_token });
    // Force a refresh so we fail fast here (and not mid-request) if revoked.
    await client.getAccessToken();
    return client;
  }

  // No cached credentials — run the loopback consent flow. @google-cloud/local-auth
  // opens the browser, captures the code on a localhost redirect, and exchanges it.
  const client = await authenticate({ keyfilePath: clientSecretsPath, scopes: SCOPES });

  const secrets = readClientSecrets(clientSecretsPath);
  saveCached({
    client_id: secrets.client_id,
    client_secret: secrets.client_secret,
    token_uri: secrets.token_uri,
    refresh_token: client.credentials.refresh_token ?? undefined,
    access_token: client.credentials.access_token ?? undefined,
  });
  return client as unknown as ColabAuth;
}
