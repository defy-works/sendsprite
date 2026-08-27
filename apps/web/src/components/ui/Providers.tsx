"use client";
import type { ReactNode } from "react";
import { ConfirmProvider } from "./confirm";
import { PromptProvider } from "./prompt";
import { ToastProvider } from "./toast";

/**
 * The overlay providers, mounted once at the root.
 *
 * At the root rather than per-section so a confirm, a prompt or a toast works
 * from anywhere — including the setup wizard and the unsubscribe page, which
 * sit outside the app shell. Each renders nothing until something is pushed,
 * so the cost on a page that never uses them is one context provider apiece.
 */
export function Providers({ children }: { children: ReactNode }) {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <PromptProvider>{children}</PromptProvider>
      </ConfirmProvider>
    </ToastProvider>
  );
}
