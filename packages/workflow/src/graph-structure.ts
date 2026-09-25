import type { WorkflowGraph } from "./graph-schema.js";

/**
 * Structural checks over a schema-valid workflow graph.
 *
 * `validateWorkflow` checks shapes; this checks what the one shared runner can actually
 * execute. The runner walks an acyclic graph from its entry node, so iteration is never an
 * edge cycle: it is a `loop` node with an explicit maximum. Every diagnostic carries a
 * stable code so an interface can explain it without parsing prose.
 */
export interface GraphDiagnostic {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export interface GraphStructureOptions {
  /** The largest explicit loop maximum a caller will execute. */
  readonly maximumLoopIterations: number;
}

export function validateGraphStructure(graph: WorkflowGraph, options: GraphStructureOptions): GraphDiagnostic[] {
  const diagnostics: GraphDiagnostic[] = [];
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const outgoing = new Map<string, string[]>(graph.nodes.map(({ id }) => [id, []]));
  const pairs = new Set<string>();

  graph.edges.forEach((edge, index) => {
    const path = `edges[${index}](${edge.id})`;
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) return;
    if (edge.from === edge.to) {
      diagnostics.push({ code: "SELF_LOOP", path, message: `Edge ${edge.id} connects ${edge.from} to itself; iteration must be a loop node with an explicit maximum.` });
      return;
    }
    const pair = `${edge.from}\u0000${edge.to}`;
    if (pairs.has(pair)) diagnostics.push({ code: "DUPLICATE_EDGE", path, message: `A second edge connects ${edge.from} to ${edge.to}.` });
    pairs.add(pair);
    if (edge.to === graph.entryNodeId) diagnostics.push({ code: "EDGE_INTO_ENTRY", path, message: `Edge ${edge.id} targets the entry node ${edge.to}; the entry node has no predecessors.` });
    outgoing.get(edge.from)?.push(edge.to);
    // Model output is untrusted text. An edge cannot promote it to system trust.
    const source = nodes.get(edge.from);
    if (source?.kind === "model" && edge.context.policy.trust === "system") {
      diagnostics.push({ code: "CONTEXT_TRUST_ESCALATION", path: `${path}.context.policy.trust`, message: `Edge ${edge.id} carries model output from ${edge.from} as system-trusted context.` });
    }
  });

  graph.nodes.forEach((node, index) => {
    if (node.kind === "loop" && node.maximum > options.maximumLoopIterations) {
      diagnostics.push({ code: "LOOP_BOUND_EXCEEDED", path: `nodes[${index}](${node.id}).maximum`, message: `Loop ${node.id} allows ${node.maximum} iterations; at most ${options.maximumLoopIterations} can execute.` });
    }
  });

  if (nodes.has(graph.entryNodeId)) {
    const reachable = new Set<string>();
    const queue = [graph.entryNodeId];
    while (queue.length > 0) {
      const id = queue.shift() as string;
      if (reachable.has(id)) continue;
      reachable.add(id);
      queue.push(...(outgoing.get(id) ?? []));
    }
    graph.nodes.forEach((node, index) => {
      if (!reachable.has(node.id)) diagnostics.push({ code: "UNREACHABLE_NODE", path: `nodes[${index}](${node.id})`, message: `Node ${node.id} is not reachable from the entry node ${graph.entryNodeId}.` });
    });
  }

  for (const cycle of cycles(graph.nodes.map(({ id }) => id), outgoing)) {
    diagnostics.push({ code: "UNBOUNDED_CYCLE", path: "$.edges", message: `Nodes ${cycle.join(", ")} form an edge cycle with no explicit bound; express iteration as a loop node with a maximum.` });
  }
  return diagnostics;
}

/** Strongly connected components with more than one node, in graph order (Tarjan). */
function cycles(order: readonly string[], outgoing: ReadonlyMap<string, readonly string[]>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const found: string[][] = [];
  let counter = 0;
  const visit = (id: string): void => {
    index.set(id, counter); low.set(id, counter); counter += 1;
    stack.push(id); onStack.add(id);
    for (const next of outgoing.get(id) ?? []) {
      if (!index.has(next)) { visit(next); low.set(id, Math.min(low.get(id) as number, low.get(next) as number)); }
      else if (onStack.has(next)) low.set(id, Math.min(low.get(id) as number, index.get(next) as number));
    }
    if (low.get(id) !== index.get(id)) return;
    const component: string[] = [];
    for (;;) {
      const member = stack.pop() as string;
      onStack.delete(member);
      component.push(member);
      if (member === id) break;
    }
    if (component.length > 1) found.push(order.filter((item) => component.includes(item)));
  };
  for (const id of order) if (!index.has(id)) visit(id);
  return found.sort((a, b) => order.indexOf(a[0] as string) - order.indexOf(b[0] as string));
}
