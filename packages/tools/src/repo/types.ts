export type ResponseFormat = "concise" | "detailed";

export interface RepositoryFile {
  readonly path: string;
  readonly content: string;
  readonly size: number;
  readonly modifiedAt: string | null;
}

export interface SearchHit {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly text: string;
  readonly startByte: number;
  readonly endByte: number;
}

export interface ReadRepository {
  listTree(scope?: string): Promise<readonly string[]>;
  readFile(path: string): Promise<RepositoryFile>;
  search(query: string, scope?: string): Promise<readonly SearchHit[]>;
  stat(path: string): Promise<{ readonly size: number; readonly modifiedAt: string | null }>;
  gitStatus(): Promise<string>;
  gitDiff(base?: string, head?: string): Promise<string>;
  gitLog(limit?: number): Promise<string>;
  readManifest(path: string): Promise<RepositoryFile>;
}

export interface ReadArtifacts { read(ref: string): Promise<string>; }
