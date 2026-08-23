import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { isAbsolute, join, normalize, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface PrivateJsonStore<T> {
  save(key: string, value: T): Promise<void>;
  load(key: string): Promise<T | null>;
}

/** Stores non-exportable run data only below `.runs/<run>/private/continuation-state`. */
export class FilePrivateJsonStore<T> implements PrivateJsonStore<T> {
  readonly directory: string;
  constructor(runRoot: string) {
    const normalized = normalize(runRoot);
    if (!isAbsolute(normalized) || !normalized.split(sep).includes(".runs")) {
      throw new Error("PRIVATE_STORE_REQUIRES_DOT_RUNS_ROOT");
    }
    this.directory = join(normalized, "private", "continuation-state");
  }

  async save(key: string, value: T): Promise<void> {
    const path = this.path(key);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await restrict(this.directory, true);
    await writeFile(path, JSON.stringify(value), { encoding: "utf8", mode: 0o600, flag: "w" });
    await restrict(path, false);
  }

  async load(key: string): Promise<T | null> {
    try { return JSON.parse(await readFile(this.path(key), "utf8")) as T; }
    catch (error) {
      if (hasCode(error, "ENOENT")) return null;
      throw error;
    }
  }

  private path(key: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u.test(key)) throw new Error("INVALID_PRIVATE_STORE_KEY");
    return join(this.directory, `${key}.json`);
  }
}

async function restrict(path: string, directory: boolean): Promise<void> {
  if (process.platform !== "win32") {
    await chmod(path, directory ? 0o700 : 0o600);
    return;
  }
  const principal = userInfo().username;
  const permission = directory ? "(OI)(CI)F" : "F";
  await execFileAsync("icacls", [path, "/inheritance:r", "/grant:r", `${principal}:${permission}`], {
    windowsHide: true,
  });
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}
