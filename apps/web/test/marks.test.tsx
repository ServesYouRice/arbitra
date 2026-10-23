// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { GateVerdict } from "../src/app/marks.js";

afterEach(cleanup);

describe("the gate verdict", () => {
  it("reads a completed run's work for the operator as done and needing them, with counts and every code", () => {
    render(<GateVerdict gate={{ status: "failed", reasons: ["unresolved_issues", "degraded_coverage", "blocking_plan_questions"] }} detail={{ unresolved_issues: "20 issues", blocking_plan_questions: "5 questions" }} />);
    expect(screen.getByText("done · needs you")).toBeTruthy();
    expect(screen.getByRole("list", { name: "what needs you" }).textContent).toBe("issues the source could not settle: check them by hand · 20 issues unresolved_issuesquestions in the plan only you can answer · 5 questions blocking_plan_questions");
    expect(screen.getByRole("list", { name: "what the run could not see" }).textContent).toBe("coverage is incomplete degraded_coverage");
  });

  it("says only that coverage has limits when nothing else is left, and keeps the compact line short", () => {
    const { container } = render(<><GateVerdict gate={{ status: "failed", reasons: ["degraded_coverage"] }} compact /><GateVerdict gate={{ status: "failed", reasons: ["unresolved_issues", "degraded_coverage"] }} compact /></>);
    expect([...container.querySelectorAll("p")].map((line) => [line.textContent, line.dataset.state])).toEqual([["done · coverage has limits", undefined], ["done · needs you · issues to check by hand", "attention"]]);
  });

  it("still reads as a failed gate when any reason is not work left on a completed run", () => {
    const { container } = render(<GateVerdict gate={{ status: "failed", reasons: ["run_not_completed", "degraded_coverage"] }} compact />);
    expect(container.textContent).toBe("gate failed · the run did not complete · coverage is incomplete");
    expect(container.querySelector("p")?.dataset.state).toBe("refuted");
  });
});
