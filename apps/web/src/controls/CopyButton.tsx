import { useEffect, useRef, useState, type ReactElement } from "react";

/**
 * Copies `text` (or what `read` returns, read at the click) and says whether it worked. The clipboard exists only in a
 * secure context; localhost is one, other hosts may not be. `label` says what is copied; for two seconds after a click
 * the button says whether it worked instead.
 */
export function CopyButton({ text, read, label, className = "button" }: { readonly text?: string; readonly read?: () => Promise<string>; readonly label: string; readonly className?: string }): ReactElement {
  const [copied, setCopied] = useState<"copied" | "failed" | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = (): void => {
    const clipboard = typeof navigator === "undefined" ? undefined : (navigator.clipboard as Clipboard | undefined);
    const done = (outcome: "copied" | "failed"): void => { setCopied(outcome); clearTimeout(timer.current); timer.current = setTimeout(() => setCopied(null), 2_000); };
    if (clipboard === undefined) { done("failed"); return; }
    void (read === undefined ? Promise.resolve(text ?? "") : read()).then((value) => clipboard.writeText(value)).then(() => done("copied"), () => done("failed"));
  };
  return <button aria-live="polite" className={className} type="button" onClick={copy}>{copied === null ? label : copied === "copied" ? "Copied" : "Could not copy"}</button>;
}
