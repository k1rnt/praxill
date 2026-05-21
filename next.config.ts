import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow any LAN device to reach the dev server's HMR endpoints. Without this,
  // cross-origin requests to /_next/webpack-hmr get blocked and the browser
  // falls back to full reloads (which wipes typed form state).
  //
  // Wildcards: `*` matches one segment, `**` matches recursive segments.
  // The patterns below cover RFC1918 private ranges, mDNS (.local), and the
  // host's own name.
  allowedDevOrigins: [
    "lize-helesta",
    "*.local",
    "192.168.*.*",
    "10.*.*.*",
    "172.20.10.*", // iPhone personal hotspot
    "172.16.*.*",
    "172.17.*.*",
    "172.18.*.*",
    "172.19.*.*",
    "172.20.*.*",
    "172.21.*.*",
    "172.22.*.*",
    "172.23.*.*",
    "172.24.*.*",
    "172.25.*.*",
    "172.26.*.*",
    "172.27.*.*",
    "172.28.*.*",
    "172.29.*.*",
    "172.30.*.*",
    "172.31.*.*",
  ],
  // Hide the on-screen "N | 1 Issue" badge. Real overlay errors still surface;
  // this just stops benign noise (e.g. wallet-extension errors) from showing
  // up as a persistent indicator. We don't ship this app to anyone else, so
  // the dev hud is more noise than signal.
  devIndicators: false,
};

export default nextConfig;
