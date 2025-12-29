import type { Graph } from "./graph";
import { EdgeCell } from "./layout/edgeCell";
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

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
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

function edgeStrokeStyle(style: string): { width: number; dash: string | undefined } {
  const s = style.trim().toLowerCase();
  if (s === "double") return { width: 2, dash: undefined };
  if (s === "bold" || s === "broad" || s === "wide") return { width: 3, dash: undefined };
  if (s === "dashed") return { width: 2, dash: "6,4" };
  if (s === "dotted") return { width: 2, dash: "1,4" };
  if (s === "dot-dash") return { width: 2, dash: "1,4,6,4" };
  if (s === "dot-dot-dash") return { width: 2, dash: "1,4,1,4,6,4" };
  if (s === "double-dash") return { width: 2, dash: "6,4" };
  if (s === "wave") return { width: 2, dash: "4,2" };
  return { width: 2, dash: undefined };
}

function computeBounds(cells: Map<string, unknown>): { minX: number; maxX: number; minY: number; maxY: number } {
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

export function renderSvg(graph: Graph): string {
  if (!graph.cells) graph.layout();
  const cells = graph.cells;
  if (!cells || cells.size === 0) {
    return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>\n`;
  }

  const { minX, maxX, minY, maxY } = computeBounds(cells);
  if (maxX < minX || maxY < minY) {
    return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>\n`;
  }

  const unit = 24;
  const pad = 12;
  const width = (maxX - minX + 1) * unit + pad * 2;
  const height = (maxY - minY + 1) * unit + pad * 2;

  const elements: string[] = [];

  // Nodes.
  for (const node of graph.nodes()) {
    if (node.x === undefined || node.y === undefined) continue;
    const shape = node.attribute("shape").trim().toLowerCase();
    if (shape === "invisible") continue;

    const cx = node.cx ?? 1;
    const cy = node.cy ?? 1;
    const x = (node.x - minX) * unit + pad;
    const y = (node.y - minY) * unit + pad;
    const w = cx * unit;
    const h = cy * unit;

    const fill = node.attribute("fill").trim() || "white";
    const borderColor = node.attribute("bordercolor").trim() || "black";
    const borderWidthRaw = node.attribute("borderwidth").trim();
    const borderWidth = borderWidthRaw === "" ? 1 : Math.max(0, Number(borderWidthRaw) || 1);

    const baseStyle = `fill="${escapeXml(fill)}" stroke="${escapeXml(borderColor)}" stroke-width="${borderWidth}"`;

    if (shape === "circle" || shape === "ellipse") {
      elements.push(
        `  <ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}" ${baseStyle} />`
      );
    } else if (shape === "rounded") {
      elements.push(`  <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" ry="10" ${baseStyle} />`);
    } else if (shape === "point") {
      elements.push(
        `  <circle cx="${x + w / 2}" cy="${y + h / 2}" r="${Math.max(2, borderWidth)}" ${baseStyle} />`
      );
    } else if (shape === "none") {
      // No border/box.
    } else {
      elements.push(`  <rect x="${x}" y="${y}" width="${w}" height="${h}" ${baseStyle} />`);
    }

    const label = node.labelText();
    if (label !== "") {
      const align = node.attribute("align") || "center";
      const font = node.attribute("font").trim();
      const fontSizeRaw = node.attribute("fontsize").trim();
      const fontSize = fontSizeRaw === "" ? 12 : Number(fontSizeRaw) || 12;
      const color = node.attribute("color").trim() || "black";

      const { lines, aligns } = parseLabel(label, align);
      const lineHeight = fontSize * 1.2;
      const totalHeight = lines.length * lineHeight;
      const startY = y + h / 2 - totalHeight / 2 + lineHeight * 0.8;

      for (let i = 0; i < lines.length; i++) {
        const line = escapeXml(lines[i]);
        const al = aligns[i] ?? "c";
        let textAnchor = "middle";
        let tx = x + w / 2;
        if (al === "l") {
          textAnchor = "start";
          tx = x + 4;
        } else if (al === "r") {
          textAnchor = "end";
          tx = x + w - 4;
        }
        const ty = startY + i * lineHeight;
        const fontAttr = font ? ` font-family="${escapeXml(font)}"` : "";
        elements.push(
          `  <text x="${tx}" y="${ty}" fill="${escapeXml(color)}" font-size="${fontSize}" text-anchor="${textAnchor}"${fontAttr}>${line}</text>`
        );
      }
    }
  }

  // Edges.
  const edgeLines: string[] = [];
  const edgeLabels: string[] = [];

  for (const edge of graph.edges) {
    const styleName = edge.attribute("style").trim().toLowerCase();
    if (styleName === "invisible") continue;

    const { width: strokeWidth, dash } = edgeStrokeStyle(styleName);
    const color = edge.attribute("color").trim() || "#000000";
    const arrowStyle = edge.attribute("arrowstyle").trim().toLowerCase();
    const markerEnd = arrowStyle === "none" ? "" : ' marker-end="url(#arrow)"';

    for (const cell of edge.cells) {
      const base = cell.type & EDGE_TYPE_MASK;
      const con = edgeConnections(base);
      const cx = (cell.x - minX + 0.5) * unit + pad;
      const cy = (cell.y - minY + 0.5) * unit + pad;

      const dirs: Array<{ dx: number; dy: number; flag: number; marker: string }> = [];
      if (con.n) dirs.push({ dx: 0, dy: -unit / 2, flag: EDGE_END_N, marker: markerEnd });
      if (con.s) dirs.push({ dx: 0, dy: unit / 2, flag: EDGE_END_S, marker: markerEnd });
      if (con.w) dirs.push({ dx: -unit / 2, dy: 0, flag: EDGE_END_W, marker: markerEnd });
      if (con.e) dirs.push({ dx: unit / 2, dy: 0, flag: EDGE_END_E, marker: markerEnd });

      for (const d of dirs) {
        const x2 = cx + d.dx;
        const y2 = cy + d.dy;
        const hasEnd = (cell.type & d.flag) !== 0;
        const marker = hasEnd ? d.marker : "";
        const dashAttr = dash ? ` stroke-dasharray="${dash}"` : "";
        edgeLines.push(
          `  <line x1="${cx}" y1="${cy}" x2="${x2}" y2="${y2}" stroke="${escapeXml(
            color
          )}" color="${escapeXml(color)}" stroke-width="${strokeWidth}" stroke-linecap="square"${dashAttr}${marker} />`
        );
      }

      if ((cell.type & EDGE_LABEL_CELL) !== 0) {
        const label = edge.labelText();
        if (label !== "") {
          const fontSizeRaw = edge.attribute("fontsize").trim();
          const fontSize = fontSizeRaw === "" ? 12 : Number(fontSizeRaw) || 12;
          const labelColor = edge.attribute("labelcolor").trim() || color;
          const align = edge.attribute("align") || "center";
          const { lines } = parseLabel(label, align);
          const lineHeight = fontSize * 1.2;
          const totalHeight = lines.length * lineHeight;
          const startY = cy - totalHeight / 2 + lineHeight * 0.8;

          for (let i = 0; i < lines.length; i++) {
            const line = escapeXml(lines[i]);
            const ty = startY + i * lineHeight;
            edgeLabels.push(
              `  <text x="${cx}" y="${ty}" fill="${escapeXml(labelColor)}" font-size="${fontSize}" text-anchor="middle">${line}</text>`
            );
          }
        }
      }
    }
  }

  const arrowDef = `
  <defs>
    <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L8,4 L0,8 z" fill="currentColor" />
    </marker>
  </defs>`;

  const out = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    arrowDef,
    ...edgeLines,
    ...edgeLabels,
    ...elements,
    `</svg>\n`,
  ];

  return out.join("\n");
}
