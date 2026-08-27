import type { ReactNode } from "react";

/** Red, inline: an action failed and the user should read why. */
export function Alert({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="text-sm text-red-300">
      {children}
    </p>
  );
}
