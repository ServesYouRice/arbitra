import { timingSafeEqual } from "node:crypto";
interface Database { query<T>(sql: string, values: readonly unknown[]): Promise<T[]> }
interface Sink { publishUnique(eventId: string, payload: unknown): Promise<void> }
export function verifySignature(actual: Buffer, expected: Buffer): boolean { return actual.length === expected.length && timingSafeEqual(actual, expected); }
export async function findAccount(db: Database, email: string): Promise<unknown[]> { return db.query("SELECT * FROM accounts WHERE email = $1", [email]); }
export async function publishOnce(sink: Sink, eventId: string, payload: unknown): Promise<void> { await sink.publishUnique(eventId, payload); }
