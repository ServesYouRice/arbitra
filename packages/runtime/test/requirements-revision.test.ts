import { describe, expect, it } from "vitest";
import type { RequirementsContract } from "@arbitra/schemas/requirements.js";
import { validateRequirementsRevision } from "../src/requirements-revision.js";

const contract: RequirementsContract = { schemaVersion: 1, featureRequest: "Feature", assumptions: [{ id: "ASM", statement: "Keep compatibility", confidence: "high" }], ambiguities: [{ id: "AMB", question: "Migrate?", proposedDefault: "Keep", blastRadius: "high" }], acceptance: [{ id: "ACC", assertion: "Feature works" }], outOfScope: ["No migration"], decision: { mode: "automatic", acceptedDefaults: [{ ambiguityId: "AMB", value: "Keep", acceptedBy: "automatic_mode" }] } };
const revision = () => ({ draft: { assumptions: contract.assumptions, ambiguities: [{ ...contract.ambiguities[0], id: "AMB", question: "Migrate?", proposedDefault: "Keep sessions", blastRadius: "high" as const }], acceptance: contract.acceptance, outOfScope: contract.outOfScope },
  lineage: ["ASM", "AMB", "ACC"].map((id) => ({ previousRequirementId: id, nextRequirementIds: [id], rationale: "Retained responsibility" })), addedRequirementIds: [] as string[], resolutions: [{ requirementId: "AMB", resolution: "Clarified default" }] });

describe("requirements revision validation", () => {
  it("retains explicit acceptance lineage for a split and newly added requirements", () => {
    const input = structuredClone(revision());
    input.draft.acceptance = [{ id: "ACC-1", assertion: "Old behavior works" }, { id: "ACC-2", assertion: "New behavior works" }, { id: "ACC-3", assertion: "Regression check" }];
    input.lineage = input.lineage.map((entry) => entry.previousRequirementId === "ACC" ? { ...entry, nextRequirementIds: ["ACC-1", "ACC-2"] } : entry);
    input.addedRequirementIds = ["ACC-3"];
    expect(validateRequirementsRevision(input, contract, ["AMB"])).toEqual(input);
  });
  it.each(["missing_lineage", "duplicate_lineage", "unknown_target", "missing_resolution", "duplicate_resolution", "unknown_resolution", "acceptance_dropped", "risk_downgraded", "ambiguity_dropped", "scope_widened", "unmapped_addition", "no_change", "invented_approval"])("rejects %s", (kind) => {
    const input = structuredClone(revision());
    if (kind === "missing_lineage") input.lineage.pop();
    if (kind === "duplicate_lineage") input.lineage.push({ previousRequirementId: "AMB", nextRequirementIds: ["AMB"], rationale: "Duplicate" });
    if (kind === "unknown_target") input.lineage = input.lineage.map((entry) => ({ ...entry, nextRequirementIds: ["unknown"] }));
    if (kind === "missing_resolution") input.resolutions = [];
    if (kind === "duplicate_resolution") input.resolutions.push({ requirementId: "AMB", resolution: "Duplicate" });
    if (kind === "unknown_resolution") input.resolutions = [{ requirementId: "unknown", resolution: "Invented" }];
    if (kind === "acceptance_dropped") { input.draft.acceptance = [{ id: "NEW", assertion: "Unrelated" }]; input.addedRequirementIds = ["NEW"]; input.lineage = input.lineage.map((entry) => entry.previousRequirementId === "ACC" ? { ...entry, nextRequirementIds: [] } : entry); }
    if (kind === "risk_downgraded") Object.assign(input.draft.ambiguities[0] ?? {}, { blastRadius: "low" });
    if (kind === "ambiguity_dropped") { input.draft.ambiguities = []; input.lineage = input.lineage.map((entry) => entry.previousRequirementId === "AMB" ? { ...entry, nextRequirementIds: [] } : entry); }
    if (kind === "scope_widened") input.draft.outOfScope = [];
    if (kind === "unmapped_addition") input.draft.acceptance.push({ id: "NEW", assertion: "Additional responsibility" });
    if (kind === "no_change") Object.assign(input.draft, { ambiguities: contract.ambiguities });
    if (kind === "invented_approval") Object.assign(input.draft, { decision: contract.decision });
    expect(() => validateRequirementsRevision(input, contract, ["AMB"])).toThrow();
  });
});
