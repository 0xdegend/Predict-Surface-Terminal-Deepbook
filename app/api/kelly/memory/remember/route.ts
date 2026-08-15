/**
 * POST /api/kelly/memory/remember — store a fact about a trader (Walrus Memory).
 * Server-only: signs each request with the delegate key via lib/walrus/memory. Fails soft
 * to { ok: false } so a memory hiccup never breaks a Kelly reply.
 *
 * AUTH: gated on a verified wallet session (the kelly_mem cookie from /api/kelly/memory/auth).
 * The OWNER of the memory is the session's address — never a value from the body — so a caller
 * can only ever write into their OWN wallet's memory. No session → 401. Still dark behind
 * NEXT_PUBLIC_KELLY_MEMORY, and returns { ok: false } if WALRUS_DELEGATE_KEY /
 * WALRUS_MEMORY_ACCOUNT_ID isn't configured.
 */
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { rememberForUser } from '@/lib/walrus/memory';
import { KELLY_AUTH_COOKIE, readSession } from '@/lib/server/kelly-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<NextResponse> {
  const jar = await cookies();
  const owner = await readSession(jar.get(KELLY_AUTH_COOKIE)?.value);
  if (!owner) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });

  let body: { owner?: unknown; text?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false });
  }
  // If the client names the wallet it's writing for, it must match the session (guards a
  // stale cookie after a wallet switch). The write itself always uses the session address.
  const asked = String(body.owner ?? '').trim().toLowerCase();
  if (asked && asked !== owner) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  const text = String(body.text ?? '').trim().slice(0, 2000);
  if (!text) return NextResponse.json({ ok: false });
  try {
    const r = await rememberForUser(owner, text);
    return NextResponse.json({ ok: true, id: r.id });
  } catch {
    return NextResponse.json({ ok: false });
  }
}
