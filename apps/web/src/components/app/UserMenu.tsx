"use client";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/Button";

export function UserMenu({ email }: { email: string }) {
  const router = useRouter();
  return (
    <div className="flex items-center gap-3">
      <span className="hidden text-sm text-white/60 sm:inline">{email}</span>
      <Button
        size="sm"
        variant="ghost"
        onClick={async () => {
          await authClient.signOut();
          router.push("/login");
          router.refresh();
        }}
      >
        Sign out
      </Button>
    </div>
  );
}
