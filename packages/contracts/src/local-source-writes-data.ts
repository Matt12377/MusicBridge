/** 新源写域的纯数据捕获；不改变 011/014 的冻结 canonical 或有效输入。 */
const isolatedSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const encoder = new TextEncoder();
const nonAscii = /[^\u0000-\u007f]/u;
/** ASCII 的 UTF-8 字节数等于单元数；其余仍使用原编码器，包括孤立代理的替换编码。 */
export const localSourceWritesUtf8Bytes = (value: string): number => typeof value === 'string' && !nonAscii.test(value) ? value.length : encoder.encode(value).byteLength;
const invalid = (): never => { throw new Error('源写请求的数据描述符、字符或预算无效。'); };

export function localSourceWritesRecord(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  try {
    if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
    const keys = Reflect.ownKeys(value);
    return keys.length <= 32 && required.every(key => keys.includes(key)) && keys.every(key => {
      if (typeof key !== 'string' || ![...required, ...optional].includes(key)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value');
    });
  } catch { return false; }
}

/** 每个原始属性只读取一次描述符；普通 Get、getter、toJSON 和迭代器都不参与捕获。 */
export function localSourceWritesDataSnapshot(value: unknown, maxBytes = 2 * 1024 * 1024, maxNodes = 50_000, maxArray = 100, maxKeys = 32): unknown {
  if (![maxBytes, maxNodes, maxArray, maxKeys].every(limit => Number.isSafeInteger(limit) && limit > 0)) return invalid();
  if (maxBytes > 2097152 || maxNodes > 65536 || maxArray > 2048 || maxKeys > 100) return invalid();
  let nodes = 0, bytes = 0;
  const active = new Set<object>();
  const add = (count: number): void => { bytes += count; if (bytes > maxBytes) invalid(); };
  const walk = (input: unknown, depth: number): unknown => {
    if (++nodes > maxNodes || depth > 12) invalid();
    if (input === null || typeof input === 'boolean') { add(input === null ? 4 : input ? 4 : 5); return input; }
    if (typeof input === 'string') {
      if (input.length > maxBytes || isolatedSurrogate.test(input)) invalid();
      add(localSourceWritesUtf8Bytes(JSON.stringify(input))); return input;
    }
    if (typeof input === 'number') {
      if (!Number.isSafeInteger(input) || Object.is(input, -0)) invalid();
      add(String(input).length); return input;
    }
    if (!input || typeof input !== 'object' || active.has(input)) return invalid();
    active.add(input);
    try {
      if (Array.isArray(input)) {
        if (Object.getPrototypeOf(input) !== Array.prototype) invalid();
        const lengthDescriptor = Object.getOwnPropertyDescriptor(input, 'length');
        const length: unknown = lengthDescriptor && Object.hasOwn(lengthDescriptor, 'value') ? lengthDescriptor.value : undefined;
        if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > maxArray) return invalid();
        const names = Reflect.ownKeys(input);
        if (names.length !== length + 1 || names.some(key => typeof key !== 'string' || key !== 'length' && !/^(0|[1-9][0-9]*)$/u.test(key))) invalid();
        add(2 + Math.max(0, length - 1));
        const result: unknown[] = [];
        for (let index = 0; index < length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
          if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return invalid();
          result.push(walk(descriptor.value, depth + 1));
        }
        return Object.freeze(result);
      }
      if (![Object.prototype, null].includes(Object.getPrototypeOf(input))) invalid();
      const names = Reflect.ownKeys(input);
      if (names.length > maxKeys) invalid();
      add(2 + Math.max(0, names.length - 1));
      const result = Object.create(null) as Record<string, unknown>;
      for (const name of names) {
        if (typeof name !== 'string' || name.length > maxBytes || isolatedSurrogate.test(name)) invalid();
        const descriptor = Object.getOwnPropertyDescriptor(input, name);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return invalid();
        add(localSourceWritesUtf8Bytes(JSON.stringify(name)) + 1);
        Object.defineProperty(result, name, { value: walk(descriptor.value, depth + 1), enumerable: true });
      }
      return Object.freeze(result);
    } finally { active.delete(input); }
  };
  try { return walk(value, 0); } catch { return invalid(); }
}

const codePointCompare = (a: string, b: string): number => {
  let leftIndex = 0, rightIndex = 0;
  while (leftIndex < a.length && rightIndex < b.length) {
    const left = a.codePointAt(leftIndex)!, right = b.codePointAt(rightIndex)!;
    if (left !== right) return left - right;
    leftIndex += left > 0xffff ? 2 : 1; rightIndex += right > 0xffff ? 2 : 1;
  }
  return leftIndex < a.length ? 1 : rightIndex < b.length ? -1 : 0;
};
/** 新域使用相同 UTF-8/码点序规则；不规范化文本，也不把 context 拼进原 planHash。 */
export function localSourceWritesCanonical(value: unknown, maxBytes = 2 * 1024 * 1024, maxNodes = 50_000, maxArray = 100, maxKeys = 32): string {
  const captured = localSourceWritesDataSnapshot(value, maxBytes, maxNodes, maxArray, maxKeys);
  const encode = (input: unknown): string => {
    if (input === null || typeof input !== 'object') return JSON.stringify(input);
    if (Array.isArray(input)) return `[${input.map(encode).join(',')}]`;
    return `{${Object.keys(input).sort(codePointCompare).map(key => `${JSON.stringify(key)}:${encode(Object.getOwnPropertyDescriptor(input, key)!.value)}`).join(',')}}`;
  };
  return encode(captured);
}
