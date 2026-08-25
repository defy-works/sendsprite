"use client";
import { useRouter } from "next/navigation";
import { useActionState } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";
import { Alert } from "@/app/setup/steps/shared";
import { createDomain } from "./actions";

export function DomainForm({ hasCloudflare }: { hasCloudflare: boolean }) {
  const router = useRouter();
  const [state, action, pending] = useActionState(
    async (_prev: unknown, fd: FormData) => {
      const res = await createDomain(fd);
      if (res.ok) router.push(`/app/domains/${res.data.id}`);
      return res;
    },
    null,
  );
  return (
    <form action={action} className="flex flex-col gap-4">
      <div>
        <Label htmlFor="name">Domain</Label>
        <Input
          id="name"
          name="name"
          placeholder="mail.example.com"
          autoComplete="off"
          required
          autoFocus
        />
        <p className="mt-1 text-xs text-white/50">
          Use a subdomain such as <code>mail.example.com</code>: its DNS and
          reputation stay separate from your main site.
        </p>
      </div>
      <p className="text-sm text-white/65">
        {hasCloudflare
          ? "If the domain is in a Cloudflare zone your token can manage, the DNS records are added for you."
          : "Cloudflare is not connected: you will add the DNS records at your provider by hand."}
      </p>
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "Adding…" : "Add domain"}
        </Button>
      </div>
      {state && !state.ok && <Alert>{state.error}</Alert>}
    </form>
  );
}
