import type { Graph } from "./graph";
import type { Edge } from "./edge";
import type { Attributes } from "./attributes";
import { EdgeCell } from "./layout/edgeCell";
import { EdgeCellEmpty } from "./layout/edgeCellEmpty";
import { GroupCell } from "./layout/groupCell";
import { NodeCell } from "./layout/nodeCell";
import { Node } from "./node";
import {
  EDGE_CROSS,
  EDGE_E_N_S,
  EDGE_E_S_W,
  EDGE_END_E,
  EDGE_END_MASK,
  EDGE_END_N,
  EDGE_END_S,
  EDGE_END_W,
  EDGE_HOR,
  EDGE_LABEL_CELL,
  EDGE_LOOP_EAST,
  EDGE_LOOP_NORTH,
  EDGE_LOOP_SOUTH,
  EDGE_LOOP_WEST,
  EDGE_N_E,
  EDGE_N_E_W,
  EDGE_N_W,
  EDGE_N_W_S,
  EDGE_NO_M_MASK,
  EDGE_S_E,
  EDGE_S_E_W,
  EDGE_S_W,
  EDGE_S_W_N,
  EDGE_START_E,
  EDGE_START_MASK,
  EDGE_START_N,
  EDGE_START_S,
  EDGE_START_W,
  EDGE_TYPE_MASK,
  EDGE_VER,
  EDGE_W_N_S,
  EDGE_W_S_E,
} from "./layout/edgeCellTypes";

type AlignChar = "l" | "r" | "c";

type LabelLines = {
  lines: string[];
  aligns: AlignChar[];
};

type Cell = Node | EdgeCell | GroupCell | NodeCell | EdgeCellEmpty;

const SUB = 4;

const BASIC_COLOR_HEX: Record<string, string> = {
  black: "#000000",
  silver: "#c0c0c0",
  gray: "#808080",
  grey: "#808080",
  white: "#ffffff",
  maroon: "#800000",
  red: "#ff0000",
  purple: "#800080",
  fuchsia: "#ff00ff",
  green: "#008000",
  lime: "#00ff00",
  olive: "#808000",
  yellow: "#ffff00",
  navy: "#000080",
  blue: "#0000ff",
  teal: "#008080",
  aqua: "#00ffff",
  cyan: "#00ffff",
  orange: "#ffa500",
  transparent: "transparent",
};

const PALETTE12 = [
  "#a6cee3",
  "#1f78b4",
  "#b2df8a",
  "#33a02c",
  "#fb9a99",
  "#e31a1c",
  "#fdbf6f",
  "#ff7f00",
  "#cab2d6",
  "#6a3d9a",
  "#ffff99",
  "#b15928",
];

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeColorForHtml(raw: string): string {
  const v0 = raw.trim();
  if (!v0) return "";

  let v = v0.replace(/^w3c\//i, "").replace(/^x11\//i, "").toLowerCase();

  if (v.startsWith("#")) {
    const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(v);
    if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
    return v;
  }

  if (/^\d+$/.test(v)) {
    const idx = Number(v);
    if (Number.isFinite(idx) && idx >= 1 && idx <= PALETTE12.length) {
      return PALETTE12[idx - 1];
    }
  }

  const direct = BASIC_COLOR_HEX[v];
  if (direct) return direct;

  const toHex2 = (n: number): string => {
    const clamped = Math.max(0, Math.min(255, Math.trunc(n)));
    return clamped.toString(16).padStart(2, "0");
  };

  const rgbTokenToByte = (token: string): number => {
    const t = token.trim();
    if (t.endsWith("%")) {
      const p = Number(t.slice(0, -1));
      if (!Number.isFinite(p)) return 0;
      return Math.floor((p / 100) * 255);
    }

    const n = Number(t);
    if (!Number.isFinite(n)) return 0;
    if (t.includes(".")) return Math.floor(n * 255);
    return Math.floor(n);
  };

  const rgbFunc = /^rgb\(\s*([^,]+)\s*,\s*([^,]+)\s*,\s*([^)]+)\s*\)$/i.exec(v);
  if (rgbFunc) {
    const r = rgbTokenToByte(rgbFunc[1]);
    const g = rgbTokenToByte(rgbFunc[2]);
    const b = rgbTokenToByte(rgbFunc[3]);
    return `#${toHex2(r)}${toHex2(g)}${toHex2(b)}`;
  }

  return v0;
}

function borderAttributeAsHtml(styleRaw: string, widthRaw: string, colorRaw: string): string {
  let style = styleRaw.trim().toLowerCase();
  let width = widthRaw.trim();
  let color = colorRaw.trim();

  if (color && !color.startsWith("#")) color = normalizeColorForHtml(color);

  if (style === "" || style === "none") return style === "none" ? "none" : "";

  if (style.startsWith("double")) width = "";

  if (style === "broad") {
    width = "0.5em";
    style = "solid";
  } else if (style === "wide") {
    width = "1em";
    style = "solid";
  } else if (style === "bold") {
    width = "4px";
    style = "solid";
  } else if (style === "bold-dash") {
    width = "4px";
    style = "dashed";
  } else if (style === "double-dash") {
    style = "double";
  }

  if (/^\d+$/.test(width)) width = `${width}px`;

  if (width === "" && style !== "double") return "";

  return [style, width, color].filter((part) => part !== "").join(" ").trim();
}

function parseLabel(label: string, align: string): LabelLines {
  const al0 = align.trim().toLowerCase().slice(0, 1);
  const defaultAlign: AlignChar = al0 === "l" ? "l" : al0 === "r" ? "r" : "c";

  if (label === "") return { lines: [], aligns: [] };

  const lines: string[] = [];
  const aligns: AlignChar[] = [];
  let currentAlign: AlignChar = defaultAlign;
  let buf = "";

  const flush = (): void => {
    let part = buf;
    buf = "";
    part = part.replace(/\\\|/g, "|");
    part = part.replace(/\\\\/g, "\\");
    part = part.replace(/^\s+/, "").replace(/\s+$/, "");
    part = part.replace(/\s+/g, " ");
    lines.push(part);
    aligns.push(currentAlign);
  };

  const s = label.replace(/\r\n?/g, "\n");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\n") {
      flush();
      currentAlign = defaultAlign;
      continue;
    }
    if (ch === "\\" && i + 1 < s.length) {
      const next = s[i + 1];
      if (next === "n" || next === "l" || next === "r" || next === "c") {
        flush();
        currentAlign = next === "n" ? defaultAlign : (next as AlignChar);
        i += 1;
        continue;
      }
    }
    buf += ch;
  }

  flush();
  return { lines, aligns };
}

function labelToHtml(label: string, align: string): string {
  const { lines, aligns } = parseLabel(label, align);
  if (lines.length === 0) return "&nbsp;";

  const parts: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = escapeHtml(lines[i]);
    const al = aligns[i] ?? "c";
    if (al === "l") parts.push(`<span class="l">${line}</span>`);
    else if (al === "r") parts.push(`<span class="r">${line}</span>`);
    else parts.push(line);
  }
  return parts.join("<br>");
}

function graphLabel(graph: Graph): string {
  return graph.graphAttributes.label ?? graph.graphAttributes.title ?? "";
}

