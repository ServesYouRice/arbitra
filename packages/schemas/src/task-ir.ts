import { z } from "zod";

export const TASK_IR_SCHEMA_VERSION = 1 as const;

export const taskGoalSchema = z.object({
  objective: z.string().min(1),
  doneWhen: z.array(z.string().min(1)),
  stopWhen: z.array(z.string().min(1)),
  blockedWhen: z.array(z.string().min(1)),
}).strict();

export const taskAddressesSchema = z.object({
  issues: z.array(z.string().min(1)),
  validation: z.array(z.string().min(1)),
  requirements: z.array(z.string().min(1)),
}).strict();

export const taskRoutingSchema = z.object({
  capability: z.enum(["frontier", "balanced", "fast"]),
  effort: z.enum(["low", "medium", "high", "xhigh"]),
  advisor: z.enum(["frontier", "balanced", "fast"]).nullable(),
  advisorMaxUses: z.number().int().nonnegative().nullable(),
  reason: z.array(z.string().min(1)),
}).strict();

export const taskCommandSchema = z.object({
  command: z.string().min(1),
  expectedExitCode: z.number().int(),
  executionPolicy: z.enum(["derived_repository_script", "allowlisted", "requires_approval"]),
}).strict();

export const taskIRSchema = z.object({
  schemaVersion: z.literal(TASK_IR_SCHEMA_VERSION),
  id: z.string().regex(/^TASK-[0-9]+$/),
  title: z.string().min(1),
  goal: taskGoalSchema,
  addresses: taskAddressesSchema,
  routing: taskRoutingSchema,
  dependencies: z.object({
    dependsOn: z.array(z.string().min(1)),
    blocks: z.array(z.string().min(1)),
    conflictsWith: z.array(z.string().min(1)),
  }).strict(),
  scope: z.object({
    likelyFiles: z.array(z.string().min(1)),
    components: z.array(z.string().min(1)),
    interfaces: z.array(z.string().min(1)),
  }).strict(),
  filesNotToTouch: z.array(z.string().min(1)),
  readFirst: z.array(z.string().min(1)),
  context: z.array(z.string().min(1)),
  invariants: z.array(z.string().min(1)),
  outOfScope: z.array(z.string().min(1)),
  implementationGuidance: z.array(z.string().min(1)),
  acceptanceCriteria: z.array(z.string().min(1)),
  verification: z.object({
    preconditions: z.array(z.string().min(1)),
    commands: z.array(taskCommandSchema),
    checks: z.array(z.string().min(1)),
  }).strict(),
  rollbackPlan: z.array(z.string().min(1)),
}).strict();

export type TaskGoal = z.infer<typeof taskGoalSchema>;
export type TaskAddresses = z.infer<typeof taskAddressesSchema>;
export type TaskRouting = z.infer<typeof taskRoutingSchema>;
export type TaskCommand = z.infer<typeof taskCommandSchema>;
export type TaskIR = z.infer<typeof taskIRSchema>;
