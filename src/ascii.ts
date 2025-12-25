import type { Edge } from "./edge";
import type { Graph } from "./graph";

import { EdgeCell } from "./layout/edgeCell";
import { EdgeCellEmpty } from "./layout/edgeCellEmpty";
import { GroupCell } from "./layout/groupCell";
import { NodeCell } from "./layout/nodeCell";
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

type CellMap = Map<string, Node | EdgeCell | NodeCell | GroupCell | EdgeCellEmpty>;

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

function borderStyleName(group: { attribute(key: string): string; name: string }): string {
  const raw = group.attribute("borderstyle").trim();
  if (raw !== "") return raw;

  // Graph::Easy defaults (Attributes.pm):
  // - group => dashed
  // - group.anon (empty-name groups like "( [A] -> [B] )") => none
  return group.name.trim() === "" ? "none" : "dashed";
}

function nodeBorderStyleName(node: Node): string {
  const shape = node.attribute("shape").trim().toLowerCase();
  if (shape === "none" || shape === "invisible") return "none";

  const raw = node.attribute("borderstyle").trim();
  return raw === "" ? "solid" : raw;
}

type BorderSides = { left: string; top: string; right: string; bottom: string };

const MERGED_BORDERS: Record<string, string> = {
  dotteddashed: "dot-dash",
  dasheddotted: "dot-dash",
  "double-dashdouble": "double",
  "doubledouble-dash": "double",
  doublesolid: "double",
  soliddouble: "double",
  "dotteddot-dash": "dot-dash",
  "dot-dashdotted": "dot-dash",
};

function mergeBorders(one: string, two: string): string {
  // Ported from Graph::Easy::Node::_merge_borders.
  const a = one === "" ? "none" : one;
  const b = two === "" ? "none" : two;

  if (a === b) return a;
  if (b === "none") return a;
  if (a === "none") return b;

  for (const strong of ["broad", "wide", "bold", "double", "solid"] as const) {
    if (a === strong || b === strong) return strong;
  }

  const both = `${a}${b}`;
  return MERGED_BORDERS[both] ?? b;
}

function mergeBordersCorner(horizontal: string, vertical: string): string {
  // Corner rendering needs a slightly different merge behavior than the shared-border
  // collapse logic: for dashed+double, Graph::Easy keeps the dashed corner character
  // even when the shared vertical border is double.
  const h = horizontal === "" ? "none" : horizontal;
  const v = vertical === "" ? "none" : vertical;
  if (h === "dashed" && v === "double") return "dashed";
  return mergeBorders(h, v);
}

function nodeAt(cells: CellMap, x: number, y: number): Node | undefined {
  const raw = cells.get(`${x},${y}`);
  if (!raw) return undefined;
  if (raw instanceof Node) return raw;
  if (raw instanceof NodeCell) return raw.node;
  return undefined;
}

function nodeBorderSides(node: Node, cells: CellMap): BorderSides {
  // Ported from Graph::Easy::Node::_border_styles (collapse logic only).
  const border = nodeBorderStyleName(node);
  const out: BorderSides = { left: border, top: border, right: border, bottom: border };

  if (node.x === undefined || node.y === undefined) return out;

  const x = node.x;
  const y = node.y;

  const left = nodeAt(cells, x - 1, y);
  const top = nodeAt(cells, x, y - 1);
  const right = nodeAt(cells, x + 1, y);
  const bottom = nodeAt(cells, x, y + 1);

  const isVisibleNeighbor = (n: Node | undefined): n is Node => {
    if (!n) return false;
    if (n === node) return false;
    return n.attribute("shape").trim().toLowerCase() !== "invisible";
  };

  // Left/top: collapse away our border when a visible neighbor exists.
  if (isVisibleNeighbor(left) && nodeBorderStyleName(left) !== "none") out.left = "none";
  if (isVisibleNeighbor(top) && nodeBorderStyleName(top) !== "none") out.top = "none";

  // Right/bottom: merge border styles so the stronger one wins.
  if (isVisibleNeighbor(right)) out.right = mergeBorders(nodeBorderStyleName(right), border);
  if (isVisibleNeighbor(bottom)) out.bottom = mergeBorders(nodeBorderStyleName(bottom), border);

  return out;
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
    part = part.replace(/\s+/g, " ");

    // \n means "use default alignment" for the next line.
    const nextAlignRaw = esc === "n" ? defaultAlign : (esc as AlignChar);

    lines.push(part);
    aligns.push(lastAlign);

    lastAlign = nextAlignRaw;
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
    const align = alignName(cell.edge, "left");
    const wrap = textwrapName(cell.edge);
    const { lines } = alignedLabel(cell.edge.labelText(), align, wrap);
    let { w, h } = labelDimensions(lines);

    // edges do not have borders
    if (h !== 0) h -= 1;

    cell.h += h;
    cell.w += w;
  }
}

