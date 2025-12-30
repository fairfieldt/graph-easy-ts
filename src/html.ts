import type { Graph } from "./graph";
import type { Edge } from "./edge";
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
  EDGE_HOR,
  EDGE_LABEL_CELL,
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

const SUB = 4;

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
  if (ts.includes("underline")) style += " text-decoration: underline;";
  if (ts.includes("none")) style += " text-decoration: none;";

  return style.trim();
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

function nodeCellTd(graph: Graph, node: Node): string {
  const cx = (node.cx ?? 1) * SUB;
  const cy = (node.cy ?? 1) * SUB;

  const shape = node.attribute("shape").trim().toLowerCase();
  const align = node.attribute("align") || "center";
  const labelRaw = expandEscapes(node.labelText(), graph, { node }, false);
  const label = labelToHtml(labelRaw, align);
  const title = resolveTitleForNode(graph, node);
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";

  const fill = node.attribute("fill").trim() || "white";
  const borderColor = node.attribute("bordercolor").trim() || "black";
  const borderWidthRaw = node.attribute("borderwidth").trim();
  const borderWidth = borderWidthRaw === "" ? 1 : Math.max(0, Number(borderWidthRaw) || 1);
  const borderStyle = edgeBorderStyle(node.attribute("borderstyle"));

  const textColor = node.rawAttribute("color")?.trim() || "";
  const font = node.attribute("font").trim();
  const fontSizeRaw = node.attribute("fontsize").trim();
  const textStyle = node.attribute("textstyle");

  let style = `background: ${fill};`;
  if (textColor) style += ` color: ${textColor};`;
  if (shape !== "none" && shape !== "point" && shape !== "invisible") {
    style += ` border: ${borderStyle} ${borderWidth}px ${borderColor};`;
  } else {
    style += " border: none;";
  }
  const labelStyle = textStyleFromAttributes(textColor, font, fontSizeRaw, textStyle);
  if (shape === "invisible") {
    style = "border: none; background: inherit;";
  }

  let content = label;
  const link = resolveLinkForNode(node);
  if (link) {
    const aStyle = labelStyle ? ` style="${labelStyle}"` : "";
    content = `<a href="${escapeHtml(link)}"${aStyle}>${label}</a>`;
  } else if (labelStyle) {
    style += ` ${labelStyle}`;
  }

  return `<td colspan="${cx}" rowspan="${cy}" class="node" style="${style}"${titleAttr}>${content}</td>`;
}

function groupSubcellTd(cell: GroupCell, subX: number, subY: number): string {
  const group = cell.group;
  const fill = group.attribute("fill").trim();
  const borderColor = group.attribute("bordercolor").trim() || "black";
  const borderStyle = edgeBorderStyle(group.attribute("borderstyle"));
  const borderWidthRaw = group.attribute("borderwidth").trim();
  const borderWidth = borderWidthRaw === "" ? 1 : Math.max(0, Number(borderWidthRaw) || 1);

  const cls = cell.cellClass;
  const hasTop = cls.includes("gt") || cls.includes("ga");
  const hasBottom = cls.includes("gb") || cls.includes("ga");
  const hasLeft = cls.includes("gl") || cls.includes("ga");
  const hasRight = cls.includes("gr") || cls.includes("ga");

  let style = "";
  if (fill) style += `background: ${fill};`;
  if (hasTop && subY === 0) style += `border-top: ${borderStyle} ${borderWidth}px ${borderColor};`;
  if (hasBottom && subY === SUB - 1) style += `border-bottom: ${borderStyle} ${borderWidth}px ${borderColor};`;
  if (hasLeft && subX === 0) style += `border-left: ${borderStyle} ${borderWidth}px ${borderColor};`;
  if (hasRight && subX === SUB - 1) style += `border-right: ${borderStyle} ${borderWidth}px ${borderColor};`;

  let content = "&nbsp;";
  if (cell.hasLabel && subX === 1 && subY === 1) {
    content = labelToHtml(cell.label, "left");
  }

  return `<td class="group" style="${style}">${content}</td>`;
}

