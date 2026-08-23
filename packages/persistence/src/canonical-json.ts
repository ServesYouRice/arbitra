const objectPrototype = Object.prototype;

/** Serialises JSON data with stable key ordering and NFC-normalised text. */
export function canonicalJson(value: unknown): string {
  return serialize(value, "$", new WeakSet<object>());
}

function serialize(value: unknown, path: string, ancestors: WeakSet<object>): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError(`${path} contains a non-finite number`);
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value.normalize("NFC"));
    case "object":
      return serializeObject(value, path, ancestors);
    default:
      throw new TypeError(`${path} contains a value that JSON cannot represent`);
  }
}

function serializeObject(value: object, path: string, ancestors: WeakSet<object>): string {
  if (ancestors.has(value)) throw new TypeError(`${path} contains a circular reference`);
  ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) throw new TypeError(`${path}[${index}] is an array hole`);
        items.push(serialize(value[index], `${path}[${index}]`, ancestors));
      }
      return `[${items.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== objectPrototype && prototype !== null) {
      throw new TypeError(`${path} is not a plain JSON object`);
    }

    const enumerableSymbols = Object.getOwnPropertySymbols(value)
      .filter((symbol) => Object.prototype.propertyIsEnumerable.call(value, symbol));
    if (enumerableSymbols.length > 0) throw new TypeError(`${path} contains a symbol key`);

    const entries = Object.keys(value).map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        throw new TypeError(`${path}.${key} is an accessor property`);
      }
      return {
        key: key.normalize("NFC"),
        originalKey: key,
        value: descriptor.value as unknown,
      };
    });

    entries.sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
    for (let index = 1; index < entries.length; index += 1) {
      if (entries[index - 1]?.key === entries[index]?.key) {
        throw new TypeError(`${path} contains keys that collide after Unicode normalisation`);
      }
    }

    return `{${entries.map((entry) => {
      const childPath = `${path}.${entry.originalKey}`;
      return `${JSON.stringify(entry.key)}:${serialize(entry.value, childPath, ancestors)}`;
    }).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}
