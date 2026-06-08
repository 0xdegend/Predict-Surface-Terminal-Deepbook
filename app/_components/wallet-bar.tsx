'use client';

/* eslint-disable @next/next/no-img-element -- wallet icons are tiny data-URI / standard-wallet icons; next/image adds no value and can't optimize arbitrary data URLs */

/**
 * WalletBar — the custom wallet sign-in / account control (replaces dapp-kit's
 * default <ConnectButton/> web component for full visual consistency with the
 * terminal's glass system). Signing logic is unchanged — this only owns the
 * connect choice, the connected display, and disconnect. Slush is offered like
 * any other wallet (registered via slushWalletConfig in lib/sui/dapp-kit.ts).
 */
import { useEffect, useRef, useState } from 'react';
import { useWalletConnection, useWallets, useCurrentNetwork } from '@mysten/dapp-kit-react';
import type { UiWallet } from '@mysten/dapp-kit-core';
import {
  LuWallet,
  LuCopy,
  LuCheck,
  LuLogOut,
  LuExternalLink,
  LuChevronDown,
} from 'react-icons/lu';
import { dAppKit } from '@/lib/sui/dapp-kit';
import { shortId } from '@/lib/format';
import { useMounted } from '@/lib/hooks/use-mounted';

const ACCOUNT_EXPLORER = (network: string, addr: string) =>
  `https://suiscan.xyz/${network}/account/${addr}`;

