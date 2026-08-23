import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

export interface ConfigSchema<T> { parse(value: unknown): T }
export interface StoredConfiguration<T> { readonly id: string; readonly name: string; readonly config: T }
export interface ConfigurationSummary { readonly id: string; readonly name: string }

export class ConfigStore<T> {
  readonly #directory: string;
  readonly #schema: ConfigSchema<T>;
  readonly #id: () => string;

  constructor(directory: string, schema: ConfigSchema<T>, id: () => string = randomUUID) {
    this.#directory = directory;
    this.#schema = schema;
    this.#id = id;
  }

  validate(value: unknown): T { return this.#schema.parse(assertNoResolvedCredentials(value)); }

  async list(): Promise<readonly ConfigurationSummary[]> {
    await mkdir(this.#directory, { recursive: true });
    const names = (await readdir(this.#directory)).filter((name) => name.endsWith(".json")).sort();
    const records = await Promise.all(names.map((name) => this.load(name.slice(0, -5))));
    return Object.freeze(records.map(({ id, name }) => Object.freeze({ id, name })));
  }

  async save(name: string, value: unknown, id = this.#id()): Promise<StoredConfiguration<T>> {
    validateId(id); if (name.trim() === "") throw new Error("CONFIGURATION_NAME_REQUIRED");
    const record = Object.freeze({ id, name, config: this.validate(value) });
    await mkdir(this.#directory, { recursive: true });
    const target = join(this.#directory, `${id}.json`); const temporary = join(this.#directory, `.${id}.${this.#id()}.tmp`);
    await writeFile(temporary, canonicalJson(record), { encoding: "utf8", flag: "wx" });
    await rename(temporary, target);
    return record;
  }

  async load(id: string): Promise<StoredConfiguration<T>> {
    validateId(id); const parsed = JSON.parse(await readFile(join(this.#directory, `${id}.json`), "utf8")) as { id: string; name: string; config: unknown };
    return Object.freeze({ id: parsed.id, name: parsed.name, config: this.validate(parsed.config) });
  }

  async update(id: string, name: string, value: unknown): Promise<StoredConfiguration<T>> { await this.load(id); return this.save(name, value, id); }
  async duplicate(id: string, name: string): Promise<StoredConfiguration<T>> { const source = await this.load(id); return this.save(name, source.config); }
  async export(id: string): Promise<string> { const record = await this.load(id); return canonicalJson(record.config); }
}

export function canonicalJson(value: unknown): string { return `${JSON.stringify(sort(value))}\n`; }

function sort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sort);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, sort(child)]));
}
function validateId(id: string): void { if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id)) throw new Error("INVALID_CONFIGURATION_ID"); }
function assertNoResolvedCredentials(value: unknown, path = "$"): unknown {
  if (Array.isArray(value)) { value.forEach((child, index) => assertNoResolvedCredentials(child, `${path}[${index}]`)); return value; }
  if (typeof value !== "object" || value === null) return value;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/(?:api[_-]?key|secret|password|credential|access[_-]?token)$/iu.test(key) && child !== null && child !== "") throw new Error(`RESOLVED_CREDENTIAL_FORBIDDEN:${path}.${key}`);
    if (/(?:env|environment)(?:var|variable|name)$/iu.test(key) && (typeof child !== "string" || !/^[A-Z_][A-Z0-9_]*$/u.test(child))) throw new Error(`INVALID_CREDENTIAL_ENVIRONMENT_REFERENCE:${path}.${key}`);
    assertNoResolvedCredentials(child, `${path}.${key}`);
  }
  return value;
}
