import type { Edge } from "./edge";
import type { Graph } from "./graph";

import { EdgeCell } from "./layout/edgeCell";
import { GroupCell } from "./layout/groupCell";
import type { NodeCell } from "./layout/nodeCell";
import {
  ARROW_DOWN,
  ARROW_LEFT,
  ARROW_RIGHT,
  ARROW_UP,
  EDGE_ARROW_HOR,
  EDGE_ARROW_MASK,
  EDGE_ARROW_VER,
  EDGE_CROSS,
  EDGE_E_N_S,
  EDGE_E_S_W,
  EDGE_END_E,
  EDGE_END_N,
  EDGE_END_S,
  EDGE_END_W,
  EDGE_FLAG_MASK,
  EDGE_HOR,
  EDGE_LABEL_CELL,
  EDGE_LOOP_TYPE,
  EDGE_MISC_MASK,
  EDGE_N_E,
  EDGE_N_E_W,
  EDGE_N_W,
  EDGE_N_W_S,
  EDGE_S_E,
  EDGE_S_E_W,
  EDGE_S_W,
  EDGE_S_W_N,
  EDGE_SHORT_CELL,
  EDGE_SHORT_E,
  EDGE_SHORT_W,
  EDGE_START_E,
  EDGE_START_W,
  EDGE_TYPE_MASK,
  EDGE_VER,
  EDGE_W_N_S,
  EDGE_W_S_E,
} from "./layout/edgeCellTypes";
import { Node } from "./node";

type CellMap = Map<string, Node | EdgeCell | NodeCell | GroupCell>;

type Fb = string[][];

type AlignChar = "l" | "c" | "r";

interface AlignedLabel {
  lines: string[];
  aligns: AlignChar[];
}

function edgeStyleName(edge: Edge): string {
  const raw = edge.attribute("style").trim();
  return raw === "" ? "solid" : raw;
}

function borderStyleName(group: { attribute(key: string): string }): string {
  const raw = group.attribute("borderstyle").trim();
  return raw === "" ? "dashed" : raw;
}

function arrowStyleName(edge: Edge): string {
  if (edge.undirected) return "none";
  const raw = edge.attribute("arrowstyle").trim();
  // In Graph::Easy, arrowstyle has a default (effectively "open").
  return raw === "" ? "open" : raw;
}

function arrowShapeName(edge: Edge): string {
  // In Graph::Easy, missing/empty arrowshape defaults to triangle.
  return edge.attribute("arrowshape").trim();
}

function textwrapName(obj: { attribute(key: string): string }): string {
  const raw = obj.attribute("textwrap").trim().toLowerCase();
  return raw === "" ? "none" : raw;
}

function alignName(obj: { attribute(key: string): string }, fallback: string): string {
  const raw = obj.attribute("align").trim().toLowerCase();
  return raw === "" ? fallback : raw;
}

// -----------------------------------------------------------------------------
// Label parsing (ported from Graph::Easy::Node::_wrapped_label/_aligned_label)

function wrappedLabel(label: string, align: string, wrap: string): AlignedLabel {
  // Replace line splits with spaces.
  let s = label.replace(/\\[nrlc]/g, " ");

  // Collapse multiple spaces.
  s = s.replace(/\s+/g, " ");

  let w = wrap;
  if (w === "auto") {
    w = String(Math.trunc(Math.sqrt(s.length) * 1.4));
  }

  let wrapN = Number(w);
  if (!Number.isFinite(wrapN)) {
    // Fall back to no wrapping if the input is nonsense.
    wrapN = s.length;
  }
  if (wrapN < 2) wrapN = 2;

  let i = 0;
  let lineLen = 0;
  let lastSpace = 0;
  let lastHyphen = 0;
  const lines: string[] = [];

  while (i < s.length) {
    const c = s[i];
    if (c === " ") lastSpace = i;
    if (c === "-") lastHyphen = i;

    lineLen += 1;

    if (lineLen >= wrapN && (lastSpace !== 0 || lastHyphen !== 0)) {
      let cut = lastSpace;
      let replace = "";
      if (lastHyphen > lastSpace) {
        cut = lastHyphen;
        replace = "-";
      }

      lines.push(s.slice(0, cut) + replace);
      s = s.slice(cut + 1);

      // Reset counters.
      lineLen = 0;
      i = 0;
      lastSpace = 0;
      lastHyphen = 0;
      continue;
    }

    i += 1;
  }

  if (s !== "") lines.push(s);

  const al = align.slice(0, 1).toLowerCase();
  const ac: AlignChar = al === "l" ? "l" : al === "r" ? "r" : "c";

  // Perl generates one extra entry; it’s harmless, but we’ll keep it for parity.
  const aligns: AlignChar[] = [];
  for (let j = 0; j <= lines.length; j++) aligns.push(ac);

  return { lines, aligns };
}

