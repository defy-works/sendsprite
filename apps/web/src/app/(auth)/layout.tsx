import type { ReactNode } from "react";
import Link from "next/link";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="grid-hairlines flex min-h-dvh items-center justify-center p-6">
      <div className="glass-strong w-full max-w-sm p-8">
        <Link href="/" className="num-stamp">
          Sendsprite
        </Link>
        <div className="mt-6">{children}</div>
      </div>
    </main>
  );
}
