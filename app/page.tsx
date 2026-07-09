import { redirect } from "next/navigation";

// Root now lands on the Latest (v2) release — it's the live product; the legacy
// testnet backend is wound down. The legacy terminal still lives at /legacy
// (reachable via the Legacy↔Latest toggle) so traders can claim old positions.
// A server redirect (307) is issued before any render — Safe-Browsing-friendly,
// no click-through interstitial.
export default function RootPage() {
  redirect("/v2");
}
