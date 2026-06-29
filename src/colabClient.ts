// TypeScript port of the parts of client.py needed for change_runtime:
// assign / unassign a Colab runtime VM with a chosen accelerator.

import { randomUUID } from 'node:crypto';

/** The slice of google-auth-library's OAuth2Client we use. Declared structurally
 *  so version skew between our copy and the one @google-cloud/local-auth bundles
 *  doesn't cause type conflicts. */
export interface ColabAuth {
  getAccessToken(): Promise<{ token?: string | null }>;
}

export const COLAB_DOMAIN = 'https://colab.research.google.com';
const TUN_ENDPOINT = '/tun/m';
const XSSI_PREFIX = ")]}'\n";

export type Accelerator = 'NONE' | 'T4' | 'L4' | 'A100';
export type Variant = 'DEFAULT' | 'GPU' | 'TPU';

const CLIENT_AGENT = 'python-colab-client'; // server expects this exact agent string

interface ListedAssignment {
  endpoint: string;
  accelerator?: string;
}

/** uuid_to_web_safe_base64 from client.py: hyphens → underscores, pad to 44 with '.'. */
function uuidToWebSafeBase64(uuid: string): string {
  const transformed = uuid.replace(/-/g, '_');
  return transformed + '.'.repeat(Math.max(0, 44 - uuid.length));
}

export class ColabClient {
  constructor(private auth: ColabAuth, private domain = COLAB_DOMAIN) {}

  private async request<T>(
    url: string,
    method: 'GET' | 'POST' = 'GET',
    extraHeaders: Record<string, string> = {},
  ): Promise<T | undefined> {
    const u = new URL(url);
    if (u.hostname === new URL(this.domain).hostname) u.searchParams.set('authuser', '0');

    const token = (await this.auth.getAccessToken()).token;
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'X-Goog-Colab-Client-Agent': CLIENT_AGENT,
      ...extraHeaders,
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch(u, { method, headers });
    if (!res.ok) {
      throw new Error(`Colab request failed: ${method} ${u} -> ${res.status} ${res.statusText}`);
    }
    let body = await res.text();
    if (body.startsWith(XSSI_PREFIX)) body = body.slice(XSSI_PREFIX.length);
    if (!body) return undefined;
    return JSON.parse(body) as T;
  }

  async listAssignments(): Promise<ListedAssignment[]> {
    const res = await this.request<{ assignments?: ListedAssignment[] }>(
      `${this.domain}${TUN_ENDPOINT}/assignments`,
    );
    return res?.assignments ?? [];
  }

  async unassign(endpoint: string): Promise<void> {
    const url = `${this.domain}${TUN_ENDPOINT}/unassign/${endpoint}`;
    const resp = await this.request<{ token: string }>(url);
    if (resp?.token) {
      await this.request(url, 'POST', { 'X-Goog-Colab-Token': resp.token });
    }
  }

  private buildAssignUrl(nbh: string, variant?: Variant, accelerator?: Accelerator): string {
    const u = new URL(`${this.domain}${TUN_ENDPOINT}/assign`);
    u.searchParams.set('nbh', uuidToWebSafeBase64(nbh));
    if (variant) u.searchParams.set('variant', variant);
    if (accelerator) u.searchParams.set('accelerator', accelerator);
    return u.toString();
  }

  /** Assign a new runtime VM with the requested accelerator. Returns its endpoint. */
  async assign(accelerator: Accelerator): Promise<{ endpoint: string }> {
    const variant: Variant = accelerator === 'NONE' ? 'DEFAULT' : 'GPU';
    const nbh = randomUUID();
    const url = this.buildAssignUrl(nbh, variant, accelerator);

    // GET first to obtain the XSRF token, then POST to actually assign.
    const getResp = await this.request<{ token: string }>(url);
    const post = await this.request<{ endpoint: string }>(url, 'POST', {
      'X-Goog-Colab-Token': getResp?.token ?? '',
    });
    if (!post?.endpoint) throw new Error('Colab assign returned no endpoint');
    return { endpoint: post.endpoint };
  }
}
