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
};

export default nextConfig;