function alignedLabel(label: string, align: string, wrap: string): AlignedLabel {
  const effectiveAlign = align === "" ? "center" : align;
  const effectiveWrap = wrap === "" ? "none" : wrap;

  if (effectiveWrap !== "none") {
    return wrappedLabel(label, effectiveAlign, effectiveWrap);
  }

  const lines: string[] = [];
  const aligns: AlignChar[] = [];

  const al0 = effectiveAlign.slice(0, 1).toLowerCase();
  const defaultAlign: AlignChar = al0 === "l" ? "l" : al0 === "r" ? "r" : "c";

  let lastAlign: AlignChar = defaultAlign;

  // Split on escaped line breaks (\n/\r/\l/\c). The escape also affects the
  // alignment of the *next* line.
  let rest = label;
  while (rest !== "") {
    const m = /^(.*?)(?:\\([nrlc])|$)/s.exec(rest);
    if (!m) break;

    let part = m[1];
    const esc = m[2] ?? "n";

    // Consume the matched prefix + escape (if present).
    rest = rest.slice(part.length + (m[2] ? 2 : 0));

    part = part.replace(/\\\|/g, "|");
    part = part.replace(/\\\\/g, "\\");
    part = part.replace(/^\s+/, "");
    part = part.replace(/\s+$/, "");

    // \n means "use default alignment" for the next line.
    const nextAlignRaw = esc === "n" ? defaultAlign : (esc as AlignChar);

    lines.push(part);
    aligns.push(lastAlign);

    lastAlign = nextAlignRaw;
  }

  // The Perl code returns at least one line; keep that behavior for empty labels.
  if (lines.length === 0) {
    lines.push("");
    aligns.push(defaultAlign);
  }

  return { lines, aligns };
}

function labelDimensions(lines: string[]): { w: number; h: number } {
  let w = 0;
  for (const l of lines) w = Math.max(w, l.length);
  return { w, h: lines.length };
}

// -----------------------------------------------------------------------------
// Size correction (ported from Edge::Cell::_correct_size and Node::_correct_size)

function correctSizeEdgeCell(cell: EdgeCell): void {
  if (cell.w !== undefined && cell.h !== undefined) return;

  // min-size is this
  cell.w = 5;
  cell.h = 3;

  // make short cell pieces very small
  if ((cell.type & EDGE_SHORT_CELL) !== 0) {
    cell.w = 1;
    cell.h = 1;
    return;
  }

  const arrows = cell.type & EDGE_ARROW_MASK;
  const baseType = cell.type & EDGE_TYPE_MASK;

  if (cell.edge.bidirectional && arrows !== 0) {
    if (baseType === EDGE_HOR) cell.w += 1;
    if (baseType === EDGE_VER) cell.h += 1;
  }

  // make joints bigger if they got arrows
  const ah = cell.type & EDGE_ARROW_HOR;
  const av = cell.type & EDGE_ARROW_VER;
  if (ah && (baseType === EDGE_S_E_W || baseType === EDGE_N_E_W)) cell.w += 1;
  if (av && (baseType === EDGE_E_N_S || baseType === EDGE_W_N_S)) cell.h += 1;

  const style = edgeStyleName(cell.edge);
  // make the edge to display ' ..-> ' instead of ' ..> '
  if (style === "dot-dot-dash") cell.w += 1;

  if (baseType >= EDGE_LOOP_TYPE) {
    cell.w = 7;
    if (baseType === EDGE_N_W_S || baseType === EDGE_S_W_N) cell.w = 8;

    cell.h = 3;
    if (baseType !== EDGE_N_W_S && baseType !== EDGE_S_W_N) cell.h = 5;
  }

  if (cell.type === EDGE_HOR) {
    cell.w = 0;
  } else if (cell.type === EDGE_VER) {
    cell.h = 0;
  } else if ((cell.type & EDGE_LABEL_CELL) !== 0) {
    const align = alignName(cell.edge, "center");
    const wrap = textwrapName(cell.edge);
    const { lines } = alignedLabel(cell.edge.label, align, wrap);
    let { w, h } = labelDimensions(lines);

    // edges do not have borders
    if (h !== 0) h -= 1;

    cell.h += h;
    cell.w += w;
  }
}

function correctSizeNode(node: Node): void {
  if (node.w !== undefined && node.h !== undefined) return;

  const shape = node.attribute("shape").trim().toLowerCase();

  if (shape === "point") {
    node.w = 5;
    node.h = 3;

    const pointStyle = node.attribute("pointstyle").trim().toLowerCase();
    const pointShape = node.attribute("pointshape").trim().toLowerCase();
    if (pointStyle === "invisible" || pointShape === "invisible") {
      node.w = 0;
      node.h = 0;
      return;
    }

    return;
  }

  if (shape === "invisible") {
    node.w = 3;
    node.h = 3;
    return;
  }

  const align = alignName(node, "center");
  const wrap = textwrapName(node);
  const { lines } = alignedLabel(node.label, align, wrap);
  const dims = labelDimensions(lines);

  // Default "box"-style sizing (matches the common case and our already-green fixtures).
  node.w = dims.w + 4;
  node.h = dims.h + 2;
}

