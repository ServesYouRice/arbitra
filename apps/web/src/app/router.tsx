import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type AnchorHTMLAttributes, type MouseEvent, type ReactElement, type ReactNode } from "react";

/**
 * The address of every screen. The whole interface state that matters to someone else is
 * in the query string, so a run, a tab and the selected item are a link to send, and the
 * browser's back button walks the operator's own path through them.
 *
 * Addresses stay in the query because the control plane owns `/runs/…` and the other API
 * paths the dev server forwards to it.
 */
export const RUN_TABS = ["overview", "issues", "plan", "requirements", "execution", "activity", "evaluation"] as const;
export type RunTab = typeof RUN_TABS[number];

export type Route =
  | { readonly page: "runs" }
  | { readonly page: "run"; readonly runId: string; readonly tab: RunTab | null; readonly item: string | null }
  | { readonly page: "new-run"; readonly from: string | null; readonly graph: string | null }
  | { readonly page: "workflows"; readonly source: string | null };

// Links written before the restructure name the old column-two views.
const LEGACY_VIEWS: Readonly<Record<string, RunTab>> = Object.freeze({ graph: "activity", traces: "activity", feature: "requirements", testing: "execution" });

export function parseRoute(search: string): Route {
  const query = new URLSearchParams(search);
  const run = query.get("run");
  if (run !== null && run !== "") {
    const view = query.get("view");
    const tab = view === null ? null : (RUN_TABS as readonly string[]).includes(view) ? view as RunTab : LEGACY_VIEWS[view] ?? null;
    return { page: "run", runId: run, tab, item: query.get("item") };
  }
  const page = query.get("page");
  if (page === "new-run") return { page: "new-run", from: query.get("from"), graph: query.get("graph") };
  if (page === "workflows") return { page: "workflows", source: query.get("source") };
  return { page: "runs" };
}

export function routeHref(route: Route, pathname = "/"): string {
  const query = new URLSearchParams();
  if (route.page === "run") {
    query.set("run", route.runId);
    if (route.tab !== null) query.set("view", route.tab);
    if (route.item !== null) query.set("item", route.item);
  } else if (route.page === "new-run") {
    query.set("page", "new-run");
    if (route.from !== null) query.set("from", route.from);
    if (route.graph !== null) query.set("graph", route.graph);
  } else if (route.page === "workflows") {
    query.set("page", "workflows");
    if (route.source !== null) query.set("source", route.source);
  }
  const text = query.toString();
  return text === "" ? pathname : `${pathname}?${text}`;
}

/** What leaving the current page would discard; set while there are unsaved edits. */
export interface LeaveGuard { readonly title: string; readonly description: string }

export interface Navigation {
  readonly route: Route;
  /** `replace` rewrites the current history entry, for changes that are not a step of their own. */
  navigate(route: Route, options?: { readonly replace?: boolean }): void;
  /** Ask before any navigation away from the page while `guard` is set. */
  setGuard(guard: LeaveGuard | null): void;
}

const NavigationContext = createContext<Navigation | null>(null);

export function useNavigation(): Navigation {
  const navigation = useContext(NavigationContext);
  if (navigation === null) throw new Error("NAVIGATION_CONTEXT_MISSING");
  return navigation;
}

/** A leave waiting for the operator: through an in-app link, or a browser back/forward step already undone. */
export interface PendingLeave { readonly guard: LeaveGuard; readonly target: Route; readonly replace: boolean; readonly via: "link" | "history" }

/**
 * History-backed navigation. A guarded page is left only after the operator confirms: an
 * in-app link asks before it moves, a browser back/forward step is undone and asked about
 * the same way, and a reload or close gets the browser's own prompt.
 */
export function NavigationProvider({ children, renderLeave }: { readonly children: ReactNode; readonly renderLeave: (pending: PendingLeave | null, keep: () => void, discard: () => void) => ReactNode }): ReactElement {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.search));
  const [pending, setPending] = useState<PendingLeave | null>(null);
  const guard = useRef<LeaveGuard | null>(null);
  const current = useRef(route);
  current.current = route;

  const apply = useCallback((target: Route, replace: boolean): void => {
    const href = routeHref(target, window.location.pathname);
    if (replace) window.history.replaceState(null, "", href);
    else window.history.pushState(null, "", href);
    setRoute(target);
  }, []);

  useEffect(() => {
    const onPop = (): void => {
      const target = parseRoute(window.location.search);
      if (guard.current === null) { setRoute(target); return; }
      // Undo the browser's step until the operator has decided.
      window.history.pushState(null, "", routeHref(current.current, window.location.pathname));
      setPending({ guard: guard.current, target, replace: false, via: "history" });
    };
    const onUnload = (event: BeforeUnloadEvent): void => { if (guard.current !== null) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("popstate", onPop);
    window.addEventListener("beforeunload", onUnload);
    return () => { window.removeEventListener("popstate", onPop); window.removeEventListener("beforeunload", onUnload); };
  }, []);

  // Stable identities: pages hand these to effects, which must not re-run on every navigation.
  const navigate = useCallback((target: Route, options?: { readonly replace?: boolean }): void => {
    const replace = options?.replace === true;
    if (guard.current !== null && routeHref(target) !== routeHref(current.current)) setPending({ guard: guard.current, target, replace, via: "link" });
    else apply(target, replace);
  }, [apply]);
  const setGuard = useCallback((next: LeaveGuard | null): void => { guard.current = next; }, []);
  const navigation = useMemo<Navigation>(() => ({ route, navigate, setGuard }), [route, navigate, setGuard]);

  const keep = (): void => setPending(null);
  const discard = (): void => {
    if (pending === null) return;
    guard.current = null;
    setPending(null);
    // A back/forward step was undone by re-pushing this page; stepping back again completes
    // it, so the abandoned page is not left behind as an extra history entry.
    if (pending.via === "history") window.history.back();
    else apply(pending.target, pending.replace);
  };
  return <NavigationContext.Provider value={navigation}>{children}{renderLeave(pending, keep, discard)}</NavigationContext.Provider>;
}

/** A real link: it opens in a new tab with the usual modifiers and navigates in place otherwise. */
export function Link({ to, replace = false, children, onClick, ...rest }: { readonly to: Route; readonly replace?: boolean; readonly children: ReactNode } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href">): ReactElement {
  const { navigate } = useNavigation();
  const follow = (event: MouseEvent<HTMLAnchorElement>): void => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(to, { replace });
  };
  return <a {...rest} href={routeHref(to, typeof window === "undefined" ? "/" : window.location.pathname)} onClick={follow}>{children}</a>;
}
