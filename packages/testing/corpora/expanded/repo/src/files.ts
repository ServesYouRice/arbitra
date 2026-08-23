import { resolve, sep } from "node:path";

export function readTenantFile(tenantRoot: string, requestedPath: string): string {
  return resolve(tenantRoot, requestedPath);
}

export function readPublicAsset(publicRoot: string, requestedPath: string): string | null {
  const root = resolve(publicRoot);
  const candidate = resolve(root, requestedPath);
  return candidate.startsWith(`${root}${sep}`) ? candidate : null;
}
