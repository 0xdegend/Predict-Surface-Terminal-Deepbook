/**
 * lib/server/share-store.ts — server-only store for shared trade links (Phase 5):
 * short-link ids and referral attribution counters.
 *
 * Same Redis-or-fallback shape as grant-store: backed by Upstash (Vercel KV injects
 * KV_REST_API_URL / KV_REST_API_TOKEN) so short links and referral tallies survive
 * redeploys and are shared across serverless instances; when those env vars are
 * absent (local dev, a fork) it degrades to in-process maps so the feature still
 * works, just without cross-instance durability.
 *
 * Attribution is OFF-CHAIN by design: a shared trade carries the sender's `ref`, and
 * we tally opens/converts per ref here. This is the data a later rewards-rail credit
 * consumes (see the shareable-trade-links plan) — on-chain per-user builder-code
 * attribution is a separate, protocol-dependent step and is intentionally not wired
 * from this store.
 *
 * Keys:
 *   share:link:<id>        the recipe token behind a short link (TTL-bounded)
 *   share:ref:<ref>:open   times a ref's links were opened (client beacon)
 *   share:ref:<ref>:conv   times a ref's links were loaded into a ticket
 *   share:total:<kind>     global counters
 */
import { Redis } from '@upstash/redis';
import { customAlphabet } from 'nanoid';

const REST_URL = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
const REST_TOKEN = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;

/** True when a Redis store is configured (durable, cross-instance). */
export const shareStoreDurable = !!REST_URL && !!REST_TOKEN;

const redis = shareStoreDurable ? new Redis({ url: REST_URL!, token: REST_TOKEN! }) : null;

/** Short-link lifetime. 90 days is plenty for a testnet trade invite. */
const LINK_TTL = 60 * 60 * 24 * 90;

/** url-safe id, no lookalike ambiguity issues for a share slug. */
const newId = customAlphabet('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 8);

export type ShareEventKind = 'open' | 'convert';
const KIND_SUFFIX: Record<ShareEventKind, string> = { open: 'open', convert: 'conv' };

const linkKey = (id: string) => `share:link:${id}`;
const refKey = (ref: string, kind: ShareEventKind) => `share:ref:${ref}:${KIND_SUFFIX[kind]}`;
const totalKey = (kind: ShareEventKind) => `share:total:${KIND_SUFFIX[kind]}`;

const VALID_ID = /^[A-Za-z0-9]{6,16}$/;
/** A ref long enough to matter, capped, and free of separators that break keys. */
export const cleanShareRef = (ref: string | undefined): string | undefined => {
  if (!ref) return undefined;
  const s = ref.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40);
  return s.length ? s : undefined;
};

/* ---------------- in-process fallback (no Redis configured) ---------------- */
const memLinks = new Map<string, string>();
const memCounts = new Map<string, number>();

/**
 * Store a recipe token behind a fresh short id (retrying on the astronomically
 * unlikely collision). Returns the id; the public link is `${origin}/s/${id}`.
 */
export async function createShortLink(token: string): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = newId();
    if (redis) {
      const ok = await redis.set(linkKey(id), token, { nx: true, ex: LINK_TTL });
      if (ok) return id;
    } else if (!memLinks.has(id)) {
      memLinks.set(id, token);
      return id;
    }
  }
  throw new Error('could not allocate a share id');
}

/** Look up the recipe token behind a short id, or null. */
export async function resolveShortLink(id: string): Promise<string | null> {
  if (!VALID_ID.test(id)) return null;
  if (redis) return (await redis.get<string>(linkKey(id))) ?? null;
  return memLinks.get(id) ?? null;
}

/** Tally an attribution event, globally and (when present) per sender ref. */
export async function recordShareEvent(kind: ShareEventKind, ref?: string): Promise<void> {
  const cleaned = cleanShareRef(ref);
  const keys = [totalKey(kind), ...(cleaned ? [refKey(cleaned, kind)] : [])];
  if (redis) {
    await Promise.all(keys.map((k) => redis.incr(k)));
  } else {
    for (const k of keys) memCounts.set(k, (memCounts.get(k) ?? 0) + 1);
  }
}

/** A sender's referral tallies (for a future rewards-rail credit). */
export async function getRefStats(ref: string): Promise<{ open: number; convert: number }> {
  const cleaned = cleanShareRef(ref);
  if (!cleaned) return { open: 0, convert: 0 };
  if (redis) {
    const [open, convert] = await Promise.all([
      redis.get<number>(refKey(cleaned, 'open')),
      redis.get<number>(refKey(cleaned, 'convert')),
    ]);
    return { open: open ?? 0, convert: convert ?? 0 };
  }
  return {
    open: memCounts.get(refKey(cleaned, 'open')) ?? 0,
    convert: memCounts.get(refKey(cleaned, 'convert')) ?? 0,
  };
}
