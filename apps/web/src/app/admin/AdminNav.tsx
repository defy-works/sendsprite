"use client";
import { Tabs } from "@/components/ui/Tabs";
import { IconBuilding, IconServer, IconUsers } from "@/components/ui/icons";

export function AdminNav() {
  return (
    <Tabs
      ariaLabel="Instance admin"
      items={[
        { href: "/admin", label: "Instance", icon: <IconServer /> },
        {
          href: "/admin/organizations",
          label: "Organizations",
          icon: <IconBuilding />,
          prefix: true,
        },
        { href: "/admin/users", label: "Users", icon: <IconUsers /> },
      ]}
    />
  );
}
