export interface Hotspot {
  readonly path: string;
  readonly churn: number;
  readonly authorSpread: number;
  readonly fixDensity: number;
  readonly lastChangedAt: string | null;
  readonly recencyRank: number;
  readonly score: number;
  readonly rank: number;
}

interface CommitRecord {
  readonly author: string;
  readonly timestamp: string;
  readonly subject: string;
  readonly paths: readonly string[];
}

/**
 * Parses one `git log` result. The expected format is one record per commit:
 * RS + hash US author US ISO timestamp US subject US newline-delimited paths.
 */
export function rankHotspots(gitLog: string): readonly Hotspot[] {
  const commits = parseGitLog(gitLog);
  const facts = new Map<string, {
    churn: number;
    authors: Set<string>;
    fixes: number;
    lastChangedAt: string | null;
  }>();

  for (const commit of commits) {
    const isFix = /\b(?:fix(?:e[ds])?|bug(?:fix)?|hotfix|revert)\b/i.test(commit.subject);
    for (const path of new Set(commit.paths)) {
      const current = facts.get(path) ?? {
        churn: 0,
        authors: new Set<string>(),
        fixes: 0,
        lastChangedAt: null,
      };
      current.churn += 1;
      current.authors.add(commit.author);
      if (isFix) current.fixes += 1;
      if (current.lastChangedAt === null || commit.timestamp > current.lastChangedAt) {
        current.lastChangedAt = commit.timestamp;
      }
      facts.set(path, current);
    }
  }

  const recencyOrder = [...facts.entries()]
    .sort((left, right) => compareNullableDate(right[1].lastChangedAt, left[1].lastChangedAt)
      || left[0].localeCompare(right[0]));
  const recencyRanks = new Map(recencyOrder.map(([path], index) => [path, index + 1]));
  const maximumChurn = Math.max(1, ...[...facts.values()].map(({ churn }) => churn));
  const maximumAuthors = Math.max(1, ...[...facts.values()].map(({ authors }) => authors.size));
  const maximumFixes = Math.max(1, ...[...facts.values()].map(({ fixes }) => fixes));
  const fileCount = Math.max(1, facts.size);

  const ranked = [...facts.entries()].map(([path, fact]) => {
    const recencyRank = recencyRanks.get(path) ?? fileCount;
    const recency = (fileCount - recencyRank + 1) / fileCount;
    const score = round(
      0.35 * fact.churn / maximumChurn
      + 0.2 * fact.authors.size / maximumAuthors
      + 0.3 * fact.fixes / maximumFixes
      + 0.15 * recency,
    );
    return {
      path,
      churn: fact.churn,
      authorSpread: fact.authors.size,
      fixDensity: round(fact.fixes / fact.churn),
      lastChangedAt: fact.lastChangedAt,
      recencyRank,
      score,
    };
  }).sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));

  return Object.freeze(ranked.map((hotspot, index) => Object.freeze({
    ...hotspot,
    rank: index + 1,
  })));
}

export function parseGitLog(gitLog: string): readonly CommitRecord[] {
  return Object.freeze(gitLog.split("\u001e").flatMap((record) => {
    const trimmed = record.trim();
    if (trimmed.length === 0) return [];
    const [hash, author, timestamp, subject, paths = ""] = trimmed.split("\u001f");
    if (!hash || !author || !timestamp || subject === undefined) {
      throw new Error("INVALID_GIT_LOG_RECORD");
    }
    return [{
      author,
      timestamp,
      subject,
      paths: Object.freeze(paths.split(/\r?\n/u).map((path) => path.trim()).filter(Boolean)),
    }];
  }));
}

function compareNullableDate(left: string | null, right: string | null): number {
  if (left === right) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  return left.localeCompare(right);
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
