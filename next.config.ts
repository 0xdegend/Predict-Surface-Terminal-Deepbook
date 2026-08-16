import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow dev-server access (HMR, /_next assets) from other devices on the LAN
  // — e.g. testing on a phone over Wi-Fi or an iPhone Personal Hotspot. Covers
  // the common private subnets so it survives switching networks. Dev-only;
  // ignored in production.
  allowedDevOrigins: [
    "192.168.0.*",
    "192.168.1.*",
    "172.20.10.*", // iPhone Personal Hotspot
    "10.0.0.*",
  ],

  // @mysten/walrus loads a WASM module (@mysten/walrus-wasm) that reads its .wasm off
  // the filesystem at module-eval. Turbopack was bundling it and rewriting the path to
  // a virtual /ROOT/... location where the asset isn't emitted, so `next build` failed
  // while collecting page data (ENOENT walrus_wasm_bg.wasm). Keeping these external makes
  // Next resolve them from node_modules instead of bundling, fixing both the build and the
  // runtime load. Used server-side only: the Walrus blob/receipt writer (lib/walrus/*) and
  // the memwal-backed Kelly memory routes (memwal depends on @mysten/walrus too).
  serverExternalPackages: ["@mysten/walrus", "@mysten/walrus-wasm"],

  // Belt-and-suspenders for serverless deploys: force the .wasm into the function output
  // for the routes that use it, in case file tracing misses the dynamically-loaded asset.
  outputFileTracingIncludes: {
    "/api/kelly/**": ["./node_modules/@mysten/walrus-wasm/**"],
  },
};

export default nextConfig;
