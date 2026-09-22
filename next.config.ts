import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";

/**
 * Baseline security headers on every response.
 *
 * CSP notes: Next's inline boot scripts and framer-motion's inline styles
 * force 'unsafe-inline' on script-src/style-src for now — a nonce-based CSP
 * requires proxy-injected nonces and is tracked as deeper hardening.
 * 'unsafe-eval' is added in development only (React dev tooling calls
 * eval(); production React never does). img-src allows any https: because
 * avatars and pasted media arrive from platform CDNs we can't enumerate.
 */
const scriptSrc = [
  "script-src 'self' 'unsafe-inline'",
  ...(isProd ? [] : ["'unsafe-eval'"]),
].join(" ");

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains",
  },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=()",
  },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      scriptSrc,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      "media-src 'self' blob:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join("; "),
  },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  serverExternalPackages: ["pg", "bcryptjs"],
  experimental: {
    optimizePackageImports: ["lucide-react", "@radix-ui/react-icons"],
  },
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default nextConfig;
