/**
 * GET /api/kelly/chat/[id] — read one of the trader's past conversations in full.
 *
 * AUTH: gated on the wallet session; the owner comes from the session, and
 * readConversation only resolves ids in THAT owner's index, so a caller can never
 * read another wallet's transcript by guessing an id.
 */
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { KELLY_AUTH_COOKIE, readSession } from '@/lib/server/kelly-auth';
import { readConversation } from '@/lib/walrus/chat-history';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const jar = await cookies();
  const owner = await readSession(jar.get(KELLY_AUTH_COOKIE)?.value);
  if (!owner) return NextResponse.json({ conversation: null }, { status: 401 });

  const { id } = await params;
  try {
    const conversation = await readConversation(owner, id);
    if (!conversation) return NextResponse.json({ conversation: null }, { status: 404 });
    return NextResponse.json({ conversation });
  } catch {
    return NextResponse.json({ conversation: null }, { status: 502 });
  }
}
