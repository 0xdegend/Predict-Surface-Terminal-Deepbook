import type { Metadata } from 'next';
import Link from 'next/link';
import { LuBadgeCheck, LuShieldCheck, LuArrowUpRight, LuArrowLeft } from 'react-icons/lu';
import { fetchCallReceipt, claimHeadline, receiptBlobUrl } from '@/lib/walrus/receipt-format';

export const dynamic = 'force-dynamic';

// A focused, shareable view of ONE Kelly call. The opengraph-image.tsx in this segment renders
// the social card; this page is what a human sees when they open the link. Server-rendered from
// the content-addressed blob (no wallet), so it works for anyone with the id.

export async function generateMetadata({ params }: { params: Promise<{ blobId: string }> }): Promise<Metadata> {
  const { blobId } = await params;
  const receipt = await fetchCallReceipt(blobId);
  if (!receipt) {
    return { title: "Kelly's Track Record", description: 'A verifiable BTC call, signed to Walrus.' };
  }
  const headline = claimHeadline(receipt.claim);
  const pct = `${Math.round(receipt.claim.probability * 100)}%`;
  const title = `Kelly's call: ${headline}`;
  const description = `Kelly gave this ${pct} and signed it to Walrus the moment it was made, so it can't be edited after the fact.`;
  return { title, description, openGraph: { title, description }, twitter: { card: 'summary_large_image', title, description } };
}

export default async function CallReceiptPage({ params }: { params: Promise<{ blobId: string }> }) {
  const { blobId } = await params;
  const receipt = await fetchCallReceipt(blobId);

  return (
    <main className="flex flex-1 flex-col">
      <div className="mx-auto w-full max-w-2xl px-4 py-10 sm:px-5">
        <Link
          href="/v2/track-record"
          className="mb-4 inline-flex items-center gap-1.5 text-[12px] text-text-3 transition-colors hover:text-text-1"
        >
          <LuArrowLeft size={13} />
          Kelly&rsquo;s Track Record
        </Link>

        <div className="glass-card p-6 sm:p-8">
          <p className="eyebrow mb-3 flex items-center gap-1.5">
            <LuBadgeCheck size={12} className="text-accent" /> Kelly · verifiable call
          </p>

          {receipt ? (
            <>
              <h1 className="text-[22px] font-semibold leading-snug tracking-tight text-text-1 sm:text-[26px]">
                {claimHeadline(receipt.claim)}
              </h1>
              <p className="mt-2.5 flex items-center gap-2 text-[13px] text-text-2">
                Kelly&rsquo;s odds
                <span className="font-mono text-[15px] text-up">{Math.round(receipt.claim.probability * 100)}%</span>
              </p>

              <div className="mt-6 flex flex-wrap gap-2.5">
                <a
                  href={receiptBlobUrl(blobId)}
                  target="_blank"
                  rel="noreferrer"
                  className="group glass-inset inline-flex items-center gap-1.5 px-3.5 py-2 text-[12px] font-medium text-text-2 transition-all duration-200 hover:border-(--accent-line) hover:text-text-1"
                >
                  <LuShieldCheck size={13} className="text-text-3 transition-colors duration-200 group-hover:text-accent" />
                  Verify on Walrus
                  <LuArrowUpRight size={11} className="text-text-3" />
                </a>
                <Link
                  href="/v2/track-record"
                  className="glass-inset inline-flex items-center px-3.5 py-2 text-[12px] font-medium text-text-2 transition-all duration-200 hover:border-(--accent-line) hover:text-text-1"
                >
                  See the full record
                </Link>
              </div>

              <p className="mt-6 flex items-start gap-1.5 border-t border-line pt-4 text-[11px] leading-relaxed text-text-3">
                <LuShieldCheck size={12} className="mt-px flex-none" />
                <span>
                  This receipt was signed by Kelly and written to Walrus the moment the call was made. It is
                  content-addressed, so it can&rsquo;t be edited after the fact. Verify opens the original exactly as it
                  was written.
                </span>
              </p>
            </>
          ) : (
            <>
              <h1 className="text-[20px] font-semibold text-text-1">This call isn&rsquo;t available.</h1>
              <p className="mt-2 text-[13px] text-text-2">
                The receipt could not be found on Walrus. It may still be settling, or the link may be incomplete.
              </p>
              <Link
                href="/v2/track-record"
                className="glass-inset mt-5 inline-flex items-center px-3.5 py-2 text-[12px] font-medium text-text-2 transition-all duration-200 hover:border-(--accent-line) hover:text-text-1"
              >
                See Kelly&rsquo;s full record
              </Link>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
