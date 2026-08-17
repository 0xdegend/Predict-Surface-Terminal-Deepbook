/**
 * lib/copilot/memory-client.ts — client-side calls to Kelly's memory API.
 *
 * Kelly runs in the browser; the memory delegate key is server-only (lib/walrus/memory.ts).
 * So the chat hosts talk to `/api/kelly/memory/*` here, and the route handlers do the
 * signed MemWal work. Both helpers fail soft (empty / false) so a memory hiccup never
 * breaks a reply — the caller just says it couldn't reach memory. See the memory intents
 * in lib/copilot/intents.ts and the wiring in copilot-screen.tsx / kelly-dock.tsx.
 *
 * AUTH: recall/remember require a wallet session (the kelly_mem HttpOnly cookie), which the
 * same-origin fetches carry automatically. The sign-in dance (nonce → sign → verify) is
 * driven by useKellyMemoryAuth; the two helpers below are its transport. No session → the
 * API returns 401 and these helpers fail soft (empty / false), same as any other hiccup.
 */

export interface MemorySession {
  authed: boolean;
  address: string | null;
  /** A fresh one-time nonce to sign, when the server has auth configured. */
  nonce: string | null;
  /** False when the server has no signing secret set (memory effectively off). */
  configured: boolean;
}

/** Read the current memory session and get a fresh nonce to sign. Fails soft to unauthed. */
export async function getMemorySession(): Promise<MemorySession> {
  try {
    const res = await fetch('/api/kelly/memory/auth', { method: 'GET' });
    if (!res.ok) return { authed: false, address: null, nonce: null, configured: false };
    const json = (await res.json()) as Partial<MemorySession>;
    return {
      authed: json.authed === true,
      address: typeof json.address === 'string' ? json.address : null,
      nonce: typeof json.nonce === 'string' ? json.nonce : null,
      configured: json.configured === true,
    };
  } catch {
    return { authed: false, address: null, nonce: null, configured: false };
  }
}

/** Exchange a signed nonce for a session cookie. Returns the proven address, or null. */
export async function verifyMemorySignIn(proof: {
  address: string;
  nonce: string;
  issuedAt: string;
  signature: string;
}): Promise<string | null> {
  try {
    const res = await fetch('/api/kelly/memory/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(proof),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { ok?: boolean; address?: unknown };
    return json.ok === true && typeof json.address === 'string' ? json.address : null;
  } catch {
    return null;
  }
}

/** Recall a trader's most relevant memories for a query. Returns plain strings, best first. */
export async function recallMemories(owner: string, query: string, limit = 6): Promise<string[]> {
  try {
    const res = await fetch('/api/kelly/memory/recall', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner, query, limit }),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { memories?: unknown };
    return Array.isArray(json.memories) ? json.memories.filter((m): m is string => typeof m === 'string') : [];
  } catch {
    return [];
  }
}

/** A broad query that pulls the trader's name, preferences, style, goals, and notes —
 *  used to ground the LLM tier so it can answer personal questions the rules don't
 *  specifically classify. */
const AI_MEMORY_QUERY = 'the trader’s name, preferences, trading style, goals, and notes';

/**
 * Recall a trader's memories to ground the LLM, capped so a slow memory service never
 * delays Kelly's answer (returns [] after ~2.5s or on any hiccup). Feed the result into
 * the AI context so Claude can answer questions about the trader from what they saved.
 */
export async function recallMemoriesForAI(owner: string): Promise<string[]> {
  const timeout = new Promise<string[]>((resolve) => setTimeout(() => resolve([]), 2500));
  try {
    return await Promise.race([recallMemories(owner, AI_MEMORY_QUERY, 8), timeout]);
  } catch {
    return [];
  }
}

/** Store a fact about a trader. Returns true when the relayer accepted and indexed it. */
export async function rememberFact(owner: string, text: string): Promise<boolean> {
  try {
    const res = await fetch('/api/kelly/memory/remember', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner, text }),
    });
    if (!res.ok) return false;
    const json = (await res.json()) as { ok?: boolean };
    return json.ok === true;
  } catch {
    return false;
  }
}
