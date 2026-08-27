"use client";
import NextLink from "next/link";
import { useState, useTransition } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { useConfirm } from "@/components/ui/confirm";
import { deleteTemplate, type Result } from "./actions";

/** Dates are pre-formatted on the server so SSR and hydration agree. */
export type TemplateRow = {
  slug: string;
  name: string;
  subject: string;
  version: number;
  updated: string;
};

export function TemplateList({
  templates,
  canManage,
}: {
  templates: TemplateRow[];
  canManage: boolean;
}) {
  const confirm = useConfirm();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const remove = async (t: TemplateRow) => {
    // The warning is the point: a slug is what a live `POST /emails` names,
    // and deleting one breaks those sends rather than degrading them.
    const ok = await confirm({
      title: `Delete the template "${t.slug}"?`,
      body: `Any live send that names template: "${t.slug}" starts failing, not falling back. Every version goes with it.`,
      confirmLabel: "Delete template",
      tone: "danger",
      typeToConfirm: t.slug,
    });
    if (!ok) return;
    start(async () => {
      setError(null);
      try {
        const res: Result = await deleteTemplate(t.slug);
        if (!res.ok) setError(res.error);
      } catch {
        setError("Something went wrong. Please try again.");
      }
    });
  };

  if (templates.length === 0)
    return (
      <EmptyState
        title="No templates yet"
        body={
          canManage
            ? 'A template holds a subject and a body with {{variable}} placeholders, versioned on every change. Send one with template: "slug" instead of html.'
            : "A template holds a subject and a body with {{variable}} placeholders. Ask an admin to add one."
        }
        action={
          canManage ? (
            <Button asChild>
              <NextLink href="/app/templates/new">New template</NextLink>
            </Button>
          ) : undefined
        }
      />
    );

  return (
    <div className="flex flex-col gap-4">
      <div className="glass overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="num-stamp text-left">
            <tr>
              <th className="px-4 py-3 font-medium">Slug</th>
              <th className="px-4 py-3 font-medium">Name</th>
              <th className="px-4 py-3 font-medium">Subject</th>
              <th className="px-4 py-3 font-medium">Version</th>
              <th className="px-4 py-3 font-medium">Updated</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {templates.map((t) => (
              <tr key={t.slug} className="border-t border-white/8">
                <td className="px-4 py-3 font-medium">
                  <NextLink
                    href={`/app/templates/${t.slug}`}
                    className="underline decoration-white/30 underline-offset-2 hover:text-white"
                  >
                    <code className="text-xs">{t.slug}</code>
                  </NextLink>
                </td>
                <td className="px-4 py-3">{t.name}</td>
                <td className="px-4 py-3 text-white/65">{t.subject}</td>
                <td className="px-4 py-3">
                  <Badge variant="muted">v{t.version}</Badge>
                </td>
                <td className="px-4 py-3 text-white/65">{t.updated}</td>
                <td className="px-4 py-3 text-right">
                  {canManage && (
                    <Button
                      size="sm"
                      variant="dangerSubtle"
                      disabled={pending}
                      onClick={() => remove(t)}
                    >
                      Delete
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-300">
          {error}
        </p>
      )}
    </div>
  );
}
