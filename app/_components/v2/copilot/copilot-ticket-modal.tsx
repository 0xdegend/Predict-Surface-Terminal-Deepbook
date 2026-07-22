'use client';

/**
 * V2CopilotTicketModal — the trade ticket as an on-demand modal rather than an
 * always-visible rail. On /v2/copilot the surface owns the page; the ticket only
 * pops out when the trader is ready — from the "Place this bet" button on a
 * co-pilot suggestion, or any pick that flips `ticketSheetOpen`. One ticket
 * instance, reading the shared trade store like everywhere else, so it's already
 * pre-filled with the suggested market/strike/direction when it opens.
 *
 * Reuses the shared Modal (portal to body, backdrop, Esc, scroll-lock) and the
 * same V2TradeTicket the Trade screen uses, so nothing about the mint flow drifts.
 */
import { Modal } from '@/app/_components/ui/modal';
import { useV2TradeStore } from '@/lib/store/v2-trade-store';
import { V2TradeTicket } from '../trade-ticket';
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
      contentClassName="px-4 py-4"
    >
      <V2TradeTicket market={market} pricer={pricer} serverNow={serverNow} />
    </Modal>
  );
}
