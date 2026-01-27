import type { Attributes } from "./attributes.js";

import { CSS_COLOR_NAMES } from "./colors.js";

function normalizeColorToken(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, "");
}

function isHexColor(token: string): boolean {
  return /^#[0-9a-f]{3}([0-9a-f]{3})?$/.test(token);
}

function isNumericColorName(token: string): boolean {
  // Graph::Easy keeps 1..12 as named colors so that brewer schemes like accent3
  // can be used without triggering "unknown color" errors.
  if (!/^\d+$/.test(token)) return false;
  const n = Number(token);
  return Number.isFinite(n) && n >= 1 && n <= 12;
}

function isValidGraphEasyColorValue(raw: string): boolean {
  const token = normalizeColorToken(raw);
  if (token === "" || token === "inherit") return true;

  // Fast-path common structured forms.
  if (token.startsWith("#")) return isHexColor(token);
  if (token.startsWith("rgb(") || token.startsWith("hsv(") || token.startsWith("hsl(")) {
    // Graph::Easy supports these forms; we intentionally don't re-implement the
    // full numeric parsing rules for the ASCII harness at this time.
    return true;
  }

  // Allow scheme/value forms (e.g. "accent4/2"). We validate only the final
  // name token against the W3C/CSS keyword set or the numeric 1..12 palette.
  const slashIdx = token.indexOf("/");
  const name = slashIdx === -1 ? token : token.slice(slashIdx + 1);

  if (isNumericColorName(name)) return true;

  // Only validate plain identifier-like tokens. If the value is more complex,
  // we leave it to other parts of the pipeline (matching our current harness
  // needs and avoiding accidental over-rejection).
  if (/^[a-z][a-z0-9]*$/.test(name)) {
    return CSS_COLOR_NAMES.has(name);
  }

  return true;
}

export function validateGroupAttributes(attrs: Attributes): void {
  // Graph::Easy validates attribute values at parse time. For harness parity we
  // only need group color/background validation right now.
  const keys: Array<keyof Attributes> = ["color", "background", "fill", "bordercolor", "labelcolor"];

  for (const k of keys) {
    const raw = attrs[k];
    if (raw === undefined) continue;

    if (!isValidGraphEasyColorValue(raw)) {
      throw new Error(`Error in attribute: '${raw}' is not a valid ${String(k)} for a group`);
    }
  }
}
