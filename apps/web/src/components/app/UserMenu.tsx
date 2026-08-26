"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { Menu, MenuItem, MenuLink, MenuSeparator } from "@/components/ui/Menu";
import {
  IconBook,
  IconChevronDown,
  IconExternal,
  IconLogOut,
  IconServer,
  IconSettings,
  IconUser,
} from "@/components/ui/icons";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";

/** Two initials from the display name, or one from the address. */
function initials(name: string | null, email: string): string {
  const source = (name ?? "").trim();
  if (source) {
    const parts = source.split(/\s+/);
    return (
      (parts[0]?.[0] ?? "") +
      (parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : "")
    ).toUpperCase();
  }
  return (email[0] ?? "?").toUpperCase();
}

/**
 * The account menu.
 *
 * It replaces a bare "Sign out" button, which was the whole of the account
 * surface: there was nowhere to change a name, a password, or to reach the
 * instance admin area, and the only affordance in the corner was the one
 * action nobody wants by accident.
 */
export function UserMenu({
  email,
  name,
  isInstanceAdmin,
}: {
  email: string;
  name: string | null;
  isInstanceAdmin?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [signingOut, setSigningOut] = useState(false);

  const signOut = async () => {
    setSigningOut(true);
    try {
      await authClient.signOut();
      router.push("/login");
      router.refresh();
    } catch {
      setSigningOut(false);
      toast({
        tone: "error",
        title: "Could not sign out",
        body: "The server did not answer. Check your connection and try again.",
      });
    }
  };

  return (
    <Menu
      label="Account"
      trigger={({ open }) => (
        <span
          className={cn(
            "flex items-center gap-2 rounded-md py-1 pr-1.5 pl-1 transition-colors",
            open ? "bg-white/8" : "hover:bg-white/6",
          )}
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-indigo-500/25 text-[11px] font-semibold tracking-wide text-indigo-100">
            {initials(name, email)}
          </span>
          <span className="hidden max-w-40 truncate text-sm text-white/70 lg:inline">
            {name || email}
          </span>
          <IconChevronDown
            className={cn(
              "text-xs text-white/45 transition-transform duration-[var(--duration-fast)]",
              open && "rotate-180",
            )}
          />
        </span>
      )}
    >
      <div className="flex flex-col gap-0.5 px-2.5 py-2">
        {name && <p className="truncate text-sm text-white">{name}</p>}
        <p className="truncate text-xs text-white/55">{email}</p>
      </div>
      <MenuSeparator />
      <MenuLink href="/app/account" icon={<IconUser />}>
        Account
      </MenuLink>
      <MenuLink href="/app/settings" icon={<IconSettings />}>
        Team settings
      </MenuLink>
      <MenuLink href="/docs" external icon={<IconBook />}>
        <span className="flex flex-1 items-center justify-between gap-2">
          Docs
          <IconExternal className="text-xs opacity-60" />
        </span>
      </MenuLink>
      {isInstanceAdmin && (
        <>
          <MenuSeparator />
          <MenuLink href="/admin" icon={<IconServer />}>
            Instance admin
          </MenuLink>
        </>
      )}
      <MenuSeparator />
      <MenuItem
        icon={<IconLogOut />}
        disabled={signingOut}
        onSelect={() => void signOut()}
      >
        {signingOut ? "Signing out…" : "Sign out"}
      </MenuItem>
    </Menu>
  );
}
