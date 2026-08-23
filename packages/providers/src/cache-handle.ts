export interface CacheHandle {
  readonly transport: string;
  readonly modelId: string;
  readonly cacheKey: string;
  readonly opaqueHandle?: string;
  readonly expiresAt?: number;
}

export interface CacheHandleStore {
  get(key: string): CacheHandle | null;
  set(key: string, handle: CacheHandle): void;
}

export class MemoryCacheHandleStore implements CacheHandleStore {
  private readonly handles = new Map<string, CacheHandle>();
  get(key: string): CacheHandle | null { return this.handles.get(key) ?? null; }
  set(key: string, handle: CacheHandle): void { this.handles.set(key, Object.freeze({ ...handle })); }
}
