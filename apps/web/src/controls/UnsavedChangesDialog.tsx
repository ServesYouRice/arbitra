import { useEffect, useRef, type ReactElement } from "react";

/**
 * The unsaved-changes guard. It is a modal alert dialog rather than `window.confirm`, so it
 * follows the design language, is fully keyboard operable (focus starts on the safe choice,
 * Escape keeps editing, Tab stays inside) and never blocks the page's event loop.
 */
export function UnsavedChangesDialog({ open, title = "unsaved graph changes", description, onDiscard, onKeep }: { readonly open: boolean; readonly title?: string; readonly description: string; readonly onDiscard: () => void; readonly onKeep: () => void }): ReactElement | null {
  const keep = useRef<HTMLButtonElement>(null);
  const discard = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    keep.current?.focus();
    return () => { previous?.focus(); };
  }, [open]);
  if (!open) return null;
  return <div className="unsaved-backdrop">
    <div aria-describedby="unsaved-description" aria-labelledby="unsaved-title" aria-modal="true" className="unsaved-dialog" role="alertdialog"
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onKeep(); }
        if (event.key === "Tab") {
          // Two controls: Tab and Shift+Tab alternate between them.
          event.preventDefault();
          (document.activeElement === keep.current ? discard.current : keep.current)?.focus();
        }
      }}>
      <h2 className="panel-title" id="unsaved-title">{title}</h2>
      <p id="unsaved-description">{description}</p>
      <div className="unsaved-actions">
        <button className="button button--primary" ref={keep} type="button" onClick={onKeep}>keep editing</button>
        <button className="button" ref={discard} type="button" onClick={onDiscard}>discard changes</button>
      </div>
    </div>
  </div>;
}