function edgeSubcellTd(graph: Graph, cell: EdgeCell, subX: number, subY: number): string {
  const edge = cell.edge;
  const styleName = edge.attribute("style").trim().toLowerCase();
  if (styleName === "invisible") {
    return `<td class="edge">&nbsp;</td>`;
  }

  const borderStyle = edgeBorderStyle(styleName);
  const color = edge.attribute("color").trim() || "#000000";
  const widthRaw = edge.attribute("borderwidth").trim();
  const width = widthRaw === "" ? 2 : Math.max(1, Number(widthRaw) || 2);

  const base = cell.type & EDGE_TYPE_MASK;
  const con = edgeConnections(base);
  const hasH = con.e || con.w;
  const hasV = con.n || con.s;

  let style = "";
  if (hasH && subY === 1) style += `border-bottom: ${borderStyle} ${width}px ${color};`;
  if (hasV && subX === 1) style += `border-left: ${borderStyle} ${width}px ${color};`;

  let content = "&nbsp;";

  const arrows = cell.type & (EDGE_END_N | EDGE_END_S | EDGE_END_E | EDGE_END_W);
  const arrowStyle = edge.attribute("arrowstyle").trim().toLowerCase();

  if (arrowStyle !== "none" && arrows !== 0) {
    if ((arrows & EDGE_END_E) !== 0 && subX === SUB - 1 && subY === 1) content = "&gt;";
    else if ((arrows & EDGE_END_W) !== 0 && subX === 0 && subY === 1) content = "&lt;";
    else if ((arrows & EDGE_END_N) !== 0 && subX === 1 && subY === 0) content = "^";
    else if ((arrows & EDGE_END_S) !== 0 && subX === 1 && subY === SUB - 1) content = "v";
  }

  const title = resolveTitleForEdge(graph, edge);
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";

  if ((cell.type & EDGE_LABEL_CELL) !== 0 && subX === 1 && subY === 1) {
    const labelRaw = expandEscapes(edge.labelText(), graph, { edge }, false);
    const label = labelToHtml(labelRaw, edge.attribute("align") || "center");
    const labelColor = edge.attribute("labelcolor").trim() || color;
    const font = edge.attribute("font").trim();
    const fontSizeRaw = edge.attribute("fontsize").trim();
    const textStyle = edge.attribute("textstyle");
    const innerStyle = textStyleFromAttributes(labelColor, font, fontSizeRaw, textStyle);
    const link = resolveLinkForEdge(edge);
    const inner = innerStyle ? ` style="${innerStyle}"` : "";
    const span = `<span${inner}>${label}</span>`;
    content = link ? `<a href="${escapeHtml(link)}"${inner}>${label}</a>` : span;
  }

  return `<td class="edge" style="${style}"${titleAttr}>${content}</td>`;
}

function markSpan(occupied: Set<string>, sx: number, sy: number, w: number, h: number): void {
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      occupied.add(`${sx + dx},${sy + dy}`);
    }
  }
}

export function renderHtml(graph: Graph): string {
  if (!graph.cells) graph.layout();
  const cells = graph.cells as Map<string, Cell> | undefined;
  if (!cells || cells.size === 0) {
    return `<table class="graph-easy" style="border-collapse: collapse;"></table>\n`;
  }

  const { minX, maxX, minY, maxY } = computeBounds(cells);
  if (maxX < minX || maxY < minY) {
    return `<table class="graph-easy" style="border-collapse: collapse;"></table>\n`;
  }

  const subCols = (maxX - minX + 1) * SUB;
  const subRows = (maxY - minY + 1) * SUB;

  const occupied = new Set<string>();
  const rows: string[] = [];

  for (let sy = 0; sy < subRows; sy++) {
    const row: string[] = [];
    for (let sx = 0; sx < subCols; sx++) {
      const key = `${sx},${sy}`;
      if (occupied.has(key)) continue;

      const baseX = Math.floor(sx / SUB) + minX;
      const baseY = Math.floor(sy / SUB) + minY;
      const cell = cells.get(`${baseX},${baseY}`);

      const subX = sx % SUB;
      const subY = sy % SUB;

      if (cell instanceof Node) {
        if (subX !== 0 || subY !== 0) continue;
        const cx = (cell.cx ?? 1) * SUB;
        const cy = (cell.cy ?? 1) * SUB;
        markSpan(occupied, sx, sy, cx, cy);
        row.push(nodeCellTd(graph, cell));
        continue;
      }

      if (cell instanceof EdgeCell) {
        row.push(edgeSubcellTd(graph, cell, subX, subY));
        continue;
      }

      if (cell instanceof GroupCell) {
        row.push(groupSubcellTd(cell, subX, subY));
        continue;
      }

      if (cell instanceof NodeCell || cell instanceof EdgeCellEmpty) {
        row.push(`<td class="empty">&nbsp;</td>`);
        continue;
      }

      row.push(`<td class="empty">&nbsp;</td>`);
    }
    rows.push(`<tr>${row.join("")}</tr>`);
  }

  const css = [
    "table.graph-easy { border-collapse: collapse; }",
    "table.graph-easy td { padding: 0; vertical-align: middle; }",
    "table.graph-easy span.l { float: left; }",
    "table.graph-easy span.r { float: right; }",
  ].join("\n");

  return `<style>\n${css}\n</style>\n<table class="graph-easy">\n${rows.join("\n")}\n</table>\n`;
}
