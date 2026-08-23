export type FsyncPolicy = "always" | "expensive-only" | "never";
export type DurabilityClass = "cheap" | "expensive";

export const DEFAULT_FSYNC_POLICY: FsyncPolicy = "expensive-only";

export interface Fsyncable {
  sync(): Promise<void>;
}

export function shouldFsync(policy: FsyncPolicy, durability: DurabilityClass): boolean {
  return policy === "always" || (policy === "expensive-only" && durability === "expensive");
}

export async function fsync(
  target: Fsyncable,
  policy: FsyncPolicy = DEFAULT_FSYNC_POLICY,
  durability: DurabilityClass = "expensive",
): Promise<void> {
  if (shouldFsync(policy, durability)) await target.sync();
}
