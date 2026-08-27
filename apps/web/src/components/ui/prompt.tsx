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
import { Field } from "./Field";
import { Modal } from "./Modal";
import { Textarea } from "./Textarea";

export interface PromptOptions {
  title: ReactNode;
  /** What the value is for, and who sees it. */
  body?: ReactNode;
  label?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
  /** Refuses to submit while the field is empty. */
  required?: boolean;
  defaultValue?: string;
  maxLength?: number;
}

type Ask = (o: PromptOptions) => Promise<string | null>;

const Ctx = createContext<Ask | null>(null);

/**
 * `window.prompt` replacement, resolving to the string or to `null` on cancel.
 *
 * The same argument as `ConfirmProvider`: the native dialog is browser chrome
 * in the middle of a dark product, it cannot explain itself in more than one
 * line, and it blocks the main thread while a server action's spinner is
 * mid-frame. Separate from confirm rather than folded into it because the
 * shapes differ where it matters — this one resolves to a value, and "" and
 * `null` are not the same answer.
 *
 * A textarea rather than an input: every use so far is a reason written for
 * somebody else to read, and a reason worth giving is usually a sentence.
 */
export function PromptProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<PromptOptions | null>(null);
  const [value, setValue] = useState("");
  const resolver = useRef<((v: string | null) => void) | null>(null);

  const settle = useCallback((v: string | null) => {
    resolver.current?.(v);
    resolver.current = null;
    setOpen(null);
    setValue("");
  }, []);

  const ask = useCallback<Ask>((o) => {
    // A second ask while one is open answers the first with a cancel rather
    // than dropping its promise on the floor.
    resolver.current?.(null);
    setValue(o.defaultValue ?? "");
    setOpen(o);
    return new Promise<string | null>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const armed = !open?.required || value.trim().length > 0;
  const provided = useMemo(() => ask, [ask]);

  return (
    <Ctx.Provider value={provided}>
      {children}
      <Modal
        open={open !== null}
        onDismiss={() => settle(null)}
        title={open?.title ?? ""}
        description={open?.body}
        size="sm"
        footer={
          <>
            <Button variant="subtle" onClick={() => settle(null)}>
              {open?.cancelLabel ?? "Cancel"}
            </Button>
            <Button
              variant={open?.tone === "danger" ? "danger" : "primary"}
              disabled={!armed}
              onClick={() => settle(value.trim())}
            >
              {open?.confirmLabel ?? "Continue"}
            </Button>
          </>
        }
      >
        <Field id="prompt-value" label={open?.label ?? "Reason"}>
          <Textarea
            id="prompt-value"
            rows={3}
            value={value}
            data-autofocus
            placeholder={open?.placeholder}
            maxLength={open?.maxLength ?? 500}
            onChange={(e) => setValue(e.target.value)}
          />
        </Field>
      </Modal>
    </Ctx.Provider>
  );
}

/**
 * Returns `prompt(options)`.
 *
 * Outside a provider it falls back to `window.prompt` for the same reason
 * `useConfirm` falls back to `window.confirm`: a component mounted outside the
 * app shell is a bug, and both ways of "handling" it here — always cancelling,
 * or always returning a value — are worse than an ugly dialog.
 */
export function usePrompt(): Ask {
  const ask = useContext(Ctx);
  return useMemo(
    () =>
      ask ??
      (async (o: PromptOptions) =>
        window.prompt(typeof o.title === "string" ? o.title : "")),
    [ask],
  );
}
