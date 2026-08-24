/**
 * lib/sui/enoki-trace.ts — debug-only tracing of the REAL Enoki API calls.
 *
 * The sponsor flow calls Enoki server-side (the private key never reaches the
 * browser), so browser DevTools only shows our `/api/sponsor` proxy — not the
 * actual `api.enoki.mystenlabs.com` request the Enoki team asks for. Set
 * `ENOKI_DEBUG=1` and this wraps the server's global `fetch` to print, for every
 * Enoki call, the exact method + URL, the SDK's per-request `Request-Id` (their
 * support looks trades up by this), the request body, and the raw response
 * status + body. Off by default — a no-op unless the flag is set, and it only
 * logs for the Enoki host, passing every other fetch straight through.
 *
 * The Authorization header (the private API key) is deliberately NEVER logged.
 */
const ENOKI_HOST = 'api.enoki.mystenlabs.com';
let installed = false;

/** Read a header value across the HeadersInit union (the SDK uses a plain object). */
function headerVal(h: HeadersInit | undefined, name: string): string | undefined {
  if (!h) return undefined;
  if (h instanceof Headers) return h.get(name) ?? undefined;
  if (Array.isArray(h)) return h.find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
  const rec = h as Record<string, string>;
  return rec[name] ?? rec[name.toLowerCase()];
}

/** Install once (idempotent). Call at module load of the sponsor route. */
export function installEnokiTrace(): void {
  if (installed || !process.env.ENOKI_DEBUG) return;
  installed = true;
  const orig = globalThis.fetch;

  const traced: typeof fetch = async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    if (!url.includes(ENOKI_HOST)) return orig(input, init);

    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const reqId = headerVal(init?.headers, 'Request-Id') ?? '(none)';
    console.log(`\n[enoki-trace] → ${method} ${url}`);
    console.log(`[enoki-trace]   Request-Id: ${reqId}`);
    if (typeof init?.body === 'string') console.log(`[enoki-trace]   request body: ${init.body}`);

    const res = await orig(input, init);
    // Clone so reading the body here doesn't consume it for the SDK.
    const text = await res
      .clone()
      .text()
      .catch(() => '<unreadable>');
    console.log(`[enoki-trace] ← ${res.status} ${res.statusText}  Request-Id: ${reqId}`);
    console.log(`[enoki-trace]   response body: ${text}\n`);
    return res;
  };

  globalThis.fetch = traced;
  console.log(`[enoki-trace] installed (ENOKI_DEBUG set), logging ${ENOKI_HOST} requests`);
}