function expandEscapes(
  text: string,
  graph: Graph,
  owner: { node?: Node; edge?: Edge },
  includeLabel: boolean
): string {
  let out = text;

  if (owner.edge) {
    const edge = owner.edge;
    out = out.replace(/\\E/g, `${edge.from.id}->${edge.to.id}`);
    out = out.replace(/\\T/g, edge.from.id);
    out = out.replace(/\\H/g, edge.to.id);
    if (out.includes("\\N")) {
      out = out.replace(/\\N/g, edge.labelText());
    }
    if (includeLabel && out.includes("\\L")) {
      out = out.replace(/\\L/g, edge.labelText());
    }
  } else if (owner.node) {
    const node = owner.node;
    out = out.replace(/\\N/g, node.id);
    if (includeLabel && out.includes("\\L")) {
      out = out.replace(/\\L/g, node.labelText());
    }
  }

  if (out.includes("\\G")) {
    out = out.replace(/\\G/g, graphLabel(graph));
  }

  return out;
}

function resolveTitleForNode(graph: Graph, node: Node): string {
  let title = node.attribute("title");
  if (title === "") {
    const autotitle = node.attribute("autotitle").trim().toLowerCase();
    if (autotitle === "name") title = node.id;
    else if (autotitle === "label") title = node.labelText() || node.id;
    else if (autotitle === "link") title = node.attribute("link");
  }
  if (title === "") return "";
  return expandEscapes(title, graph, { node }, true);
}

function resolveTitleForEdge(graph: Graph, edge: Edge): string {
  let title = edge.attribute("title");
  if (title === "") {
    const autotitle = edge.attribute("autotitle").trim().toLowerCase();
    if (autotitle === "name") title = edge.labelText();
    else if (autotitle === "label") title = edge.labelText();
    else if (autotitle === "link") title = edge.attribute("link");
  }
  if (title === "") return "";
  return expandEscapes(title, graph, { edge }, true);
}

function resolveLinkForNode(node: Node): string {
  return node.attribute("link");
}

function resolveLinkForEdge(edge: Edge): string {
  return edge.attribute("link");
}

function textStyleFromAttributes(
  color: string,
  font: string,
  fontSizeRaw: string,
  textStyle: string
): string {
  let style = "";
  if (color) style += `color: ${color};`;
  if (font) style += ` font-family: ${font};`;
  if (fontSizeRaw) {
    const size = /^\d+(\.\d+)?$/.test(fontSizeRaw) ? `${fontSizeRaw}px` : fontSizeRaw;
    style += ` font-size: ${size};`;
  }

  const ts = textStyle.trim().toLowerCase();
  if (ts.includes("bold")) style += " font-weight: bold;";
  if (ts.includes("italic")) style += " font-style: italic;";
  const deco: string[] = [];
  if (ts.includes("none")) {
    deco.push("none");
  } else {
    if (ts.includes("underline")) deco.push("underline");
    if (ts.includes("overline")) deco.push("overline");
    if (ts.includes("line-through")) deco.push("line-through");
  }
  if (deco.length > 0) style += ` text-decoration: ${deco.join(" ")};`;

  return style.trim();
}

function normalizeClassToken(raw: string): string {
  return raw.trim().replace(/\./g, "_");
}

function classTokens(base: string, rawClass: string): string {
  const raw = rawClass.trim();
  if (!raw) return base;

  const tokens = raw
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((token) => normalizeClassToken(token));
  const expanded = tokens.map((t) => `${base}_${t}`);
  return [base, ...expanded].join(" ");
}

function tableClassName(graph: Graph): string {
  return graph.id ? `graph${graph.id}` : "graph";
}

const EDGE_END_NORTH =
  ' <td colspan=2 class="##class## eb" style="##bg####ec##">&nbsp;</td>\n' +
  ' <td colspan=2 class="##class## eb" style="##bg####ec##"><span class="su">^</span></td>\n';
const EDGE_END_SOUTH =
  ' <td colspan=2 class="##class## eb" style="##bg####ec##">&nbsp;</td>\n' +
  ' <td colspan=2 class="##class## eb" style="##bg####ec##"><span class="sv">v</span></td>\n';

const EDGE_EMPTY_ROW = ' <td colspan=4 class="##class## eb"></td>';

const EDGE_ARROW_WEST_UPPER =
  '<td rowspan=2 class="##class## eb" style="##ec####bg##"><span class="shl">&lt;</span></td>\n';
const EDGE_ARROW_WEST_LOWER = '<td rowspan=2 class="##class## eb">&nbsp;</td>\n';

const EDGE_ARROW_EAST_UPPER =
  '<td rowspan=2 class="##class## eb" style="##ec####bg##"><span class="sh">&gt;</span></td>\n';
const EDGE_ARROW_EAST_LOWER = '<td rowspan=2 class="##class## eb"></td>\n';

