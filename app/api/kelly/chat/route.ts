/**
 * /api/kelly/chat — a trader's durable Kelly chat history on Walrus.
 *   POST  → save (or update) the current conversation; body { id, messages }.
 *   GET   → list the trader's past conversations (compact index rows).
 *
 * AUTH: gated on a verified wallet session (the kelly_mem cookie from
 * /api/kelly/memory/auth). The owner ALWAYS comes from the session, never the body,
 * so a trader can only ever touch their own chats. Fails soft so a Walrus hiccup
 * never breaks the chat UI. Server-only (writes sign with the Walrus writer key).
 */
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { KELLY_AUTH_COOKIE, readSession } from '@/lib/server/kelly-auth';
import { saveConversation, listConversations, sanitizeConversation } from '@/lib/walrus/chat-history';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function sessionOwner(): Promise<string | null> {
  const jar = await cookies();
  return readSession(jar.get(KELLY_AUTH_COOKIE)?.value);
}

export async function GET(req: Request): Promise<NextResponse> {
  const owner = await sessionOwner();
  if (!owner) return NextResponse.json({ conversations: [] }, { status: 401 });
  const limit = Math.min(Math.max(Number(new URL(req.url).searchParams.get('limit')) || 50, 1), 100);
  try {
    return NextResponse.json({ conversations: await listConversations(owner, limit) });
  } catch {
    return NextResponse.json({ conversations: [] });
  }
}

export async function POST(req: Request): Promise<NextResponse> {
  const owner = await sessionOwner();
  if (!owner) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  if (!process.env.WALRUS_WRITER_KEY) return NextResponse.json({ ok: false, error: 'not_configured' }, { status: 503 });

  let body: { id?: unknown; messages?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: 'bad_request' }, { status: 400 });
  }

  const convo = sanitizeConversation(body.id, body.messages, Date.now());
  if (!convo) return NextResponse.json({ ok: false, error: 'nothing_to_save' }, { status: 400 });

  try {
    const { id, blobId } = await saveConversation(owner, convo);
    return NextResponse.json({ ok: true, id, blobId });
  } catch {
    return NextResponse.json({ ok: false, error: 'save_failed' }, { status: 502 });
  }
}
