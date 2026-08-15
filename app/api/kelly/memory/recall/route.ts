/**
 * POST /api/kelly/memory/recall — recall a trader's saved memories (semantic search).
 * Server-only: uses the delegate key via lib/walrus/memory. Fails soft to { memories: [] }
 * so a memory hiccup never breaks a Kelly reply.
 *
 * AUTH: gated on a verified wallet session (the kelly_mem cookie from /api/kelly/memory/auth).
 * We recall from the SESSION's address, never an owner from the body, so a caller can only read
 * their OWN wallet's memories. No session → 401 with an empty list (the client treats it as
 * "nothing saved" and, for an explicit ask, prompts a one-time sign-in). Still dark behind
 * NEXT_PUBLIC_KELLY_MEMORY, and returns empty if the delegate key / account id isn't configured.
 */
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { recallForUser } from '@/lib/walrus/memory';
import { KELLY_AUTH_COOKIE, readSession } from '@/lib/server/kelly-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<NextResponse> {
  const jar = await cookies();
  const owner = await readSession(jar.get(KELLY_AUTH_COOKIE)?.value);
  if (!owner) return NextResponse.json({ memories: [] }, { status: 401 });

  let body: { owner?: unknown; query?: unknown; limit?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ memories: [] });
  }
  // If the client names the wallet it's asking for, it must match the session (guards a
  // stale cookie after a wallet switch). The recall itself always uses the session address.
  const asked = String(body.owner ?? '').trim().toLowerCase();
  if (asked && asked !== owner) return NextResponse.json({ memories: [] }, { status: 401 });
  const query = String(body.query ?? '').trim().slice(0, 400);
  const limit = Math.min(Math.max(Math.trunc(Number(body.limit) || 6), 1), 20);
  if (!query) return NextResponse.json({ memories: [] });
  try {
    const mems = await recallForUser(owner, query, limit);
    return NextResponse.json({ memories: mems.map((m) => m.text).filter(Boolean) });
  } catch {
    return NextResponse.json({ memories: [] });
  }
}
