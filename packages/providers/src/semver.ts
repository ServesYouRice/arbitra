/** Plain major.minor.patch versions, as the supported CLIs report them. */
export function parseSemanticVersion(value: string): readonly [number, number, number] | null {
  const match = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/u.exec(value);
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function versionInRange(version: string, range: { readonly minimum: string; readonly below: string }): boolean {
  const actual = parseSemanticVersion(version); const minimum = parseSemanticVersion(range.minimum); const below = parseSemanticVersion(range.below);
  if (actual === null || minimum === null || below === null) return false;
  return compare(actual, minimum) >= 0 && compare(actual, below) < 0;
}

function compare(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  for (let index = 0; index < 3; index += 1) if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0);
  return 0;
}