function correctSizeNode(node: Node, cells: CellMap): void {
  if (node.w !== undefined && node.h !== undefined) return;

  const shape = node.attribute("shape").trim().toLowerCase();

  if (shape === "edge") {
    // Graph::Easy renders shape=edge nodes as a dummy horizontal edge label cell
    // (Graph::Easy::As_ascii.pm: as_ascii() branch for shape eq 'edge').
    const align = alignName(node, "left");
    const wrap = textwrapName(node);
    const { lines } = alignedLabel(node.labelText(), align, wrap);

    // Graph::Easy treats whitespace-only labels as "no label" for sizing.
    const hasVisibleLabel = lines.some((l) => l !== "");
    let { w, h } = labelDimensions(lines);

    if (!hasVisibleLabel) {
      w = 0;
      h = 0;
    }

    // Graph::Easy sizes these nodes slightly differently than Edge::Cell::_correct_size:
    // - Empty labels shrink to 3x3.
    // - Non-empty labels have a base width of 4 (plus label width).
    // - Label height shares the baseline line row, so subtract 1 when non-empty.
    const baseH = 3;
    const baseW = h === 0 ? 3 : 4;
    if (h !== 0) h -= 1;

    node.w = baseW + w;
    node.h = baseH + h;
    return;
  }

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
  const { lines } = alignedLabel(node.labelText(), align, wrap);
  const dims = labelDimensions(lines);

  const border = nodeBorderStyleName(node);
  const sides = nodeBorderSides(node, cells);

  // Ported from Graph::Easy::Node::_correct_size.
  // Base sizing: width = label width + 2, height = label height.
  let w = dims.w + 2;
  let h = dims.h;

  if (border !== "none") {
    if (sides.left !== "none") w += 1;
    if (sides.right !== "none") w += 1;
    if (sides.top !== "none") h += 1;
    if (sides.bottom !== "none") h += 1;
  } else {
    // When there is no border, Graph::Easy adds extra vertical padding.
    h += 2;
  }

  node.w = w;
  node.h = h;
}

const POINT_SHAPES_ASCII: Record<string, Record<string, string>> = {
  filled: {
    star: "*",
    square: "#",
    dot: ".",
    circle: "o",
    cross: "+",
    diamond: "<>",
    x: "X",
  },
  closed: {
    star: "*",
    square: "#",
    dot: ".",
    circle: "o",
    cross: "+",
    diamond: "<>",
    x: "X",
  },
};

function pointStyle(node: Node): string {
  let shape = node.attribute("pointshape").trim().toLowerCase();
  let style = node.attribute("pointstyle").trim().toLowerCase();

  if (shape === "") shape = "star";
  if (shape === "invisible") return "";

  if (/^(star|square|dot|circle|cross|diamond)$/.test(style)) {
    shape = style;
    style = "filled";
  }

  if (style === "") style = "filled";

  return POINT_SHAPES_ASCII[style]?.[shape] ?? "";
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
    let i = 0;
    let sm = need + 1;
    let smI = 0;

    // Match Perl's behavior exactly: the index counter only increments for
    // non-zero elements, which can cause growth to be applied to an earlier
    // (zero) column/row.
    for (const s of sizes) {
      sum += s;
      if (s === 0) continue;
      if (s < sm) {
        sm = s;
        smI = i;
      }
      i += 1;
    }

    if (sum >= need) break;

    sizes[smI] += 1;
  }
}

