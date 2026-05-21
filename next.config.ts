import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow LAN devices (phones, etc.) to reach the dev server's HMR endpoints.
  // Without this, cross-origin requests to /_next/webpack-hmr are blocked
  // and the browser falls back to full page reloads, which wipes form state.
  allowedDevOrigins: [
    "lize-helesta",
    "192.168.0.30",
    "*.local",
  ],
};

export default nextConfig;
