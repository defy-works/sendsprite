"use client";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button } from "./Button";
import { Input } from "./Input";
import { Label } from "./Label";
import { Modal } from "./Modal";

export interface ConfirmOptions {
  title: ReactNode;
  /** The consequence, in a sentence. Not a restatement of the title. */
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red confirm button. Default for anything that deletes. */
  tone?: "default" | "danger";
  /**
   * Requires the user to type this exact string before confirming. For the
   * handful of actions that destroy something unrecoverable — a team and
   * everything under it — where a reflexive click is the actual risk.
   */
  typeToConfirm?: string;
  /** Label above the type-to-confirm field. */
  typeToConfirmLabel?: ReactNode;
}

type Ask = (o: ConfirmOptions) => Promise<boolean>;

const Ctx = createContext<Ask | null>(null);

/**
 * `window.confirm` replacement.
 *
 * The native dialog was wrong here for three separate reasons, and the third
 * is the one that matters: it is unstyled and unmistakably a browser chrome
 * artefact in the middle of a dark product; it cannot render a list, a warning
 * or a count; and on a page that has just called a server action it blocks the
 * main thread, so the spinner behind it freezes mid-frame.
 *
 * The promise shape keeps every call site a one-line change from the original
 * `if (!window.confirm(...)) return;`.
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<ConfirmOptions | null>(null);
  const [typed, setTyped] = useState("");
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const settle = useCallback((ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setOpen(null);
    setTyped("");
  }, []);

  const ask = useCallback<Ask>((o) => {
    // A second ask while one is open answers the first with "no" rather than
    // dropping its promise on the floor — an awaited call that never settles
    // leaves the caller in `pending` for ever.
    resolver.current?.(false);
    setTyped("");
    setOpen(o);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const gate = open?.typeToConfirm;
  const armed = !gate || typed.trim() === gate;

  const value = useMemo(() => ask, [ask]);
  return (
    <Ctx.Provider value={value}>
      {children}
      <Modal
        open={open !== null}
        onDismiss={() => settle(false)}
        title={open?.title ?? ""}
        description={open?.body}
        size="sm"
        footer={
          <>
            <Button variant="subtle" onClick={() => settle(false)}>
              {open?.cancelLabel ?? "Cancel"}
            </Button>
            <Button
              variant={open?.tone === "danger" ? "danger" : "primary"}
              disabled={!armed}
              onClick={() => settle(true)}
              data-autofocus={gate ? undefined : true}
            >
              {open?.confirmLabel ?? "Confirm"}
            </Button>
          </>
        }
      >
        {gate && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="confirm-gate">
              {open?.typeToConfirmLabel ?? (
                <>
                  Type <span className="text-white">{gate}</span> to confirm
                </>
              )}
            </Label>
            <Input
              id="confirm-gate"
              value={typed}
              autoComplete="off"
              spellCheck={false}
              data-autofocus
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && armed) settle(true);
              }}
            />
          </div>
        )}
      </Modal>
    </Ctx.Provider>
  );
}

/**
 * Returns `confirm(options)`.
 *
 * Outside a provider it falls back to `window.confirm` rather than throwing or
 * auto-answering. A component mounted outside the app shell is a bug, but the
 * two ways to "handle" it here are both worse than an ugly dialog: resolving
 * `true` turns every delete into an unconfirmed delete, and resolving `false`
 * turns every confirm button into a dead one. The provider wraps `/app`,
 * `/setup` and `/admin`, so this is unreachable in practice.
 */
export function useConfirm(): Ask {
  const ask = useContext(Ctx);
  return useMemo(
    () =>
      ask ??
      (async (o: ConfirmOptions) =>
        window.confirm(
          typeof o.title === "string" ? o.title : "Are you sure?",
        )),
    [ask],
  );
}
