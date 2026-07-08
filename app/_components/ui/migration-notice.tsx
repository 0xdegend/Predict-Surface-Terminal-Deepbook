/**
 * MigrationNotice — shown on the legacy surface when the legacy Predict server
 * can't be reached. The legacy testnet backend has been wound down, so instead
 * of a dead-end "server error" we tell the trader the app has moved and hand
 * them a one-click path to the new release. A quiet Retry stays for the case
 * where the old server briefly comes back.
 */
import Link from 'next/link';
import { LuArrowRightLeft, LuArrowRight } from 'react-icons/lu';
import { RetryButton } from '../retry-button';

export function MigrationNotice({
  message,
  detail,
}: {
  /** Raw fetch error — kept as the de-emphasized technical footer. */
  message: string;
  /** e.g. the legacy server URL. */
  detail?: string;
}) {
  return (
    <div className="flex min-h-[60vh] flex-1 items-center justify-center p-6">
      <div className="glass relative w-full max-w-md overflow-hidden rounded-2xl p-7 text-center shadow-[0_24px_70px_-24px_rgba(0,0,0,0.8)]">
        {/* soft accent wash at the top — teal: this is an invitation, not an error */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-24"
          style={{
            background: 'radial-gradient(80% 100% at 50% 0%, var(--accent-soft), transparent 70%)',
          }}
        />

        <div className="relative flex flex-col items-center gap-4">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-(--accent-soft) text-up ring-1 ring-up/20">
            <LuArrowRightLeft size={22} />
          </span>

          <div className="flex flex-col gap-1.5">
            <h2 className="text-[16px] font-semibold tracking-tight text-text-1">
              Migration notice
            </h2>
            <p className="text-[12px] leading-relaxed text-text-2">
              The legacy testnet server is no longer responding, so this version can&apos;t load
              market data. Trading continues on the new release — same wallet, same DUSDC.
            </p>
          </div>

          <Link
            href="/v2"
            className="group inline-flex w-full items-center justify-center gap-2 rounded-xl border border-(--accent-line) bg-(--accent-soft) px-4 py-3 text-[13px] font-semibold text-up transition-all duration-200 hover:bg-up/15 hover:shadow-[0_0_30px_-8px_var(--accent-glow)]"
          >
            Navigate to V2
            <LuArrowRight
              size={15}
              className="transition-transform duration-200 group-hover:translate-x-0.5"
            />
          </Link>

          {/* quiet recovery path in case the legacy server comes back */}
          <RetryButton />

          {/* technical detail — de-emphasized, for support/debugging */}
          <p className="break-words font-mono text-[10px] leading-relaxed text-text-3">
            {message}
            {detail ? ` · ${detail}` : ''}
          </p>
        </div>
      </div>
    </div>
  );
}
