'use client';

/**
 * V2CopilotTicketModal — the trade ticket as an on-demand modal rather than an
 * always-visible rail. On /v2/copilot the surface owns the page; the ticket only
 * pops out when the trader is ready — from the "Place this bet" button on a
 * co-pilot suggestion, or any pick that flips `ticketSheetOpen`.
 *
 * It reuses the SHORT `V2CompactTicket` (the same one the surface click-to-mint
 * popover uses) instead of the full rail ticket, so the modal stays tight — no
 * first-timer guide, step bar, or mode toggle to scroll past. The co-pilot has
 * already chosen side + level, so it opens straight on the bet view (amount +
 * leverage + mint); "change strike" steps back to the slider if they want it.
 */
import { Modal } from '@/app/_components/ui/modal';
import { useV2TradeStore } from '@/lib/store/v2-trade-store';
import { useNow } from '@/lib/hooks/use-now';
import { V2CompactTicket } from '../ticket/compact-ticket';
import type { SmileInput } from '@/lib/svi/surface';
import type { Oracle } from '@/lib/api/types';
import type { V2Market } from '@/lib/api/v2/types';
import type { LivePricer } from '@/lib/sui/v2/pricer';

export function V2CopilotTicketModal({
  market,
  pricer,
  serverNow,
}: {
  market: V2Market | null;
  pricer?: LivePricer;
  serverNow: number;
}) {
  const open = useV2TradeStore((s) => s.ticketSheetOpen);
  const close = useV2TradeStore((s) => s.closeTicketSheet);

  return (
    <Modal
      open={open}
      onClose={close}
      title="Place your bet"
      subtitle="Set your amount and trade — nothing sends until you confirm."
      variant="glass"
      maxWidthClass="max-w-sm"
      contentClassName="p-0"
    >
      {/* Rendered only while open (Modal returns null when closed), so the
          per-second clock below never ticks in the background. */}
      <CopilotTicketBody market={market} pricer={pricer} serverNow={serverNow} onClose={close} />
    </Modal>
  );
}

function CopilotTicketBody({
  market,
  pricer,
  serverNow,
  onClose,
}: {
  market: V2Market | null;
  pricer?: LivePricer;
  serverNow: number;
  onClose: () => void;
}) {
  const now = useNow(serverNow);
  // The compact ticket only reads svi + forward off the input; the oracle stub is
  // enough (same shape the surface builds). Null until the live pricer lands.
  const input: SmileInput | null =
    market && pricer
      ? {
          oracle: {
            oracle_id: market.expiry_market_id,
            expiry: market.expiry,
            underlying_asset: 'BTC',
          } as unknown as Oracle,
          svi: pricer.svi,
          forward: pricer.forward,
        }
      : null;

  return <V2CompactTicket market={market} input={input} now={now} onClose={onClose} initialView="ticket" />;
}
