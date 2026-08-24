import type { Metadata } from "next";
import type { ReactNode } from "react";
import "@/styles/globals.css";

// Per-instance app: every route depends on runtime env, so nothing is
// statically prerendered at build time.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { default: "Sendsprite", template: "%s · Sendsprite" },
  description: "Self-hosted email API on Amazon SES.",
  icons: { icon: "/favicon.svg" },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh bg-ink font-sans text-white antialiased">
        {children}
      </body>
    </html>
  );
}
