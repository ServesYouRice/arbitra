// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { GateVerdict, StateChip } from "../src/app/marks.js";

afterEach(cleanup);

describe("the gate verdict, as one line in the run list", () => {
  it("reads a completed run's work for the operator as done and needing them, naming the work and no code", () => {
    const { container } = render(<GateVerdict gate={{ status: "failed", reasons: ["unresolved_issues", "degraded_coverage", "blocking_plan_questions"] }} />);
    expect(container.textContent).toBe("done · needs you · issues to check by hand · questions for you");
    expect(container.querySelector("p")?.dataset.state).toBe("attention");
    expect(container.textContent).not.toMatch(/unresolved_issues|degraded_coverage|blocking_plan_questions/u);
  });

  it("says only that coverage has limits when nothing else is left", () => {
    const { container } = render(<><GateVerdict gate={{ status: "failed", reasons: ["degraded_coverage"] }} /><GateVerdict gate={{ status: "failed", reasons: ["unresolved_issues", "degraded_coverage"] }} /></>);
    expect([...container.querySelectorAll("p")].map((line) => [line.textContent, line.dataset.state])).toEqual([["done · coverage has limits", undefined], ["done · needs you · issues to check by hand", "attention"]]);
  });

  it("still reads as a failed gate when any reason is not work left on a completed run", () => {
    const { container } = render(<GateVerdict gate={{ status: "failed", reasons: ["run_not_completed", "degraded_coverage"] }} />);
    expect(container.textContent).toBe("gate failed · the run did not complete · coverage is incomplete");
    expect(container.querySelector("p")?.dataset.state).toBe("refuted");
  });
});

describe("the state chip", () => {
  it("names the state in words only: the recorded code is in the details, not on the chip", () => {
    const { container } = render(<>{["DISCOVERY_RUNNING", "SUSPENDED_RATE_LIMIT", "BLOCKED", "COMPLETED", "FAILED"].map((state) => <StateChip key={state} state={state} />)}</>);
    expect([...container.querySelectorAll(".chip")].map((chip) => [chip.textContent, (chip as HTMLElement).dataset.tone])).toEqual([["running", undefined], ["paused for usage", "degraded"], ["needs you", "attention"], ["done", undefined], ["failed", "refuted"]]);
  });
});
