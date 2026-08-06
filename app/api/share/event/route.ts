/**
 * POST /api/share/event — record a shared-link attribution event.
 *
 * Body: { kind: 'open' | 'convert', ref? }. Best-effort and fire-and-forget: it
 * never fails the client. `open` fires when a recipient lands on a shared link,
 * `convert` when they load it into their ticket. Tallied per sender ref for a later
 * rewards-rail credit (see lib/server/share-store).
 */
import { NextResponse } from 'next/server';
import { recordShareEvent } from '@/lib/server/share-store';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const kind = body?.kind;
    if (kind !== 'open' && kind !== 'convert') {
      return NextResponse.json({ ok: false }, { status: 400 });
    }
    const ref = typeof body?.ref === 'string' ? body.ref : undefined;
    await recordShareEvent(kind, ref);
  } catch {
    /* best-effort; swallow so attribution never breaks the flow */
  }
  return NextResponse.json({ ok: true });
}