function orderedCellEntries(cells: CellMap): Array<[string, Node | EdgeCell | NodeCell | GroupCell | EdgeCellEmpty]> {
  // Graph::Easy::Util::ord_values orders by key lexicographically.
  return [...cells.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function isRenderableCell(v: Node | EdgeCell | NodeCell | GroupCell | EdgeCellEmpty): v is Node | EdgeCell | GroupCell {
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
    let x = 0;
    let y = 0;
    let w = 0;
    let h = 0;
    let cx = 1;
    let cy = 1;

    // Include NodeCell placeholders so our row/col keying and mx/my tracking
    // matches Perl's _prepare_layout (it iterates all cells, not just visible ones).
    if (raw instanceof NodeCell || raw instanceof EdgeCellEmpty) {
      x = raw.x;
      y = raw.y;
    } else if (raw instanceof EdgeCell) {
      correctSizeEdgeCell(raw);
      x = raw.x ?? 0;
      y = raw.y ?? 0;
      w = raw.w ?? 0;
      h = raw.h ?? 0;
      ({ cx, cy } = cellSpan(raw));
    } else if (raw instanceof GroupCell) {
      correctSizeGroupCell(raw);
      x = raw.x ?? 0;
      y = raw.y ?? 0;
      w = raw.w ?? 0;
      h = raw.h ?? 0;
      ({ cx, cy } = cellSpan(raw));
    } else if (raw instanceof Node) {
      correctSizeNode(raw, cells);
      x = raw.x ?? 0;
      y = raw.y ?? 0;
      w = raw.w ?? 0;
      h = raw.h ?? 0;
      ({ cx, cy } = cellSpan(raw));
    } else {
      continue;
    }

    // Ensure every seen coordinate has a row/col entry (even if size 0). Perl's
    // _prepare_layout initializes row/col maps for all cells, and later sizing
    // logic (nextDefined) assumes keys exist.
    if (!rowSizes.has(y)) rowSizes.set(y, 0);
    if (!colSizes.has(x)) colSizes.set(x, 0);

    // Set the minimum cell size only for single-celled objects.
    if (cx + cy === 2) {
      rowSizes.set(y, Math.max(rowSizes.get(y) ?? 0, h));
      colSizes.set(x, Math.max(colSizes.get(x) ?? 0, w));
    }

    // Track highest X,Y pair (Perl uses x,y, not x+cx/y+cy; multi-cell extents
    // are represented by additional placeholder cells in the grid).
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
  // NOTE: Perl uses `int($y+$i+$y1)` where `$y` for middle alignment already
  // includes `$y1` (so `$y1` is effectively applied twice). We match the
  // *observed* behavior by adding the fractional part of y1 again for middle
  // alignment.
  const y1Int = Math.trunc(y1);
  const y1Frac = y1 - y1Int;

  let y = y1 + h / 2 - lines.length / 2;
  let yExtra = 0;
  if (alignVer === "top") {
    y = y1;
  } else if (alignVer === "bottom") {
    // Perl resets y1=0 for bottom alignment.
    y = y1Int + (h - lines.length);
  } else {
    // middle
    yExtra = y1Frac;
  }

  const xc = w / 2;

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const al = aligns[i] ?? "l";

    let x = 0;
    if (al === "c") x = xc - l.length / 2;
    else if (al === "r") x = w - l.length;

    const rx = Math.trunc(x1 + x);
    const ry = Math.trunc(y + i + yExtra);

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

// Ported from Graph::Easy::As_ascii.pm $crossings (ASCII variant) for EDGE_CROSS.
const EDGE_CROSSINGS_ASCII: Record<string, string> = {
  boldsolid: "+",
  dashedsolid: "+",
  dottedsolid: "!",
  dottedwave: "+",
  doublesolid: "+",
  "dot-dashsolid": "+",
  "dot-dot-dashsolid": "+",
  soliddotted: "+",
  solidwave: "+",
  soliddashed: "+",
  soliddouble: "H",
  wavesolid: "+",
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
    const align = alignName(cell.edge, "left");
    const wrap = textwrapName(cell.edge);
    const label = alignedLabel(cell.edge.labelText(), align, wrap);

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
    const align = alignName(cell.edge, "left");
    const wrap = textwrapName(cell.edge);
    const label = alignedLabel(cell.edge.labelText(), align, wrap);

    // Place the label to the right of the vertical stroke (which is at x+2), leaving
    // one space after the stroke. Use the full vertical height for centering.
    const xs = 4;
    const lw = Math.max(0, w - xs);
    const lh = h;

    printfbAligned(fb, absX + xs, absY, lw, lh, label, "middle");
  }
}

function drawCross(cell: EdgeCell, fb: Fb, absX: number, absY: number, rx: number): void {
  const w = cell.w ?? 0;
  const h = cell.h ?? 0;
  if (w <= 0 || h <= 0) return;

  const baseType = cell.type & EDGE_TYPE_MASK;
  const flags = cell.type & EDGE_FLAG_MASK;

  const horEdge = cell.crossHorEdge ?? cell.edge;
  const verEdge = cell.crossVerEdge ?? cell.edge;

  const horStyleName = edgeStyleName(horEdge);
  const verStyleName = edgeStyleName(verEdge);

  const styleH = edgeStyle(horStyleName);
  const styleV = edgeStyle(verStyleName);

  const crossKey = `${horStyleName}${verStyleName}`;
  const crossChar =
    baseType === EDGE_CROSS ? (EDGE_CROSSINGS_ASCII[crossKey] ?? styleH[2]) : styleH[2];

  const asH = arrowStyleName(horEdge);
  const ashapeH = asH !== "none" ? arrowShapeName(horEdge) : "";
  const asV = arrowStyleName(verEdge);
  const ashapeV = asV !== "none" ? arrowShapeName(verEdge) : "";

  const y = h - 2;

  // Vertical line
  {
    const segLen = styleV[1].length;
    const repeatCount = Math.floor(2 + h / segLen);
    let line = styleV[1].repeat(Math.max(0, repeatCount));
    if (line.length > h) line = line.slice(0, h);

    if (asV !== "none") {
      if ((flags & EDGE_END_N) !== 0 && line.length > 0) {
        line = arrowChar(asV, ARROW_UP, ashapeV) + line.slice(1);
      }
      if ((flags & EDGE_END_S) !== 0 && line.length > 0) {
        line = line.slice(0, -1) + arrowChar(asV, ARROW_DOWN, ashapeV);
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
    const len = styleH[0].length;
    const repeatCount = Math.floor(2 + w / len);
    let line = styleH[0].repeat(Math.max(0, repeatCount));

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
      if (asH !== "none" && line.length > 0) {
        line = line.slice(0, -1) + arrowChar(asH, ARROW_RIGHT, ashapeH);
      }
    }
    if ((flags & EDGE_END_W) !== 0) {
      if (asH === "none") {
        if (line.length > 0) line = " " + line.slice(1);
      } else {
        if (line.length >= 2) {
          line = " " + arrowChar(asH, ARROW_LEFT, ashapeH) + line.slice(2);
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
  putChar(fb, absX + 2, absY + y, crossChar);
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

function insertEdgeLabel(
  cell: EdgeCell,
  fb: Fb,
  absX: number,
  absY: number,
  xs: number,
  ys: number,
  ws: number,
  hs: number,
  alignVer: "top" | "middle" | "bottom"
): void {
  const w = cell.w ?? 0;
  const h = cell.h ?? 0;
  if (w <= 0 || h <= 0) return;

  const align = alignName(cell.edge, "left");
  const wrap = textwrapName(cell.edge);
  const label = alignedLabel(cell.edge.labelText(), align, wrap);

  // Perl supports negative ys to align relative to the bottom.
  let y = ys;
  if (y < 0) y = h - label.lines.length + y;

  const lw = w - ws - xs;
  const lh = h - hs - y;
  printfbAligned(fb, absX + xs, absY + y, lw, lh, label, alignVer);
}

function drawLoopHor(cell: EdgeCell, fb: Fb, absX: number, absY: number, rx: number): void {
  // Ported from Graph::Easy::As_ascii::_draw_loop_hor.
  const w = cell.w ?? 0;
  const h = cell.h ?? 0;
  if (w <= 0 || h <= 0) return;

  const baseType = cell.type & EDGE_TYPE_MASK;
  const flags = cell.type & EDGE_FLAG_MASK;

  const style = edgeStyle(edgeStyleName(cell.edge));

  // draw the vertical pieces
  let vh = 1;
  let vy = h - 1;
  if (baseType === EDGE_S_W_N) {
    vh = h - 2;
    vy = 0;
  }

  const segLen = style[1].length;
  const repeatCount = Math.floor(1 + vh / segLen);
  let vline = style[1].repeat(Math.max(0, repeatCount));
  if (vline.length > vh) vline = vline.slice(0, vh);

  const as = arrowStyleName(cell.edge);
  const ashape = as !== "none" ? arrowShapeName(cell.edge) : "";

  // Right vertical piece: arrows only for bidirectional edges.
  {
    let line = vline;
    if (cell.edge.bidirectional && as !== "none") {
      if ((flags & EDGE_END_N) !== 0 && line.length > 0) {
        line = arrowChar(as, ARROW_UP, ashape) + line.slice(1);
      }
      if ((flags & EDGE_END_S) !== 0 && line.length > 0) {
        line = line.slice(0, -1) + arrowChar(as, ARROW_DOWN, ashape);
      }
    }
    putVer(fb, absX + (w - 3), absY + vy, line);
  }

  // Left vertical piece: arrows for any edge with arrowstyle != none.
  {
    let line = vline;
    if (as !== "none") {
      if ((flags & EDGE_END_N) !== 0 && line.length > 0) {
        line = arrowChar(as, ARROW_UP, ashape) + line.slice(1);
      }
      if ((flags & EDGE_END_S) !== 0 && line.length > 0) {
        line = line.slice(0, -1) + arrowChar(as, ARROW_DOWN, ashape);
      }
    }
    putVer(fb, absX + 2, absY + vy, line);
  }

  // horizontal piece
  const hw = w - 6;
  const y = h - 2;
  const x = 3;

  const len = style[0].length;
  const repeatCount2 = Math.floor(2 + hw / len);
  let hline = style[0].repeat(Math.max(0, repeatCount2));

  const ofs = (x + rx) % len;
  if (ofs !== 0) hline = hline.slice(ofs);
  if (hline.length > hw) hline = hline.slice(0, hw);

  putText(fb, absX + x, absY + y, hline);

  let cornerIdx = 3;
  if (baseType === EDGE_S_W_N) cornerIdx = 5;
  putChar(fb, absX + 2, absY + y, style[cornerIdx]);
  putChar(fb, absX + (w - 3), absY + y, style[cornerIdx + 1]);

  const align = baseType === EDGE_S_W_N ? "top" : "bottom";
  if ((cell.type & EDGE_LABEL_CELL) !== 0) {
    insertEdgeLabel(cell, fb, absX, absY, 4, 0, 4, 2, align);
  }
}

function drawLoopVer(cell: EdgeCell, fb: Fb, absX: number, absY: number, rx: number): void {
  // Ported from Graph::Easy::As_ascii::_draw_loop_ver.
  const w = cell.w ?? 0;
  const h = cell.h ?? 0;
  if (w <= 0 || h <= 0) return;

  const baseType = cell.type & EDGE_TYPE_MASK;
  const flags = cell.type & EDGE_FLAG_MASK;

  const style = edgeStyle(edgeStyleName(cell.edge));

  // draw the vertical piece
  {
    const segLen = style[1].length;
    const repeatCount = Math.floor(1 + 1 / segLen);
    let vline = style[1].repeat(Math.max(0, repeatCount));
    if (vline.length > 1) vline = vline.slice(0, 1);

    const x = baseType === EDGE_E_S_W ? w - 3 : 2;
    const y = h - 3;
    putVer(fb, absX + x, absY + y, vline);
  }

  // horizontal pieces
  const hw = w - 3;
  const yTop = h - 4;
  const yBottom = h - 2;
  const xStart = baseType === EDGE_E_S_W ? 1 : 2;

  const len = style[0].length;
  const repeatCount = Math.floor(2 + hw / len);
  let baseLine = style[0].repeat(Math.max(0, repeatCount));

  const ofs = (xStart + rx) % len;
  if (ofs !== 0) baseLine = baseLine.slice(ofs);
  if (baseLine.length > hw) baseLine = baseLine.slice(0, hw);

  const as = arrowStyleName(cell.edge);
  const ashape = as !== "none" ? arrowShapeName(cell.edge) : "";

  const withArrows = (lineIn: string): string => {
    if (as === "none") return lineIn;
    let line = lineIn;
    if ((flags & EDGE_END_W) !== 0 && line.length > 0) {
      line = arrowChar(as, ARROW_LEFT, ashape) + line.slice(1);
    }
    if ((flags & EDGE_END_E) !== 0 && line.length > 0) {
      line = line.slice(0, -1) + arrowChar(as, ARROW_RIGHT, ashape);
    }
    return line;
  };

  // Top line: arrows only for bidirectional edges.
  {
    const line = cell.edge.bidirectional ? withArrows(baseLine) : baseLine;
    putText(fb, absX + xStart, absY + yTop, line);
  }

  // Bottom line: arrows for any edge with arrowstyle != none.
  {
    const line = withArrows(baseLine);
    putText(fb, absX + xStart, absY + yBottom, line);
  }

  const xCorner = baseType === EDGE_E_S_W ? w - 3 : 2;
  let cornerIdx = 3;
  if (baseType === EDGE_E_S_W) cornerIdx = 4;

  // insert the corner characters
  putChar(fb, absX + xCorner, absY + yTop, style[cornerIdx]);
  putChar(fb, absX + xCorner, absY + yBottom, style[cornerIdx + 2]);

  if ((cell.type & EDGE_LABEL_CELL) !== 0) {
    const xs = baseType === EDGE_E_S_W ? 3 : 4;
    insertEdgeLabel(cell, fb, absX, absY, xs, 0, xs, 4, "bottom");
  }
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

type NodeBorderStyle = {
  ul: string;
  ur: string;
  lr: string;
  ll: string;
  horTop: string;
  horBottom: string;
  verLeft: string[];
  verRight: string[];
};

// Ported from Graph::Easy::As_ascii.pm $border_styles (ASCII variant only).
const NODE_BORDER_STYLES_ASCII: Record<string, NodeBorderStyle> = {
  solid: { ul: "+", ur: "+", lr: "+", ll: "+", horTop: "-", horBottom: "-", verLeft: ["|"], verRight: ["|"] },
  dotted: { ul: ".", ur: ".", lr: ":", ll: ":", horTop: ".", horBottom: ".", verLeft: [":"], verRight: [":"] },
  dashed: { ul: "+", ur: "+", lr: "+", ll: "+", horTop: "- ", horBottom: "- ", verLeft: ["'"], verRight: ["'"] },
  "dot-dash": { ul: "+", ur: "+", lr: "+", ll: "+", horTop: ".-", horBottom: ".-", verLeft: ["!"], verRight: ["!"] },
  "dot-dot-dash": {
    ul: "+",
    ur: "+",
    lr: "+",
    ll: "+",
    horTop: "..-",
    horBottom: "..-",
    verLeft: ["|", ":"],
    verRight: ["|", ":"],
  },
  bold: { ul: "#", ur: "#", lr: "#", ll: "#", horTop: "#", horBottom: "#", verLeft: ["#"], verRight: ["#"] },
  "bold-dash": {
    ul: "#",
    ur: "#",
    lr: "#",
    ll: "#",
    horTop: "# ",
    horBottom: "# ",
    verLeft: ["#", " "],
    verRight: ["#", " "],
  },
  double: { ul: "#", ur: "#", lr: "#", ll: "#", horTop: "=", horBottom: "=", verLeft: ["H"], verRight: ["H"] },
  "double-dash": {
    ul: "#",
    ur: "#",
    lr: "#",
    ll: "#",
    horTop: "= ",
    horBottom: "= ",
    verLeft: ['"'],
    verRight: ['"'],
  },
  wave: { ul: "+", ur: "+", lr: "+", ll: "+", horTop: "~", horBottom: "~", verLeft: ["{", "}"], verRight: ["{", "}"] },
  broad: { ul: "#", ur: "#", lr: "#", ll: "#", horTop: "#", horBottom: "#", verLeft: ["#"], verRight: ["#"] },
  wide: { ul: "#", ur: "#", lr: "#", ll: "#", horTop: "#", horBottom: "#", verLeft: ["#"], verRight: ["#"] },
  none: { ul: " ", ur: " ", lr: " ", ll: " ", horTop: " ", horBottom: " ", verLeft: [" "], verRight: [" "] },
};

function nodeBorderStyle(style: string): NodeBorderStyle {
  const s = NODE_BORDER_STYLES_ASCII[style];
  if (!s) {
    // Unknown style; Graph::Easy treats this as an error; keep it loud.
    throw new Error(`Unknown node border style '${style}'`);
  }
  return s;
}

function drawNode(node: Node, cells: CellMap, fb: Fb, absX: number, absY: number): void {
  const w = node.w ?? 0;
  const h = node.h ?? 0;
  if (w <= 0 || h <= 0) return;

  const shape = node.attribute("shape").trim().toLowerCase();
  if (shape === "invisible") return;

  if (shape === "edge") {
    // Graph::Easy::As_ascii.pm: shape=edge nodes are rendered as a dummy
    // EDGE_HOR + EDGE_LABEL_CELL edge cell.
    const style = edgeStyle("solid");
    const len = style[0].length;
    const repeatCount = Math.floor(2 + w / len);
    let line = style[0].repeat(Math.max(0, repeatCount));

    const ofs = absX % len;
    if (ofs !== 0) line = line.slice(ofs);
    if (line.length > w) line = line.slice(0, w);

    putText(fb, absX, absY + (h - 2), line);

    const align = alignName(node, "left");
    const wrap = textwrapName(node);
    const label = alignedLabel(node.labelText(), align, wrap);

    const xs = 1;
    const ys = 0;
    const ws = xs;
    const hs = 2;

    const lw = w - ws - xs;
    const lh = h - hs - ys;
    printfbAligned(fb, absX + xs, absY + ys, lw, lh, label, "bottom");
    return;
  }

  if (shape === "point") {
    // Graph::Easy::As_ascii.pm: ASCII point nodes only draw the glyph (no label).
    const glyph = pointStyle(node);
    if (glyph) {
      putText(fb, absX + 2, absY + (h - 2), glyph);
    }
    return;
  }

  // Graph::Easy::As_ascii.pm: for ASCII output, rounded nodes render with blank corners.
  // (Unicode rounded corners are only used in boxart output.)
  const rounded = shape === "rounded";

  const border = nodeBorderStyleName(node);
  const sides = nodeBorderSides(node, cells);
  const topStyle = sides.top;
  const bottomStyle = sides.bottom;
  const leftStyle = sides.left;
  const rightStyle = sides.right;

  const top = topStyle !== "none";
  const bottom = bottomStyle !== "none";
  const left = leftStyle !== "none";
  const right = rightStyle !== "none";

  const leftNeighborBorderless = (() => {
    if (node.x === undefined || node.y === undefined) return false;
    const n = nodeAt(cells, node.x - 1, node.y);
    if (!n) return false;
    const shape = n.attribute("shape").trim().toLowerCase();
    if (shape === "invisible") return false;
    return nodeBorderStyleName(n) === "none";
  })();

  // When a bordered node sits immediately to the right of a borderless node (shape=none),
  // Graph::Easy overlaps the shared border by one column. This avoids an extra padding
  // column and matches fixtures like 4_autosplit_shape.
  const drawX = border !== "none" && leftNeighborBorderless ? absX - 1 : absX;

  if (border !== "none") {
    // Horizontal borders.
    const horLine = (yOfs: number, seg: string, leftCorner?: string, rightCorner?: string): void => {
      const len = seg.length;
      const repeatCount = Math.floor(w / len) + 2;
      let line = seg.repeat(Math.max(0, repeatCount));

      // Node border patterns are not phase-shifted by absolute X; they always start
      // at the beginning of the pattern for each node.
      if (line.length > w) line = line.slice(0, w);

      if (leftCorner && line.length > 0) line = leftCorner + line.slice(1);
      if (rightCorner && w > 0) line = line.slice(0, w - 1) + rightCorner;

      putText(fb, drawX, absY + yOfs, line);
    };

    if (top) {
      const st = nodeBorderStyle(topStyle);
      const tlStyle = top && left ? mergeBordersCorner(topStyle, leftStyle) : "none";
      const trStyle = top && right ? mergeBordersCorner(topStyle, rightStyle) : "none";
      let tl = tlStyle !== "none" ? nodeBorderStyle(tlStyle).ul : undefined;
      let tr = trStyle !== "none" ? nodeBorderStyle(trStyle).ur : undefined;
      if (rounded) {
        if (tl !== undefined) tl = " ";
        if (tr !== undefined) tr = " ";
      }
      horLine(0, st.horTop, tl, tr);
    }

    if (bottom) {
      const st = nodeBorderStyle(bottomStyle);
      const blStyle = bottom && left ? mergeBordersCorner(bottomStyle, leftStyle) : "none";
      const brStyle = bottom && right ? mergeBordersCorner(bottomStyle, rightStyle) : "none";
      let bl = blStyle !== "none" ? nodeBorderStyle(blStyle).ll : undefined;
      let br = brStyle !== "none" ? nodeBorderStyle(brStyle).lr : undefined;
      if (rounded) {
        if (bl !== undefined) bl = " ";
        if (br !== undefined) br = " ";
      }
      if (leftNeighborBorderless && left) {
        // For borderless-left neighbors, Graph::Easy leaves the bottom-left corner blank.
        // Because our framebuffer writer treats spaces as no-ops, avoid writing the
        // first column at all.
        const len = st.horBottom.length;
        const repeatCount = Math.floor(w / len) + 2;
        let line = st.horBottom.repeat(Math.max(0, repeatCount));
        if (line.length > w) line = line.slice(0, w);
        if (bl && line.length > 0) line = bl + line.slice(1);
        if (br && w > 0) line = line.slice(0, w - 1) + br;
        if (line.length > 1) putText(fb, drawX + 1, absY + h - 1, line.slice(1));
      } else {
        horLine(h - 1, st.horBottom, bl, br);
      }
    }

    // Vertical borders.
    // Graph::Easy starts the repeating pattern at the first *interior* row
    // (y=1 when a top border exists), not at y=0.
    const vStart = top ? 1 : 0;
    const vEnd = bottom ? h - 2 : h - 1;

    if (left && vStart <= vEnd) {
      const st = nodeBorderStyle(leftStyle);
      let li = 0;
      for (let y = vStart; y <= vEnd; y++) {
        const lc = st.verLeft[li % st.verLeft.length] ?? " ";
        li += 1;
        putChar(fb, drawX, absY + y, lc);
      }
    }
    if (right && vStart <= vEnd) {
      const st = nodeBorderStyle(rightStyle);
      let ri = 0;
      for (let y = vStart; y <= vEnd; y++) {
        const rc = st.verRight[ri % st.verRight.length] ?? " ";
        ri += 1;
        putChar(fb, drawX + w - 1, absY + y, rc);
      }
    }

    // Corner override (only when both incident borders are present).
    // Rounded nodes intentionally keep corners blank in ASCII output.
    if (!rounded) {
      if (top && left) {
        const cs = nodeBorderStyle(mergeBordersCorner(topStyle, leftStyle));
        if (leftNeighborBorderless) {
          const st = nodeBorderStyle(leftStyle);
          putChar(fb, drawX, absY, st.verLeft[0] ?? " ");
        } else {
          putChar(fb, drawX, absY, cs.ul);
        }
      }
      if (top && right) {
        const cs = nodeBorderStyle(mergeBordersCorner(topStyle, rightStyle));
        putChar(fb, drawX + w - 1, absY, cs.ur);
      }
      if (bottom && left) {
        const cs = nodeBorderStyle(mergeBordersCorner(bottomStyle, leftStyle));
        if (leftNeighborBorderless) {
          putChar(fb, drawX, absY + h - 1, " ");
        } else {
          putChar(fb, drawX, absY + h - 1, cs.ll);
        }
      }
      if (bottom && right) {
        const cs = nodeBorderStyle(mergeBordersCorner(bottomStyle, rightStyle));
        putChar(fb, drawX + w - 1, absY + h - 1, cs.lr);
      }
    }
  }

  const align = alignName(node, "center");
  const wrap = textwrapName(node);
  const label = alignedLabel(node.labelText(), align, wrap);

  if (border === "none") {
    // Ported from Graph::Easy::As_ascii.pm::_draw_label.
    // Borderless nodes use a 1-column horizontal inset, but when they sit next to a
    // bordered neighbor we drop padding on that side to avoid double-spacing.
    let leftPad = 1;
    let rightPad = 1;
    if (node.x !== undefined && node.y !== undefined) {
      const ln = nodeAt(cells, node.x - 1, node.y);
      const rn = nodeAt(cells, node.x + 1, node.y);
      if (ln && nodeBorderStyleName(ln) !== "none") leftPad = 0;
      if (rn && nodeBorderStyleName(rn) !== "none") rightPad = 0;
    }
    const xs = leftPad;
    const ys = 0;
    const ws = w - leftPad - rightPad;
    const hs = h;
    printfbAligned(fb, drawX + xs, absY + ys, ws, hs, label, "middle");
  } else {
    // For bordered nodes, Graph::Easy uses fixed insets (independent of border
    // collapse) to keep labels aligned within record parts.
    const xs = 2;
    const ys = 0.5;
    const ws = w - 4;
    const hs = h - 2;
    printfbAligned(fb, drawX + xs, absY + ys, ws, hs, label, "middle");
  }
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
    drawNode(raw, cells, fb, absX, absY);
  }

  const lines = fb.map((r) => r.join("").replace(/\s+$/g, ""));
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const out = lines.join("\n") + "\n";

  const graphLabel = graph.graphAttributes.label?.trim() ?? "";
  if (graphLabel === "") return out;

  const labelPosRaw = graph.graphAttributes.labelpos?.trim().toLowerCase() ?? "";
  const labelPos = labelPosRaw.startsWith("b") ? "bottom" : "top";

  const contentLines = out.replace(/\n$/, "").split("\n");

  if (labelPos === "bottom") {
    const contentWidth = contentLines.reduce((m, l) => Math.max(m, l.length), 0);
    const labelWidth = graphLabel.length;
    const overallWidth = Math.max(contentWidth, labelWidth) + 2;

    // Match Graph::Easy's centering bias: when the leftover width is odd, the
    // drawing is shifted one extra space to the right.
    const contentPad = Math.max(0, Math.trunc((overallWidth - contentWidth + 1) / 2));
    const labelPad = Math.max(0, Math.trunc((overallWidth - labelWidth) / 2));

    const paddedContent = contentPad ? contentLines.map((l) => " ".repeat(contentPad) + l) : contentLines;
    const labelLine = " ".repeat(labelPad) + graphLabel;

    return [...paddedContent, "", labelLine].join("\n") + "\n";
  }

  // Center relative to the framebuffer width (pre-trim), not the trimmed line lengths.
  const width = maxX;
  const pad = Math.max(0, Math.trunc((width - graphLabel.length) / 2));
  const labelLine = " ".repeat(pad) + graphLabel;

  return ["", labelLine, "", ...contentLines].join("\n") + "\n";
}
