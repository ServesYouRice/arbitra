import type { ELK as ElkInstance, ElkNode } from "elkjs";
export interface WorkflowJson { readonly id: string; readonly nodes: readonly { readonly id: string; readonly kind: "deterministic" | "model" | "gate" | "loop" | "human" | "subgraph"; readonly label: string; readonly config?: Readonly<Record<string, unknown>> }[]; readonly edges: readonly { readonly id: string; readonly from: string; readonly to: string }[] }
export interface PositionedNode { readonly id: string; readonly x: number; readonly y: number; readonly width: number; readonly height: number }
// elkjs is 1.6 MB minified and is only reachable once a graph is laid out, so it loads on
// demand rather than from the entry chunk. The promise is cached so repeated layouts share
// one module instance.
let elkModule: Promise<new() => ElkInstance> | null = null;
function loadElk(): Promise<new() => ElkInstance> { elkModule ??= import("elkjs").then((module) => (module.default ?? module) as unknown as new() => ElkInstance); return elkModule; }
// Laid out top-down rather than left-to-right. Column two is the fluid column but it is
// still far taller than it is wide, and audit-deep is an eight-layer chain: laid out RIGHT
// it only fits at 0.38 scale, which renders the labels illegible. DOWN fits the same graph
// at 0.72 and reads in the same order as the stage list beneath it.
export async function layoutWorkflow(workflow: WorkflowJson): Promise<readonly PositionedNode[]> { const ElkConstructor = await loadElk(); const elk = new ElkConstructor(); const graph = await elk.layout({ id: workflow.id, layoutOptions: { "elk.algorithm": "layered", "elk.direction": "DOWN", "elk.spacing.nodeNode": "20", "elk.layered.spacing.nodeNodeBetweenLayers": "52" }, children: workflow.nodes.map(({ id }) => ({ id, width: 180, height: 44 })), edges: workflow.edges.map(({ id, from, to }) => ({ id, sources: [from], targets: [to] })) }); return Object.freeze((graph.children ?? []).map(({ id, x, y, width, height }: ElkNode) => Object.freeze({ id, x: x ?? 0, y: y ?? 0, width: width ?? 180, height: height ?? 44 }))); }