export function WalletBar() {
  const conn = useWalletConnection();
  const wallets = useWallets();
  const network = useCurrentNetwork();
  const mounted = useMounted();

  const [open, setOpen] = useState(false);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close the menu on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const isTestnet = /test|dev|local/i.test(network);
  const connected = mounted && conn.isConnected;

  async function connect(wallet: UiWallet) {
    setConnecting(wallet.name);
    try {
      await dAppKit.connectWallet({ wallet });
      setOpen(false);
    } catch {
      /* user dismissed or wallet errored — leave the menu open to retry */
    } finally {
      setConnecting(null);
    }
  }

  async function disconnect() {
    try {
      await dAppKit.disconnectWallet();
    } finally {
      setOpen(false);
    }
  }

  function copyAddress(addr: string) {
    navigator.clipboard?.writeText(addr);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  }

  return (
    <div ref={ref} className="relative flex items-center gap-2.5">
      {/* network pill */}
      <span
        className={`hidden items-center gap-1.5 rounded-md border px-2 py-1 text-[10px] font-medium uppercase tracking-wider sm:inline-flex ${
          isTestnet
            ? 'border-[var(--warn-soft)] bg-[var(--warn-soft)] text-warn'
            : 'border-[var(--line)] text-text-2'
        }`}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${isTestnet ? 'bg-warn' : 'bg-accent'}`} />
        {network}
      </span>

      {/* trigger */}
      {!mounted ? (
        <span className="inline-flex h-9 w-28 animate-pulse rounded-lg border border-white/10 bg-white/[0.03]" />
      ) : connected ? (
        <button
          onClick={() => setOpen((v) => !v)}
          className="chip h-9 px-2.5 font-mono text-[11px] tabular-nums text-text-1 transition-colors hover:border-line-strong"
          aria-expanded={open}
        >
          <WalletGlyph wallet={conn.wallet} />
          <span className="hidden md:inline">{shortId(conn.account.address)}</span>
          <LuChevronDown
            size={13}
            className={`text-text-3 transition-transform ${open ? 'rotate-180' : ''}`}
          />
        </button>
      ) : (
        <button
          onClick={() => setOpen((v) => !v)}
          className="inline-flex h-9 items-center gap-2 rounded-lg border border-[var(--accent-line)] bg-[var(--accent-soft)] px-3.5 text-[12px] font-semibold tracking-tight text-up transition-shadow hover:shadow-[0_0_22px_-6px_var(--accent-glow)]"
          aria-expanded={open}
        >
          <LuWallet size={14} />
          Connect
        </button>
      )}

      {/* dropdown */}
      {open && (
        <div className="glass-menu popover-in absolute right-0 top-[calc(100%+8px)] z-50 w-72 overflow-hidden rounded-2xl p-1.5">
          {connected ? (
            <ConnectedMenu
              wallet={conn.wallet}
              address={conn.account.address}
              network={network}
              copied={copied}
              onCopy={() => copyAddress(conn.account.address)}
              onDisconnect={disconnect}
            />
          ) : (
            <ConnectMenu wallets={wallets} connecting={connecting} onConnect={connect} />
          )}
        </div>
      )}
    </div>
  );
}

/* ----------------------------- connected ----------------------------- */

function ConnectedMenu({
  wallet,
  address,
  network,
  copied,
  onCopy,
  onDisconnect,
}: {
  wallet: UiWallet;
  address: string;
  network: string;
  copied: boolean;
  onCopy: () => void;
  onDisconnect: () => void;
}) {
  return (
    <div className="flex flex-col gap-1.5 p-1">
      {/* identity */}
      <div className="flex items-center gap-2.5 px-1.5 pt-1">
        <WalletGlyph wallet={wallet} size={26} />
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-[12px] font-medium text-text-1">{wallet.name}</span>
          <span className="flex items-center gap-1.5 text-[10px] text-text-3">
            <span className="live-dot scale-[0.7]" /> Connected · {network}
          </span>
        </div>
      </div>

      {/* address */}
      <button
        onClick={onCopy}
        className="glass-inset group flex items-center justify-between gap-2 rounded-xl px-3 py-2.5 text-left transition-colors hover:border-line-strong"
      >
        <span className="font-mono text-[11px] tabular-nums text-text-2 group-hover:text-text-1">
          {shortId(address, 10, 8)}
        </span>
        {copied ? (
          <span className="flex items-center gap-1 text-[10px] text-up">
            <LuCheck size={12} /> Copied
          </span>
        ) : (
          <LuCopy size={13} className="text-text-3 group-hover:text-text-2" />
        )}
      </button>

      <a
        href={ACCOUNT_EXPLORER(network, address)}
        target="_blank"
        rel="noreferrer"
        className="ctrl-soft flex items-center justify-between rounded-xl px-3 py-2.5 text-[12px] text-text-2 hover:text-text-1"
      >
        View on explorer
        <LuExternalLink size={13} />
      </a>

      <button
        onClick={onDisconnect}
        className="flex items-center justify-between rounded-xl border border-down/30 px-3 py-2.5 text-[12px] font-medium text-down transition-colors hover:bg-down/10"
      >
        Disconnect
        <LuLogOut size={13} />
      </button>
    </div>
  );
}

/* ------------------------------ connect ------------------------------ */

function ConnectMenu({
  wallets,
  connecting,
  onConnect,
}: {
  wallets: UiWallet[];
  connecting: string | null;
  onConnect: (w: UiWallet) => void;
}) {
  return (
    <div className="flex flex-col gap-1 p-1">
      <span className="eyebrow px-2 pt-1.5 pb-1">Connect a wallet</span>
      {wallets.length === 0 ? (
        <p className="px-2 py-3 text-[11px] leading-relaxed text-text-3">
          No Sui wallet detected. Slush opens in-browser automatically — pick it when prompted.
        </p>
      ) : (
        wallets.map((w) => {
          const busy = connecting === w.name;
          return (
            <button
              key={w.name}
              onClick={() => onConnect(w)}
              disabled={!!connecting}
              className="ctrl-soft flex items-center gap-2.5 rounded-xl px-2.5 py-2.5 text-left text-[12px] text-text-1 disabled:opacity-50"
            >
              <WalletGlyph wallet={w} size={24} />
              <span className="flex-1 font-medium">{w.name}</span>
              {busy && (
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-[1.5px] border-text-3 border-t-transparent" />
              )}
            </button>
          );
        })
      )}
    </div>
  );
}

/* ------------------------------- glyph ------------------------------- */

/** Wallet icon if the wallet exposes one, else a neutral wallet glyph chip. */
function WalletGlyph({ wallet, size = 18 }: { wallet: UiWallet; size?: number }) {
  const icon = (wallet as { icon?: string }).icon;
  if (icon) {
    return (
      <img
        src={icon}
        alt=""
        width={size}
        height={size}
        className="flex-none rounded-md"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span
      className="inline-flex flex-none items-center justify-center rounded-md border border-line-soft bg-white/[0.04] text-text-2"
      style={{ width: size, height: size }}
    >
      <LuWallet size={Math.round(size * 0.55)} />
    </span>
  );
}
