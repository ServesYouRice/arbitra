import "./app.css";
import { lazy, Suspense, type ReactElement } from "react";
import { UnsavedChangesDialog } from "../controls/UnsavedChangesDialog.js";
import { RunsPage } from "../pages/RunsPage.js";
import { ApiProvider, type Apis } from "./apis.js";
import { Link, NavigationProvider, useNavigation, type Route } from "./router.js";

// Each page is its own chunk: the run page carries React Flow and elkjs, the workflow editor
// carries them too, and the run list, which is the first screen, needs neither.
const RunPage = lazy(async () => ({ default: (await import("../pages/run/RunPage.js")).RunPage }));
const NewRunPage = lazy(async () => ({ default: (await import("../pages/new-run/NewRunPage.js")).NewRunPage }));
const WorkflowsPage = lazy(async () => ({ default: (await import("../pages/WorkflowsPage.js")).WorkflowsPage }));
const SettingsPage = lazy(async () => ({ default: (await import("../pages/SettingsPage.js")).SettingsPage }));

/**
 * The operator interface: a list of runs, one page per run, a form to start a run, the
 * workflow editor and this computer's settings. Every page and every run tab has an address (see `router.tsx`).
 */
export function App({ apis }: { readonly apis?: Partial<Apis> }): ReactElement {
  return <ApiProvider {...(apis === undefined ? {} : { apis })}>
    <NavigationProvider renderLeave={(pending, keep, discard) => <UnsavedChangesDialog open={pending !== null} title={pending?.guard.title ?? ""} description={pending?.guard.description ?? ""} onKeep={keep} onDiscard={discard} />}>
      <Frame />
    </NavigationProvider>
  </ApiProvider>;
}

function Frame(): ReactElement {
  const { route } = useNavigation();
  return <div className="app">
    <header className="app-header">
      <Link className="wordmark" to={{ page: "runs" }}><img alt="" src={new URL("../assets/brand/mark-triangle-of-error.svg", import.meta.url).href} /><span>arbitra</span></Link>
      <nav aria-label="main" className="main-nav">
        <NavLink to={{ page: "runs" }} current={route.page === "runs" || route.page === "run"}>Runs</NavLink>
        <NavLink to={{ page: "new-run", from: null, graph: null }} current={route.page === "new-run"}>New run</NavLink>
        <NavLink to={{ page: "workflows", source: null }} current={route.page === "workflows"}>Workflows</NavLink>
        <NavLink to={{ page: "settings" }} current={route.page === "settings"}>Settings</NavLink>
      </nav>
    </header>
    <main className={route.page === "run" ? "page page--wide" : "page"}>
      <Suspense fallback={<p className="state" data-state="unexamined" role="status">loading page</p>}>
        {route.page === "runs" ? <RunsPage />
          : route.page === "run" ? <RunPage key={route.runId} runId={route.runId} tab={route.tab} item={route.item} />
          : route.page === "new-run" ? <NewRunPage from={route.from} graph={route.graph} />
          : route.page === "settings" ? <SettingsPage />
          : <WorkflowsPage source={route.source} />}
      </Suspense>
    </main>
  </div>;
}

function NavLink({ to, current, children }: { readonly to: Route; readonly current: boolean; readonly children: string }): ReactElement {
  return <Link to={to} aria-current={current ? "page" : undefined}>{children}</Link>;
}