function correctSizeGroupCell(cell: GroupCell): void {
  if (cell.w !== undefined && cell.h !== undefined) return;

  const border = borderStyleName(cell.group);

  cell.w = 0;
  cell.h = 0;

  // label needs space
  if (cell.hasLabel) cell.h = 1;

  if (border !== "none") {
    // For corner cells etc, cellClass contains e.g. "gt gr" so there will be
    // whitespace after a g[rltb] token.
    if (cell.hasLabel || /g[rltb]\s/.test(cell.cellClass)) {
      cell.w = 2;
      cell.h = 2;
    } else if (/^ g[rl]$/.test(cell.cellClass)) {
      cell.w = 2;
    } else if (/^ g[bt]$/.test(cell.cellClass)) {
      cell.h = 2;
    }
  }

  if (cell.hasLabel) {
    const align = alignName(cell.group, "left");
    const wrap = textwrapName(cell.group);
    const { lines } = alignedLabel(cell.label, align, wrap);
    const dims = labelDimensions(lines);
    cell.h += dims.h;
    cell.w += dims.w;
  }
}

function balanceSizes(sizes: number[], need: number): void {
  // Ported from Graph::Easy::_balance_sizes.
  if (need < 1) return;

  if (sizes.length === 1) {
    if (sizes[0] < need) sizes[0] = need;
    return;
  }

  while (true) {
    let sum = 0;
    let sm = need + 1;
    let smI = 0;

    for (let i = 0; i < sizes.length; i++) {
      const s = sizes[i];
      sum += s;
      if (s === 0) continue;
      if (s < sm) {
        sm = s;
        smI = i;
      }
    }

    if (sum >= need) break;

    sizes[smI] += 1;
  }
}

function orderedCellEntries(cells: CellMap): Array<[string, Node | EdgeCell | NodeCell | GroupCell]> {
  // Graph::Easy::Util::ord_values orders by key lexicographically.
  return [...cells.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function isRenderableCell(v: Node | EdgeCell | NodeCell | GroupCell): v is Node | EdgeCell | GroupCell {
  return v instanceof Node || v instanceof EdgeCell || v instanceof GroupCell;
}

function cellSpan(cell: Node | EdgeCell | GroupCell): { cx: number; cy: number } {
  return { cx: cell.cx ?? 1, cy: cell.cy ?? 1 };
}

function prepareLayout(cells: CellMap): { rows: Map<number, number>; cols: Map<number, number>; maxX: number; maxY: number } {
  const rowSizes = new Map<number, number>();
  const colSizes = new Map<number, number>();

  let mx = -1000000;
  let my = -1000000;

  const entries = orderedCellEntries(cells);

  // Pass 1: correct sizes + gather single-cell max sizes.
  for (const [, raw] of entries) {
    if (!isRenderableCell(raw)) continue;

    if (raw instanceof EdgeCell) correctSizeEdgeCell(raw);
    else if (raw instanceof GroupCell) correctSizeGroupCell(raw);
    else correctSizeNode(raw);

    const x = raw.x ?? 0;
    const y = raw.y ?? 0;

    const w = raw.w ?? 0;
    const h = raw.h ?? 0;

    const { cx, cy } = cellSpan(raw);

    // Set the minimum cell size only for single-celled objects.
    if (cx + cy === 2) {
      rowSizes.set(y, Math.max(rowSizes.get(y) ?? 0, h));
      colSizes.set(x, Math.max(colSizes.get(x) ?? 0, w));
    }

    mx = Math.max(mx, x);
    my = Math.max(my, y);
  }

  // insert a dummy row/column with size=0 as last
  rowSizes.set(my + 1, 0);
  colSizes.set(mx + 1, 0);

  // Pass 2: multi-celled objects (balance their required w/h across spanned rows/cols).
  for (const [, raw] of entries) {
    if (!isRenderableCell(raw)) continue;

    const { cx, cy } = cellSpan(raw);
    if (cx + cy <= 2) continue;

    const x = raw.x ?? 0;
    const y = raw.y ?? 0;

    // X (columns)
    {
      const sizes: number[] = [];
      for (let i = 0; i < cx; i++) sizes.push(colSizes.get(i + x) ?? 0);
      balanceSizes(sizes, raw.w ?? 0);
      for (let i = 0; i < cx; i++) colSizes.set(i + x, sizes[i]);
    }

    // Y (rows)
    {
      const sizes: number[] = [];
      for (let i = 0; i < cy; i++) sizes.push(rowSizes.get(i + y) ?? 0);
      balanceSizes(sizes, raw.h ?? 0);
      for (let i = 0; i < cy; i++) rowSizes.set(i + y, sizes[i]);
    }
  }

  // Absolute positions.
  const rows = new Map<number, number>();
  const cols = new Map<number, number>();

  let pos = 0;
  for (const y of [...rowSizes.keys()].sort((a, b) => a - b)) {
    const s = rowSizes.get(y) ?? 0;
    rows.set(y, pos);
    pos += s;
  }

  pos = 0;
  for (const x of [...colSizes.keys()].sort((a, b) => a - b)) {
    const s = colSizes.get(x) ?? 0;
    cols.set(x, pos);
    pos += s;
  }

  // Find max dimensions for framebuffer.
  let maxY = 0;
  let maxX = 0;

  const nextDefined = (m: Map<number, number>, start: number): number => {
    let k = start;
    while (!m.has(k)) k += 1;
    return m.get(k) ?? 0;
  };

  // single-celled
  for (const [, raw] of entries) {
    if (!isRenderableCell(raw)) continue;
    const { cx, cy } = cellSpan(raw);
    if (cx + cy !== 2) continue;

    const gx = raw.x ?? 0;
    const gy = raw.y ?? 0;

    const x = cols.get(gx) ?? 0;
    const y = rows.get(gy) ?? 0;

    (raw as Node & { minw?: number; minh?: number }).minw = raw.w;
    (raw as Node & { minw?: number; minh?: number }).minh = raw.h;

    const nextCol = nextDefined(cols, gx + 1);
    const nextRow = nextDefined(rows, gy + 1);

    raw.w = nextCol - x;
    raw.h = nextRow - y;

    maxY = Math.max(maxY, y + (raw.h ?? 0) - 1);
    maxX = Math.max(maxX, x + (raw.w ?? 0) - 1);
  }

  // multi-celled
  for (const [, raw] of entries) {
    if (!isRenderableCell(raw)) continue;
    const { cx, cy } = cellSpan(raw);
    if (cx + cy <= 2) continue;

    const gx = raw.x ?? 0;
    const gy = raw.y ?? 0;

    const x = cols.get(gx) ?? 0;
    const y = rows.get(gy) ?? 0;

    (raw as Node & { minw?: number; minh?: number }).minw = raw.w;
    (raw as Node & { minw?: number; minh?: number }).minh = raw.h;

    const nextCol = nextDefined(cols, gx + cx);
    const nextRow = nextDefined(rows, gy + cy);

    raw.w = nextCol - x;
    raw.h = nextRow - y;

    maxY = Math.max(maxY, y + (raw.h ?? 0) - 1);
    maxX = Math.max(maxX, x + (raw.w ?? 0) - 1);
  }

  return { rows, cols, maxX, maxY };
}

// -----------------------------------------------------------------------------
// Framebuffer helpers

function makeFb(w: number, h: number): Fb {
  const fb: Fb = [];
  for (let y = 0; y < h; y++) {
    const row: string[] = [];
    for (let x = 0; x < w; x++) row.push(" ");
    fb.push(row);
  }
  return fb;
}

function putChar(fb: Fb, x: number, y: number, ch: string): void {
  if (ch === "") return;
  if (y < 0 || y >= fb.length) return;
  if (x < 0 || x >= fb[y].length) return;
  if (ch === " ") return;
  fb[y][x] = ch;
}

function putText(fb: Fb, x: number, y: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    putChar(fb, x + i, y, text[i]);
  }
}

function putVer(fb: Fb, x: number, y: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    putChar(fb, x, y + i, text[i]);
  }
}

