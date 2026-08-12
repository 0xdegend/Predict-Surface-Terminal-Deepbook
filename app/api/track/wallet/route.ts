/**
 * POST /api/track/wallet — the wallet-mix beacon.
 *
 * The client fires this once per browser session when a wallet connects, reporting
 * the PUBLIC address + the sign-in category (google / slush / other) so the admin
 * console can show the wallet mix. No auth (it's a usage beacon), but the address is
 * format-validated and the kind is enum-checked, so junk can't inflate the sets. It
 * stores only the address + category — never a Google identity, email, or any PII.
 */
import { NextResponse } from 'next/server';
import { recordWalletKind } from '@/lib/server/wallet-track-store';
import { isWalletKind } from '@/lib/wallet-kind';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ADDR_RE = /^0x[0-9a-f]{64}$/i;

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'bad json' }, { status: 400 });
  }
  const { address, kind } = (body ?? {}) as { address?: unknown; kind?: unknown };
  if (typeof address !== 'string' || !ADDR_RE.test(address) || !isWalletKind(kind)) {
    return NextResponse.json({ ok: false, error: 'bad input' }, { status: 400 });
  }
  try {
    await recordWalletKind(address, kind);
  } catch {
    // Never surface a store hiccup to the beacon — it's fire-and-forget on the client.
  }
  return NextResponse.json({ ok: true });
}
