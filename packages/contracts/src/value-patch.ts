export type ValuePatch = { path: string[]; value?: unknown; from?: string[] }[];

function isDeepStrictEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>, keys = Object.keys(left);
  return keys.length === Object.keys(right).length && (!Array.isArray(a) || a.length === (b as unknown[]).length) &&
    keys.every(key => Object.hasOwn(right, key) && isDeepStrictEqual(left[key], right[key]));
}

/** Exact within-receipt text references keep reordered submission fields out of the state ledger. */
function textReferences(value: unknown, path: string[] = [], result = new Map<string,string[]>()) {
  if (typeof value === "string" && value.length && !result.has(value)) result.set(value,path);
  else if (value && typeof value === "object")
    for (const [key,item] of Object.entries(value)) textReferences(item,[...path,key],result);
  return result;
}
export function difference(base: unknown, value: unknown, path: string[] = [], texts?: Map<string, string[]>): ValuePatch {
  if (isDeepStrictEqual(base,value)) return [];
  texts ??= textReferences(base);
  if (typeof value === "string" && texts.has(value)) return [{path,from:texts.get(value)!}];
  const sameContainer = !!base && !!value && typeof base === "object" && typeof value === "object" &&
    Array.isArray(base) === Array.isArray(value) && (!Array.isArray(base) || base.length === (value as unknown[]).length);
  if (!sameContainer) {
    if (value && typeof value === "object") return [{path,value:Array.isArray(value)?[]:{}},
      ...Object.entries(value).flatMap(([key,item])=>difference(undefined,item,[...path,key],texts))];
    return [{path,...(value!==undefined?{value}:{})}];
  }
  const a=base as Record<string,unknown>,b=value as Record<string,unknown>;
  return [...new Set([...Object.keys(a),...Object.keys(b)])].flatMap(key=>difference(a[key],b[key],[...path,key],texts));
}
export function restore(base: unknown, patch: ValuePatch): unknown {
  let value=structuredClone(base);
  for(const entry of patch) {
    let replacement=entry.value;
    if(entry.from) {
      if(Object.hasOwn(entry,"value")) throw new Error("恢复字段不能同时声明字面值和来源引用。");
      replacement=base;
      for(const key of entry.from) {
        if(!replacement || typeof replacement!=="object" || !Object.hasOwn(replacement,key))
          throw new Error("正式结果缺少恢复引用："+entry.from.join("/"));
        replacement=(replacement as Record<string,unknown>)[key];
      }
    }
    if(!entry.path.length) { value=structuredClone(replacement); continue; }
    let parent=value as Record<string,unknown>;
    for(const key of entry.path.slice(0,-1))parent=parent[key] as Record<string,unknown>;
    const key=entry.path.at(-1)!;
    if(entry.from || Object.hasOwn(entry,"value")) Object.defineProperty(parent,key,{value:structuredClone(replacement),writable:true,configurable:true,enumerable:true});
    else delete parent[key];
  }
  return value;
}