function printfbAligned(
  fb: Fb,
  x1: number,
  y1: number,
  w: number,
  h: number,
  label: AlignedLabel,
  alignVer: "top" | "middle" | "bottom" = "middle"
): void {
  const { lines, aligns } = label;

  // Ported intent of Graph::Easy::As_ascii::_printfb_aligned: compute the
  // top-left insertion point inside the given rectangle, allowing fractional
  // positions and truncating toward zero.
  let y = y1 + h / 2 - lines.length / 2;
  if (alignVer === "top") {
    y = y1;
  } else if (alignVer === "bottom") {
    y = y1 + (h - lines.length);
  }

  const xc = w / 2;

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const al = aligns[i] ?? "l";

    let x = 0;
    if (al === "c") x = xc - l.length / 2;
    else if (al === "r") x = w - l.length;

    const rx = Math.trunc(x1 + x);
    const ry = Math.trunc(y + i);

    putText(fb, rx, ry, l);
  }
}

// -----------------------------------------------------------------------------
// Edge drawing (ported from Graph::Easy::Edge::Cell in As_ascii.pm)

type EdgeStyle = [string, string, string, string, string, string, string];

const EDGE_STYLES_ASCII: Record<string, EdgeStyle> = {
  solid: ["--", "|", "+", "+", "+", "+", "+"],
  double: ["==", "H", "#", "#", "#", "#", "#"],
  "double-dash": ["= ", '"', "#", "#", "#", "#", "#"],
  dotted: ["..", ":", ":", ".", ".", ".", "."],
  dashed: ["- ", "'", "+", "+", "+", "+", "+"],
  "dot-dash": [".-", "!", "+", "+", "+", "+", "+"],
  "dot-dot-dash": ["..-", "!", "+", "+", "+", "+", "+"],
  wave: ["~~", "}", "+", "*", "*", "*", "*"],
  bold: ["##", "#", "#", "#", "#", "#", "#"],
  "bold-dash": ["# ", "#", "#", "#", "#", "#", "#"],
  wide: ["##", "#", "#", "#", "#", "#", "#"],
  broad: ["##", "#", "#", "#", "#", "#", "#"],
  invisible: ["  ", " ", " ", " ", " ", " ", " "],
};

