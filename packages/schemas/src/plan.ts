import { z } from "zod";

import { taskIRSchema } from "./task-ir.js";
import { validationContractSchema } from "./validation-contract.js";

export const PLAN_IR_SCHEMA_VERSION = 1 as const;

export const unresolvedQuestionSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  blocking: z.boolean(),
  blastRadius: z.enum(["low", "medium", "high"]),
}).strict();

export const planTaskIRSchema = taskIRSchema.extend({
  escalateIf: z.array(z.string().min(1)),
  expectedEvidence: z.array(z.string().min(1)),
  estimatedTurns: z.number().int().positive().nullable(),
}).strict();

const requirementLinkSchema = z.object({
  requirementId: z.string().min(1),
  validationIds: z.array(z.string().min(1)).min(1),
  taskIds: z.array(z.string().min(1)).min(1),
}).strict();

const traceabilitySchema = z.object({
  issueToValidation: z.array(z.object({ issueId: z.string().min(1), validationIds: z.array(z.string().min(1)).min(1) }).strict()),
  requirementLinks: z.object({ schemaVersion: z.number().int().positive(), links: z.array(requirementLinkSchema) }).strict(),
}).strict();

export const planIRSchema = z.object({
  schemaVersion: z.literal(PLAN_IR_SCHEMA_VERSION),
  id: z.string().min(1),
  title: z.string().min(1),
  mode: z.enum(["audit", "feature", "testing"]),
  reasoningOutcome: z.string().min(1),
  implementationStrategy: z.array(z.string().min(1)).min(1),
  dependencies: z.array(z.string().min(1)),
  acceptedIssueIds: z.array(z.string().min(1)),
  unresolvedQuestions: z.array(unresolvedQuestionSchema),
  validationContract: validationContractSchema,
  tasks: z.array(planTaskIRSchema),
  taskGraph: z.array(z.object({ from: z.string().min(1), to: z.string().min(1) }).strict()),
  traceability: traceabilitySchema,
  routingRecommendations: z.array(z.object({ taskId: z.string().min(1), capability: z.enum(["frontier", "balanced", "fast"]), effort: z.enum(["low", "medium", "high", "xhigh"]), reason: z.array(z.string().min(1)).min(1) }).strict()),
  rolloutConcerns: z.array(z.string().min(1)),
  migrationConcerns: z.array(z.string().min(1)),
  premiseReport: z.object({ status: z.enum(["positive", "null", "negative", "unavailable"]), interpretation: z.literal("smoke_test_only_not_proof"), limitations: z.array(z.string().min(1)).min(1) }).strict(),
}).strict();

export type UnresolvedQuestion = z.infer<typeof unresolvedQuestionSchema>;
export type PlanIR = z.infer<typeof planIRSchema>;
export type PlanTaskIR = z.infer<typeof planTaskIRSchema>;
