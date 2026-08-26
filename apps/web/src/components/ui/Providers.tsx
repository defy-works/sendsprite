"use client";
import type { ReactNode } from "react";
import { ConfirmProvider } from "./confirm";
import { ToastProvider } from "./toast";

/**
 * The two overlay providers, mounted once at the root.
 *
 * At the root rather than per-section so a confirm or a toast works from
 * anywhere — including the setup wizard and the unsubscribe page, which sit
 * outside the app shell. Both render nothing until something is pushed, so the
 * cost on a page that never uses them is one context provider each.
 */
export function Providers({ children }: { children: ReactNode }) {
  return (
    <ToastProvider>
      <ConfirmProvider>{children}</ConfirmProvider>
    </ToastProvider>
  );
}
