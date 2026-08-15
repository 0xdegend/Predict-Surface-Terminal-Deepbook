/**
 * /api/kelly/memory/auth — the Sign In with Sui gate for Kelly's memory.
 *
 * GET    → session status ({ authed, address }) plus a fresh one-time nonce to sign.
 * POST   → exchange a signed nonce ({ address, nonce, issuedAt, signature }) for a session
 *          cookie. Verifies the signature recovers the address (server rebuilds the exact
 *          signed message), consumes the nonce, then sets an HttpOnly cookie.
 * DELETE → sign out (clear the cookie).
 *
 * All the crypto lives in lib/server/kelly-auth.ts. Fails closed: a bad/absent proof never
 * sets a cookie, and the recall/remember routes reject anything without a valid session.
 */
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import {
  KELLY_AUTH_COOKIE,
  kellyAuthConfigured,
  issueNonce,
  verifySignIn,
  mintSession,
  readSession,
  sessionCookieOptions,
} from '@/lib/server/kelly-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET — current session + a nonce for a fresh sign-in. */
export async function GET(): Promise<NextResponse> {
  if (!kellyAuthConfigured()) {
    return NextResponse.json({ authed: false, address: null, nonce: null, configured: false });
  }
  const jar = await cookies();
  const address = await readSession(jar.get(KELLY_AUTH_COOKIE)?.value);
  const nonce = await issueNonce();
  return NextResponse.json({ authed: !!address, address, nonce, configured: true });
}

/** POST — verify a signed nonce and set the session cookie. */
export async function POST(req: Request): Promise<NextResponse> {
  if (!kellyAuthConfigured()) {
    return NextResponse.json({ ok: false, error: 'unconfigured' }, { status: 503 });
  }
  let body: { address?: unknown; nonce?: unknown; issuedAt?: unknown; signature?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: 'bad_request' }, { status: 400 });
  }
  const address = String(body.address ?? '').trim();
  const nonce = String(body.nonce ?? '').trim();
  const issuedAt = String(body.issuedAt ?? '').trim();
  const signature = String(body.signature ?? '').trim();
  if (!address || !nonce || !issuedAt || !signature) {
    return NextResponse.json({ ok: false, error: 'missing_fields' }, { status: 400 });
  }

  const proven = await verifySignIn({ address, nonce, issuedAt, signature });
  if (!proven) {
    return NextResponse.json({ ok: false, error: 'invalid_signature' }, { status: 401 });
  }
  const token = await mintSession(proven);
  if (!token) {
    return NextResponse.json({ ok: false, error: 'unconfigured' }, { status: 503 });
  }
  const res = NextResponse.json({ ok: true, address: proven });
  res.cookies.set(KELLY_AUTH_COOKIE, token, sessionCookieOptions());
  return res;
}

/** DELETE — sign out. */
export async function DELETE(): Promise<NextResponse> {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(KELLY_AUTH_COOKIE, '', { ...sessionCookieOptions(), maxAge: 0 });
  return res;
}
