import { RetryButton } from '../retry-button';

/**
 * Shared server-fetch error panel (redesign Phase 6). One tokenized, premium
 * treatment for the home + risk routes — replaces the ad-hoc raw-red boxes.
 */
export function ErrorState({
  title,
  message,
  detail,
  note,
}: {
  title: string;
  message: string;
  detail?: string;
  note?: string;
}) {
  return (
    <div className="m-4 sm:m-5">
      <div className="card max-w-xl overflow-hidden">
        <div className="flex items-start gap-3 border-b border-line-soft bg-[var(--down-soft)] px-4 py-3">
          <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-down" />
          <p className="text-[13px] font-medium text-down">{title}</p>
        </div>
        <div className="flex flex-col gap-2 px-4 py-3.5">
          <p className="break-words font-mono text-[11px] tabular-nums text-text-2">{message}</p>
          {detail && <p className="break-words font-mono text-[11px] text-text-3">{detail}</p>}
          {note && <p className="text-[11px] leading-relaxed text-text-3">{note}</p>}
          <div>
            <RetryButton />
          </div>
        </div>
      </div>
    </div>
  );
}
