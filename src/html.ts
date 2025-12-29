import type { Graph } from "./graph";
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
  EDGE_END_N,
  EDGE_END_S,
  EDGE_END_W,
  EDGE_LABEL_CELL,
  EDGE_HOR,
  EDGE_N_E,
  EDGE_N_E_W,
  EDGE_N_W,
  EDGE_N_W_S,
  EDGE_S_E,
  EDGE_S_E_W,
  EDGE_S_W,
  EDGE_S_W_N,
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

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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

function edgeBorderStyle(raw: string): string {
  const style = raw.trim().toLowerCase();
  if (style === "" || style === "solid") return "solid";
  if (style === "invisible" || style === "none") return "none";
  if (style.includes("double")) return "double";
  if (style.includes("dash")) return "dashed";
  if (style.includes("dot")) return "dotted";
  return "solid";
}

function edgeConnections(baseType: number): { n: boolean; s: boolean; e: boolean; w: boolean } {
  switch (baseType) {
    case EDGE_CROSS:
      return { n: true, s: true, e: true, w: true };
    case EDGE_HOR:
      return { n: false, s: false, e: true, w: true };
    case EDGE_VER:
      return { n: true, s: true, e: false, w: false };
    case EDGE_N_E:
      return { n: true, s: false, e: true, w: false };
    case EDGE_N_W:
      return { n: true, s: false, e: false, w: true };
    case EDGE_S_E:
      return { n: false, s: true, e: true, w: false };
    case EDGE_S_W:
      return { n: false, s: true, e: false, w: true };
    case EDGE_S_E_W:
      return { n: false, s: true, e: true, w: true };
    case EDGE_N_E_W:
      return { n: true, s: false, e: true, w: true };
    case EDGE_E_N_S:
      return { n: true, s: true, e: true, w: false };
    case EDGE_W_N_S:
      return { n: true, s: true, e: false, w: true };
    case EDGE_N_W_S:
      return { n: true, s: true, e: false, w: true };
    case EDGE_S_W_N:
      return { n: true, s: true, e: false, w: true };
    case EDGE_E_S_W:
      return { n: false, s: true, e: true, w: true };
    case EDGE_W_S_E:
      return { n: false, s: true, e: true, w: true };
    default:
      return { n: false, s: false, e: false, w: false };
  }
}

function arrowForDirection(dir: "n" | "s" | "e" | "w"): string {
  if (dir === "n") return "^";
  if (dir === "s") return "v";
  if (dir === "w") return "&lt;";
  return "&gt;";
}

function cellSpan(cell: Cell): { cx: number; cy: number } {
  if (cell instanceof Node) {
    return { cx: cell.cx ?? 1, cy: cell.cy ?? 1 };
  }
  return { cx: 1, cy: 1 };
}

function nodeCellHtml(node: Node): string {
  const shape = node.attribute("shape").trim().toLowerCase();
  if (shape === "invisible") {
    return "";
  }

  const align = node.attribute("align") || "center";
  const label = node.labelText();
  const content = labelToHtml(label, align);

  const fill = node.attribute("fill").trim() || "white";
  const borderColor = node.attribute("bordercolor").trim() || "black";
  const borderWidthRaw = node.attribute("borderwidth").trim();
  const borderWidth = borderWidthRaw === "" ? 1 : Math.max(0, Number(borderWidthRaw) || 1);
  const borderStyle = edgeBorderStyle(node.attribute("borderstyle"));

  const textColor = node.attribute("color").trim() || "black";
  const font = node.attribute("font").trim();
  const fontSizeRaw = node.attribute("fontsize").trim();
  const fontSize = fontSizeRaw === "" ? "" : `${fontSizeRaw}px`;

  let style = `background: ${fill}; color: ${textColor};`;
  if (shape !== "none" && shape !== "point") {
    style += ` border: ${borderStyle} ${borderWidth}px ${borderColor};`;
  } else {
    style += " border: none;";
  }
  if (font) style += ` font-family: ${font};`;
  if (fontSize) style += ` font-size: ${fontSize};`;

  return `<div style="${style}">${content}</div>`;
}

