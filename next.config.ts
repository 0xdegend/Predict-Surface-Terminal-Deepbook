import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow dev-server access (HMR, /_next assets) from other devices on the LAN
  // — e.g. testing the mobile bottom nav on a phone. Dev-only; ignored in prod.
  allowedDevOrigins: ["192.168.0.146", "192.168.0.*"],
};

export default nextConfig;
