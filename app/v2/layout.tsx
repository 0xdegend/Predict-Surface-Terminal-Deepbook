/**
 * Layout for the Latest (v2) deployment — wraps every /v2/* route in the shared
 * V2Chrome (top) + V2BottomNav (mobile dock) so the new experience matches the
 * legacy terminal shell. Legacy lives under `/` with its own frozen chrome.
 *
 * The bottom dock floats (fixed), so content gets mobile bottom padding for
 * clearance; at lg+ the dock is hidden and the header nav takes over.
 *
 * The shell is sized to the DYNAMIC viewport (100dvh), not 100vh: on mobile, vh
 * counts the area behind the browser toolbar, so a vh shell is taller than what's
 * visible and the page picks up a phantom scroll (which opened an empty gap under
 * viewport-locked pages like Ask Kelly). dvh === vh on desktop, so this is a
 * mobile-only correction with no desktop change.
 *
 * The whole shell sits inside AutopilotEngineProvider so a live Autopilot run survives
 * every navigation inside /v2 (it used to die the moment the Autopilot panel unmounted).
 */
import { V2Chrome } from '@/app/_components/v2/chrome';
import { V2BottomNav } from '@/app/_components/v2/bottom-nav';
import { AutopilotEngineProvider } from '@/app/_components/v2/autopilot/engine-provider';

export default function V2Layout({ children }: { children: React.ReactNode }) {
  return (
    // Autopilot's engine hangs off the LAYOUT, not a page, so an armed run keeps trading
    // while the trader moves around the app. It mounts itself only when there is a run to
    // drive or the Autopilot panel is asking, and it carries the small floating pill that
    // keeps a live run visible from every screen.
    <AutopilotEngineProvider>
      <div className="v2-shell flex min-h-dvh flex-col">
        <V2Chrome />
        {/* v2-content: dock-clearance padding is dropped when the keyboard is up
            (globals.css) so a viewport-locked screen can fill the space above it. */}
        <div className="v2-content flex flex-1 flex-col pb-20 lg:pb-0">{children}</div>
        <V2BottomNav />
      </div>
    </AutopilotEngineProvider>
  );
}
