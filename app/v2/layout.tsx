/**
 * Layout for the Latest (v2) deployment — wraps every /v2/* route in the shared
 * V2Chrome (top) + V2BottomNav (mobile dock) so the new experience matches the
 * legacy terminal shell. Legacy lives under `/` with its own frozen chrome.
 *
 * The bottom dock floats (fixed), so content gets mobile bottom padding for
 * clearance; at lg+ the dock is hidden and the header nav takes over.
 */
import { V2Chrome } from '@/app/_components/v2/chrome';
import { V2BottomNav } from '@/app/_components/v2/bottom-nav';

export default function V2Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <V2Chrome />
      <div className="flex flex-1 flex-col pb-20 lg:pb-0">{children}</div>
      <V2BottomNav />
    </div>
  );
}
