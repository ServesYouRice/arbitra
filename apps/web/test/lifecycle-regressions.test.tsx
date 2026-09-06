// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigurationApi } from "../src/api/configurations.js";
import { RunApi, useRehydratedRun } from "../src/api/runs.js";
import { ConfigurationEditor } from "../src/configuration/ConfigurationEditor.js";
import { ConfigurationWorkspace } from "../src/configuration/ConfigurationWorkspace.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("configuration editing", () => {
  it("edits module and diff scope details without replacing dedicated fields through JSON", async () => {
    const api = new ConfigurationApi();
    const validate = vi.spyOn(api, "validate").mockResolvedValue({ valid: true });
    render(<ConfigurationEditor api={api} initialName="Scoped" initialValue={{ models: {}, scope: { kind: "repository" } }} />);
    fireEvent.change(screen.getByLabelText("scope kind"), { target: { value: "module" } });
    fireEvent.change(screen.getByLabelText("modules (one path per line)"), { target: { value: "src/api\nsrc/model" } });
    fireEvent.click(screen.getByText("validate"));
    await waitFor(() => expect(validate).toHaveBeenLastCalledWith(expect.objectContaining({ scope: { kind: "module", modules: ["src/api", "src/model"] } })));
    fireEvent.change(screen.getByLabelText("scope kind"), { target: { value: "diff" } });
    fireEvent.change(screen.getByLabelText("diff mode"), { target: { value: "staged" } });
    fireEvent.click(screen.getByText("validate"));
    await waitFor(() => expect(validate).toHaveBeenLastCalledWith(expect.objectContaining({ scope: { kind: "diff", diffMode: "staged" } })));
  });
  it("does not save invalid JSON drafts or configurations rejected by validation", async () => {
    const api = new ConfigurationApi();
    const save = vi.spyOn(api, "save");
    const validate = vi.spyOn(api, "validate").mockResolvedValue({ valid: false, errors: ["rounds invalid"] });
    render(<ConfigurationEditor api={api} initialName="Draft" initialValue={{ models: {} }} />);
    fireEvent.change(screen.getByLabelText("validated JSON fallback"), { target: { value: "{" } });
    fireEvent.click(screen.getByText("save"));
    await waitFor(() => expect(screen.getByRole("status").textContent).not.toBe("unvalidated"));
    expect(save).not.toHaveBeenCalled(); expect(validate).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("validated JSON fallback"), { target: { value: "{}" } });
    fireEvent.click(screen.getByText("save"));
    expect(await screen.findByText("invalid: rounds invalid")).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
  });

  it("notifies the workspace when a configuration is selected or newly saved", async () => {
    const api = new ConfigurationApi();
    const selected = vi.fn();
    const record = { id: "cfg-2", name: "Second", config: { models: {} } };
    vi.spyOn(api, "list").mockResolvedValue([{ id: record.id, name: record.name }]);
    vi.spyOn(api, "load").mockResolvedValue(record);
    vi.spyOn(api, "validate").mockResolvedValue({ valid: true });
    vi.spyOn(api, "save").mockResolvedValue({ ...record, id: "cfg-new", name: "untitled" });
    render(<ConfigurationWorkspace api={api} defaults={{ models: {} }} onSelect={selected} />);
    await screen.findByText("Second");
    fireEvent.change(screen.getByLabelText("saved configuration"), { target: { value: record.id } });
    await waitFor(() => expect(selected).toHaveBeenCalledWith(record));
    fireEvent.change(screen.getByLabelText("saved configuration"), { target: { value: "" } });
    fireEvent.click(screen.getByText("save"));
    await waitFor(() => expect(selected).toHaveBeenCalledWith(expect.objectContaining({ id: "cfg-new" })));
  });
});

describe("run event rehydration", () => {
  it("uses the API origin, retains replay transitions and closes on the stream end event", async () => {
    const instances: Source[] = [];
    class Source {
      onmessage: ((message: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      readonly close = vi.fn();
      readonly listeners = new Map<string, () => void>();
      constructor(readonly url: string) { instances.push(this); }
      addEventListener(name: string, callback: () => void) { this.listeners.set(name, callback); }
    }
    vi.stubGlobal("EventSource", Source);
    const api = new RunApi("https://control.example.test");
    vi.spyOn(api, "status").mockImplementation(async (runId) => ({ runId, state: "CREATED", resumable: true, checkpoints: [] }));
    function Fixture({ runId }: { runId: string | null }) { const run = useRehydratedRun(api, runId); return <p>{run.resource?.state ?? "none"}:{run.events.length}:{run.error ?? "clear"}</p>; }
    const view = render(<Fixture runId="run-1" />);
    await screen.findByText("CREATED:0:clear");
    const source = instances[0]; if (source === undefined) throw new Error("missing event source");
    expect(source.url).toBe("https://control.example.test/runs/run-1/events");
    act(() => { for (const state of ["CANCELLED", "CREATED", "COMPLETED"]) source.onmessage?.({ data: JSON.stringify({ t: "run_transition", runId: "run-1", state }) }); });
    expect(screen.getByText("COMPLETED:3:clear")).toBeTruthy();
    expect(source.close).not.toHaveBeenCalled();
    act(() => source.listeners.get("end")?.());
    expect(source.close).toHaveBeenCalledOnce();
    view.rerender(<Fixture runId={null} />);
    expect(await screen.findByText("none:0:clear")).toBeTruthy();
  });
});
