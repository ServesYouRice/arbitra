// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ARTIFACT_CACHE_LIMIT, ArtifactApi } from "../src/api/artifacts.js";
import { RunApi, useLoaded, useRehydratedRun, type RunResource } from "../src/api/runs.js";
import { ArtifactView } from "../src/controls/ArtifactView.js";
import { useRunArtifact } from "../src/views/issue-board/run-artifacts.js";
import { json } from "./support.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("control-plane clients", () => {
  it("maps every run operation to its declared route and keeps the server's explanation of a failure", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => { calls.push(`${init?.method ?? "GET"} ${String(input)}${init?.body === undefined ? "" : ` ${String(init.body)}`}`); return json({}); });
    const api = new RunApi();
    await api.list(); await api.overview("run-1"); await api.selectedRepository(); await api.selectRepository("/work"); await api.preflight({ mode: "audit" }, "/work"); await api.preflight({ mode: "audit" }, " ");
    await api.estimate("cfg-1", "/work"); await api.start("cfg-1"); await api.status("run-1"); await api.resume("run-1"); await api.cancel("run-1"); await api.respondCheckpoint("run-1", "cp", "v", "reject");
    await api.answerPlanQuestions("run-1", "v", [{ questionId: "Q-1", answer: "Throw." }]);
    expect(calls).toEqual([
      "GET /runs", "GET /runs/run-1/overview", "GET /repositories/selected", `POST /repositories/select {"path":"/work"}`,
      `POST /preflight {"config":{"mode":"audit"},"repository":"/work"}`, `POST /preflight {"config":{"mode":"audit"}}`,
      `POST /estimate {"configurationId":"cfg-1","repository":"/work"}`, `POST /runs {"configurationId":"cfg-1"}`, "GET /runs/run-1", "POST /runs/run-1/resume", "POST /runs/run-1/cancel",
      `POST /runs/run-1/checkpoints/cp {"version":"v","decision":"reject"}`, `POST /runs/run-1/checkpoints/plan-questions {"version":"v","answers":[{"questionId":"Q-1","answer":"Throw."}]}`,
    ]);
    vi.stubGlobal("fetch", async () => json({ statusCode: 404, error: "REQUEST_FAILED", message: "REPOSITORY_NOT_FOUND:/work" }, 404));
    await expect(api.start("cfg-1", "/work")).rejects.toThrow("REPOSITORY_NOT_FOUND:/work (RUN_API_404)");
    vi.stubGlobal("fetch", async () => new Response("not json", { status: 503 }));
    await expect(api.status("run-1")).rejects.toThrow(/^RUN_API_503$/u);
  });

  it("shares one artifact list request per run event, and starts a new one for the next event", async () => {
    let lists = 0;
    vi.stubGlobal("fetch", async () => { lists += 1; return json([]); });
    const api = new ArtifactApi();
    await Promise.all([api.list("run-1", 3), api.list("run-1", 3), api.list("run-1", 3)]);
    expect(lists).toBe(1);
    await Promise.all([api.list("run-1", 4), api.list("run-2", 4)]);
    expect(lists).toBe(3);
    await api.list("run-1", 3);
    expect(lists).toBe(4);
  });

  it("keeps the most recently read artifacts up to a bound", async () => {
    let loads = 0;
    vi.stubGlobal("fetch", async () => { loads += 1; return json({ artifactId: "a", kind: "k", content: "{}" }); });
    const api = new ArtifactApi();
    for (let index = 0; index <= ARTIFACT_CACHE_LIMIT; index += 1) await api.load("run-1", `a-${index}`);
    expect(loads).toBe(ARTIFACT_CACHE_LIMIT + 1);
    await api.load("run-1", `a-${ARTIFACT_CACHE_LIMIT}`);
    expect(loads).toBe(ARTIFACT_CACHE_LIMIT + 1);
    await api.load("run-1", "a-0");
    expect(loads).toBe(ARTIFACT_CACHE_LIMIT + 2);
  });

  it("loads an artifact once, however many views read it, and retries one that failed", async () => {
    let loads = 0;
    vi.stubGlobal("fetch", async () => { loads += 1; return loads === 1 ? json({}, 500) : json({ artifactId: "a", kind: "plan-ir", content: "{}" }); });
    const api = new ArtifactApi();
    await expect(api.load("run-1", "a")).rejects.toThrow("ARTIFACT_API_500");
    const [first, second] = await Promise.all([api.load("run-1", "a"), api.load("run-1", "a")]);
    expect(first).toBe(second);
    await api.load("run-1", "a");
    expect(loads).toBe(2);
  });
});

