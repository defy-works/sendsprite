import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Providers } from "@/components/ui/Providers";
import { siteOrigin } from "@/services/landing";
import "@/styles/globals.css";

// Per-instance app: every route depends on runtime env, so nothing is
// statically prerendered at build time.
export const dynamic = "force-dynamic";

/** Rendered by `bun run og` (scripts/build-og.ts); every page inherits it. */
const OG_IMAGE = { url: "/og/default.png", width: 1200, height: 630 };

export const metadata: Metadata = {
  metadataBase: new URL(siteOrigin()),
  title: { default: "Sendsprite", template: "%s · Sendsprite" },
  description: "Self-hosted email API on Amazon SES.",
  applicationName: "Sendsprite",
  icons: { icon: "/favicon.svg" },
  openGraph: { siteName: "Sendsprite", type: "website", images: [OG_IMAGE] },
  twitter: { card: "summary_large_image", images: [OG_IMAGE.url] },
  robots: { index: true, follow: true },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh bg-ink font-sans text-white antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
