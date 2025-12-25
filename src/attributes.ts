export type Attributes = Record<string, string>;

function splitBorderAttributes(borderRaw: string): {
  style: string;
  width?: string;
  color?: string;
} {
  // Ported from Graph::Easy::Attributes::split_border_attributes.
  // Split "1px solid black" or "red dotted" into style, width and color.
  const border0 = borderRaw.trim();

  // special case
  if (border0 === "0") return { style: "none" };

  let border = border0;

  // extract style
  let style: string | undefined;
  border = border.replace(
    /(solid|dotted|dot-dot-dash|dot-dash|dashed|double-dash|double|bold-dash|bold|broad|wide|wave|none)/g,
    (m) => {
      style = m;
      return "";
    }
  );
  style ??= "solid";

  // extract width
  let widthToken: string | undefined;
  border = border.replace(/(\d+(px|em|%))/g, (m) => {
    widthToken = m;
    return "";
  });

  let width: string | undefined;
  if (widthToken) {
    const digits = widthToken.replace(/[^0-9]+/g, "");
    if (digits !== "") width = digits;
  }

  // rem unnec. spaces
  border = border.replace(/\s+/g, "");

  const color = border === "" ? undefined : border;

  return { style, width, color };
}

export function mergeAttributes(target: Attributes, incoming: Attributes): void {
  for (const [k, v] of Object.entries(incoming)) {
    // Graph::Easy's 'border' attribute is a shorthand for borderstyle/borderwidth/bordercolor.
    if (k === "border") {
      const { style, width, color } = splitBorderAttributes(v);
      target.borderstyle = style;
      if (width !== undefined) target.borderwidth = width;
      if (color !== undefined) target.bordercolor = color;
      continue;
    }

    if (k === "size") {
      // Ported from Graph::Easy::Node->set_attribute for size.
      const m = /^(\d+)\s*,\s*(\d+)\s*$/.exec(v.trim());
      if (!m) {
        throw new Error(`Invalid size attribute: '${v}'`);
      }

      const cx = Math.abs(Math.trunc(Number(m[1])));
      const cy = Math.abs(Math.trunc(Number(m[2])));
      target.columns = String(cx);
      target.rows = String(cy);
      continue;
    }

    target[k] = v;
  }
}

function cleanAttributeValue(value: string): string {
  // Ported from Graph::Easy::Attributes (value parsing):
  // - strip surrounding quotes
  // - reverse backslashed chars
  // - remove any %00-%1f, %7f and high-bit chars to avoid exploits and problems
  // - decode %XX entities for printable bytes (%2x..%7x, excluding %7f)

  let v = value.trim();

  // Strip outer quotes.
  v = v.replace(/^["'](.*)["']$/s, "$1");

  // Reverse backslashed chars.
  v = v.replace(/\\([#"';\\])/g, "$1");

  // Remove unsafe/corrupt percent-encoded bytes.
  v = v.replace(/%7f/gi, "");
  v = v.replace(/%[^2-7][a-fA-F0-9]/g, "");

  // Decode %XX entities for printable bytes.
  v = v.replace(/%([2-7][a-fA-F0-9])/g, (_m, hex: string) => {
    return String.fromCharCode(parseInt(hex, 16));
  });

  return v;
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
    const value = cleanAttributeValue(m[2]);
    attrs[key] = value;
  }

  return attrs;
}