const ARROW_SHAPES: Record<string, number> = {
  triangle: 0,
  diamond: 1,
  box: 2,
  dot: 3,
  inv: 4,
  line: 5,
  cross: 6,
  x: 7,
};

const ARROW_STYLES_ASCII: Array<Record<string, [string, string, string, string]>> = [
  // triangle
  {
    open: [">", "<", "^", "v"],
    closed: [">", "<", "^", "v"],
    filled: [">", "<", "^", "v"],
  },
  // diamond
  {
    open: [">", "<", "^", "v"],
    closed: [">", "<", "^", "v"],
    filled: [">", "<", "^", "v"],
  },
  // box
  {
    open: ["]", "[", "°", "u"],
    closed: ["D", "D", "D", "D"],
    filled: ["#", "#", "#", "#"],
  },
  // dot
  {
    open: [")", "(", "^", "u"],
    closed: ["o", "o", "o", "o"],
    filled: ["*", "*", "*", "*"],
  },
  // inv
  {
    open: ["<", ">", "v", "^"],
    closed: ["<", ">", "v", "^"],
    filled: ["<", ">", "v", "^"],
  },
  // line
  {
    open: ["|", "|", "_", "-"],
    closed: ["|", "|", "_", "-"],
    filled: ["|", "|", "_", "-"],
  },
  // cross
  {
    open: ["+", "+", "+", "+"],
    closed: ["+", "+", "+", "+"],
    filled: ["+", "+", "+", "+"],
  },
  // x
  {
    open: ["x", "x", "x", "x"],
    closed: ["x", "x", "x", "x"],
    filled: ["x", "x", "x", "x"],
  },
];

function edgeStyle(style: string): EdgeStyle {
  return EDGE_STYLES_ASCII[style] ?? EDGE_STYLES_ASCII.solid;
}

function arrowChar(style: string, dir: number, shape: string): string {
  const shapeIdx = ARROW_SHAPES[shape] ?? 0;
  const byStyle = ARROW_STYLES_ASCII[shapeIdx][style];
  if (!byStyle) {
    // Unknown style; Graph::Easy treats this as an error; we keep it loud.
    throw new Error(`Unknown arrow style '${style}'`);
  }
  return byStyle[dir] ?? byStyle[0];
}

function drawHor(cell: EdgeCell, fb: Fb, absX: number, absY: number, rx: number): void {
  const w = cell.w ?? 0;
  const h = cell.h ?? 0;
  if (w <= 0 || h <= 0) return;

  const style = edgeStyle(edgeStyleName(cell.edge));

  const len = style[0].length;
  const repeatCount = Math.floor(2 + w / len);
  let line = style[0].repeat(Math.max(0, repeatCount));

  const ofs = rx % len;
  const typeNoMisc = cell.type & ~EDGE_MISC_MASK;
  if (ofs !== 0 && typeNoMisc !== EDGE_SHORT_E && typeNoMisc !== EDGE_SHORT_W) {
    line = line.slice(ofs);
  }

  if (line.length > w) line = line.slice(0, w);

  const flags = cell.type & EDGE_FLAG_MASK;

  const as = arrowStyleName(cell.edge);
  const ashape = as !== "none" ? arrowShapeName(cell.edge) : "";

  let x = 0;
  let xs = 1;
  let xr = 0;

  if ((flags & EDGE_START_W) !== 0) {
    x += 1;
    line = line.slice(0, Math.max(0, line.length - 1));
    xs += 1;
  }
  if ((flags & EDGE_START_E) !== 0) {
    line = line.slice(0, Math.max(0, line.length - 1));
  }

  if ((flags & EDGE_END_E) !== 0) {
    line = line.slice(0, Math.max(0, line.length - 1));
    if (as !== "none" && line.length > 0) {
      line = line.slice(0, -1) + arrowChar(as, ARROW_RIGHT, ashape);
    }
    xr += 1;
  }
  if ((flags & EDGE_END_W) !== 0) {
    if (as === "none") {
      if (line.length > 0) line = " " + line.slice(1);
    } else {
      if (line.length >= 2) {
        line = " " + arrowChar(as, ARROW_LEFT, ashape) + line.slice(2);
      }
    }
    xs += 1;
  }

  putText(fb, absX + x, absY + (h - 2), line);

  if ((cell.type & EDGE_LABEL_CELL) !== 0) {
    const align = alignName(cell.edge, "center");
    const wrap = textwrapName(cell.edge);
    const label = alignedLabel(cell.edge.label, align, wrap);

    const ys = 0;
    const ws = xs + xr;
    const hs = 2;

    const lw = w - ws - xs;
    const lh = h - hs - ys;

    printfbAligned(fb, absX + xs, absY + ys, lw, lh, label, "bottom");
  }
}

