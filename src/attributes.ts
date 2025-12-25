export type Attributes = Record<string, string>;

export function mergeAttributes(target: Attributes, incoming: Attributes): void {
  for (const [k, v] of Object.entries(incoming)) {
    target[k] = v;
  }
}

export function parseAttributesBlock(blockText: string): Attributes {
  const trimmed = blockText.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    throw new Error(`Expected an attribute block like "{ a: b; }", got: ${blockText}`);
  }

  const inner = trimmed.slice(1, -1).trim();
  const attrs: Attributes = Object.create(null);
  if (!inner) return attrs;

  for (const rawPart of inner.split(";")) {
    const part = rawPart.trim();
    if (!part) continue;

    const m = /^([^:=]+?)\s*[:=]\s*(.*?)\s*$/.exec(part);
    if (!m) {
      throw new Error(`Invalid attribute entry: ${part}`);
    }

    // Graph::Easy accepts attribute keys with dashes (e.g. "arrow-style") but
    // internally uses normalized names (e.g. "arrowstyle"). Normalize here so
    // the rest of the codebase can consistently call attribute("arrowstyle").
    const key = m[1].trim().toLowerCase().replace(/-/g, "");
    const value = m[2].trim();
    attrs[key] = value;
  }

  return attrs;
}