describe("live run state", () => {
  it("reads the durable state before streaming, records the latest transition's reason, and closes on the end event", async () => {
    const order: string[] = [];
    const sources: Source[] = [];
    class Source {
      onmessage: ((message: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      readonly close = vi.fn();
      readonly listeners = new Map<string, () => void>();
      constructor(readonly url: string) { order.push("stream"); sources.push(this); }
      addEventListener(name: string, callback: () => void) { this.listeners.set(name, callback); }
    }
    vi.stubGlobal("EventSource", Source);
    const api = new RunApi("https://control.example.test");
    vi.spyOn(api, "status").mockImplementation(async (runId) => { order.push("status"); return { runId, state: "CREATED", resumable: true, checkpoints: [] }; });
    function Fixture({ runId }: { runId: string | null }) { const run = useRehydratedRun(api, runId); return <p>{run.resource?.state ?? "none"}:{run.events.length}:{run.reason ?? "no reason"}</p>; }
    const view = render(<Fixture runId="run-1" />);
    await screen.findByText("CREATED:0:no reason");
    const source = sources[0];
    if (source === undefined) throw new Error("no event stream opened");
    expect(source.url).toBe("https://control.example.test/runs/run-1/events");
    act(() => { source.onmessage?.({ data: JSON.stringify({ t: "run_transition", runId: "run-1", state: "FAILED", reason: "PROVIDER_TIMEOUT" }) }); });
    expect(await screen.findByText("FAILED:1:PROVIDER_TIMEOUT")).toBeTruthy();
    act(() => source.listeners.get("end")?.());
    expect(source.close).toHaveBeenCalledOnce();
    expect(order.slice(0, 2)).toEqual(["status", "stream"]);
    view.rerender(<Fixture runId={null} />);
    expect(await screen.findByText("none:0:no reason")).toBeTruthy();
  });

  it("keeps a run's last known state while it re-subscribes after a decision, and starts empty for another run", async () => {
    class Source { onmessage: unknown = null; onerror: unknown = null; constructor(readonly url: string) {} addEventListener(): void {} close(): void {} }
    vi.stubGlobal("EventSource", Source);
    const api = new RunApi();
    let release: ((value: RunResource) => void) | undefined;
    let reads = 0;
    vi.spyOn(api, "status").mockImplementation((runId) => { reads += 1; return reads === 1 ? Promise.resolve({ runId, state: "BLOCKED", resumable: true, checkpoints: [] }) : new Promise<RunResource>((resolve) => { release = resolve; }); });
    function Fixture({ runId, version }: { runId: string; version: number }) { const run = useRehydratedRun(api, runId, version); return <p>{run.resource?.state ?? "none"}</p>; }
    const view = render(<Fixture runId="run-1" version={0} />);
    await screen.findByText("BLOCKED");
    // Found by browser QA: blanking here unmounted the open tab and lost its confirmation notice.
    view.rerender(<Fixture runId="run-1" version={1} />);
    expect(screen.getByText("BLOCKED")).toBeTruthy();
    act(() => release?.({ runId: "run-1", state: "RUNNING", resumable: true, checkpoints: [] }));
    await screen.findByText("RUNNING");
    view.rerender(<Fixture runId="run-2" version={1} />);
    expect(screen.getByText("none")).toBeTruthy();
  });

  it("keeps showing an artifact while a run event re-reads it, instead of flashing empty", async () => {
    let release: (() => void) | undefined;
    let lists = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/artifacts")) {
        lists += 1;
        if (lists > 1) await new Promise<void>((resolve) => { release = resolve; });
        return json([{ artifactId: "plan-ir-1", kind: "plan-ir", mediaType: "application/json", bytes: 2, redacted: true }]);
      }
      return json({ artifactId: "plan-ir-1", kind: "plan-ir", content: JSON.stringify({ title: "Plan A" }) });
    });
    const api = new ArtifactApi();
    function Fixture({ refresh }: { refresh: number }) { const plan = useRunArtifact<{ title: string }>(api, "run-1", "plan-ir", refresh); return <p>{plan.state}:{plan.value?.title ?? "none"}</p>; }
    const view = render(<Fixture refresh={0} />);
    await screen.findByText("loaded:Plan A");
    view.rerender(<Fixture refresh={1} />);
    expect(screen.getByText("loaded:Plan A")).toBeTruthy();
    await waitFor(() => expect(release).toBeDefined());
    act(() => release?.());
    await screen.findByText("loaded:Plan A");
    expect(lists).toBe(2);
  });

  it("starts a different key empty and a null key loads nothing", async () => {
    const load = vi.fn(async () => "value");
    function Fixture({ id }: { id: string | null }) { const loaded = useLoaded(id, load); return <p>{loaded.loading ? "loading" : loaded.value ?? "nothing"}</p>; }
    const view = render(<Fixture id={null} />);
    expect(screen.getByText("nothing")).toBeTruthy();
    view.rerender(<Fixture id="a" />);
    expect(await screen.findByText("value")).toBeTruthy();
    expect(load).toHaveBeenCalledOnce();
  });
});

describe("persisted artifacts", () => {
  it("shows bounded redacted content, its truncation and continuation, and a prompt that does not parse as plain content", async () => {
    vi.stubGlobal("fetch", async () => json({ artifactId: "compiled-prompt-a", kind: "compiled-prompt-deadbeefdeadbeefdeadbeef", mediaType: "application/json", bytes: 512, redacted: true, nodeId: "feature/requirements", content: "[REDACTED:api_key]", truncated: true, continuationArtifactId: "a-2" }));
    render(<ArtifactView api={new ArtifactApi()} runId="run-1" artifactId="compiled-prompt-a" />);
    expect(await screen.findByText("[REDACTED:api_key]")).toBeTruthy();
    expect(screen.getByText("compiled-prompt · deadbeef")).toBeTruthy();
    expect(screen.getByText("persisted redacted content · 512 bytes · node feature/requirements").dataset.state).toBe("tainted");
    expect(screen.getByText("truncated · continuation artifact a-2").dataset.state).toBe("unexamined");
  });

  it("reports an artifact that cannot be read", async () => {
    vi.stubGlobal("fetch", async () => json({ statusCode: 404, error: "REQUEST_FAILED", message: "ARTIFACT_ABSENT:x" }, 404));
    render(<ArtifactView api={new ArtifactApi()} runId="run-1" artifactId="x" />);
    expect((await screen.findByRole("alert")).textContent).toBe("artifact unavailable · ARTIFACT_ABSENT:x (ARTIFACT_API_404)");
  });
});
