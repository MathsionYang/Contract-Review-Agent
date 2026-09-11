import { isReactive, isReadonly, isRef, toRaw } from "vue";

// IPC 只接受结构化克隆数据，递归移除 Pinia/Vue 响应式代理后再跨进程传递。
export function toCloneable(value, seen = new WeakMap()) {
  if (isRef(value)) return toCloneable(value.value, seen);
  if (value === null || typeof value !== "object") return value;

  const raw = isReactive(value) || isReadonly(value) ? toRaw(value) : value;
  if (raw === null || typeof raw !== "object") return raw;
  if (raw instanceof Date) return new Date(raw.getTime());
  if (raw instanceof RegExp) return new RegExp(raw.source, raw.flags);
  if (seen.has(raw)) return seen.get(raw);

  if (Array.isArray(raw)) {
    const result = [];
    seen.set(raw, result);
    raw.forEach((item) => result.push(toCloneable(item, seen)));
    return result;
  }

  if (raw instanceof Map) {
    const result = new Map();
    seen.set(raw, result);
    raw.forEach((item, key) => result.set(toCloneable(key, seen), toCloneable(item, seen)));
    return result;
  }

  if (raw instanceof Set) {
    const result = new Set();
    seen.set(raw, result);
    raw.forEach((item) => result.add(toCloneable(item, seen)));
    return result;
  }

  const result = {};
  seen.set(raw, result);
  Object.keys(raw).forEach((key) => {
    result[key] = toCloneable(raw[key], seen);
  });
  return result;
}