function drawVer(cell: EdgeCell, fb: Fb, absX: number, absY: number): void {
  const w = cell.w ?? 0;
  const h = cell.h ?? 0;
  if (w <= 0 || h <= 0) return;

  const style = edgeStyle(edgeStyleName(cell.edge));

  const segLen = style[1].length;
  const repeatCount = Math.floor(1 + h / segLen);
  let line = style[1].repeat(Math.max(0, repeatCount));
  if (line.length > h) line = line.slice(0, h);

  const flags = cell.type & EDGE_FLAG_MASK;

  const as = arrowStyleName(cell.edge);
  if (as !== "none") {
    const ashape = arrowShapeName(cell.edge);
    if ((flags & EDGE_END_N) !== 0 && line.length > 0) {
      line = arrowChar(as, ARROW_UP, ashape) + line.slice(1);
    }
    if ((flags & EDGE_END_S) !== 0 && line.length > 0) {
      line = line.slice(0, -1) + arrowChar(as, ARROW_DOWN, ashape);
    }
  }

  putVer(fb, absX + 2, absY + 0, line);

  if ((cell.type & EDGE_LABEL_CELL) !== 0) {
    const align = alignName(cell.edge, "center");
    const wrap = textwrapName(cell.edge);
    const label = alignedLabel(cell.edge.label, align, wrap);

    const xs = 4;
    const ys = 1;
    const ws = 4;
    const hs = 2;

    const lw = w - ws - xs;
    const lh = h - hs - ys;

    printfbAligned(fb, absX + xs, absY + ys, lw, lh, label, "middle");
  }
}

function drawCross(cell: EdgeCell, fb: Fb, absX: number, absY: number, rx: number): void {
  const w = cell.w ?? 0;
  const h = cell.h ?? 0;
  if (w <= 0 || h <= 0) return;

  const baseType = cell.type & EDGE_TYPE_MASK;
  const flags = cell.type & EDGE_FLAG_MASK;

  const style = edgeStyle(edgeStyleName(cell.edge));

  const as = arrowStyleName(cell.edge);
  const ashape = as !== "none" ? arrowShapeName(cell.edge) : "";

  const y = h - 2;

  // Vertical line
  {
    const segLen = style[1].length;
    const repeatCount = Math.floor(2 + h / segLen);
    let line = style[1].repeat(Math.max(0, repeatCount));
    if (line.length > h) line = line.slice(0, h);

    if (as !== "none") {
      if ((flags & EDGE_END_N) !== 0 && line.length > 0) {
        line = arrowChar(as, ARROW_UP, ashape) + line.slice(1);
      }
      if ((flags & EDGE_END_S) !== 0 && line.length > 0) {
        line = line.slice(0, -1) + arrowChar(as, ARROW_DOWN, ashape);
      }
    }

    // create joints
    if (baseType === EDGE_S_E_W) {
      line = " ".repeat(y) + line.slice(y);
    } else if (baseType === EDGE_N_E_W) {
      line = line.slice(0, y) + "  " + line.slice(y + 2);
    }

    putVer(fb, absX + 2, absY + 0, line);
  }

  // Horizontal line
  {
    const len = style[0].length;
    const repeatCount = Math.floor(2 + w / len);
    let line = style[0].repeat(Math.max(0, repeatCount));

    const ofs = rx % len;
    if (ofs !== 0) line = line.slice(ofs);
    if (line.length > w) line = line.slice(0, w);

    let x = 0;

    if ((flags & EDGE_START_W) !== 0) {
      x += 1;
      line = line.slice(0, Math.max(0, line.length - 1));
    }
    if ((flags & EDGE_START_E) !== 0) {
      line = line.slice(0, Math.max(0, line.length - 1));
    }
    if ((flags & EDGE_END_E) !== 0) {
      line = line.slice(0, Math.max(0, line.length - 1));
      if (as !== "none" && line.length > 0) {
        line = line.slice(0, -1) + arrowChar(as, ARROW_RIGHT, ashape);
      }
    }
    if ((flags & EDGE_END_W) !== 0) {
      if (as === "none") {
        if (line.length > 0) line = " " + line.slice(1);
      } else {
        if (line.length >= 2) {
          line = " " + arrowChar(as, ARROW_LEFT, ashape) + line.slice(2);
        }
      }
    }

    if (baseType === EDGE_E_N_S) {
      line = "  " + line.slice(2);
    } else if (baseType === EDGE_W_N_S) {
      line = line.slice(0, 2) + " ".repeat(Math.max(0, w - 2));
    }

    putText(fb, absX + x, absY + y, line);
  }

  // Crossing character.
  putChar(fb, absX + 2, absY + y, style[2]);
}

