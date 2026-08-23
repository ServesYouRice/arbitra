import { describe, expect, it } from "vitest";

import { canonicalJson } from "../src/canonical-json.js";

describe("canonicalJson", () => {
  it("sorts object keys recursively", () => {
    expect(canonicalJson({ z: 1, a: { y: true, b: null } }))
      .toBe('{"a":{"b":null,"y":true},"z":1}');
  });

  it("normalises keys and string values to Unicode NFC", () => {
    expect(canonicalJson({ "e\u0301": "A\u030A" })).toBe('{"é":"Å"}');
    expect(() => canonicalJson({ "e\u0301": 1, "é": 2 }))
      .toThrow(/collide after Unicode normalisation/u);
  });

  it("is independent of key insertion order for generated nested values", () => {
    const random = seededRandom(0x51a7e);
    for (let iteration = 0; iteration < 250; iteration += 1) {
      const value = generatedValue(random, 0);
      expect(canonicalJson(shuffleObjects(value, random))).toBe(canonicalJson(value));
    }
  });

  it.each([
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    1n,
    new Date(0),
    makeSparseArray(),
  ])("rejects non-JSON input %#", (value) => {
    expect(() => canonicalJson(value)).toThrow(TypeError);
  });

  it("rejects circular structures", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => canonicalJson(circular)).toThrow(/circular reference/u);
  });
});

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function makeSparseArray(): unknown[] {
  const value = new Array<unknown>(2);
  value[1] = 1;
  return value;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function generatedValue(random: () => number, depth: number): JsonValue {
  const kind = depth >= 3 ? Math.floor(random() * 4) : Math.floor(random() * 6);
  if (kind === 0) return null;
  if (kind === 1) return random() > 0.5;
  if (kind === 2) return Math.floor(random() * 20_000) - 10_000;
  if (kind === 3) return `text-${Math.floor(random() * 1000)}`;
  if (kind === 4) {
    return Array.from({ length: Math.floor(random() * 5) }, () => generatedValue(random, depth + 1));
  }

  const result: { [key: string]: JsonValue } = {};
  const keyCount = Math.floor(random() * 5);
  for (let index = 0; index < keyCount; index += 1) {
    result[`key-${index}-${Math.floor(random() * 1000)}`] = generatedValue(random, depth + 1);
  }
  return result;
}

function shuffleObjects(value: JsonValue, random: () => number): JsonValue {
  if (Array.isArray(value)) return value.map((item) => shuffleObjects(item, random));
  if (value === null || typeof value !== "object") return value;

  const entries = Object.entries(value);
  for (let index = entries.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    const current = entries[index];
    const replacement = entries[target];
    if (current !== undefined && replacement !== undefined) {
      entries[index] = replacement;
      entries[target] = current;
    }
  }
  return Object.fromEntries(entries.map(([key, item]) => [key, shuffleObjects(item, random)]));
}
