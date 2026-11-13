// src/services/redis.ts
import { config } from '../config';
import { REDIS_CONNECTION_OPTIONS } from './redis-connection-options';
import { SupervisedRedisClient } from './redis-supervisor';

class RedisService {
  // Supervised, not a bare instance. Two separate failures live here:
  //
  //   `maxRetries` (redis-connection-options.ts, fr#955) fixes "the client gave
  //   up after 10 redials" — a REDIS outage. Necessary, and it holds.
  //
  //   The supervisor (redis-supervisor.ts, fr#947 recurrence 2026-09-06) fixes
  //   "the client stopped redialling at all" — a TRANSPORT reset while Redis
  //   stayed up and answering. A retry BUDGET cannot restart a loop that is no
  //   longer running, which is why the running image already had unbounded
  //   retries and still served 503 for 2h45m.
  private readonly supervisor = new SupervisedRedisClient({
    name: 'fr-redis',
    factory: () => new Bun.RedisClient(config.redis.url, REDIS_CONNECTION_OPTIONS),
    onConnect: () => {
      console.log('Redis connected');
    },
    onClose: () => {
      // WARN, not log: this line is the first sign of the fr#947 shape, and at
      // `log` it reads like routine lifecycle noise next to 'Redis connected'.
      console.warn('Redis disconnected — reconnecting (see fr#947)');
    },
  });

  async get<T = any>(key: string): Promise<T | null> {
    const value = await this.supervisor.run((c) => c.get(key));
    if (!value) return null;

    try {
      return JSON.parse(value) as T;
    } catch {
      return value as T;
    }
  }

  async set(key: string, value: any, ttlSeconds = 300): Promise<void> {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    await this.supervisor.run((c) => c.setex(key, ttlSeconds, serialized));
  }

  async del(key: string): Promise<void> {
    await this.supervisor.run((c) => c.del(key));
  }

  async exists(key: string): Promise<boolean> {
    return this.supervisor.run((c) => c.exists(key));
  }

  async ping(): Promise<string> {
    // The health path. This is the call that returned
    // `ERR_REDIS_CONNECTION_CLOSED: Connection has failed` every ~10s for 2.5h
    // against a Redis that answered `+PONG` to a fresh socket in the same
    // container — so it is the call that must be able to notice and recover.
    return this.supervisor.run((c) => c.ping());
  }

  /**
   * Escape hatch for raw Redis commands that aren't first-class on Bun.RedisClient.
   * Used by services/download-tokens.ts for atomic single-use `GETDEL`.
   */
  async send(command: string, args: string[]): Promise<unknown> {
    return this.supervisor.run((c) => c.send(command, args));
  }

  async close(): Promise<void> {
    this.supervisor.close();
  }

  /** Test/observability only — rebuild count and current disconnect state. */
  stats() {
    return this.supervisor.stats();
  }
}

export const redis = new RedisService();
