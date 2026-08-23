export const EXECUTION_POLICIES = ["derived_repository_script", "allowlisted", "requires_approval"] as const;
export type ExecutionPolicy = typeof EXECUTION_POLICIES[number];

export interface ManifestCommand {
  readonly command: string;
  readonly expectedExitCode: number;
  readonly executionPolicy: string;
}

export interface ManifestTask {
  readonly id: string;
  readonly title: string;
  readonly phase: string;
  readonly goal: { readonly objective: string; readonly doneWhen: readonly string[]; readonly stopWhen?: readonly string[]; readonly blockedWhen?: readonly string[] };
  readonly addresses: { readonly issues?: readonly string[]; readonly requirements: readonly string[]; readonly validation: readonly string[] };
  readonly routing: { readonly capability: string; readonly effort: string; readonly reason: readonly string[] };
  readonly dependencies: { readonly dependsOn: readonly string[]; readonly conflictsWith?: readonly string[]; readonly blocks?: readonly string[] };
  readonly scope: { readonly likelyFiles: readonly string[]; readonly components?: readonly string[]; readonly interfaces?: readonly string[] };
  readonly filesNotToTouch?: readonly string[];
  readonly readFirst: readonly string[];
  readonly context?: readonly string[];
  readonly invariants?: readonly string[];
  readonly outOfScope?: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly verification: { readonly preconditions?: readonly string[]; readonly commands: readonly ManifestCommand[]; readonly checks?: readonly string[] };
  readonly rollbackPlan?: readonly string[];
  readonly escalateIf?: readonly string[];
  readonly expectedEvidence?: readonly string[];
  readonly estimatedTurns?: number;
}

export interface ImplementationManifest {
  readonly manifestVersion: string;
  readonly trustWarning?: string;
  readonly run: {
    readonly runId: string;
    readonly mode: string;
    readonly repository: string;
    readonly scopeKind?: string;
    readonly snapshot?: { readonly note?: string; readonly files?: readonly string[] };
    readonly degradations?: readonly { readonly field: string; readonly reason: string; readonly statement: string }[];
    readonly metrics?: { readonly modelCalls?: number | null; readonly tokens?: number | null; readonly cost?: number | null; readonly note?: string };
  };
  readonly requirements: {
    readonly assumptions: readonly { readonly id: string; readonly statement: string; readonly confidence?: string }[];
    readonly ambiguities: readonly { readonly id: string; readonly question: string; readonly proposedDefault?: string; readonly blastRadius?: string }[];
    readonly acceptance: readonly { readonly id: string; readonly assertion: string }[];
    readonly outOfScope?: readonly string[];
  };
  readonly unresolvedQuestions?: readonly { readonly id: string; readonly question?: string; readonly statement?: string; readonly blastRadius?: string }[];
  readonly issues?: readonly { readonly id: string; readonly title?: string; readonly description?: string; readonly status?: string; readonly dissent?: readonly string[]; readonly provenance?: readonly string[] }[];
  readonly validation: readonly { readonly id: string; readonly assertion: string; readonly evidence?: readonly string[]; readonly addresses?: readonly string[] }[];
  readonly phases?: readonly { readonly id: string; readonly title: string; readonly goal?: string }[];
  readonly tasks: readonly ManifestTask[];
  readonly progressSchema: Readonly<Record<string, unknown>>;
}

export function assertImplementationManifest(value: ImplementationManifest): void {
  if (value.manifestVersion.trim() === "" || value.run.runId.trim() === "") throw new Error("INVALID_IMPLEMENTATION_MANIFEST_IDENTITY");
  if (!isObject(value.progressSchema) || value.progressSchema.type !== "object") throw new Error("INVALID_PROGRESS_SCHEMA");
  const taskIds = new Set<string>();
  const validationIds = new Set(value.validation.map(({ id }) => id));
  for (const task of value.tasks) {
    if (!/^TASK-[0-9]{3}$/u.test(task.id) || taskIds.has(task.id)) throw new Error(`INVALID_OR_DUPLICATE_TASK_ID:${task.id}`);
    taskIds.add(task.id);
    if (task.addresses.validation.length === 0 || task.addresses.validation.some((id) => !validationIds.has(id))) throw new Error(`INVALID_TASK_VALIDATION_MAPPING:${task.id}`);
    if (task.verification.commands.length === 0) throw new Error(`TASK_WITHOUT_VERIFICATION_COMMAND:${task.id}`);
  }
}

export function executionPolicy(value: string): ExecutionPolicy {
  return (EXECUTION_POLICIES as readonly string[]).includes(value) ? value as ExecutionPolicy : "requires_approval";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
