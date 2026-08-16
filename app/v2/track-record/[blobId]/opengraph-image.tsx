import { ImageResponse } from 'next/og';
import { fetchCallReceipt, claimHeadline } from '@/lib/walrus/receipt-format';

// A per-call social card: the claim Kelly made + the odds she gave, framed as a signed,
// verifiable receipt. Rendered from the content-addressed blob (no wallet, no Walrus SDK).
export const runtime = 'nodejs';
export const alt = "Kelly's verifiable BTC call";
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

const BG = '#0A0B0D';
const TEAL = '#4dd6b0';
const TEXT = '#E6E8EB';
const MUTED = '#9aa4af';
const LINE = 'rgba(255,255,255,0.08)';

export default async function Image({ params }: { params: Promise<{ blobId: string }> }) {
  const { blobId } = await params;
  const receipt = await fetchCallReceipt(blobId);
  const headline = receipt ? claimHeadline(receipt.claim) : "Kelly's Track Record";
  const odds = receipt ? `${Math.round(receipt.claim.probability * 100)}%` : null;

  return new ImageResponse(
    (
      <div
        style={{
          height: '100%',
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          background: BG,
          padding: '68px 72px',
          fontFamily: 'sans-serif',
        }}
      >
        {/* eyebrow */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{ width: 12, height: 12, borderRadius: 12, background: TEAL, display: 'flex' }} />
          <div style={{ color: TEAL, fontSize: 24, letterSpacing: 3, textTransform: 'uppercase', display: 'flex' }}>
            Kelly · Verifiable call
          </div>
        </div>

        {/* headline claim */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 26 }}>
          <div style={{ color: TEXT, fontSize: 66, fontWeight: 700, lineHeight: 1.08, display: 'flex' }}>{headline}</div>
          {odds && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <div style={{ color: MUTED, fontSize: 32, display: 'flex' }}>Kelly&#39;s odds</div>
              <div style={{ color: TEAL, fontSize: 32, fontWeight: 700, display: 'flex' }}>{odds}</div>
            </div>
          )}
        </div>

        {/* footer */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderTop: `1px solid ${LINE}`,
            paddingTop: 28,
          }}
        >
          <div style={{ color: MUTED, fontSize: 26, display: 'flex' }}>Signed on Walrus · anyone can verify</div>
          <div style={{ color: TEXT, fontSize: 34, fontWeight: 700, letterSpacing: 1, display: 'flex' }}>Skew</div>
        </div>
      </div>
    ),
    { ...size },
  );
}
