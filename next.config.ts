import type { NextConfig } from "next";

console.log("NEXT CONFIG LOADED");

const nextConfig: NextConfig = {
  allowedDevOrigins: [
    '100.83.58.22',
    '192.168.29.129',
  ],
};

export default nextConfig;