function drawCorner(cell: EdgeCell, fb: Fb, absX: number, absY: number, rx: number): void {
  const w = cell.w ?? 0;
  const h = cell.h ?? 0;
  if (w <= 0 || h <= 0) return;

  const baseType = cell.type & EDGE_TYPE_MASK;
  const flags = cell.type & EDGE_FLAG_MASK;

  const style = edgeStyle(edgeStyleName(cell.edge));

  // Vertical piece
  let vh = 1;
  let vy = h - 1;
  if (baseType === EDGE_N_E || baseType === EDGE_N_W) {
    vh = h - 2;
    vy = 0;
  }

  {
    const segLen = style[1].length;
    const repeatCount = Math.floor(1 + vh / segLen);
    let line = style[1].repeat(Math.max(0, repeatCount));
    if (line.length > vh) line = line.slice(0, vh);

    const as = arrowStyleName(cell.edge);
    if (as !== "none") {
      const ashape = arrowShapeName(cell.edge);
      if ((flags & EDGE_END_N) !== 0 && line.length > 0) {
        line = arrowChar(as, ARROW_UP, ashape) + line.slice(1);
      }
      if ((flags & EDGE_END_S) !== 0 && line.length > 0) {
        line = line.slice(0, -1) + arrowChar(as, ARROW_DOWN, ashape);
      }
    }

    putVer(fb, absX + 2, absY + vy, line);
  }

  // Horizontal piece
  {
    let hw = w - 3;
    let y = h - 2;
    let x = 3;

    if (baseType === EDGE_N_W || baseType === EDGE_S_W) {
      hw = 2;
      x = 0;
    }

    const len = style[0].length;
    const repeatCount = Math.floor(2 + hw / len);
    let line = style[0].repeat(Math.max(0, repeatCount));

    const ofs = (x + rx) % len;
    if (ofs !== 0) line = line.slice(ofs);
    if (line.length > hw) line = line.slice(0, hw);

    if ((flags & EDGE_START_E) !== 0 && line.length > 0) {
      line = line.slice(0, -1) + " ";
    }
    if ((flags & EDGE_START_W) !== 0 && line.length > 0) {
      line = " " + line.slice(1);
    }

    const as = arrowStyleName(cell.edge);
    const ashape = as !== "none" ? arrowShapeName(cell.edge) : "";

    if ((flags & EDGE_END_E) !== 0) {
      if (as === "none") {
        if (line.length > 0) line = line.slice(0, -1) + " ";
      } else if (line.length >= 2) {
        line = line.slice(0, -2) + arrowChar(as, ARROW_RIGHT, ashape) + " ";
      }
    }

    if ((flags & EDGE_END_W) !== 0) {
      if (as === "none") {
        if (line.length > 0) line = " " + line.slice(1);
      } else if (line.length >= 2) {
        line = " " + arrowChar(as, ARROW_LEFT, ashape) + line.slice(2);
      }
    }

    putText(fb, absX + x, absY + y, line);

    // Corner character
    let idx = 3;
    if (baseType === EDGE_S_W) idx = 4;
    else if (baseType === EDGE_N_E) idx = 5;
    else if (baseType === EDGE_N_W) idx = 6;

    putChar(fb, absX + 2, absY + y, style[idx]);
  }
}

function drawLoopHor(cell: EdgeCell, fb: Fb, absX: number, absY: number, rx: number): void {
  // Minimal port; enough to avoid crashes when loops exist.
  // The full Graph::Easy loop art will be tightened once we hit loop fixtures.
  drawCorner(cell, fb, absX, absY, rx);
}

function drawLoopVer(cell: EdgeCell, fb: Fb, absX: number, absY: number, rx: number): void {
  drawCorner(cell, fb, absX, absY, rx);
}

function drawEdgeCell(cell: EdgeCell, fb: Fb, absX: number, absY: number): void {
  const baseType = cell.type & EDGE_TYPE_MASK;

  // If the edge itself is invisible, don’t draw (except crossings, which can still
  // matter if another edge crosses through).
  if (edgeStyleName(cell.edge) === "invisible" && baseType !== EDGE_CROSS) return;

  const rx = absX;

  if (baseType === EDGE_HOR) return drawHor(cell, fb, absX, absY, rx);
  if (baseType === EDGE_VER) return drawVer(cell, fb, absX, absY);

  if (baseType === EDGE_S_E || baseType === EDGE_S_W || baseType === EDGE_N_E || baseType === EDGE_N_W) {
    return drawCorner(cell, fb, absX, absY, rx);
  }

  if (baseType === EDGE_CROSS || baseType === EDGE_W_N_S || baseType === EDGE_E_N_S || baseType === EDGE_N_E_W || baseType === EDGE_S_E_W) {
    return drawCross(cell, fb, absX, absY, rx);
  }

  if (baseType === EDGE_N_W_S || baseType === EDGE_S_W_N) {
    return drawLoopHor(cell, fb, absX, absY, rx);
  }

  if (baseType === EDGE_E_S_W || baseType === EDGE_W_S_E) {
    return drawLoopVer(cell, fb, absX, absY, rx);
  }

  throw new Error(`Unknown edge cell type ${baseType} at ${cell.x},${cell.y}`);
}

