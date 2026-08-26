"use client";

import { useId, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "@/lib/cn";

interface Tab {
  id: string;
  label: string;
  file: string;
  code: string;
}

const TABS: Tab[] = [
  {
    id: "curl",
    label: "curl",
    file: "shell",
    code: `curl https://mail.example.com/api/v1/emails \\
  -H "Authorization: Bearer ss_live_..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "from": "Acme <hello@example.com>",
    "to": ["you@example.com"],
    "subject": "Hello from Sendsprite",
    "html": "<p>It works.</p>"
  }'`,
  },
  {
    id: "node",
    label: "Node",
    file: "send.ts",
    code: `import { Sendsprite } from "sendsprite";

const sendsprite = new Sendsprite({
  baseUrl: "https://mail.example.com",
  apiKey: process.env.SENDSPRITE_API_KEY,
});

const { id } = await sendsprite.emails.send({
  from: "Acme <hello@example.com>",
  to: ["you@example.com"],
  subject: "Hello from Sendsprite",
  html: "<p>It works.</p>",
});`,
  },
  {
    id: "react",
    label: "React",
    file: "welcome.tsx",
    code: `import { Sendsprite } from "sendsprite";
import { Html, Body, Text, Button } from "sendsprite/react";

function Welcome({ name }: { name: string }) {
  return (
    <Html>
      <Body>
        <Text>Welcome aboard, {name}.</Text>
        <Button href="https://example.com/start">Get started</Button>
      </Body>
    </Html>
  );
}

const sendsprite = new Sendsprite({ baseUrl, apiKey });
await sendsprite.emails.send({
  from: "Acme <hello@example.com>",
  to: ["you@example.com"],
  subject: "Welcome",
  react: <Welcome name="Ada" />,
});`,
  },
  {
    id: "cli",
    label: "CLI",
    file: "shell",
    code: `npx sendsprite login \\
  --url https://mail.example.com \\
  --api-key ss_live_...

npx sendsprite emails send \\
  --from "Acme <hello@example.com>" \\
  --to you@example.com \\
  --subject "Hello from Sendsprite" \\
  --text "It works."`,
  },
];

/**
 * WAI-ARIA tabs: roving tabindex, Enter/Space activate the focused tab,
 * arrow keys move between tabs (wrapping), Home/End jump to the ends.
 */
export function CodeTabs() {
  const [active, setActive] = useState(0);
  const base = useId();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const focusTab = (i: number) => {
    const n = (i + TABS.length) % TABS.length;
    setActive(n);
    refs.current[n]?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    switch (e.key) {
      case "ArrowRight":
        e.preventDefault();
        focusTab(i + 1);
        break;
      case "ArrowLeft":
        e.preventDefault();
        focusTab(i - 1);
        break;
      case "Home":
        e.preventDefault();
        focusTab(0);
        break;
      case "End":
        e.preventDefault();
        focusTab(TABS.length - 1);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        setActive(i);
        break;
    }
  };

  const tab = TABS[active]!;

  return (
    <div className="glass min-w-0 overflow-hidden rounded-md">
      <div className="flex items-center justify-between border-b border-white/12">
        <div
          role="tablist"
          aria-label="Send an email"
          className="flex items-stretch"
        >
          {TABS.map((t, i) => {
            const selected = i === active;
            return (
              <button
                key={t.id}
                ref={(el) => {
                  refs.current[i] = el;
                }}
                type="button"
                role="tab"
                id={`${base}-tab-${t.id}`}
                aria-selected={selected}
                aria-controls={`${base}-panel-${t.id}`}
                tabIndex={selected ? 0 : -1}
                onClick={() => setActive(i)}
                onKeyDown={(e) => onKeyDown(e, i)}
                className={cn(
                  "relative px-4 py-3 font-mono text-[11px] tracking-[0.2em] uppercase transition-colors duration-[var(--duration-fast)] focus-visible:outline-offset-[-2px]",
                  selected
                    ? "text-white"
                    : "text-white/45 hover:bg-white/6 hover:text-white/80",
                )}
              >
                {t.label}
                {selected && (
                  <span
                    aria-hidden
                    className="absolute inset-x-0 -bottom-px h-px bg-indigo-400"
                  />
                )}
              </button>
            );
          })}
        </div>
        <span className="hidden px-4 font-mono text-[11px] tracking-[0.08em] text-white/35 sm:block">
          {tab.file}
        </span>
      </div>
      <div
        role="tabpanel"
        id={`${base}-panel-${tab.id}`}
        aria-labelledby={`${base}-tab-${tab.id}`}
        tabIndex={0}
        className="overflow-x-auto"
      >
        <pre className="min-w-max px-5 py-5 font-mono text-[13px] leading-relaxed text-white/85">
          <code>{tab.code}</code>
        </pre>
      </div>
    </div>
  );
}
