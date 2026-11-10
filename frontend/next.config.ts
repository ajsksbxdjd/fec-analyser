import type { NextConfig } from "next";

const BACKEND_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

const nextConfig: NextConfig = {
  // Raise the body-size cap for the Next.js dev proxy (belt-and-suspenders).
  // File uploads bypass this anyway by going direct to the backend via XHR.
  experimental: {
    serverActions: {
      bodySizeLimit: "500mb",
    },
    // The dev proxy (rewrites below) cuts request bodies at 10 MB and gives up
    // after 30 s by default. Through a tunnel every upload goes via this proxy.
    middlewareClientMaxBodySize: "100mb",
    proxyTimeout: 300_000,
  },
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${BACKEND_URL}/api/:path*` },
      { source: "/uploads/:path*", destination: `${BACKEND_URL}/uploads/:path*` },
    ];
  },
};

export default nextConfig;
