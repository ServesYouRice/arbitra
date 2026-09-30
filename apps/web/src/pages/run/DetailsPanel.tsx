import { useEffect, useRef, type ReactElement, type ReactNode } from "react";
import { DETAILS_OVERLAY_QUERY, useMediaQuery } from "../../app/media.js";

/**
 * The one place a selected thing is explained: beside the page on a wide screen, over it
 * on a narrow one. It exists only while something is selected, so it never covers
 * controls with an empty panel. Escape closes it; as an overlay it takes focus and gives
 * it back when it closes.
 */
export function DetailsPanel({ title, onClose, children }: { readonly title: string; readonly onClose: () => void; readonly children: ReactNode }): ReactElement {
  const overlay = useMediaQuery(DETAILS_OVERLAY_QUERY);
  const close = useRef<HTMLButtonElement>(null);
  const latestClose = useRef(onClose);
  latestClose.current = onClose;
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => { if (event.key === "Escape" && !event.defaultPrevented) latestClose.current(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    if (!overlay) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    close.current?.focus();
    return () => { previous?.focus(); };
  }, [overlay]);
  return <aside aria-label={`details · ${title}`} aria-modal={overlay ? true : undefined} className="details" data-overlay={overlay} role={overlay ? "dialog" : "complementary"}>
    <div className="details__head">
      <h2 className="details__title">{title}</h2>
      <button aria-label="close details" className="button" ref={close} type="button" onClick={onClose}>close</button>
    </div>
    <div className="details__body">{children}</div>
  </aside>;
}
