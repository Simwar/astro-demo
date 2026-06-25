/**
 * Persistent OAuthStorage for Mastra's MCPOAuthClientProvider.
 *
 * The OAuth flow (dynamic client registration, PKCE verifier, access/refresh
 * tokens) writes through this store, so it must survive process restarts and be
 * readable by every provider instance that shares a server key.
 *
 * `makeOAuthStorage(serverKey)` picks the backend:
 *   - REDIS_URL present  -> Redis (works on the read-only deployed container FS;
 *                           provisioned by `knowledge.cache: redis` in astropods.yml)
 *   - otherwise          -> a JSON file under OAUTH_STORE_DIR (local dev)
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createClient } from 'redis';
import type { OAuthStorage } from '@mastra/mcp';

/**
 * File-backed store. Reads fresh on every `get` (no in-memory cache): the
 * agent runtime and the auth tools each construct their own provider for the
 * same server, and one must see tokens the other just wrote.
 */
export class FileOAuthStorage implements OAuthStorage {
  constructor(private readonly file: string) {}

  private load(): Record<string, string> {
    try {
      return JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, string>;
    } catch {
      return {};
    }
  }

  private flush(data: Record<string, string>): void {
    mkdirSync(dirname(this.file), { recursive: true });
    // 0600: these are bearer/refresh tokens — keep them owner-only.
    writeFileSync(this.file, JSON.stringify(data, null, 2), { mode: 0o600 });
  }

  get(key: string): string | undefined {
    return this.load()[key];
  }

  set(key: string, value: string): void {
    const data = this.load();
    data[key] = value;
    this.flush(data);
  }

  delete(key: string): void {
    const data = this.load();
    delete data[key];
    this.flush(data);
  }
}

/** Redis-backed store, namespaced per server key. Connects lazily. */
export class RedisOAuthStorage implements OAuthStorage {
  private readonly client: ReturnType<typeof createClient>;
  private readonly ready: Promise<unknown>;

  constructor(private readonly prefix: string, url: string) {
    this.client = createClient({
      url,
      // Survive transient drops (the agent may outlive a Redis blip). node-redis
      // queues commands while reconnecting, so get/set just wait rather than fail.
      socket: { reconnectStrategy: (retries) => Math.min(retries * 200, 3000) },
    });
    this.client.on('error', (err) => console.error('[oauth-storage] redis error:', err));
    this.ready = this.client.connect().catch((err) => {
      console.error('[oauth-storage] redis connect failed:', err);
    });
  }

  private k(key: string): string {
    return `oauth:${this.prefix}:${key}`;
  }

  async get(key: string): Promise<string | undefined> {
    await this.ready;
    return (await this.client.get(this.k(key))) ?? undefined;
  }

  async set(key: string, value: string): Promise<void> {
    await this.ready;
    await this.client.set(this.k(key), value);
  }

  async delete(key: string): Promise<void> {
    await this.ready;
    await this.client.del(this.k(key));
  }
}

export function makeOAuthStorage(serverKey: string): OAuthStorage {
  const url = process.env.REDIS_URL;
  if (url) return new RedisOAuthStorage(serverKey, url);
  const dir = process.env.OAUTH_STORE_DIR ?? join(process.cwd(), '.astro-oauth');
  return new FileOAuthStorage(join(dir, `${serverKey}.json`));
}

/**
 * Describes the active token-store backend, for a one-line boot diagnostic.
 * Surfacing this means `ast project logs` confirms tokens are durable on a
 * deployed agent (Redis) instead of silently falling back to the read-only FS.
 */
export function oauthStorageInfo(): { backend: 'redis' | 'file'; durable: boolean; detail: string } {
  if (process.env.REDIS_URL) {
    return { backend: 'redis', durable: true, detail: 'Redis — durable across restarts' };
  }
  const dir = process.env.OAUTH_STORE_DIR ?? join(process.cwd(), '.astro-oauth');
  return {
    backend: 'file',
    durable: false,
    detail: `file store at ${dir} — NOT durable across container restarts (set REDIS_URL via knowledge.cache to persist)`,
  };
}
