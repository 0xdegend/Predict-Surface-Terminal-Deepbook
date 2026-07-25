/**
 * lib/insights/clawby-server.ts — SERVER-ONLY Clawby relay helpers.
 *
 * Holds the CLAWBY_API_KEY and the relay call + CoinGlass envelope unwrap shared by
 * the /api/insights routes. NEVER import this from a client component: the key is a
 * per-account secret and the API is rate-limited. Kept OUT of the lib/insights
 * barrel so it can't be pulled into a browser bundle by accident.
 */
const CLAWBY = 'https://api.openclawby.com/api/relay';
const KEY = process.env.CLAWBY_API_KEY;

export const hasClawbyKey = () => !!KEY;

/** Unwrap the CoinGlass envelope `{code, data}` that Clawby relays return. */
export function unwrap(data: unknown): unknown {
  if (data && typeof data === 'object') {
    const o = data as Record<string, unknown>;
    if ('data' in o && 'code' in o) return o.data;
  }
  return data;
}

export async function relay(name: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const res = await fetch(CLAWBY, {
    method: 'POST',
    headers: { 'X-API-Key': KEY as string, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, params }),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`clawby ${name} → ${res.status}`);
  const json = (await res.json()) as { data?: unknown };
  return unwrap(json.data);
}

export function asList(v: unknown): Record<string, unknown>[] {
  const u = unwrap(v);
  return Array.isArray(u) ? (u as Record<string, unknown>[]) : [];
}

export function toNum(v: unknown): number | null {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

/** '260726' (YYMMDD) → '2026-07-26'. */
export function parseYymmdd(d: unknown): string {
  const s = String(d ?? '');
  return /^\d{6}$/.test(s) ? `20${s.slice(0, 2)}-${s.slice(2, 4)}-${s.slice(4, 6)}` : s;
}