const EDGE_HTML: Record<number, string[]> = {
  [EDGE_S_E]: [
    ' <td colspan=2 rowspan=2 class="##class## eb"></td>\n' +
      ' <td colspan=2 rowspan=2 class="##class## eb" style="border-bottom: ##border##;">&nbsp;</td>',
    "",
    ' <td colspan=2 rowspan=2 class="##class## eb"></td>\n' +
      ' <td colspan=2 rowspan=2 class="##class## eb" style="border-left: ##border##;">&nbsp;</td>',
    "",
  ],

  [EDGE_S_E + EDGE_START_E + EDGE_END_S]: [
    ' <td colspan=2 rowspan=2 class="##class## eb"></td>\n' +
      ' <td rowspan=2 class="##class## eb" style="border-bottom: ##border##;">&nbsp;</td>\n' +
      ' <td rowspan=4 class="##class## el"></td>',
    "",
    ' <td colspan=2 class="##class## eb"></td>\n' +
      ' <td class="##class## eb" style="border-left: ##border##;">&nbsp;</td>',
    EDGE_END_SOUTH,
  ],

  [EDGE_S_E + EDGE_START_E]: [
    ' <td colspan=2 rowspan=2 class="##class## eb"></td>\n' +
      ' <td rowspan=2 class="##class## eb" style="border-bottom: ##border##;">&nbsp;</td>\n' +
      ' <td rowspan=4 class="##class## el"></td>',
    "",
    ' <td colspan=2 rowspan=2 class="##class## eb"></td>\n' +
      ' <td colspan=2 rowspan=2 class="##class## eb" style="border-left: ##border##;">&nbsp;</td>',
    "",
  ],

  [EDGE_S_E + EDGE_END_E]: [
    ' <td colspan=2 rowspan=2 class="##class## eb"></td>\n' +
      ' <td rowspan=2 class="##class## eb" style="border-bottom: ##border##;">&nbsp;</td>\n' +
      ' <td rowspan=4 class="##class##"##edgecolor##><span class="sa">&gt;</span></td>',
    "",
    ' <td colspan=2 rowspan=2 class="##class## eb"></td>\n' +
      ' <td rowspan=2 class="##class## eb" style="border-left: ##border##;">&nbsp;</td>',
    "",
  ],

  [EDGE_S_E + EDGE_START_S]: [
    ' <td colspan=2 rowspan=2 class="##class## eb"></td>\n' +
      ' <td colspan=2 rowspan=2 class="##class## eb" style="border-bottom: ##border##;">&nbsp;</td>',
    "",
    ' <td colspan=2 class="##class## eb"></td>\n' +
      ' <td colspan=2 class="##class## eb" style="border-left: ##border##;">&nbsp;</td>\n',
    EDGE_EMPTY_ROW,
  ],

  [EDGE_S_E + EDGE_START_S + EDGE_END_E]: [
    ' <td colspan=2 rowspan=2 class="##class## eb"></td>\n' +
      ' <td rowspan=2 class="##class## eb" style="border-bottom: ##border##;">&nbsp;</td>' +
      ' <td rowspan=4 class="##class##"##edgecolor##><span class="sa">&gt;</span></td>',
    "",
    ' <td colspan=2 rowspan=2 class="##class## eb"></td>\n' +
      ' <td class="##class## eb" style="border-left: ##border##;">&nbsp;</td>\n',
    ' <td class="##class## eb"></td>',
  ],

  [EDGE_S_E + EDGE_END_S]: [
    ' <td colspan=2 rowspan=2 class="##class## eb"></td>\n' +
      ' <td colspan=2 rowspan=2 class="##class## eb" style="border-bottom: ##border##;">&nbsp;</td>',
    "",
    ' <td colspan=2 class="##class## eb"></td>\n' +
      ' <td colspan=2 class="##class## eb" style="border-left: ##border##;">&nbsp;</td>\n',
    EDGE_END_SOUTH,
  ],

  [EDGE_S_E + EDGE_END_S + EDGE_END_E]: [
    ' <td colspan=2 rowspan=2 class="##class## eb"></td>\n' +
      ' <td rowspan=2 class="##class## eb" style="border-bottom: ##border##;">&nbsp;</td>\n' +
      ' <td rowspan=4 class="##class## ha"##edgecolor##><span class="sa">&gt;</span></td>',
    "",
    ' <td colspan=2 class="##class## eb"></td>\n' +
      ' <td class="##class## eb" style="border-left: ##border##;">&nbsp;</td>\n',
    ' <td colspan=3 class="##class## v"##edgecolor##>v</td>',
  ],

  [EDGE_S_W]: [
    ' <td colspan=2 rowspan=2 class="##class## eb" style="border-bottom: ##border##;">&nbsp;</td>\n' +
      ' <td colspan=2 rowspan=2 class="##class## eb"></td>',
    "",
    ' <td colspan=2 rowspan=2 class="##class## eb"></td>\n' +
      ' <td colspan=2 rowspan=2 class="##class## eb" style="border-left: ##border##;">&nbsp;</td>',
    "",
  ],

  [EDGE_S_W + EDGE_START_W]: [
    ' <td rowspan=2 class="##class## el"></td>\n' +
      ' <td rowspan=2 class="##class## eb" style="border-bottom: ##border##;">&nbsp;</td>\n' +
      ' <td colspan=2 rowspan=2 class="##class## eb"></td>',
    "",
    ' <td colspan=2 rowspan=2 class="##class## eb"></td>\n' +
      ' <td colspan=2 rowspan=2 class="##class## eb" style="border-left: ##border##;">&nbsp;</td>',
    "",
  ],

  [EDGE_S_W + EDGE_END_W]: [
    ' <td rowspan=2 class="##class## va"##edgecolor##><span class="shl">&lt;</span></td>\n' +
      ' <td rowspan=2 class="##class## eb" style="border-bottom: ##border##;">&nbsp;</td>\n' +
      ' <td colspan=2 rowspan=2 class="##class## eb"></td>',
    "",
    ' <td colspan=2 rowspan=2 class="##class## eb"></td>\n' +
      ' <td colspan=2 rowspan=2 class="##class## eb" style="border-left: ##border##;">&nbsp;</td>',
    "",
  ],

  [EDGE_S_W + EDGE_START_S]: [
    ' <td colspan=2 rowspan=2 class="##class## eb" style="border-bottom: ##border##;">&nbsp;</td>\n' +
      ' <td colspan=2 rowspan=2 class="##class## eb"></td>',
    "",
    ' <td colspan=2 class="##class## eb"></td>\n' +
      ' <td colspan=2 class="##class## eb" style="border-left: ##border##;">&nbsp;</td>',
    EDGE_EMPTY_ROW,
  ],

  [EDGE_S_W + EDGE_END_S]: [
    ' <td colspan=2 rowspan=2 class="##class## eb" style="border-bottom: ##border##;">&nbsp;</td>\n' +
      ' <td colspan=2 rowspan=2 class="##class## eb"></td>',
    "",
    ' <td colspan=2 class="##class## eb"></td>\n' +
      ' <td colspan=2 class="##class## eb" style="border-left: ##border##;">&nbsp;</td>',
    EDGE_END_SOUTH,
  ],

  [EDGE_S_W + EDGE_START_W + EDGE_END_S]: [
    ' <td rowspan=2 class="##class## el"></td>\n' +
      ' <td rowspan=2 class="##class## eb" style="border-bottom: ##border##;">&nbsp;</td>\n' +
      ' <td colspan=2 rowspan=2 class="##class## eb"></td>',
    "",
    ' <td colspan=2 class="##class## eb"></td>\n' +
      ' <td colspan=2 class="##class## eb" style="border-left: ##border##;">&nbsp;</td>',
    EDGE_END_SOUTH,
  ],

  [EDGE_S_W + EDGE_START_S + EDGE_END_W]: [
    ' <td rowspan=3 class="##class## sh"##edgecolor##>&lt;</td>\n' +
      ' <td rowspan=2 class="##class## eb" style="border-bottom: ##border##;">&nbsp;</td>\n' +
      ' <td colspan=2 rowspan=2 class="##class## eb"></td>',
    "",
    ' <td class="##class## eb"></td>\n' +
      ' <td colspan=2 class="##class## eb" style="border-left: ##border##;">&nbsp;</td>',
    EDGE_EMPTY_ROW,
  ],

  [EDGE_N_W]: [
    ' <td colspan=2 rowspan=2 class="##class## eb" style="border-bottom: ##border##;">&nbsp;</td>\n' +
      ' <td colspan=2 rowspan=2 class="##class## eb" style="border-left: ##border##;">&nbsp;</td>',
    "",
    ' <td colspan=4 rowspan=2 class="##class## eb"></td>',
    "",
  ],

  [EDGE_N_W + EDGE_START_N]: [
    EDGE_EMPTY_ROW,
    ' <td colspan=2 class="##class## eb" style="border-bottom: ##border##;">&nbsp;</td>\n' +
      ' <td colspan=2 class="##class## eb" style="border-left: ##border##;">&nbsp;</td>',
    "",
    ' <td colspan=4 rowspan=2 class="##class## eb"></td>',
  ],

  [EDGE_N_W + EDGE_END_N]: [
    EDGE_END_NORTH,
    ' <td colspan=2 class="##class## eb" style="border-bottom: ##border##;">&nbsp;</td>\n' +
      ' <td colspan=2 class="##class## eb" style="border-left: ##border##;">&nbsp;</td>',
    ' <td colspan=4 rowspan=2 class="##class## eb"></td>',
    "",
  ],

  [EDGE_N_W + EDGE_END_N + EDGE_START_W]: [
    EDGE_END_NORTH,
    ' <td rowspan=3 class="##class## eb"></td>' +
      ' <td class="##class## eb" style="border-bottom: ##border##;">&nbsp;</td>\n' +
      ' <td colspan=2 class="##class## eb" style="border-left: ##border##;">&nbsp;</td>',
    ' <td colspan=4 rowspan=2 class="##class## eb"></td>',
    "",
  ],

  [EDGE_N_W + EDGE_START_W]: [
    ' <td rowspan=2 class="##class## el"></td>\n' +
      ' <td rowspan=2 class="##class## eb" style="border-bottom: ##border##;">&nbsp;</td>\n' +
      ' <td colspan=2 rowspan=2 class="##class## eb" style="border-left: ##border##;">&nbsp;</td>\n',
    "",
    ' <td colspan=4 rowspan=2 class="##class## eb"></td>',
    "",
  ],

  [EDGE_N_W + EDGE_END_W]: [
    ' <td rowspan=4 class="##class## sh"##edgecolor##>&lt;</td>\n' +
      ' <td rowspan=2 class="##class## eb" style="border-bottom: ##border##;">&nbsp;</td>\n' +
      ' <td colspan=2 rowspan=2 class="##class## eb" style="border-left: ##border##;">&nbsp;</td>\n',
    "",
    ' <td colspan=3 rowspan=2 class="##class## eb"></td>',
    "",
  ],

  [EDGE_N_E]: [
    ' <td colspan=2 rowspan=2 class="##class## eb"></td>\n' +
      ' <td colspan=2 rowspan=2 class="##class## eb" style="border-bottom: ##border##; border-left: ##border##;">&nbsp;</td>',
    "",
    ' <td colspan=4 rowspan=2 class="##class## eb"></td>',
    "",
  ],

  [EDGE_N_E + EDGE_START_E]: [
    ' <td colspan=2 rowspan=2 class="##class## eb"></td>\n' +
      ' <td rowspan=2 class="##class## eb" style="border-bottom: ##border##; border-left: ##border##;">&nbsp;</td>\n' +
      ' <td rowspan=4 class="##class## el"></td>',
    "",
    ' <td colspan=3 rowspan=2 class="##class## eb"></td>',
    "",
  ],

  [EDGE_N_E + EDGE_END_E]: [
    ' <td colspan=2 rowspan=2 class="##class## eb"></td>\n' +
      ' <td rowspan=2 class="##class## eb" style="border-bottom: ##border##; border-left: ##border##;">&nbsp;</td>\n' +
      ' <td rowspan=4 class="##class## va"##edgecolor##><span class="sa">&gt;</span></td>',
    "",
    ' <td colspan=3 rowspan=2 class="##class## eb"></td>',
    "",
  ],

  [EDGE_N_E + EDGE_END_E + EDGE_START_N]: [
    EDGE_EMPTY_ROW,
    ' <td colspan=2 class="##class## eb"></td>\n' +
      ' <td class="##class## eb" style="border-bottom: ##border##; border-left: ##border##;">&nbsp;</td>\n' +
      ' <td rowspan=3 class="##class## va"##edgecolor##><span class="sa">&gt;</span></td>',
    ' <td colspan=3 rowspan=2 class="##class## eb"></td>',
    "",
  ],

  [EDGE_N_E + EDGE_START_E + EDGE_END_N]: [
    EDGE_END_NORTH,
    ' <td colspan=2 class="##class## eb"></td>\n' +
      ' <td class="##class## eb" style="border-bottom: ##border##; border-left: ##border##;">&nbsp;</td>\n' +
      ' <td rowspan=3 class="##class## eb">&nbsp;</td>',
    ' <td colspan=3 rowspan=2 class="##class## eb"></td>',
    "",
  ],

  [EDGE_N_E + EDGE_START_N]: [
    EDGE_EMPTY_ROW,
    ' <td colspan=2 rowspan=3 class="##class## eb"></td>\n' +
      ' <td colspan=2 class="##class## eb" style="border-bottom: ##border##; border-left: ##border##;">&nbsp;</td>',
    ' <td colspan=2 class="##class## eb"></td>',
    "",
  ],

  [EDGE_N_E + EDGE_END_N]: [
    EDGE_END_NORTH,
    ' <td colspan=2 rowspan=3 class="##class## eb"></td>\n' +
      ' <td colspan=2 class="##class## eb" style="border-bottom: ##border##; border-left: ##border##;">&nbsp;</td>',
    "",
    ' <td colspan=2 class="##class## eb"></td>',
  ],

  [EDGE_LOOP_NORTH - EDGE_LABEL_CELL]: [
    '<td rowspan=2 class="##class## eb">&nbsp;</td>\n' +
      ' <td colspan=2 rowspan=2 class="##class## lh" style="border-bottom: ##border##;##lc####bg##">##label##</td>\n' +
      ' <td rowspan=2 class="##class## eb">&nbsp;</td>',
    "",
    '<td class="##class## eb">&nbsp;</td>\n' +
      ' <td colspan=2 class="##class## eb" style="border-left: ##border##;##bg##">&nbsp;</td>\n' +
      ' <td class="##class## eb" style="border-left: ##border##;##bg##">&nbsp;</td>',
    '<td colspan=2 class="##class## v" style="##bg##"##edgecolor##>v</td>\n' +
      ' <td colspan=2 class="##class## eb">&nbsp;</td>',
  ],

  [EDGE_LOOP_SOUTH - EDGE_LABEL_CELL]: [
    '<td colspan=2 class="##class## v" style="##bg##"##edgecolor##>^</td>\n' +
      ' <td colspan=2 class="##class## eb">&nbsp;</td>',
    '<td rowspan=2 class="##class## eb">&nbsp;</td>\n' +
      ' <td colspan=2 rowspan=2 class="##class## lh" style="border-left:##border##;border-bottom:##border##;##lc####bg##">##label##</td>\n' +
      ' <td rowspan=2 class="##class## eb" style="border-left:##border##;##bg##">&nbsp;</td>',
    "",
    '<td colspan=4 class="##class## eb">&nbsp;</td>',
  ],

  [EDGE_LOOP_WEST - EDGE_LABEL_CELL]: [
    EDGE_EMPTY_ROW +
      ' <td colspan=2 rowspan=2 class="##class## lh" style="border-bottom: ##border##;##lc####bg##">##label##</td>\n' +
      ' <td rowspan=2 class="##class## eb">&nbsp;</td>',
    "",
    '<td colspan=2 class="##class## eb" style="border-left: ##border##; border-bottom: ##border##;##bg##">&nbsp;</td>\n' +
      ' <td rowspan=2 class="##class## va" style="##bg##"##edgecolor##><span class="sa">&gt;</span></td>',
    '<td colspan=2 class="##class## eb">&nbsp;</td>',
  ],

  [EDGE_LOOP_EAST - EDGE_LABEL_CELL]: [
    '<td rowspan=2 class="##class## eb">&nbsp;</td>\n' +
      ' <td colspan=2 rowspan=2 class="##class## lh" style="border-bottom: ##border##;##lc####bg##">##label##</td>\n' +
      ' <td rowspan=2 class="##class## eb">&nbsp;</td>',
    "",
    '<td rowspan=2 class="##class## va" style="##bg##"##edgecolor##><span class="sh">&lt;</span></td>\n' +
      ' <td colspan=2 class="##class## eb" style="border-bottom: ##border##;##bg##">&nbsp;</td>\n' +
      ' <td class="##class## eb" style="border-left: ##border##;##bg##">&nbsp;</td>',
    '<td colspan=3 class="##class## eb">&nbsp;</td>',
  ],

  [EDGE_E_N_S]: [
    '<td colspan=2 rowspan=2 class="##class## eb">&nbsp;</td>\n' +
      ' <td colspan=2 rowspan=2 class="##class## eb" style="border-left:##borderv##;border-bottom:##border##;##bg##">&nbsp;</td>',
    "",
    '<td colspan=2 rowspan=2 class="##class## eb">&nbsp;</td>\n' +
      ' <td colspan=2 rowspan=2 class="##class## eb" style="border-left: ##borderv##;##bg##">&nbsp;</td>',
    "",
  ],

  [EDGE_E_N_S + EDGE_END_E]: [
    '<td colspan=2 rowspan=2 class="##class## eb">&nbsp;</td>\n' +
      ' <td rowspan=2 class="##class## eb" style="border-left: ##borderv##; border-bottom: ##border##;##bg##">&nbsp;</td>\n' +
      ' <td rowspan=4 class="##class## va"##edgecolor##><span class="sa">&gt;</span></td>',
    "",
    '<td colspan=2 rowspan=2 class="##class## eb">&nbsp;</td>\n' +
      ' <td rowspan=2 class="##class## eb" style="border-left: ##borderv##;##bg##">&nbsp;</td>',
    "",
  ],

  [EDGE_W_N_S]: [
    '<td colspan=2 rowspan=2 class="##class## eb" style="border-bottom: ##border##;##bg##">&nbsp;</td>\n' +
      ' <td colspan=2 rowspan=4 class="##class## eb" style="border-left: ##borderv##;##bg##">&nbsp;</td>',
    "",
    '<td colspan=2 rowspan=2 class="##class## eb">&nbsp;</td>',
    "",
  ],

  [EDGE_S_E_W]: [
    '<td colspan=4 rowspan=2 class="##class## eb" style="border-bottom: ##border##;##bg##">&nbsp;</td>',
    "",
    '<td colspan=2 rowspan=2 class="##class## eb">&nbsp;</td>\n' +
      ' <td colspan=2 rowspan=2 class="##class## eb" style="border-left: ##borderv##;##bg##">&nbsp;</td>',
    "",
  ],

  [EDGE_S_E_W + EDGE_END_S]: [
    '<td colspan=4 rowspan=2 class="##class## eb" style="border-bottom: ##border##;##bg##">&nbsp;</td>',
    "",
    '<td colspan=2 class="##class## eb">&nbsp;</td>\n' +
      ' <td colspan=2 class="##class## eb" style="border-left: ##borderv##;##bg##">&nbsp;</td>',
    EDGE_END_SOUTH,
  ],

  [EDGE_S_E_W + EDGE_START_S]: [
    '<td colspan=4 rowspan=2 class="##class## eb" style="border-bottom: ##border##;##bg##">&nbsp;</td>',
    "",
    '<td colspan=2 class="##class## eb">&nbsp;</td>\n' +
      ' <td colspan=2 class="##class## eb" style="border-left: ##borderv##;##bg##">&nbsp;</td>',
    ' <td colspan=4 class="##class## eb"></td>',
  ],

  [EDGE_S_E_W + EDGE_START_W]: [
    '<td rowspan=4 class="##class## el"></td>\n' +
      '<td colspan=3 rowspan=2 class="##class## eb" style="border-bottom: ##border##;##bg##">&nbsp;</td>',
    "",
    '<td rowspan=2 class="##class## eb">&nbsp;</td>\n' +
      ' <td rowspan=2 class="##class## eb" style="border-left: ##borderv##;##bg##">&nbsp;</td>',
    "",
  ],

  [EDGE_S_E_W + EDGE_END_E]: [
    '<td colspan=3 rowspan=2 class="##class## eb" style="border-bottom: ##border##;##bg##">&nbsp;</td>\n' +
      ' <td rowspan=4 class="##class## va"##edgecolor##><span class="sa">&gt;</span></td>',
    "",
    '<td colspan=2 rowspan=2 class="##class## eb">&nbsp;</td>\n' +
      ' <td rowspan=2 class="##class## eb" style="border-left: ##borderv##;##bg##">&nbsp;</td>',
    "",
  ],

  [EDGE_S_E_W + EDGE_END_W]: [
    EDGE_ARROW_WEST_UPPER +
      '<td colspan=3 rowspan=2 class="##class## eb" style="border-bottom: ##border##;##bg##">&nbsp;</td>\n',
    "",
    '<td colspan=2 rowspan=2 class="##class## eb">&nbsp;</td>\n' +
      '<td colspan=2 rowspan=2 class="##class## eb" style="border-left: ##borderv##;##bg##">&nbsp;</td>',
  ],

  [EDGE_N_E_W]: [
    ' <td colspan=2 rowspan=2 class="##class## eb" style="border-bottom: ##borderv##;##bg##">&nbsp;</td>\n' +
      '<td colspan=2 rowspan=2 class="##class## eb" style="border-left: ##borderv##; border-bottom: ##border##;##bg##">&nbsp;</td>',
    "",
    '<td colspan=4 rowspan=2 class="##class## eb">&nbsp;</td>',
    "",
  ],

  [EDGE_N_E_W + EDGE_END_N]: [
    EDGE_END_NORTH,
    ' <td colspan=2 class="##class## eb" style="border-bottom: ##borderv##;##bg##">&nbsp;</td>\n' +
      '<td colspan=2 class="##class## eb" style="border-left: ##borderv##; border-bottom: ##border##;##bg##">&nbsp;</td>',
    "",
    '<td colspan=4 rowspan=2 class="##class## eb">&nbsp;</td>',
    "",
  ],

  [EDGE_N_E_W + EDGE_START_N]: [
    EDGE_EMPTY_ROW,
    ' <td colspan=2 class="##class## eb" style="border-bottom: ##borderv##;##bg##">&nbsp;</td>\n' +
      '<td colspan=2 class="##class## eb" style="border-left: ##borderv##; border-bottom: ##border##;##bg##">&nbsp;</td>',
    "",
    '<td colspan=4 rowspan=2 class="##class## eb">&nbsp;</td>',
    "",
  ],
};

