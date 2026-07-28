/**
 * lib/server/kv.ts — the shared server-only Redis (Upstash / "Vercel KV") client.
 *
 * Vercel's KV marketplace integration injects KV_REST_API_URL / KV_REST_API_TOKEN;
 * a plain Upstash setup uses UPSTASH_REDIS_REST_URL / _TOKEN. Either works. When
 * neither is configured (local dev, or a fork without a store) `kv` is null and
 * callers fall back to their own in-process cache. Same env read as the original KV
 * consumer, lib/server/grant-store.ts.
 */
import { Redis } from '@upstash/redis';

const REST_URL = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
const REST_TOKEN = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;

/** True when a durable Redis store is configured (survives cold starts / instances). */
export const kvDurable = !!REST_URL && !!REST_TOKEN;

/** Shared Upstash client, or null when no store is configured. */
export const kv = kvDurable ? new Redis({ url: REST_URL!, token: REST_TOKEN! }) : null;
