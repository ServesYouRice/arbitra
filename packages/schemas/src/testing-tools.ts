import { z } from "zod";

export const testingReadFileSchema = z.strictObject({ path: z.string().min(1), startLine: z.number().int().positive().optional(), endLine: z.number().int().positive().optional(), startColumn: z.number().int().positive().optional() });
export const testingWriteFileSchema = z.strictObject({ path: z.string().min(1), expectedHash: z.string().regex(/^[a-f0-9]{64}$/u).nullable(), content: z.string().max(512 * 1024) });
export const testingWriterResultSchema = z.strictObject({ summary: z.string().min(1), limitations: z.array(z.string().min(1)) });
