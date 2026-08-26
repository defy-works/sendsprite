"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "@/components/ui/Menu";
import { Spinner } from "@/components/ui/Spinner";
import {
  IconBuilding,
  IconCheck,
  IconChevronDown,
  IconPlus,
} from "@/components/ui/icons";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";

/**
 * Switches the active team.
 *
 * Was a native `<select>`, which on this surface meant an OS-drawn white popup
 * and — worse — a silent failure: a rejected `setActive` only reached
 * `console.error`, so the dropdown snapped back to the old team with no
 * explanation. The failure is now a toast, and the row that is active is
 * ticked rather than merely being the one the closed control happens to show.
 */
export function TeamSwitcher({
  activeId,
  activeName,
}: {
  activeId: string;
  /** Rendered before the org list has loaded, so the trigger is never blank. */
  activeName: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const { data: orgs } = authClient.useListOrganizations();
  const [switching, setSwitching] = useState<string | null>(null);

  async function change(id: string) {
    if (id === activeId) return;
    setSwitching(id);
    try {
      const res = await authClient.organization.setActive({
        organizationId: id,
      });
      if (res.error) {
        toast({
          tone: "error",
          title: "Could not switch team",
          body: res.error.message ?? "The server refused the change.",
        });
        return;
      }
      router.refresh();
    } catch {
      toast({
        tone: "error",
        title: "Could not switch team",
        body: "The server did not answer. Check your connection and try again.",
      });
    } finally {
      setSwitching(null);
    }
  }

  return (
    <Menu
      label="Switch team"
      align="start"
      className="w-full"
      trigger={({ open }) => (
        <span
          className={cn(
            "flex w-full items-center gap-2.5 rounded-md border px-2.5 py-2 text-left text-sm transition-colors",
            open
              ? "border-indigo-500 bg-indigo-500/8"
              : "border-white/12 bg-white/4 hover:border-white/25",
          )}
        >
          <IconBuilding className="text-base text-indigo-300/80" />
          <span className="min-w-0 flex-1 truncate">{activeName}</span>
          <IconChevronDown
            className={cn(
              "text-xs text-white/45 transition-transform duration-[var(--duration-fast)]",
              open && "rotate-180",
            )}
          />
        </span>
      )}
    >
      <MenuLabel>Teams</MenuLabel>
      {orgs == null ? (
        <p className="flex items-center gap-2 px-2.5 py-2 text-sm text-white/50">
          <Spinner size={13} /> Loading…
        </p>
      ) : (
        orgs.map((o) => (
          <MenuItem
            key={o.id}
            disabled={switching !== null}
            onSelect={() => void change(o.id)}
            icon={
              <IconCheck
                className={cn(
                  "text-indigo-300",
                  o.id === activeId ? "opacity-100" : "opacity-0",
                )}
              />
            }
          >
            <span className="flex-1 truncate">{o.name}</span>
            {switching === o.id && <Spinner size={13} />}
          </MenuItem>
        ))
      )}
      <MenuSeparator />
      <MenuItem icon={<IconPlus />} onSelect={() => router.push("/teams/new")}>
        New team
      </MenuItem>
    </Menu>
  );
}