// -----------------------------------------------------------------------------
// Node drawing (minimal but deterministic; we’ll extend to full Graph::Easy parity
// once edge rendering is stable).

function drawNode(node: Node, fb: Fb, absX: number, absY: number): void {
  const w = node.w ?? 0;
  const h = node.h ?? 0;
  if (w <= 0 || h <= 0) return;

  const shape = node.attribute("shape").trim().toLowerCase();
  if (shape === "invisible") return;

  // For now, treat most shapes like a standard box.
  const top = "+" + "-".repeat(Math.max(0, w - 2)) + "+";
  const bot = top;

  putText(fb, absX, absY, top);
  putText(fb, absX, absY + h - 1, bot);
  for (let y = 1; y < h - 1; y++) {
    putChar(fb, absX, absY + y, "|");
    putChar(fb, absX + w - 1, absY + y, "|");
  }

  const align = alignName(node, "center");
  const wrap = textwrapName(node);
  const label = alignedLabel(node.label, align, wrap);

  printfbAligned(fb, absX + 1, absY + 1, Math.max(0, w - 2), Math.max(0, h - 2), label, "middle");
}

function drawGroupCell(cell: GroupCell, fb: Fb, absX: number, absY: number): void {
  const w = cell.w ?? 0;
  const h = cell.h ?? 0;
  if (w <= 0 || h <= 0) return;

  const border = borderStyleName(cell.group);

  if (border !== "none") {
    const cls = cell.cellClass;
    const all = cls.includes("ga");

    const top = all || cls.includes("gt");
    const bottom = all || cls.includes("gb");
    const left = all || cls.includes("gl");
    const right = all || cls.includes("gr");

    const style = edgeStyle(border);
    const segH = style[0];
    const segV = style[1];
    const corner = style[2];

    const horLine = (y: number): void => {
      const len = segH.length;
      const repeatCount = Math.floor(2 + w / len);
      let line = segH.repeat(Math.max(0, repeatCount));

      const ofs = absX % len;
      if (ofs !== 0) line = line.slice(ofs);
      if (line.length > w) line = line.slice(0, w);

      putText(fb, absX, absY + y, line);
    };

    if (top) horLine(0);
    if (bottom) horLine(h - 1);

    if (left) {
      for (let y = 0; y < h; y++) putChar(fb, absX, absY + y, segV);
    }
    if (right) {
      for (let y = 0; y < h; y++) putChar(fb, absX + w - 1, absY + y, segV);
    }

    if (top && left) putChar(fb, absX, absY, corner);
    if (top && right) putChar(fb, absX + w - 1, absY, corner);
    if (bottom && left) putChar(fb, absX, absY + h - 1, corner);
    if (bottom && right) putChar(fb, absX + w - 1, absY + h - 1, corner);
  }

  if (cell.hasLabel) {
    const align = alignName(cell.group, "left");
    const wrap = textwrapName(cell.group);
    const label = alignedLabel(cell.label, align, wrap);

    let ys = 0;
    let lh = h;
    if (border !== "none") {
      ys = 0.5;
      lh = h - 1;
    }

    printfbAligned(fb, absX, absY + ys, w, lh, label, "middle");
  }
}

export function renderAscii(graph: Graph): string {
  if (!graph.cells) graph.layout();
  const cells = graph.cells;
  if (!cells) throw new Error("renderAscii(): graph.layout() did not produce cells");

  // If there are no renderable cells (e.g. empty graph), Graph::Easy prints just a newline.
  const hasRenderable = [...cells.values()].some((c) => c instanceof Node || c instanceof EdgeCell || c instanceof GroupCell);
  if (!hasRenderable) return "\n";

  const { rows, cols, maxX, maxY } = prepareLayout(cells);

  const fb = makeFb(maxX + 1, maxY + 1);

  const entries = orderedCellEntries(cells);

  // Draw group borders/background first so edges can overwrite them.
  for (const [, raw] of entries) {
    if (!(raw instanceof GroupCell)) continue;
    const absX = cols.get(raw.x ?? 0) ?? 0;
    const absY = rows.get(raw.y ?? 0) ?? 0;
    drawGroupCell(raw, fb, absX, absY);
  }

  // Draw edge cells first.
  for (const [, raw] of entries) {
    if (!(raw instanceof EdgeCell)) continue;
    const absX = cols.get(raw.x ?? 0) ?? 0;
    const absY = rows.get(raw.y ?? 0) ?? 0;
    drawEdgeCell(raw, fb, absX, absY);
  }

  // Then nodes.
  for (const [, raw] of entries) {
    if (!(raw instanceof Node)) continue;
    const absX = cols.get(raw.x ?? 0) ?? 0;
    const absY = rows.get(raw.y ?? 0) ?? 0;
    drawNode(raw, fb, absX, absY);
  }

  return fb.map((r) => r.join("").replace(/\s+$/g, "")).join("\n") + "\n";
}
