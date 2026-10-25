import type { FastifyInstance } from "fastify";
import type { Orchestrator } from "@arbitra/runtime/orchestrator.js";
import { exportPlan, planOutline, savedPlans } from "@arbitra/runtime/plan-export.js";
import { planResultRecord } from "@arbitra/runtime/plan-results.js";
import { assertNoSecretEgress } from "./routes/control-plane.js";

/**
 * The plan's hand-over, a route of the local app: saving the plan into the project (on the operator's explicit request
 * only), where it was saved before and what its premise check found then, the order of work the saved folder follows,
 * and what the executing agent recorded in its `results.json`. The order of work comes from the run's own records and
 * passes the outbound secret guard; the results are the agent's text, read from the project and redacted as read.
 */
export function registerHandoffRoutes(app: FastifyInstance, orchestrator: Orchestrator): void {
  app.post<{ Params: { runId: string } }>("/handoff/runs/:runId", async (request) => exportPlan(orchestrator, request.params.runId));
  // Read from the project, so the run page can say the plan is saved after a reload. Writes nothing.
  app.get<{ Params: { runId: string } }>("/handoff/runs/:runId", async (request) => savedPlans(orchestrator, request.params.runId));
  app.get<{ Params: { runId: string } }>("/handoff/runs/:runId/outline", async (request) => assertNoSecretEgress(await planOutline(orchestrator, request.params.runId)));
  app.get<{ Params: { runId: string } }>("/handoff/runs/:runId/results", async (request) => {
    const { repository } = await orchestrator.overview(request.params.runId);
    return { results: repository === null ? null : await planResultRecord(repository, request.params.runId) };
  });
}