function htmlEdgeHor(cell: EdgeCell, arrowStyle: string): string[] {
  let sFlags = cell.type & EDGE_START_MASK;
  let eFlags = cell.type & EDGE_END_MASK;

  if (arrowStyle === "none") eFlags = 0;

  const rc = [
    ' <td colspan=##mod## rowspan=2 class="##class## lh" style="border-bottom: ##border##;##lc####bg##">##label##</td>',
    "",
    '<td colspan=##mod## rowspan=2 class="##class## eb">&nbsp;</td>',
    "",
  ];

  let mod = 4;
  if (sFlags & EDGE_START_W) {
    mod -= 1;
    rc[0] = '<td rowspan=4 class="##class## el"></td>\n' + rc[0];
  }
  if (sFlags & EDGE_START_E) {
    mod -= 1;
    rc[0] += "\n " + '<td rowspan=4 class="##class## el"></td>';
  }
  if (eFlags & EDGE_END_W) {
    mod -= 1;
    rc[0] = EDGE_ARROW_WEST_UPPER + rc[0];
    rc[2] = EDGE_ARROW_WEST_LOWER + rc[2];
  }
  if (eFlags & EDGE_END_E) {
    mod -= 1;
    rc[0] += "\n " + EDGE_ARROW_EAST_UPPER;
    rc[2] += "\n " + EDGE_ARROW_EAST_LOWER;
  }

  const span = (cell.cx ?? 1) * 4 - 4 + mod;
  return rc.map((line) => line.replace(/##mod##/g, String(span)));
}

function htmlEdgeVer(cell: EdgeCell, arrowStyle: string): string[] {
  let sFlags = cell.type & EDGE_START_MASK;
  let eFlags = cell.type & EDGE_END_MASK;

  if (arrowStyle === "none") eFlags = 0;

  let mod = 4;

  const rc: string[] = [
    '<td colspan=2 rowspan=##mod## class="##class## el">&nbsp;</td>\n ' +
      '<td colspan=2 rowspan=##mod## class="##class## lv" style="border-left: ##border##;##lc####bg##">##label##</td>\n',
    "",
    "",
    "",
    "",
  ];

  if (sFlags & EDGE_START_N) {
    mod -= 1;
    rc.unshift('<td colspan=4 class="##class## eb"></td>\n');
    rc.pop();
  } else if (eFlags & EDGE_END_N) {
    mod -= 1;
    rc.unshift(EDGE_END_NORTH);
    rc.pop();
  }

  if (sFlags & EDGE_START_S) {
    mod -= 1;
    rc[3] = '<td colspan=4 class="##class## eb"></td>\n';
  }

  if (eFlags & EDGE_END_S) {
    mod -= 1;
    rc[3] = EDGE_END_SOUTH;
  }

  const span = (cell.cy ?? 1) * 4 - 4 + mod;
  return rc.map((line) => line.replace(/##mod##/g, String(span)));
}

function htmlEdgeCross(): string[] {
  return [
    ' <td colspan=2 rowspan=2 class="##class## eb el" style="border-bottom: ##border##">&nbsp;</td>\n' +
      ' <td colspan=2 rowspan=2 class="##class## eb el" style="border-left: ##borderv##; border-bottom: ##border##">&nbsp;</td>\n',
    "",
    ' <td colspan=2 rowspan=2 class="##class## eb el"></td>\n' +
      ' <td colspan=2 rowspan=2 class="##class## eb el" style="border-left: ##borderv##">&nbsp;</td>\n',
    "",
  ];
}

function formatEdgeTd(
  template: string,
  className: string,
  border: string,
  borderV: string,
  labelStyle: string,
  edgeColor: string,
  bg: string,
  arrowStyle: string,
  titleAttr: string,
  label: string
): string {
  if (!template) return "";

  let out = template;

  out = out.replace(/( e[bl]")(>(?:&nbsp;)?<\/td>)/g, `$1 style="##bg##"$2`);
  out = out.replace(/style="border/g, 'style="##bg##border');

  out = out.replace(/##class##/g, className);
  out = out.replace(/##border##/g, border);
  out = out.replace(/##borderv##/g, borderV);
  out = out.replace(/##lc##/g, labelStyle);
  out = out.replace(/##edgecolor##/g, edgeColor ? ` style="${edgeColor}"` : "");
  out = out.replace(/##ec##/g, edgeColor);
  out = out.replace(/##bg##/g, bg);
  out = out.replace(/ style=""/g, "");

  if (arrowStyle === "none") {
    out = out.replace(/>(v|\^|&lt;|&gt;)/g, "> ");
    out = out.replace(/>\s+</g, "><");
  }

  out = out.replace(/>##label##/, `${titleAttr}>${label}`);

  if (!out.endsWith("\n")) out += "\n";
  return out;
}

function edgeHtml(graph: Graph, cell: EdgeCell): string[] {
  const edge = cell.edge;
  const styleRaw = edge.attribute("style").trim().toLowerCase();

  const arrowStyle = edge.undirected
    ? "none"
    : edge.attribute("arrowstyle").trim().toLowerCase() || "open";

  const baseType = cell.type & EDGE_TYPE_MASK;
  const type = cell.type & EDGE_NO_M_MASK;

  let code = EDGE_HTML[type];

  if (!code) {
    if (styleRaw !== "invisible") {
      if (baseType === EDGE_HOR) code = htmlEdgeHor(cell, arrowStyle);
      else if (baseType === EDGE_VER) code = htmlEdgeVer(cell, arrowStyle);
      else if (baseType === EDGE_CROSS) code = htmlEdgeCross();
    } else {
      code = [' <td colspan=4 rowspan=4 class="##class##">&nbsp;</td>'];
    }

    if (!code) {
      code = [' <td colspan=4 rowspan=4 class="##class##">???</td>'];
    }
  }

  let color = edge.attribute("color").trim();
  if (color === "") color = "#000000";
  color = normalizeColorForHtml(color);

  let border = borderAttributeAsHtml(styleRaw || "solid", "2", color);
  let borderV = border;

  if (baseType === EDGE_CROSS) {
    const verEdge = cell.crossVerEdge ?? edge;
    let verColor = verEdge.attribute("color").trim();
    if (verColor === "") verColor = "#000000";
    verColor = normalizeColorForHtml(verColor);
    const verStyle = verEdge.attribute("style").trim().toLowerCase() || "solid";
    borderV = borderAttributeAsHtml(verStyle, "2", verColor);
  }

  let label = "";
  let labelStyle = "";

  if (styleRaw !== "invisible" && (cell.type & EDGE_LABEL_CELL)) {
    const labelRaw = expandEscapes(edge.labelText(), graph, { edge }, false);
    label = labelToHtml(labelRaw, edge.attribute("align") || "center");

    const rawLabelColor = edge.rawAttribute("labelcolor")?.trim() ?? "";
    let labelColor = rawLabelColor || color;
    labelColor = normalizeColorForHtml(labelColor);

    if (labelColor && labelColor.toLowerCase() !== "#000000") {
      labelStyle += `color: ${labelColor};`;
    }

    const font = edge.attribute("font").trim();
    if (font) labelStyle += ` font-family: ${font};`;

    const fontSizeRaw = edge.attribute("fontsize").trim();
    if (fontSizeRaw) {
      const size = /^\d+(\.\d+)?$/.test(fontSizeRaw) ? `${fontSizeRaw}px` : fontSizeRaw;
      labelStyle += ` font-size: ${size};`;
    }

    const extra = textStyleFromAttributes("", "", "", edge.attribute("textstyle"));
    if (extra) labelStyle += ` ${extra}`;

    labelStyle = labelStyle.trim();
    if (labelStyle && !labelStyle.endsWith(";")) labelStyle += ";";

    const link = resolveLinkForEdge(edge);
    if (link) {
      const linkEscaped = link.replace(/\s/g, "+").replace(/'/g, "%27");
      const styleAttr = labelStyle ? ` style='${labelStyle}'` : "";
      label = `<a href='${escapeHtml(linkEscaped)}'${styleAttr}>${label}</a>`;
      labelStyle = "";
    }
  }

  if (label === "") label = "&nbsp;";

  const title = resolveTitleForEdge(graph, edge);
  const titleAttr = title ? ` title=\"${escapeHtml(title)}\"` : "";

  let bg = edge.attribute("background").trim();
  if (bg === "inherit") bg = "";
  if (!bg && edge.group) {
    const groupFill = edge.group.attribute("fill").trim();
    if (groupFill && groupFill !== "inherit") bg = groupFill;
  }
  if (bg && bg !== "inherit") bg = normalizeColorForHtml(bg);
  const bgStyle = bg ? ` background: ${bg};` : "";

  const edgeColor = color ? `color: ${color};` : "";

  const edgeClass = classTokens("edge", edge.attribute("class"));
  const groupClass = edge.group ? classTokens("group", edge.group.attribute("class")) : "";
  const className = groupClass ? `${groupClass} ${edgeClass}` : edgeClass;

  return code.map((line) =>
    formatEdgeTd(line, className, border, borderV, labelStyle, edgeColor, bgStyle, arrowStyle, titleAttr, label)
  );
}

function nodeCellTd(graph: Graph, node: Node): string {
  const cx = (node.cx ?? 1) * SUB;
  const cy = (node.cy ?? 1) * SUB;

  const shape = node.attribute("shape").trim().toLowerCase();
  const align = node.attribute("align") || "center";
  const labelRaw = expandEscapes(node.labelText(), graph, { node }, false);
  const label = labelToHtml(labelRaw, align);
  const title = resolveTitleForNode(graph, node);
  const titleAttr = title ? ` title=\"${escapeHtml(title)}\"` : "";

  let fill = node.attribute("fill").trim() || "white";
  fill = normalizeColorForHtml(fill);

  let borderColor = node.attribute("bordercolor").trim() || "black";
  borderColor = normalizeColorForHtml(borderColor);

  const borderStyle = node.attribute("borderstyle").trim() || "solid";
  const borderWidthRaw = node.attribute("borderwidth").trim() || "1";
  const border = borderAttributeAsHtml(borderStyle, borderWidthRaw, borderColor);

  const textColorRaw = node.rawAttribute("color")?.trim() || "";
  const textColor = textColorRaw ? normalizeColorForHtml(textColorRaw) : "";
  const font = node.attribute("font").trim();
  const fontSizeRaw = node.attribute("fontsize").trim();
  const textStyle = node.attribute("textstyle");

  let style = `background: ${fill};`;
  if (textColor) style += ` color: ${textColor};`;
  if (shape !== "none" && shape !== "point" && shape !== "invisible") {
    if (border) style += ` border: ${border};`;
  } else {
    style += " border: none;";
  }

  if (shape === "invisible") {
    style = "border: none; background: inherit;";
  }

  const labelStyle = textStyleFromAttributes(textColor, font, fontSizeRaw, textStyle);

  let content = label;
  const link = resolveLinkForNode(node);
  if (link) {
    const linkEscaped = link.replace(/\s/g, "+").replace(/'/g, "%27");
    const aStyle = labelStyle ? ` style=\"${labelStyle}\"` : "";
    content = `<a href=\"${escapeHtml(linkEscaped)}\"${aStyle}>${label}</a>`;
  } else if (labelStyle) {
    style += ` ${labelStyle}`;
  }

  const className = classTokens("node", node.attribute("class"));
  return `<td colspan=\"${cx}\" rowspan=\"${cy}\" class=\"${className}\" style=\"${style}\"${titleAttr}>${content}</td>`;
}

function groupCellTd(cell: GroupCell): string {
  const group = cell.group;

  let fill = group.attribute("fill").trim();
  if (fill) fill = normalizeColorForHtml(fill);

  let borderColor = group.attribute("bordercolor").trim() || "black";
  borderColor = normalizeColorForHtml(borderColor);

  const borderStyle = group.attribute("borderstyle").trim() || "solid";
  const borderWidthRaw = group.attribute("borderwidth").trim() || "1";
  const border = borderAttributeAsHtml(borderStyle, borderWidthRaw, borderColor);

  const cls = new Set(cell.cellClass.trim().split(/\s+/).filter(Boolean));
  const hasAll = cls.has("ga");
  const hasTop = hasAll || cls.has("gt");
  const hasBottom = hasAll || cls.has("gb");
  const hasLeft = hasAll || cls.has("gl");
  const hasRight = hasAll || cls.has("gr");

  let style = "";
  if (fill) style += `background: ${fill};`;
  if (border && hasTop) style += ` border-top: ${border};`;
  if (border && hasBottom) style += ` border-bottom: ${border};`;
  if (border && hasLeft) style += ` border-left: ${border};`;
  if (border && hasRight) style += ` border-right: ${border};`;

  let content = "&nbsp;";
  if (cell.hasLabel) {
    content = labelToHtml(cell.label, "left");
  }

  const className = `${classTokens("group", group.attribute("class"))} ${cell.cellClass.trim()}`.trim();
  return `<td colspan=\"${SUB}\" rowspan=\"${SUB}\" class=\"${className}\" style=\"${style}\">${content}</td>`;
}

function captionRow(graph: Graph, colSpan: number): { html: string; pos: string } {
  const labelRaw = graphLabel(graph);
  if (!labelRaw) return { html: "", pos: "" };

  const align = graph.graphAttributes.align?.trim().toLowerCase() || "center";
  const label = labelToHtml(expandEscapes(labelRaw, graph, {}, false), align);

  const fillRaw = graph.graphAttributes.fill?.trim() || "";
  const fill = fillRaw ? normalizeColorForHtml(fillRaw) : "";
  const textColorRaw = graph.graphAttributes.color?.trim() || "";
  const textColor = textColorRaw ? normalizeColorForHtml(textColorRaw) : "";
  const font = graph.graphAttributes.font?.trim() || "";
  const fontSizeRaw = graph.graphAttributes.fontsize?.trim() || "";
  const textStyle = graph.graphAttributes.textstyle?.trim() || "";

  let style = `text-align: ${align}`;
  if (fill) style += `; background: ${fill}`;
  const textStyleCss = textStyleFromAttributes(textColor, font, fontSizeRaw, textStyle);
  if (textStyleCss) style += `; ${textStyleCss}`;

  const html = `<tr><td colspan=\"${colSpan}\" style=\"${style}\">${label}</td></tr>`;
  const pos = graph.graphAttributes.labelpos?.trim().toLowerCase() || "top";
  return { html, pos };
}

function buildHtmlTable(graph: Graph): { table: string; colSpan: number } {
  if (!graph.cells) graph.layout();
  const cells = graph.cells as Map<string, Cell> | undefined;
  if (!cells || cells.size === 0) {
    const cls = tableClassName(graph);
    return { table: `<table class=\"${cls}\"></table>\n`, colSpan: 0 };
  }

  const rows = new Map<number, Map<number, Cell>>();
  const cols = new Set<number>();

  let minX = Infinity;
  let maxX = -Infinity;

  for (const cell of cells.values()) {
    const x = (cell as { x?: number }).x;
    const y = (cell as { y?: number }).y;
    if (x === undefined || y === undefined) continue;

    if (!rows.has(y)) rows.set(y, new Map());
    rows.get(y)?.set(x, cell);
    cols.add(x);

    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
  }

  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) {
    const cls = tableClassName(graph);
    return { table: `<table class=\"${cls}\"></table>\n`, colSpan: 0 };
  }

  const colList = [...cols].sort((a, b) => a - b);
  const rowList = [...rows.keys()].sort((a, b) => a - b);

  const cls = tableClassName(graph);
  const out: string[] = [];
  out.push(`<table class=\"${cls}\" cellpadding=0 cellspacing=0>`);

  const maxCells = maxX - minX + 1;
  const span = maxCells * 4;
  const caption = captionRow(graph, span);
  if (caption.html && caption.pos !== "bottom") out.push(caption.html);

  for (const y of rowList) {
    const rowMap = rows.get(y) ?? new Map();
    const rowBuckets: Array<Array<string | undefined>> = [[], [], [], []];

    for (const x of colList) {
      if (!rowMap.has(x)) {
        rowBuckets[0].push(undefined);
        continue;
      }

      const cell = rowMap.get(x);
      if (!cell) {
        rowBuckets[0].push(undefined);
        continue;
      }

      if (cell instanceof NodeCell || cell instanceof EdgeCellEmpty) {
        continue;
      }

      if (cell instanceof EdgeCell) {
        const parts = edgeHtml(graph, cell);
        for (let i = 0; i < parts.length; i++) {
          rowBuckets[i].push(parts[i]);
        }
        continue;
      }

      if (cell instanceof GroupCell) {
        rowBuckets[0].push(groupCellTd(cell));
        continue;
      }

      if (cell instanceof Node) {
        rowBuckets[0].push(nodeCellTd(graph, cell));
        continue;
      }

      rowBuckets[0].push(undefined);
    }

    for (const row of rowBuckets) {
      while (row.length > 0 && row[row.length - 1] === undefined) row.pop();
      for (let i = 0; i < row.length; i++) {
        if (row[i] === undefined) row[i] = " <td colspan=4 rowspan=4></td>\n";
      }
    }

    for (const row of rowBuckets) {
      const htmlRow = row.join("");
      out.push(`<tr>${htmlRow}</tr>`);
    }
  }

  if (caption.html && caption.pos === "bottom") out.push(caption.html);

  out.push("</table>\n");
  return { table: out.join("\n"), colSpan: span };
}

function cssForAttributes(attrs: Attributes, kind: "node" | "edge" | "group"): string {
  const styles: string[] = [];

  const push = (prop: string, value: string): void => {
    styles.push(`${prop}: ${value};`);
  };

  const align = attrs.align?.trim();
  if (align && align !== "inherit") push("text-align", align);

  const font = attrs.font?.trim();
  if (font && font !== "inherit") push("font-family", font);

  const fontSizeRaw = attrs.fontsize?.trim();
  if (fontSizeRaw && fontSizeRaw !== "inherit") {
    const size = /^\d+(\.\d+)?$/.test(fontSizeRaw) ? `${fontSizeRaw}px` : fontSizeRaw;
    push("font-size", size);
  }

  const color = attrs.color?.trim();
  if (color && color !== "inherit") push("color", normalizeColorForHtml(color));

  const background = attrs.background?.trim();
  if (background && background !== "inherit") push("background", normalizeColorForHtml(background));

  const fill = attrs.fill?.trim();
  if (fill && fill !== "inherit" && kind !== "edge") push("background", normalizeColorForHtml(fill));

  const border = borderAttributeAsHtml(
    attrs.borderstyle ?? "",
    attrs.borderwidth ?? "",
    attrs.bordercolor ?? ""
  );
  if (border && border !== "none") push("border", border);

  const textStyle = attrs.textstyle?.trim();
  if (textStyle) {
    const extra = textStyleFromAttributes("", "", "", textStyle);
    if (extra) styles.push(extra);
  }

  const textwrap = attrs.textwrap?.trim().toLowerCase();
  if (textwrap === "auto") push("white-space", "normal");

  return styles.join(" ");
}

function classCssSelector(base: string, className?: string): string {
  if (!className) return `.${base}`;
  return `.${base}_${normalizeClassToken(className)}`;
}

function buildClassCss(graph: Graph, tableBase: string): string[] {
  const css: string[] = [];

  const emit = (selector: string, styles: string): void => {
    if (!styles) return;
    css.push(`${tableBase} ${selector} { ${styles} }`);
  };

  emit(classCssSelector("node"), cssForAttributes(graph.defaultNodeAttributes, "node"));
  emit(classCssSelector("edge"), cssForAttributes(graph.defaultEdgeAttributes, "edge"));

  for (const [name, attrs] of graph.nodeClassAttributes) {
    emit(classCssSelector("node", name), cssForAttributes(attrs, "node"));
  }
  for (const [name, attrs] of graph.edgeClassAttributes) {
    emit(classCssSelector("edge", name), cssForAttributes(attrs, "edge"));
  }
  for (const [name, attrs] of graph.groupClassAttributes) {
    emit(classCssSelector("group", name), cssForAttributes(attrs, "group"));
  }

  return css;
}

function buildCss(tableClass: string, graph: Graph): string {
  const base = `table.${tableClass}`;
  const css: string[] = [];
  css.push(
    `${base} .edge { font-family: monospaced, courier-new, courier, sans-serif; margin: 0.1em; padding: 0.2em; vertical-align: bottom; }`
  );
  css.push(`${base} { border-collapse: collapse; empty-cells: show; margin: 0.5em; padding: 0.5em; }`);

  let groupFill = graph.defaultGroupAttributes.fill?.trim() ?? "#a0d0ff";
  if (!groupFill || groupFill === "inherit") groupFill = "#a0d0ff";
  groupFill = normalizeColorForHtml(groupFill);
  css.push(
    `${base} .group,${base} .group_anon { text-align: left; border-style: none; border-width: 1px; background: ${groupFill}; font-size: 0.8em; padding: 0.2em; }`
  );
  css.push(`${base} .group_anon { border-style: none; }`);

  let nodeFill = graph.defaultNodeAttributes.fill?.trim() ?? "white";
  if (!nodeFill || nodeFill === "inherit") nodeFill = "white";
  nodeFill = normalizeColorForHtml(nodeFill);
  let nodeBorderColor = graph.defaultNodeAttributes.bordercolor?.trim() ?? "#000000";
  if (!nodeBorderColor || nodeBorderColor === "inherit") nodeBorderColor = "#000000";
  nodeBorderColor = normalizeColorForHtml(nodeBorderColor);
  const nodeBorderStyle = graph.defaultNodeAttributes.borderstyle?.trim() || "solid";
  let nodeBorderWidth = graph.defaultNodeAttributes.borderwidth?.trim() || "1";
  if (/^\d+$/.test(nodeBorderWidth)) nodeBorderWidth = `${nodeBorderWidth}px`;
  css.push(
    `${base} .node,${base} .node_anon { text-align: center; border-color: ${nodeBorderColor}; border-style: ${nodeBorderStyle}; border-width: ${nodeBorderWidth}; background: ${nodeFill}; margin: 0.1em; padding: 0.2em; padding-left: 0.3em; padding-right: 0.3em; }`
  );
  css.push(`${base} .node_anon { border-style: none; }`);

  css.push(...buildClassCss(graph, base));

  if (graph.groups.length > 0) {
    css.push(`${base} td[class|=\"group\"] { padding: 0.2em; }`);
  }
  css.push(`${base} td { padding: 2px; background: inherit; white-space: nowrap; vertical-align: middle; }`);
  css.push(`${base} span.l { float: left; }`);
  css.push(`${base} span.r { float: right; }`);
  css.push(`${base} .va { vertical-align: middle; line-height: 1em; width: 0.4em; }`);
  css.push(`${base} .el { width: 0.1em; max-width: 0.1em; min-width: 0.1em; }`);
  css.push(`${base} .lh, ${base} .lv { font-size: 0.8em; padding-left: 0.4em; }`);
  css.push(
    `${base} .sv, ${base} .sh, ${base} .shl, ${base} .sa, ${base} .su { max-height: 1em; line-height: 1em; position: relative; top: 0.55em; left: -0.3em; overflow: visible; }`
  );
  css.push(`${base} .sv, ${base} .su { max-height: 0.5em; line-height: 0.5em; }`);
  css.push(`${base} .shl { left: 0.3em; }`);
  css.push(`${base} .sv { left: -0.5em; top: -0.4em; }`);
  css.push(`${base} .su { left: -0.5em; top: 0.4em; }`);
  css.push(`${base} .sa { left: -0.3em; top: 0; }`);
  css.push(`${base} .eb { max-height: 0; line-height: 0; height: 0; }`);
  return css.join("\n");
}

export function renderHtml(graph: Graph, opts: { includeCss?: boolean } = {}): string {
  const includeCss = opts.includeCss !== false;
  const tableClass = tableClassName(graph);
  const { table } = buildHtmlTable(graph);

  if (!includeCss) return table;

  const css = buildCss(tableClass, graph);
  return `<style>\n${css}\n</style>\n${table}`;
}

export function renderHtmlFile(graph: Graph): string {
  const tableClass = tableClassName(graph);
  const css = buildCss(tableClass, graph);
  const title = graph.graphAttributes.title || graph.graphAttributes.label || "Untitled graph";
  const table = renderHtml(graph, { includeCss: false });

  return (
    `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN">\n` +
    `<html>\n` +
    ` <head>\n` +
    ` <meta http-equiv=\"Content-Type\" content=\"text/html; charset=utf-8\">\n` +
    ` <title>${escapeHtml(title)}</title>\n` +
    ` <style type=\"text/css\">\n <!--\n ${css} -->\n </style>\n` +
    `</head>\n` +
    `<body bgcolor=white text=black>\n` +
    table +
    `</body></html>\n`
  );
}
