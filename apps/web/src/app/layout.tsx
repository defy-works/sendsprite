import type { Metadata } from "next";
import type { ReactNode } from "react";
import "@/styles/globals.css";

export const metadata: Metadata = {
  title: { default: "Sendsprite", template: "%s · Sendsprite" },
  description: "Self-hosted email API on Amazon SES.",
  icons: { icon: "/favicon.svg" },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh bg-ink text-white antialiased">
        {children}
      </body>
    </html>
  );
}