function edgeCellHtml(cell: EdgeCell): string {
  const base = cell.type & EDGE_TYPE_MASK;
  const edge = cell.edge;
  const styleName = edge.attribute("style").trim().toLowerCase();
  if (styleName === "invisible") return "";

  const borderStyle = edgeBorderStyle(styleName);
  const color = edge.attribute("color").trim() || "#000000";
  const widthRaw = edge.attribute("borderwidth").trim();
  const width = widthRaw === "" ? 2 : Math.max(1, Number(widthRaw) || 2);

  const con = edgeConnections(base);
  let style = "";
  const hasH = con.e || con.w;
  const hasV = con.n || con.s;
  if (hasH) style += `border-bottom: ${borderStyle} ${width}px ${color};`;
  if (hasV) style += `border-left: ${borderStyle} ${width}px ${color};`;

  let content = "&nbsp;";
  if ((cell.type & EDGE_LABEL_CELL) !== 0) {
    const label = edge.labelText();
    const align = edge.attribute("align") || "center";
    const labelColor = edge.attribute("labelcolor").trim() || color;
    const font = edge.attribute("font").trim();
    const fontSizeRaw = edge.attribute("fontsize").trim();
    const fontSize = fontSizeRaw === "" ? "" : `${fontSizeRaw}px`;
    let innerStyle = `color: ${labelColor};`;
    if (font) innerStyle += ` font-family: ${font};`;
    if (fontSize) innerStyle += ` font-size: ${fontSize};`;
    content = `<span style="${innerStyle}">${labelToHtml(label, align)}</span>`;
  } else {
    const arrows = cell.type & (EDGE_END_N | EDGE_END_S | EDGE_END_E | EDGE_END_W);
    if (arrows !== 0 && edge.attribute("arrowstyle").trim().toLowerCase() !== "none") {
      if (arrows & EDGE_END_N) content = arrowForDirection("n");
      else if (arrows & EDGE_END_S) content = arrowForDirection("s");
      else if (arrows & EDGE_END_W) content = arrowForDirection("w");
      else if (arrows & EDGE_END_E) content = arrowForDirection("e");
    }
  }

  return `<div style="${style} text-align: center;">${content}</div>`;
}

function groupCellHtml(cell: GroupCell): string {
  const group = cell.group;
  const label = cell.hasLabel ? labelToHtml(cell.label, "left") : "&nbsp;";
  const fill = group.attribute("fill").trim() || "transparent";
  const borderColor = group.attribute("bordercolor").trim() || "black";
  const borderStyle = edgeBorderStyle(group.attribute("borderstyle"));
  const borderWidthRaw = group.attribute("borderwidth").trim();
  const borderWidth = borderWidthRaw === "" ? 1 : Math.max(0, Number(borderWidthRaw) || 1);

  const style = `background: ${fill}; border: ${borderStyle} ${borderWidth}px ${borderColor};`;
  return `<div style="${style}">${label}</div>`;
}

function cellHtml(cell: Cell | undefined): string {
  if (!cell) return "";
  if (cell instanceof Node) return nodeCellHtml(cell);
  if (cell instanceof EdgeCell) return edgeCellHtml(cell);
  if (cell instanceof GroupCell) return groupCellHtml(cell);
  return "";
}

function cellKey(x: number, y: number): string {
  return `${x},${y}`;
}

function computeBounds(cells: Map<string, Cell>): { minX: number; maxX: number; minY: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const cell of cells.values()) {
    const x = (cell as { x?: number }).x;
    const y = (cell as { y?: number }).y;
    if (x === undefined || y === undefined) continue;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return { minX: 0, minY: 0, maxX: -1, maxY: -1 };
  }

  return { minX, minY, maxX, maxY };
}

export function renderHtml(graph: Graph): string {
  if (!graph.cells) graph.layout();
  const cells = graph.cells;
  if (!cells || cells.size === 0) {
    return `<table class="graph-easy" style="border-collapse: collapse;"></table>\n`;
  }

  const { minX, maxX, minY, maxY } = computeBounds(cells as Map<string, Cell>);
  if (maxX < minX || maxY < minY) {
    return `<table class="graph-easy" style="border-collapse: collapse;"></table>\n`;
  }

  const skipped = new Set<string>();
  const rows: string[] = [];

  for (let y = minY; y <= maxY; y++) {
    const cols: string[] = [];
    for (let x = minX; x <= maxX; x++) {
      const key = cellKey(x, y);
      if (skipped.has(key)) continue;

      const cell = cells.get(key) as Cell | undefined;
      if (cell instanceof NodeCell || cell instanceof EdgeCellEmpty) {
        cols.push('<td style="padding:0;"></td>');
        continue;
      }

      const { cx, cy } = cell ? cellSpan(cell) : { cx: 1, cy: 1 };
      if (cell && (cx > 1 || cy > 1)) {
        for (let dy = 0; dy < cy; dy++) {
          for (let dx = 0; dx < cx; dx++) {
            if (dx === 0 && dy === 0) continue;
            skipped.add(cellKey(x + dx, y + dy));
          }
        }
      }

      const content = cellHtml(cell);
      const spanAttrs: string[] = [];
      if (cell && cx > 1) spanAttrs.push(`colspan="${cx}"`);
      if (cell && cy > 1) spanAttrs.push(`rowspan="${cy}"`);

      cols.push(`<td ${spanAttrs.join(" ")} style="padding:0;">${content || "&nbsp;"}</td>`);
    }
    rows.push(`<tr>${cols.join("")}</tr>`);
  }

  const css = [
    "table.graph-easy { border-collapse: collapse; }",
    "table.graph-easy td { padding: 0; vertical-align: middle; }",
    "table.graph-easy span.l { float: left; }",
    "table.graph-easy span.r { float: right; }",
  ].join("\n");

  return `<style>\n${css}\n</style>\n<table class="graph-easy">\n${rows.join("\n")}\n</table>\n`;
}
