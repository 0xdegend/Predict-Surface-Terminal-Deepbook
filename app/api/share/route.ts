/**
 * POST /api/share — mint a short link for a shared trade.
 *
 * Body: { token }  where token is a valid /t/<token> recipe token.
 * Returns: { id }  → the public link is `${origin}/s/${id}`.
 *
 * The token is validated (decoded) before storage so only real recipes get a slug,
 * never arbitrary strings. Falls back to in-process storage when no KV is configured
 * (the client then just keeps using the long /t link — see the share modal).
 */
import { NextResponse } from 'next/server';
import { decodeRecipe } from '@/lib/share/trade-link';
import { createShortLink } from '@/lib/server/share-store';

export async function POST(req: Request) {
  let token: unknown;
  try {
    ({ token } = await req.json());
  } catch {
    return NextResponse.json({ error: 'bad request' }, { status: 400 });
  }
  if (typeof token !== 'string' || !decodeRecipe(token)) {
    return NextResponse.json({ error: 'invalid token' }, { status: 400 });
  }
  try {
    const id = await createShortLink(token);
    return NextResponse.json({ id });
  } catch {
    return NextResponse.json({ error: 'could not create link' }, { status: 500 });
  }
}
