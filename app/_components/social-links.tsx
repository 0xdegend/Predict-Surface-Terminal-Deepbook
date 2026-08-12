'use client';

/**
 * Social links, driven by the shared config/socials list.
 *
 *  - `SOCIAL_ICON` maps each social's id to its brand glyph (the one place a new
 *     platform needs an icon).
 *  - `SocialIconLinks` is the compact always-on icon cluster for the top-right
 *     chrome (desktop). The "More" menu builds its own rows from `SOCIALS` +
 *     `SOCIAL_ICON`, so this file owns the icons and the header treatment only.
 */
import { FaXTwitter, FaDiscord, FaTelegram } from 'react-icons/fa6';
import type { IconType } from 'react-icons';
import { SOCIALS, type SocialLink } from '@/config/socials';

export const SOCIAL_ICON: Record<SocialLink['id'], IconType> = {
  x: FaXTwitter,
  discord: FaDiscord,
  telegram: FaTelegram,
};

/**
 * Compact social icons for the header cluster. Display is left to the caller
 * (pass e.g. `hidden lg:flex`) so the tight mobile bar can opt out and let the
 * "More" sheet carry the links instead.
 */
export function SocialIconLinks({ className = '' }: { className?: string }) {
  if (SOCIALS.length === 0) return null;
  return (
    <div className={`items-center gap-0.5 ${className}`}>
      {SOCIALS.map((s) => {
        const Icon = SOCIAL_ICON[s.id];
        return (
          <a
            key={s.id}
            href={s.url}
            target="_blank"
            rel="noreferrer"
            aria-label={`Follow Skew on ${s.label}`}
            title={`Follow @${s.handle.replace(/^@/, '')} on ${s.label}`}
            className="grid h-8 w-8 place-items-center rounded-md text-text-2 transition-colors hover:bg-white/[0.06] hover:text-text-1"
          >
            <Icon size={15} />
          </a>
        );
      })}
    </div>
  );
}
