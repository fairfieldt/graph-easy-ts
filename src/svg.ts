import type { Graph } from "./graph";
import type { Edge } from "./edge";
import { EdgeCell } from "./layout/edgeCell";
import { GroupCell } from "./layout/groupCell";
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

function fontSizeToSvg(raw: string, fallback: number): number {
  if (!raw) return fallback;
  const v = Number(raw);
  if (Number.isFinite(v)) return v;
  const m = /(\d+(?:\.\d+)?)/.exec(raw);
  if (m) return Number(m[1]);
  return fallback;
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

function edgeStrokeStyle(style: string): { width: number; dash: string | undefined; double: boolean } {
  const s = style.trim().toLowerCase();
  if (s === "double") return { width: 1.5, dash: undefined, double: true };
  if (s === "double-dash") return { width: 1.5, dash: "6,4", double: true };
  if (s === "bold" || s === "broad" || s === "wide") return { width: 3, dash: undefined, double: false };
  if (s === "dashed") return { width: 2, dash: "6,4", double: false };
  if (s === "dotted") return { width: 2, dash: "1,4", double: false };
  if (s === "dot-dash") return { width: 2, dash: "1,4,6,4", double: false };
  if (s === "dot-dot-dash") return { width: 2, dash: "1,4,1,4,6,4", double: false };
  if (s === "wave") return { width: 2, dash: "4,2", double: false };
  return { width: 2, dash: undefined, double: false };
}

function arrowMarker(raw: string): string {
  const v = raw.trim().toLowerCase();
  if (v === "none") return "";
  if (v === "open" || v === "") return 'marker-end="url(#arrow-open)"';
  return 'marker-end="url(#arrow-filled)"';
}

function emitLine(
  out: string[],
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: string,
  spec: { width: number; dash?: string; double: boolean },
  marker: string,
  title?: string
): void {
  const dashAttr = spec.dash ? ` stroke-dasharray="${spec.dash}"` : "";
  const base = (ax: number, ay: number, bx: number, by: number, withMarker: boolean): string => {
    const markerAttr = withMarker && marker ? ` ${marker}` : "";
    const line = `  <line x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}" stroke="${escapeXml(
      color
    )}" color="${escapeXml(color)}" stroke-width="${spec.width}" stroke-linecap="square"${dashAttr}${markerAttr}`;
    if (title) {
      return `${line}><title>${escapeXml(title)}</title></line>`;
    }
    return `${line} />`;
  };

  if (spec.double) {
    if (y1 === y2) {
      const offset = 2;
      out.push(base(x1, y1 - offset, x2, y2 - offset, false));
      out.push(base(x1, y1 + offset, x2, y2 + offset, true));
      return;
    }
    if (x1 === x2) {
      const offset = 2;
      out.push(base(x1 - offset, y1, x2 - offset, y2, false));
      out.push(base(x1 + offset, y1, x2 + offset, y2, true));
      return;
    }
  }

  out.push(base(x1, y1, x2, y2, true));
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

  const groupRects: string[] = [];
  const groupBorders: string[] = [];
  const groupLabels: string[] = [];
  const elements: string[] = [];

  for (const cell of cells.values()) {
    if (!(cell instanceof GroupCell)) continue;
    if (cell.x === undefined || cell.y === undefined) continue;

    const gx = (cell.x - minX) * unit + pad;
    const gy = (cell.y - minY) * unit + pad;

    const fill = cell.group.attribute("fill").trim();
    if (fill && fill !== "inherit") {
      groupRects.push(`  <rect x="${gx}" y="${gy}" width="${unit}" height="${unit}" fill="${escapeXml(fill)}" />`);
    }

    const borderStyle = cell.group.attribute("borderstyle").trim() || "solid";
    const borderColor = cell.group.attribute("bordercolor").trim() || "black";
    const borderWidthRaw = cell.group.attribute("borderwidth").trim();
    const borderWidth = borderWidthRaw === "" ? 1 : Math.max(0, Number(borderWidthRaw) || 1);

    const spec = edgeStrokeStyle(borderStyle);
    spec.width = borderWidth;

    const cls = cell.cellClass;
    const hasTop = cls.includes("gt") || cls.includes("ga");
    const hasBottom = cls.includes("gb") || cls.includes("ga");
    const hasLeft = cls.includes("gl") || cls.includes("ga");
    const hasRight = cls.includes("gr") || cls.includes("ga");

    if (hasTop) emitLine(groupBorders, gx, gy, gx + unit, gy, borderColor, spec, "", "");
    if (hasBottom) emitLine(groupBorders, gx, gy + unit, gx + unit, gy + unit, borderColor, spec, "", "");
    if (hasLeft) emitLine(groupBorders, gx, gy, gx, gy + unit, borderColor, spec, "", "");
    if (hasRight) emitLine(groupBorders, gx + unit, gy, gx + unit, gy + unit, borderColor, spec, "", "");

    if (cell.hasLabel) {
      const label = cell.label;
      if (label !== "") {
        const fontSize = 12;
        const lx = gx + unit / 2;
        const ly = gy + unit / 2 + fontSize * 0.4;
        groupLabels.push(
          `  <text x="${lx}" y="${ly}" fill="black" font-size="${fontSize}" text-anchor="middle">${escapeXml(
            label
          )}</text>`
        );
      }
    }
  }

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

    const parts: string[] = [];
    const title = resolveTitleForNode(graph, node);
    if (title) parts.push(`    <title>${escapeXml(title)}</title>`);

    if (shape === "circle" || shape === "ellipse") {
      parts.push(
        `    <ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}" ${baseStyle} />`
      );
    } else if (shape === "rounded") {
      parts.push(`    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" ry="10" ${baseStyle} />`);
    } else if (shape === "point") {
      parts.push(
        `    <circle cx="${x + w / 2}" cy="${y + h / 2}" r="${Math.max(2, borderWidth)}" ${baseStyle} />`
      );
    } else if (shape === "none") {
      // No border/box.
    } else {
      parts.push(`    <rect x="${x}" y="${y}" width="${w}" height="${h}" ${baseStyle} />`);
    }

    const labelRaw = expandEscapes(node.labelText(), graph, { node }, false);
    if (labelRaw !== "") {
      const align = node.attribute("align") || "center";
      const font = node.attribute("font").trim();
      const fontSizeRaw = node.attribute("fontsize").trim();
      const fontSize = fontSizeToSvg(fontSizeRaw, 12);
      const color = node.attribute("color").trim() || "black";
      const textStyle = node.attribute("textstyle").trim().toLowerCase();

      const { lines, aligns } = parseLabel(labelRaw, align);
      const lineHeight = fontSize * 1.2;
      const totalHeight = lines.length * lineHeight;
      const startY = y + h / 2 - totalHeight / 2 + lineHeight * 0.8;

      const fontAttr = font ? ` font-family="${escapeXml(font)}"` : "";
      const weightAttr = textStyle.includes("bold") ? ` font-weight="bold"` : "";
      const styleAttr = textStyle.includes("italic") ? ` font-style="italic"` : "";
      const decoAttr = textStyle.includes("underline")
        ? ` text-decoration="underline"`
        : textStyle.includes("none")
        ? ` text-decoration="none"`
        : "";

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
        parts.push(
          `    <text x="${tx}" y="${ty}" fill="${escapeXml(color)}" font-size="${fontSize}" text-anchor="${textAnchor}"${fontAttr}${weightAttr}${styleAttr}${decoAttr}>${line}</text>`
        );
      }
    }

    const group = `  <g>\n${parts.join("\n")}\n  </g>`;
    const link = resolveLinkForNode(node);
    if (link) {
      elements.push(`  <a xlink:href="${escapeXml(link)}">${group}</a>`);
    } else {
      elements.push(group);
    }
  }

  // Edges.
  const edgeLines: string[] = [];
  const edgeLabels: string[] = [];

  for (const edge of graph.edges) {
    const styleName = edge.attribute("style").trim().toLowerCase();
    if (styleName === "invisible") continue;

    const spec = edgeStrokeStyle(styleName);
    const color = edge.attribute("color").trim() || "#000000";
    const marker = arrowMarker(edge.attribute("arrowstyle"));
    const title = resolveTitleForEdge(graph, edge);

    for (const cell of edge.cells) {
      const base = cell.type & EDGE_TYPE_MASK;
      const con = edgeConnections(base);
      const cx = (cell.x - minX + 0.5) * unit + pad;
      const cy = (cell.y - minY + 0.5) * unit + pad;

      const dirs: Array<{ dx: number; dy: number; flag: number; marker: string }> = [];
      if (con.n) dirs.push({ dx: 0, dy: -unit / 2, flag: EDGE_END_N, marker });
      if (con.s) dirs.push({ dx: 0, dy: unit / 2, flag: EDGE_END_S, marker });
      if (con.w) dirs.push({ dx: -unit / 2, dy: 0, flag: EDGE_END_W, marker });
      if (con.e) dirs.push({ dx: unit / 2, dy: 0, flag: EDGE_END_E, marker });

      for (const d of dirs) {
        const x2 = cx + d.dx;
        const y2 = cy + d.dy;
        const hasEnd = (cell.type & d.flag) !== 0;
        emitLine(edgeLines, cx, cy, x2, y2, color, spec, hasEnd ? d.marker : "", title || undefined);
      }

      if ((cell.type & EDGE_LABEL_CELL) !== 0) {
        const label = expandEscapes(edge.labelText(), graph, { edge }, false);
        if (label !== "") {
          const font = edge.attribute("font").trim();
          const fontSizeRaw = edge.attribute("fontsize").trim();
          const fontSize = fontSizeToSvg(fontSizeRaw, 12);
          const labelColor = edge.attribute("labelcolor").trim() || color;
          const textStyle = edge.attribute("textstyle").trim().toLowerCase();
          const align = edge.attribute("align") || "center";
          const { lines } = parseLabel(label, align);
          const lineHeight = fontSize * 1.2;
          const totalHeight = lines.length * lineHeight;
          const startY = cy - totalHeight / 2 + lineHeight * 0.8;

          for (let i = 0; i < lines.length; i++) {
            const line = escapeXml(lines[i]);
            const ty = startY + i * lineHeight;
            const weightAttr = textStyle.includes("bold") ? ` font-weight="bold"` : "";
            const styleAttr = textStyle.includes("italic") ? ` font-style="italic"` : "";
            const decoAttr = textStyle.includes("underline")
              ? ` text-decoration="underline"`
              : textStyle.includes("none")
              ? ` text-decoration="none"`
              : "";
            const link = resolveLinkForEdge(edge);
            const fontAttr = font ? ` font-family="${escapeXml(font)}"` : "";
            const text = `  <text x="${cx}" y="${ty}" fill="${escapeXml(
            labelColor
          )}" font-size="${fontSize}" text-anchor="middle"${fontAttr}${weightAttr}${styleAttr}${decoAttr}>${line}</text>`;
            edgeLabels.push(link ? `  <a xlink:href="${escapeXml(link)}">${text}</a>` : text);
          }
        }
    }
  }
  }

  const arrowDef = `
  <defs>
    <marker id="arrow-filled" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L8,4 L0,8 z" fill="currentColor" />
    </marker>
    <marker id="arrow-open" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L8,4 L0,8 z" fill="none" stroke="currentColor" stroke-width="1.2" />
    </marker>
  </defs>`;

  const out = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    arrowDef,
    ...groupRects,
    ...groupBorders,
    ...edgeLines,
    ...edgeLabels,
    ...elements,
    ...groupLabels,
    `</svg>\n`,
  ];

  return out.join("\n");
}
