import type { Edge } from "./edge";
import type { Graph } from "./graph";
import type { Group } from "./group";
import type { Node } from "./node";

const GRAPH_EASY_VERSION_FOR_BANNER = "0.76";

const RESERVED_KEYWORDS = new Set(["subgraph", "graph", "node", "edge", "strict"]);

function directionAsNumber(raw: string | undefined): 0 | 90 | 180 | 270 {
  if (!raw) return 90;
  const v = raw.trim().toLowerCase();
  if (v === "0" || v === "90" || v === "180" || v === "270") return Number(v) as 0 | 90 | 180 | 270;
  if (v === "east" || v === "right" || v === "forward" || v === "front") return 90;
  if (v === "west" || v === "left" || v === "back") return 270;
  if (v === "north" || v === "up") return 0;
  if (v === "south" || v === "down") return 180;
  // Default in Perl is east.
  return 90;
}

function graphName(graph: Graph): string {
  const gid = (graph.graphAttributes.gid ?? "0").trim() || "0";
  return `GRAPH_${gid}`;
}

function graphType(graph: Graph): "digraph" | "graph" {
  const t = (graph.graphAttributes.type ?? "directed").trim().toLowerCase();
  return t === "undirected" ? "graph" : "digraph";
}

function edgeOperator(type: "digraph" | "graph"): "->" | "--" {
  return type === "digraph" ? "->" : "--";
}

function escapeGraphvizId(name: string): string {
  // Ported from Graph::Easy::Node::as_graphviz_txt (see As_graphviz.pm).
  // Escape special chars in name (including doublequote!)
  let s = name.replace(/[\[\]\(\)\{\}"]/g, (m) => `\\${m}`);

  // Quote if necessary:
  // 2, A, A2, "2A", "2 A" etc
  if (!/^([a-zA-Z_]+|\d+)$/.test(s) || RESERVED_KEYWORDS.has(s.toLowerCase())) {
    s = `"${s}"`;
  }

  return s;
}

function graphvizQuoteIfNeeded(value: string): string {
  // `_att_as_graphviz` quotes values that are not purely alnum.
  const v = value.replace(/\n/g, "\\n");
  if (!/^[a-z0-9A-Z]+$/.test(v)) {
    return `"${v}"`;
  }
  return v;
}

function collapseGraphvizLabelWhitespace(graph: Graph | undefined, raw: string): string {
  // Graph::Easy collapses internal whitespace in labels by default.
  // (DOT/GDL parsing can opt into preserving exact spacing via preserveLabelWhitespace.)
  if (!graph || graph.preserveLabelWhitespace) return raw;
  return raw.trim().replace(/\s+/g, " ");
}

function expandGraphvizNodeLabelEscapes(node: Node, rawLabel: string): string {
  const graphTitle = (node.graph?.graphAttributes.title ?? "").trim();
  // Use string replacement (not regex) to avoid backslash-escape ambiguity.
  let out = rawLabel;
  if (graphTitle !== "") {
    out = out.split("\\G").join(graphTitle);
  }
  out = out.split("\\N").join(node.id);
  return out;
}

function escapeGraphvizGroupName(name: string): string {
  // Ported from Graph::Easy::As_graphviz::_as_graphviz_group.
  return name.replace(/[\[\]\(\)\{\}\#"]/g, (m) => `\\${m}`);
}

function attAsGraphviz(out: Record<string, string>): string {
  // Port of Graph::Easy::As_graphviz::_att_as_graphviz.
  let att = "";
  const keys = Object.keys(out).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  for (const key of keys) {
    const v = graphvizQuoteIfNeeded(out[key]);
    att += `  ${key}=${v},\n`;
  }

  // remove last ","
  att = att.replace(/,\n$/, " ");

  if (att !== "") {
    // the following makes short, single definitions to fit on one line
    if (!/\n[^\n]*\n/.test(att) && att.length < 40) {
      att = att.replace(/\n/, " ");
      att = att.replace(/( )+/g, " ");
    } else {
      att = att.replace(/\n/g, "\n  ");
      att = `\n  ${att}`;
    }
  }

  return att;
}

function remapArrowStyleForGraphviz(style: string | undefined): { name: "arrowhead" | "arrowtail"; value: string } {
  // Port of _graphviz_remap_arrow_style + caller logic.
  // Perl defaults to Graph::Easy's default arrowstyle, which is `open`.
  // (If the graph overrides it, we remap accordingly.)
  let s = "open";
  if (style !== undefined) {
    const v = style.trim().toLowerCase();
    if (v === "none" || v === "open") s = v;
    else if (v === "closed") s = "empty";
    else s = "normal";
  }

  return { name: "arrowhead", value: s };
}

function graphvizInlineValue(attr: string, value: string): string {
  // Ported from Graph::Easy::As_graphviz.pm attribute emission rules.
  // HTML-like Graphviz labels must not be quoted/escaped.
  if (attr === "label" && value.startsWith("<<") && value.endsWith(">>")) {
    return value;
  }

  const v = value.replace(/"/g, "\\\"");
  if (attr === "URL") return `"${v}"`;
  if (/^[a-z0-9A-Z]+$/.test(v)) return v;
  return `"${v}"`;
}

function htmlEscapeGraphvizLabelText(text: string): string {
  // Keep this minimal: enough for record-node cell content.
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeGraphvizPortComponent(raw: string): string {
  // Ported from Graph::Easy::As_graphviz::_html_like_label: only escape quotes.
  return raw.replace(/"/g, "\\\"");
}

function graphvizPortRef(rootName: string, portName: string): string {
  // Ported from Graph::Easy::As_graphviz::_html_like_label:
  //   $n->{_graphviz_portname} = '"' . $name . '":"' . $portname . '"';
  const root = escapeGraphvizPortComponent(rootName);
  const port = escapeGraphvizPortComponent(portName);
  return `"${root}":"${port}"`;
}

type HtmlLikePlacementCell =
  | {
      kind: "node";
      node: Node;
    }
  | {
      kind: "filler";
    };

function htmlLikeLabelForRelativePlacementNode(root: Node, portMap: Map<Node, string>): string {
  const sizeOf = (n: Node): { cx: number; cy: number } => {
    if (n.cx !== undefined && n.cy !== undefined) {
      return { cx: n.cx, cy: n.cy };
    }

    const parseDim = (raw: string): number => {
      const trimmed = raw.trim();
      if (trimmed === "") return 1;
      const num = Number(trimmed);
      if (!Number.isFinite(num)) {
        throw new Error(`Invalid node dimension: '${raw}'`);
      }
      const abs = Math.abs(num);
      return abs === 0 ? 1 : abs;
    };

    const cy = parseDim(n.attribute("rows") || "1");
    const cx = parseDim(n.attribute("columns") || "1");
    return { cx, cy };
  };

  const cells = new Map<string, HtmlLikePlacementCell>();

  const ensureRectFree = (x: number, y: number, cx: number, cy: number): void => {
    for (let dx = 0; dx < cx; dx++) {
      for (let dy = 0; dy < cy; dy++) {
        const key = `${x + dx},${y + dy}`;
        if (cells.has(key)) {
          throw new Error(`Relative-placement HTML label overlap at ${key} under '${root.id}'`);
        }
      }
    }
  };

  const placeNodeRect = (n: Node, x: number, y: number): void => {
    const { cx, cy } = sizeOf(n);
    ensureRectFree(x, y, cx, cy);

    cells.set(`${x},${y}`, { kind: "node", node: n });
    for (let dx = 0; dx < cx; dx++) {
      for (let dy = 0; dy < cy; dy++) {
        if (dx === 0 && dy === 0) continue;
        cells.set(`${x + dx},${y + dy}`, { kind: "filler" });
      }
    }
  };

  const placeChildren = (n: Node, x: number, y: number): void => {
    const { cx, cy } = sizeOf(n);

    const children = [...n.children.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const child of children) {
      const baseDx = child.dx > 0 ? cx - 1 : 0;
      const baseDy = child.dy > 0 ? cy - 1 : 0;
      placeChildren(child, x + baseDx + child.dx, y + baseDy + child.dy);
    }

    placeNodeRect(n, x, y);
  };

  placeChildren(root, 0, 0);

  const keys = [...cells.keys()].sort((a, b) => {
    const [ax, ay] = a.split(",").map((v) => Number(v));
    const [bx, by] = b.split(",").map((v) => Number(v));
    return ay - by || ax - bx;
  });

  // Ported from Graph::Easy::As_graphviz::_html_like_label.
  let label = '<<TABLE BORDER="0"><TR>';
  let oldY = 0;
  let oldX = 0;

  for (const key of keys) {
    const cell = cells.get(key);
    if (!cell) continue;
    const [x, y] = key.split(",").map((v) => Number(v));

    if (y > oldY) {
      label += "</TR><TR>";
      oldX = 0;
    }

    let l = "";
    let portname = "";
    let cx: number | undefined;
    let cy: number | undefined;

    if (cell.kind === "node") {
      l = cell.node.labelText().replace(/\n/g, "<BR/>");
      // Perl uses `$n->{autosplit_portname}` (and only falls back to label if it
      // is undefined). This matters for autosplit/record parts where the portname
      // is intentionally the empty string (PORT="").
      const rawPortname = cell.node.rawAttribute("autosplit_portname");
      portname = rawPortname !== undefined ? rawPortname : cell.node.labelText();
      ({ cx, cy } = sizeOf(cell.node));
      portMap.set(cell.node, graphvizPortRef(root.id, portname));
    }

    const escapedPort = escapeGraphvizPortComponent(portname);

    if (x - oldX > 0) {
      label += `<TD BORDER="0" COLSPAN="${x - oldX}"></TD>`;
    }

    label += `<TD BORDER="1" PORT="${escapedPort}">${l}</TD>`;
    oldY = y + (cy ?? 0);
    oldX = x + (cx ?? 0);
  }

  label += "</TR></TABLE>>";
  return label;
}

function htmlLikeLabelForRecordNode(node: Node): string | undefined {
  // Ported from Graph::Easy::Node::_html_like_label call site in As_graphviz.pm.
  // We only generate this for autosplit record roots.
  if (node.origin) return undefined;
  if (!node.autosplitLabel) return undefined;
  if (node.children.size === 0) return undefined;

  // DOT-derived record nodes preserve per-field port names (e.g. <f1> / <f2>) in
  // Graphviz output. Perl renders these as HTML-like labels with PORT set to the
  // record port name (and uses a single-space PORT for unnamed fields).
  if (node.rawAttribute("autosplit_from_dot") === "1") {
    const graph = node.graph;
    if (!graph) {
      throw new Error(`htmlLikeLabelForRecordNode: missing graph for record node '${node.id}'`);
    }

    const base = node.rawAttribute("autosplit_basename") ?? node.id.split(".")[0];
    const parts: Node[] = [];
    for (let idx = 0; ; idx++) {
      const part = graph.node(`${base}.${idx}`);
      if (!part) break;
      parts.push(part);
    }

    let html = '<<TABLE BORDER="0"><TR>';
    for (const part of parts) {
      const rawPort = part.rawAttribute("autosplit_portname") ?? "";
      const escapedPort = escapeGraphvizPortComponent(rawPort);

      const rawText0 = part.labelText().replace(/\r?\n/g, "");
      const trimmed = rawText0.trim();
      // Perl DOT record empty-field behavior depends on port naming:
      // - When unnamed fields use PORT=" " (single space), the cell body is empty.
      // - When an empty field uses PORT="  " (two spaces), the cell body is a single space.
      const cellText =
        trimmed === ""
          ? rawPort === "  "
            ? " "
            : ""
          : htmlEscapeGraphvizLabelText(trimmed);

      html += `<TD BORDER="1" PORT="${escapedPort}">${cellText}</TD>`;
    }
    html += "</TR></TABLE>>";
    return html;
  }

  // autosplitLabel is the record label string containing pipes.
  const raw = node.autosplitLabel;

  // Perl renders autosplit labels as a single-row HTML table, splitting cells on
  // unescaped '||' (and also unescaped single '|'). Escaped pipes (\\|) are kept
  // as literal text.
  const labelCells: string[] = [];
  let cell = "";

  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];

    if (escaped) {
      cell += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      cell += ch;
      escaped = true;
      continue;
    }

    if (ch === "|" && raw[i + 1] === "|") {
      labelCells.push(cell);
      cell = "";
      i += 1;
      continue;
    }

    if (ch === "|") {
      labelCells.push(cell);
      cell = "";
      continue;
    }

    cell += ch;
  }
  labelCells.push(cell);

  // Perl Graph::Easy honors `columns` (including via node classes) for autosplit record roots.
  // For example in t/in/6_autosplit_class.txt, class columns=2 causes the first record field
  // to span 2 cells, followed by a gap cell before the remaining fields.
  const columnsRaw = node.attribute("columns").trim();
  const columns = columnsRaw === "" ? 1 : Number(columnsRaw);
  const colSpan = Number.isFinite(columns) && columns > 0 ? Math.trunc(columns) : 1;

  type RecordHtmlCell =
    | { kind: "cell"; text: string; emptyAsSpace: boolean }
    | { kind: "gap"; colspan: number };

  const outCells: RecordHtmlCell[] = [];

  if (colSpan > 1 && labelCells.length > 0) {
    // Use the node's effective label (can come from class defaults) for the first cell.
    const firstLabel = node.labelText();
    outCells.push({ kind: "cell", text: firstLabel, emptyAsSpace: true });
    for (let i = 1; i < colSpan; i++) {
      // Filler cells for the extra column width: Perl emits an empty TD (not a single space).
      outCells.push({ kind: "cell", text: "", emptyAsSpace: false });
    }

    // Gap before the remaining record fields.
    outCells.push({ kind: "gap", colspan: 1 });

    for (const cellRaw of labelCells.slice(1)) {
      outCells.push({ kind: "cell", text: cellRaw, emptyAsSpace: true });
    }
  } else {
    for (const cellRaw of labelCells) {
      outCells.push({ kind: "cell", text: cellRaw, emptyAsSpace: true });
    }
  }

  let html = '<<TABLE BORDER="0"><TR>';
  for (const entry of outCells) {
    if (entry.kind === "gap") {
      html += `<TD BORDER="0" COLSPAN="${entry.colspan}"></TD>`;
      continue;
    }

    const trimmed = entry.text.replace(/\r?\n/g, "").trim();
    const cellText = trimmed === "" ? (entry.emptyAsSpace ? " " : "") : htmlEscapeGraphvizLabelText(trimmed);
    html += `<TD BORDER="1" PORT="">${cellText}</TD>`;
  }
  html += "</TR></TABLE>>";
  return html;
}

function nodeGraphvizStatementAttributes(node: Node, relativeHtmlLabels: Map<Node, string>): Record<string, string> {
  const link = node.attribute("link").trim();
  const urlAttr: Record<string, string> = link !== "" ? { URL: link } : {};

  const relative = relativeHtmlLabels.get(node);
  if (relative !== undefined) {
    return {
      ...urlAttr,
      label: relative,
      shape: "none",
    };
  }

  const html = htmlLikeLabelForRecordNode(node);
  if (html !== undefined) {
    const out: Record<string, string> = {};

    // Perl remaps Graph::Easy `fill` -> Graphviz `fillcolor`.
    const fillRaw = node.attribute("fill").trim();
    // Perl Graph::Easy 0.76 `color_as_hex` returns undef for scheme-prefixed colors
    // like `w3c/grey`, so as_graphviz omits the attribute.
    if (fillRaw !== "" && fillRaw.toLowerCase() !== "inherit" && !fillRaw.includes("/")) {
      out.fillcolor = normalizeColorForGraphviz(fillRaw);
    }

    // Perl only emits border/style overrides for record nodes when the borderstyle
    // is a non-default (e.g. dashed). In particular, it does NOT emit the
    // borderstyle=none remap (style=filled + color=fill) for HTML-record nodes.
    const borderstyle = node.attribute("borderstyle").trim().toLowerCase();
    if (borderstyle !== "" && borderstyle !== "solid" && borderstyle !== "none") {
      Object.assign(out, remapBorderStyleForGraphviz(node));
    }

    // Node text color (Graph::Easy `color`) maps to Graphviz fontcolor.
    const fontColorRaw = node.attribute("color").trim();
    if (fontColorRaw !== "") {
      out.fontcolor = normalizeColorForGraphviz(fontColorRaw);
    }

    const fontNameRaw = node.attribute("font").trim();
    if (fontNameRaw !== "") {
      out.fontname = fontNameRaw;
    }

    return {
      ...out,
      ...urlAttr,
      label: html,
      shape: "none",
    };
  }

  const shape = node.attribute("shape").trim().toLowerCase();

  // Perl Graph::Easy::As_graphviz special-cases point-shaped nodes:
  // for pointstyle/pointshape=invisible it emits a plaintext node with label="" and size 0.
  if (shape === "point") {
    const pointStyle = node.attribute("pointstyle").trim().toLowerCase();
    const pointShape = node.attribute("pointshape").trim().toLowerCase();
    if (pointStyle === "invisible" || pointShape === "invisible") {
      return {
        ...urlAttr,
        fillcolor: "white",
        height: "0",
        label: "",
        shape: "plaintext",
        width: "0",
      };
    }

    // Ported from Perl Graph::Easy::As_graphviz point-style handling as observed in
    // t/in/8_points.txt.
    const point = pointStyle !== "" ? pointStyle : pointShape;
    const label =
      point === "square"
        ? "#"
        : point === "dot"
          ? "."
          : point === "circle"
            ? "o"
            : point === "diamond"
              ? "<>"
              : point === "cross"
                ? "+"
                : "*"; // default/star

    // Note: when the graph default node shape is point, the node class block is
    // already `shape=plaintext`, so we only need to emit the label.
    return {
      ...urlAttr,
      label,
    };
  }

  if (shape === "edge") {
    // Port of Graph::Easy::As_graphviz node shape=EDGE behavior as observed in
    // t/in/4_node_edge.txt: named nodes emit shape=edge, while anonymous #N edge-nodes
    // are rendered as a plaintext spacer.
    if (node.id.startsWith("#")) {
      return {
        ...urlAttr,
        color: "#ffffff",
        fillcolor: "white",
        label: " ",
        shape: "plaintext",
        style: "filled",
      };
    }

    return {
      ...urlAttr,
      shape: "edge",
    };
  }

  if (shape === "invisible" && !node.id.startsWith("#")) {
    // Perl emits named invisible nodes as plaintext nodes with label=' ' and a white fillcolor.
    // (Anonymous #N invisible nodes instead go through the border-remap path and end up
    // as `color="#ffffff", style=filled`.)
    return {
      ...urlAttr,
      fillcolor: "white",
      label: " ",
      shape: "plaintext",
    };
  }

  const out = remapBorderStyleForGraphviz(node);

  // Graph::Easy emits node rank constraints as a node attribute in as_graphviz.
  // (See t/in/6_ranks.txt: `D [ rank=0 ]`, `F [ rank=0 ]`.)
  const rankRaw = node.attribute("rank").trim();
  if (rankRaw !== "") {
    out.rank = rankRaw;
  }

  // Non-default shapes are emitted on the node statement.
  // (Default node class shape comes from graph default node attributes when present.)
  const defaultNodeShapeRaw = node.graph?.defaultNodeAttributes.shape;
  const defaultNodeShape0 = (defaultNodeShapeRaw ?? "").trim().toLowerCase();
  // Perl uses style=rounded (not shape=rounded), so treat that default as box.
  const defaultNodeShape = defaultNodeShape0 === "" || defaultNodeShape0 === "rounded" ? "box" : defaultNodeShape0;
  // Perl Graph::Easy as_graphviz remaps Graph::Easy shape=none to Graphviz shape=plaintext.
  const gvShape = shape === "none" ? "plaintext" : shape;
  const gvDefaultNodeShape = defaultNodeShape === "none" ? "plaintext" : defaultNodeShape;
  if (gvShape !== "" && gvShape !== gvDefaultNodeShape && shape !== "invisible" && shape !== "rounded") {
    out.shape = gvShape;

    // dot/5_scope_atr.dot: when DOT scoped defaults set `shape=plaintext` on a node,
    // Perl emits an explicit `fillcolor=white` on that node statement.
    const explicitShape = (node.explicitAttributes.shape ?? "").trim().toLowerCase();
    if (out.shape === "plaintext" && out.fillcolor === undefined && explicitShape !== "" && explicitShape !== "inherit") {
      out.fillcolor = "white";
    }
  }

  // Perl remaps Graph::Easy `fill` -> Graphviz `fillcolor`.
  const fillRaw = node.attribute("fill").trim();
  // Perl Graph::Easy 0.76 `color_as_hex` returns undef for scheme-prefixed colors
  // like `w3c/grey`, so as_graphviz omits the attribute.
  if (fillRaw !== "" && fillRaw.toLowerCase() !== "inherit" && !fillRaw.includes("/")) {
    out.fillcolor = normalizeColorForGraphviz(fillRaw);
  }

  // Graph::Easy font-size => Graphviz fontsize.
  // Important: avoid emitting fontsize when it is effectively inherited from a node class.
  const fontSizeRaw0 = node.rawAttribute("fontsize");
  const fontSizeRaw = fontSizeRaw0 !== undefined ? fontSizeRaw0.trim() : "";
  let emitFontSize = fontSizeRaw !== "";
  if (emitFontSize) {
    const classRaw0 = node.rawAttribute("class");
    const classRaw = classRaw0 !== undefined ? classRaw0.trim() : "";
    if (classRaw !== "" && node.graph) {
      const classNames = classRaw.split(/\s+/).filter(Boolean);
      for (const c of classNames) {
        const cls = node.graph.nodeClassAttributes.get(c);
        const clsFontSize = cls?.fontsize?.trim();
        if (clsFontSize !== undefined && clsFontSize !== "" && clsFontSize === fontSizeRaw) {
          emitFontSize = false;
          break;
        }
      }
    }
  }

    if (emitFontSize) {
      const lower = fontSizeRaw.toLowerCase();
      const mPx = /^(\d+(?:\.\d+)?)px$/.exec(lower);
    const mEm = /^(\d+(?:\.\d+)?)em$/.exec(lower);
    if (mPx) {
      out.fontsize = mPx[1];
    } else if (mEm) {
      const n = Number(mEm[1]);
      if (Number.isFinite(n)) {
        out.fontsize = String(n * 11);
      }
    } else {
      out.fontsize = fontSizeRaw;
    }

  }

  // Node text color (Graph::Easy `color`) maps to Graphviz fontcolor.
  const fontColorRaw = node.attribute("color").trim();
  if (fontColorRaw !== "") {
    out.fontcolor = normalizeColorForGraphviz(fontColorRaw);
  }

  const fontNameRaw = node.attribute("font").trim();
  if (fontNameRaw !== "") {
    out.fontname = fontNameRaw;
  }

  if (shape === "invisible") {
    // For anonymous invisible nodes (#N), Perl keeps the node shape defaults but forces label=' '.
    out.label = " ";
  } else {
    // Perl suppresses labels on non-edges when the label matches the object name,
    // but does emit a label when it differs (e.g. autolabel shortening).
    // DOT label placeholders (\G/\N) are expanded in node labels by Perl.
    // Graph::Easy uses \c for centered labels; Graphviz uses \n.
    const expandedRaw = expandGraphvizNodeLabelEscapes(node, node.labelText());
    let label = collapseGraphvizLabelWhitespace(node.graph, expandedRaw).replace(/\\c/g, "\\n");

    const align = node.attribute("align").trim().toLowerCase();
    if (label !== "") {
      if (align === "right") {
        label = label.replace(/\\n/g, "\\r");
        if (!label.endsWith("\\r")) label += "\\r";
      } else if (align === "left") {
        label = label.replace(/\\n/g, "\\l");
        if (!label.endsWith("\\l")) label += "\\l";
      }
    }
    if (label !== "" && label !== node.id) {
      out.label = label;
    }
  }

  if (link !== "") {
    out.URL = link;
  }

  return out;
}

function graphvizEdgeEndpointRef(node: Node, portMap: Map<Node, string>): string {
  const portRef = portMap.get(node);
  if (portRef !== undefined) return portRef;

  if (!node.origin) {
    const id = escapeGraphvizId(node.id);
    // Perl emits an explicit empty port (:"\"") for nodes whose HTML-like label
    // uses PORT="" (autosplit record nodes).
    if (node.autosplitLabel) {
      if (node.rawAttribute("autosplit_from_dot") === "1") {
        const rawPortname = node.rawAttribute("autosplit_portname");
        if (rawPortname !== undefined) {
          return graphvizPortRef(node.id, rawPortname);
        }
      }
      return `${id}:""`;
    }
    return id;
  }

  const root = node.findGrandparent();
  if (root.autosplitLabel) {
    if (root.rawAttribute("autosplit_from_dot") === "1") {
      const rawPortname = node.rawAttribute("autosplit_portname");
      if (rawPortname !== undefined) {
        return graphvizPortRef(root.id, rawPortname);
      }
    }
    return `${escapeGraphvizId(root.id)}:""`;
  }

  throw new Error(
    `graphvizEdgeEndpointRef: expected a Graphviz port mapping for relative-placement node '${node.id}' under '${root.id}'`
  );
}

function graphvizInlineAttributes(out: Record<string, string>): string {
  const keys = Object.keys(out).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (keys.length === 0) return "";

  const parts = keys.map((k) => `${k}=${graphvizInlineValue(k, out[k])}`);
  return ` [ ${parts.join(", ")} ]`;
}

function normalizeColorForGraphviz(raw: string): string {
  const v0 = raw.trim();
  const v1 = v0.replace(/^w3c\//i, "");
  const lc = v1.toLowerCase();

  // Perl Graph::Easy normalizes some named colors to hex (via Attributes.pm).
  // Keep this mapping minimal and fixture-driven.
  if (lc === "silver") return "#c0c0c0";

  // Graph::Easy ships a 12-color palette mapping for numeric indices.
  // (See Graph-Easy-0.76/lib/Graph/Easy/Attributes.pm.)
  const palette12 = [
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
  if (/^\d+$/.test(lc)) {
    const idx = Number(lc);
    if (Number.isFinite(idx) && idx >= 1 && idx <= palette12.length) {
      return palette12[idx - 1];
    }
  }

  // hsv(h,s,v) => "h s v" (Graphviz HSV form)
  const hsv = /^hsv\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)\s*\)/i.exec(lc);
  if (hsv) {
    return `${hsv[1]} ${hsv[2]} ${hsv[3]}`;
  }

  const toHex2 = (n: number): string => {
    const clamped = Math.max(0, Math.min(255, Math.trunc(n)));
    return clamped.toString(16).padStart(2, "0");
  };

  const rgb01Or255OrPercentToByte = (token: string): number => {
    const t = token.trim();
    if (t.endsWith("%")) {
      const p = Number(t.slice(0, -1));
      if (!Number.isFinite(p)) return 0;
      return Math.floor((p / 100) * 255);
    }

    const n = Number(t);
    if (!Number.isFinite(n)) return 0;

    // Graph::Easy supports mixed forms like rgb(0.1, 100, 10%).
    // - If the token contains a '.', treat it as 0..1.
    // - Otherwise treat it as 0..255.
    if (t.includes(".")) {
      return Math.floor(n * 255);
    }

    return Math.floor(n);
  };

  const rgbFunc = /^rgb\(\s*([^,]+)\s*,\s*([^,]+)\s*,\s*([^)]+)\s*\)$/i.exec(lc);
  if (rgbFunc) {
    const r = rgb01Or255OrPercentToByte(rgbFunc[1]);
    const g = rgb01Or255OrPercentToByte(rgbFunc[2]);
    const b = rgb01Or255OrPercentToByte(rgbFunc[3]);
    return `#${toHex2(r)}${toHex2(g)}${toHex2(b)}`;
  }

  const hslFunc = /^hsl\(\s*([^,]+)\s*,\s*([^,]+)\s*,\s*([^)]+)\s*\)$/i.exec(lc);
  if (hslFunc) {
    const hDeg = Number(hslFunc[1]);
    const s = Number(hslFunc[2]);
    const l = Number(hslFunc[3]);
    const h = Number.isFinite(hDeg) ? ((((hDeg % 360) + 360) % 360) / 360) : 0;
    const sat = Number.isFinite(s) ? Math.max(0, Math.min(1, s)) : 0;
    const lig = Number.isFinite(l) ? Math.max(0, Math.min(1, l)) : 0;

    const hue2rgb = (p: number, q: number, t: number): number => {
      let tt = t;
      if (tt < 0) tt += 1;
      if (tt > 1) tt -= 1;
      if (tt < 1 / 6) return p + (q - p) * 6 * tt;
      if (tt < 1 / 2) return q;
      if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
      return p;
    };

    let r = lig;
    let g = lig;
    let b = lig;

    if (sat !== 0) {
      const q = lig < 0.5 ? lig * (1 + sat) : lig + sat - lig * sat;
      const p = 2 * lig - q;
      r = hue2rgb(p, q, h + 1 / 3);
      g = hue2rgb(p, q, h);
      b = hue2rgb(p, q, h - 1 / 3);
    }

    return `#${toHex2(r * 255)}${toHex2(g * 255)}${toHex2(b * 255)}`;
  }

  // Graph::Easy tends to emit colors as hex in as_graphviz output.
  // Start with a small named-color map and extend as fixtures require.
  const named: Record<string, string> = {
    black: "#000000",
    white: "#ffffff",
    red: "#ff0000",
    blue: "#0000ff",
    yellow: "#ffff00",
    cyan: "#00ffff",
    magenta: "#ff00ff",
    grey: "#808080",
    gray: "#808080",
    cornflowerblue: "#6495ed",
    seagreen: "#2e8b57",
    maroon: "#800000",
    darkslategrey: "#2f4f4f",
    // X11 color name used in DOT fixtures (dot/9_edge_styles.dot)
    lightsalmon: "#ffa07a",
  };

  const mapped = named[lc];
  if (mapped !== undefined) return mapped;

  if (v1.startsWith("#")) return v1.toLowerCase().replace(/\s+/g, "");

  return v1;
}

function parseFiniteNumber(kind: string, id: string, key: string, raw: string, defaultValue = 0): number {
  const trimmed = raw.trim();
  if (trimmed === "") return defaultValue;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid ${kind} ${key} for '${id}': '${raw}'`);
  }
  return n;
}

function remapEdgeStyleForGraphviz(styleRaw: string | undefined): string | undefined {
  // Port of Graph::Easy::As_graphviz::_graphviz_remap_edge_style.
  let style = (styleRaw ?? "").trim().toLowerCase();
  if (style === "") style = "solid";

  if (style.startsWith("dot-")) style = "dotted";
  if (style.startsWith("wave")) style = "dotted";

  // double lines will be handled in the color attribute as "color:color"
  if (style === "double") style = "solid";
  if (style.startsWith("double-dash")) style = "dashed";

  if (style === "invisible") style = "invis";

  if (style.startsWith("bold-dash")) style = "setlinewidth(2), dashed";
  if (style.startsWith("broad")) style = "setlinewidth(5)";
  if (style.startsWith("wide")) style = "setlinewidth(11)";

  return style === "solid" ? undefined : style;
}

function remapBorderStyleForGraphviz(node: Node): Record<string, string> {
  // Port of Graph::Easy::As_graphviz::_graphviz_remap_border_style plus the
  // peripheries=2 handling for double borderstyles.
  const out: Record<string, string> = {};

  const shape = node.attribute("shape").trim().toLowerCase();

  // Some shapes don't need a border.
  // Note: Perl still runs the border remap logic for `shape=invisible`.
  if (/^(none|img|point)$/.test(shape)) {
    return out;
  }

  const borderstyleRaw = node.attribute("borderstyle");
  let style = borderstyleRaw.trim().toLowerCase();
  if (style === "") style = "solid";

  if (style.startsWith("dot-")) style = "dotted";
  if (style.startsWith("double-")) style = "dashed";
  if (style.startsWith("wave")) style = "dotted";

  // borderstyle double will be handled extra with peripheries=2 later
  if (style === "double") style = "solid";

  // XXX TODO: These should be (2, 0.5em, 1em) instead of 2,5,11
  if (style.startsWith("bold")) style = "setlinewidth(2)";
  if (style.startsWith("broad")) style = "setlinewidth(5)";
  if (style.startsWith("wide")) style = "setlinewidth(11)";

  // "solid 0px" => "none"
  // In Graph::Easy, borderwidth defaults to 1 (non-zero) unless explicitly set,
  // except for shape=invisible nodes (Perl treats these like borderwidth=0).
  const defaultBorderwidth = shape === "invisible" ? 0 : 1;
  const borderwidth = parseFiniteNumber(
    "node",
    node.id,
    "borderwidth",
    node.attribute("borderwidth"),
    defaultBorderwidth
  );
  if (borderwidth === 0) {
    style = "none";
  }

  if (style === "none") {
    const fillRaw = node.attribute("fill") || "white";
    out.color = normalizeColorForGraphviz(fillRaw || "white");
    out.style = "filled";
  } else {
    // default style can be suppressed
    if (!/^(|solid)$/.test(style) || shape === "rounded") {
      // for graphviz v2.4 and up
      let gv = style === "solid" ? "filled" : `filled,${style}`;
      if (gv === "filled,filled") gv = "filled";
      if (shape === "rounded" && style !== "none") gv = `rounded,${gv}`;
      gv = gv.replace(/,$/, "");
      out.style = gv;
    }
  }

  const borderColorRaw = node.attribute("bordercolor").trim();
  if (style !== "none" && borderColorRaw !== "") {
    out.color = normalizeColorForGraphviz(borderColorRaw);
  }

  // borderstyle: double:
  if (/^double/.test(borderstyleRaw.trim().toLowerCase()) && borderwidth > 0) {
    out.peripheries = "2";
  }

  return out;
}

function edgeGraphvizAttributes(edge: Edge, flipEdges: boolean): Record<string, string> {
  // Port of Graph::Easy::As_graphviz edge style + color handling (subset).
  const out: Record<string, string> = {};

  const graph = edge.graph;
  if (!graph) {
    throw new Error(`edgeGraphvizAttributes: missing graph for edge '${edge.id}'`);
  }

  const portSideToCompass = (side: string): "n" | "s" | "e" | "w" => {
    if (side === "north") return "n";
    if (side === "south") return "s";
    if (side === "east") return "e";
    if (side === "west") return "w";
    throw new Error(`Unsupported port side: ${side}`);
  };

  // Use raw attribute for style, but suppress it if it matches the default edge style
  // (even if our model stored it explicitly).
  const styleRaw0 = edge.rawAttribute("style");
  const defaultStyleRaw = graph.defaultEdgeAttributes.style;
  const styleRaw =
    styleRaw0 !== undefined &&
    defaultStyleRaw !== undefined &&
    styleRaw0.trim().toLowerCase() === defaultStyleRaw.trim().toLowerCase()
      ? undefined
      : styleRaw0;
  const styleToken = (edge.attribute("style") ?? "").trim().toLowerCase() || "solid";

  let color = edge.attribute("color").trim();
  if (color === "") color = "#000000";
  const baseColor = normalizeColorForGraphviz(color);

  let gvColor = baseColor;
  if (styleToken.startsWith("double")) {
    gvColor = `${baseColor}:${baseColor}`;
  }

  out.color = gvColor;

  const label = edge.labelText();
  const rawLabel = edge.rawAttribute("label");
  const effectiveLabel = rawLabel !== undefined ? rawLabel : edge.label;
  if (effectiveLabel !== "") {
    out.label = collapseGraphvizLabelWhitespace(edge.graph, effectiveLabel).replace(/\\c/g, "\\n");

    // Only emit labelcolor/fontcolor when explicitly set on the edge.
    // (Perl does not apply edge-default label-color to as_graphviz edge statements.)
    const rawLabelColor0 = edge.rawAttribute("labelcolor");
    const defaultLabelColorRaw = graph.defaultEdgeAttributes.labelcolor;
    const rawLabelColor =
      rawLabelColor0 !== undefined &&
      defaultLabelColorRaw !== undefined &&
      rawLabelColor0.trim().toLowerCase() === defaultLabelColorRaw.trim().toLowerCase()
        ? undefined
        : rawLabelColor0;
    if (rawLabelColor !== undefined) {
      const labelColorRaw = rawLabelColor.trim();
      if (labelColorRaw !== "") {
        out.fontcolor = normalizeColorForGraphviz(labelColorRaw);
      }
    } else if (effectiveLabel !== "0") {
      // Perl treats the string '0' as false; it emits label=0 but does not
      // default labelcolor/fontcolor in that case.
      out.fontcolor = baseColor;
    }
  }

  // Port hints (Graph::Easy `start`/`end`) map to Graphviz tailport/headport.
  // Perl only emits these when they are explicitly set on the edge (not inherited
  // via `edge { ... }` defaults).
  const explicitStart = edge.explicitAttributes.start;
  const explicitEnd = edge.explicitAttributes.end;
  const hasExplicitStart =
    explicitStart !== undefined && explicitStart.trim() !== "" && explicitStart.trim().toLowerCase() !== "inherit";
  const hasExplicitEnd =
    explicitEnd !== undefined && explicitEnd.trim() !== "" && explicitEnd.trim().toLowerCase() !== "inherit";

  const [tailSide, tailPort] = hasExplicitStart ? edge.port("start") : [undefined, undefined];
  const [headSide, headPort] = hasExplicitEnd ? edge.port("end") : [undefined, undefined];
  // Only non-strict port hints (no numeric port position) map to Graphviz tail/head ports.
  // Strict ports (e.g. start: south,0) are handled via joint helper nodes like Perl.
  let tailCompass: "n" | "s" | "e" | "w" | undefined =
    tailSide !== undefined && tailPort === undefined ? portSideToCompass(tailSide) : undefined;
  let headCompass: "n" | "s" | "e" | "w" | undefined =
    headSide !== undefined && headPort === undefined ? portSideToCompass(headSide) : undefined;

  if (flipEdges) {
    [tailCompass, headCompass] = [headCompass, tailCompass];
  }

  if (tailCompass !== undefined) out.tailport = tailCompass;
  if (headCompass !== undefined) out.headport = headCompass;

  // Bidirectional / undirected edges.
  // Ported from Graph::Easy::As_graphviz.pm (around the _remap_attributes caller).
  if (edge.undirected) {
    out.arrowhead = "none";
    out.arrowtail = "none";
  } else if (edge.bidirectional) {
    const raw = edge.attribute("arrowstyle").trim();
    const arrow = remapArrowStyleForGraphviz(raw === "" ? undefined : raw);
    out.arrowhead = arrow.value;
    out.arrowtail = arrow.value;
  }

  // Edge minlen: Graph::Easy remaps minlen to Graphviz as int((len + 1) / 2).
  // (See Graph::Easy::As_graphviz::_graphviz_remap_edge_minlen.)
  const minlenRaw = edge.attribute("minlen").trim();
  if (minlenRaw !== "") {
    const n = Number(minlenRaw);
    if (!Number.isFinite(n)) {
      throw new Error(`Invalid edge minlen for '${edge.id}': '${minlenRaw}'`);
    }
    out.minlen = String(Math.trunc((n + 1) / 2));
  }

  const gvStyle = remapEdgeStyleForGraphviz(styleRaw);
  if (gvStyle !== undefined) {
    out.style = gvStyle;
  }

  return out;
}

function collectClassAttributes(graph: Graph, flipEdges: boolean, flow: 0 | 90 | 180 | 270): {
  edge: Record<string, string>;
  graph: Record<string, string>;
  node: Record<string, string>;
} {
  // This is a minimal-but-Perl-shaped subset to get early cases matching.
  const graphOut: Record<string, string> = {};
  const edgeOut: Record<string, string> = {};
  const nodeOut: Record<string, string> = {};

  // graph class
  if (flow === 90 || flow === 270) {
    graphOut.rankdir = "LR";
  }

  // Perl remaps graph fill->bgcolor and graph color->fontcolor.
  const graphFillRaw = graph.graphAttributes.fill;
  if (graphFillRaw !== undefined) {
    const fill = graphFillRaw.trim();
    if (fill !== "") {
      graphOut.bgcolor = normalizeColorForGraphviz(fill);
    }
  }

  const graphColorRaw = graph.graphAttributes.color;
  if (graphColorRaw !== undefined) {
    const color = graphColorRaw.trim();
    if (color !== "") {
      graphOut.fontcolor = normalizeColorForGraphviz(color);
    }
  }

  const graphLabelRaw = graph.graphAttributes.label;
  if (graphLabelRaw !== undefined) {
    const label = graphLabelRaw.trim();
    if (label !== "") {
      graphOut.label = collapseGraphvizLabelWhitespace(graph, label);
      const labelpos = (graph.graphAttributes.labelpos ?? "").trim().toLowerCase();
      graphOut.labelloc = labelpos === "bottom" ? "bottom" : "top";

      // DOT `labeljust=l|r` is remapped into Graph::Easy `align=left|right`.
      // Perl re-emits this as Graphviz `labeljust=l|r` on the graph class.
      const align = (graph.graphAttributes.align ?? "").trim().toLowerCase();
      if (align === "left") graphOut.labeljust = "l";
      else if (align === "right") graphOut.labeljust = "r";
    }
  }

  // DOT parsing sets graphAttributes.title (defaulting to 'unnamed').
  // Perl as_graphviz emits this as a graph class attribute.
  const graphTitleRaw = graph.graphAttributes.title;
  if (graphTitleRaw !== undefined) {
    const title = graphTitleRaw.trim();
    if (title !== "") {
      graphOut.title = title;
    }
  }

  // DOT parsing preserves some Graphviz graph attrs as x-dot-* keys in graphAttributes
  // (see Graph-Easy-0.76/t/txt/dot fixtures). Perl as_graphviz re-emits these by
  // stripping the x-dot- prefix (handled via _remap_custom_dot_attributes).
  for (const [k, v0] of Object.entries(graph.graphAttributes)) {
    if (!k.startsWith("x-dot-")) continue;
    const v = v0.trim();
    if (v === "") continue;
    const gvName = k.slice("x-dot-".length);
    // Prefer explicit Graph::Easy attributes when both exist.
    if (graphOut[gvName] === undefined) {
      graphOut[gvName] = v;
    }
  }

  // Perl sets graph style=filled when groups exist.
  const graphHasBorder =
    (graph.graphAttributes.border !== undefined && graph.graphAttributes.border.trim() !== "") ||
    (graph.graphAttributes.borderstyle !== undefined && graph.graphAttributes.borderstyle.trim() !== "") ||
    (graph.graphAttributes.borderwidth !== undefined && graph.graphAttributes.borderwidth.trim() !== "") ||
    (graph.graphAttributes.bordercolor !== undefined && graph.graphAttributes.bordercolor.trim() !== "");
  if (graphHasBorder) {
    graphOut.style = "filled";
    if (graphOut.color === undefined) {
      graphOut.color = "white";
    }
  }

  if (graph.groups.length > 0) {
    graphOut.style = "filled";
  }

  const graphFontSizeRaw = graph.graphAttributes.fontsize;
  if (graphFontSizeRaw !== undefined) {
    const raw = graphFontSizeRaw.trim().toLowerCase();
    const m = /^(\d+(?:\.\d+)?)em$/.exec(raw);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n)) {
        // Perl uses 11pt as the baseline node font size, and scales em off that.
        graphOut.fontsize = String(n * 11);
      }
    }
  }

  // edge class
  if (flow === 270 || flow === 0) {
    edgeOut.dir = "back";
  }

  const arrowstyle = graph.defaultEdgeAttributes.arrowstyle;
  const arrow = remapArrowStyleForGraphviz(arrowstyle);
  if (flipEdges) {
    edgeOut.arrowtail = arrow.value;
  } else {
    edgeOut.arrowhead = arrow.value;
  }

  const defaultEdgeColorRaw = graph.defaultEdgeAttributes.color;
  if (defaultEdgeColorRaw !== undefined) {
    const color = defaultEdgeColorRaw.trim();
    if (color !== "") {
      edgeOut.color = normalizeColorForGraphviz(color);
    }
  }

  const defaultEdgeStyleRaw = graph.defaultEdgeAttributes.style;
  if (defaultEdgeStyleRaw !== undefined) {
    const style = defaultEdgeStyleRaw.trim();
    const gvStyle = remapEdgeStyleForGraphviz(style);
    if (gvStyle !== undefined) {
      edgeOut.style = gvStyle;
    }
  }

  const defaultEdgeLabelRaw = graph.defaultEdgeAttributes.label;
  if (defaultEdgeLabelRaw !== undefined) {
    const defaultEdgeLabel = defaultEdgeLabelRaw.trim();
    if (defaultEdgeLabel !== "") {
      // Graph::Easy uses \c for centered labels; Graphviz uses \n.
      edgeOut.label = defaultEdgeLabel.replace(/\\c/g, "\\n");
    }
  }

  // node class defaults (Perl sets these if missing)
  const defaultNodeShapeRaw = graph.defaultNodeAttributes.shape;
  const defaultNodeShape0 = (defaultNodeShapeRaw ?? "").trim().toLowerCase();
  // Perl uses style=rounded (not shape=rounded), so keep the default Graphviz shape as box.
  // Perl also maps Graph::Easy `shape: point` to Graphviz `shape=plaintext`.
  const defaultNodeShape = defaultNodeShape0 === "" || defaultNodeShape0 === "rounded" ? "box" : defaultNodeShape0;
  nodeOut.shape = defaultNodeShape === "point" ? "plaintext" : defaultNodeShape;
  nodeOut.style = "filled";
  nodeOut.fontsize = "11";
  nodeOut.fillcolor = "white";

  // Perl's node class block does not force a default `color`, but it can appear
  // when it is implied by Graph::Easy default border attributes (after remap).
  // Example: `node { border: double; }` causes `color=white` in t/in/4_autosplit_class.txt.
  const defaultNodeBorderColorRaw = graph.defaultNodeAttributes.bordercolor;
  if (defaultNodeBorderColorRaw !== undefined) {
    const bordercolor = defaultNodeBorderColorRaw.trim();
    if (bordercolor !== "") {
      nodeOut.color = normalizeColorForGraphviz(bordercolor);
    }
  } else {
    const defaultNodeBorderstyleRaw = graph.defaultNodeAttributes.borderstyle;
    if (defaultNodeBorderstyleRaw !== undefined) {
      const borderstyle = defaultNodeBorderstyleRaw.trim().toLowerCase();
      if (borderstyle !== "" && borderstyle !== "solid") {
        nodeOut.color = "white";
      }
    }
  }

  // Default node text color (Graph::Easy `color`) maps to Graphviz fontcolor.
  const defaultNodeColorRaw = graph.defaultNodeAttributes.color;
  if (defaultNodeColorRaw !== undefined) {
    const color = defaultNodeColorRaw.trim();
    if (color !== "") {
      nodeOut.fontcolor = normalizeColorForGraphviz(color);
    }
  }

  // Graph::Easy `title` maps to Graphviz tooltip.
  const defaultNodeTitleRaw = graph.defaultNodeAttributes.title;
  if (defaultNodeTitleRaw !== undefined) {
    const title = defaultNodeTitleRaw.trim();
    if (title !== "") {
      nodeOut.tooltip = title;
    }
  }

  // Default node label is emitted in the node class block in Perl (even if
  // redundant with per-node labels).
  const defaultNodeLabelRaw = graph.defaultNodeAttributes.label;
  if (defaultNodeLabelRaw !== undefined) {
    const defaultNodeLabel = defaultNodeLabelRaw.trim();
    if (defaultNodeLabel !== "") {
      nodeOut.label = collapseGraphvizLabelWhitespace(graph, defaultNodeLabel);
    }
  }

  return { edge: edgeOut, graph: graphOut, node: nodeOut };
}

function sortGroupsById(groups: Iterable<Group>): Group[] {
  // Preserve creation/insertion order (matches how groups are added during parse).
  return [...groups];
}

function groupDefaultGraphvizAttributes(group: Group, nodeClass: Record<string, string>): Record<string, string> {
  // Defaults inferred from Perl output (e.g. t/in/0_empty_group.txt).
  // Note: Perl prints these inside the subgraph body (key=value;), ordered by
  // reverse sort of keys.

  const nodeFontsizeRaw = nodeClass.fontsize;
  const nodeFontsize = Number(nodeFontsizeRaw);

  const groupFontsize = Number.isFinite(nodeFontsize) ? String(nodeFontsize * 0.8) : "8.8";

  const labelpos = group.attribute("labelpos").trim().toLowerCase();
  const labelloc = labelpos === "bottom" ? "bottom" : "top";

  // Group border handling.
  // Graph::Easy allows `border: none;` on groups; Perl as_graphviz emits `border=none`.
  const borderStyle = group.attribute("borderstyle").trim().toLowerCase();
  const borderWidth = group.attribute("borderwidth").trim();
  const borderColorRaw = group.attribute("bordercolor").trim();
  const border = borderStyle;
  const borderIsNone =
    group.name.trim() === "" || border === "none" || borderStyle === "none" || borderWidth === "0";

  const labelAttrRaw = group.attribute("label").trim();

  const nodeclass = group.attribute("nodeclass").trim();

  let fillcolor = "#a0d0ff";
  const fillRaw = group.attribute("fill").trim();
  if (fillRaw !== "") {
    fillcolor = normalizeColorForGraphviz(fillRaw);
  } else if (group.name.trim() === "") {
    // Perl's Graph::Easy::Group::Anon defaults to a white group background in Graphviz output.
    fillcolor = "#ffffff";
  }

  const align = group.attribute("align").trim().toLowerCase();
  const labeljust = align === "center" ? "c" : align === "right" ? "r" : "l";

  return {
    style: "filled",
    ...(nodeclass !== "" ? { nodeclass } : {}),
    labelloc,
    labeljust,
    ...(labelAttrRaw !== "" ? { label: labelAttrRaw } : {}),
    fontsize: groupFontsize,
    fontname: "serif",
    fontcolor: "#000000",
    fillcolor,
    color: "white",
    ...(borderIsNone
      ? { border: "none" }
      : borderStyle !== "" && borderStyle !== "solid"
        ? { border: borderColorRaw !== "" ? `${borderStyle}  ${borderColorRaw}` : borderStyle }
        : {}),
  };
}

function renderGraphvizGroup(
  graph: Graph,
  group: Group,
  depth: number,
  nodeClass: Record<string, string>,
  relativeHtmlLabels: Map<Node, string>,
  processedNodes: Set<Node>
): string {
  const indent = "  ".repeat(depth + 1);

  let txt = "";

  txt += `${indent}subgraph "cluster${group.id}" {\n`;
  // Perl always quotes group labels (even when they are purely alnum).
  const groupLabel = group.name.trim() !== "" ? group.name : `Group #${group.id}`;
  txt += `${indent}label="${escapeGraphvizGroupName(groupLabel)}";\n`;

  // Subgroups first (Perl emits these immediately after the label line).
  for (const sg of sortGroupsById(group.groups)) {
    txt += renderGraphvizGroup(graph, sg, depth + 1, nodeClass, relativeHtmlLabels, processedNodes);
  }

  // Default group attributes.
  const out = groupDefaultGraphvizAttributes(group, nodeClass);
  for (const key of Object.keys(out).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).reverse()) {
    txt += `${indent}${key}=${graphvizQuoteIfNeeded(out[key])};\n`;
  }
  txt += "\n";

  // Nodes within the group.
  // Perl emits these in creation/id order (not lexical by name).
  const groupNodeclass = group.attribute("nodeclass").trim();
  const groupNodeclassColor =
    groupNodeclass !== "" ? graph.nodeClassAttributes.get(groupNodeclass)?.color?.trim() : undefined;
  for (const n of sortedNodesByNumericId(group.nodes)) {
    if (!shouldEmitNode(n)) continue;
    processedNodes.add(n);

    const attrs = nodeGraphvizStatementAttributes(n, relativeHtmlLabels);
    if (groupNodeclassColor && attrs.fontcolor === undefined) {
      attrs.fontcolor = normalizeColorForGraphviz(groupNodeclassColor);
    }
    const att = graphvizInlineAttributes(attrs);
    txt += `${indent}${escapeGraphvizId(n.id)}${att}\n`;
  }

  // Perl ends subgraph blocks with a single newline (no extra blank line).
  txt += `${indent}}\n`;
  return txt;
}

function shouldEmitNode(n: Node): boolean {
  // Skip nodes that are relative to others (autosplit children), like Perl.
  return !n.origin;
}

function sortedNodesByName(nodes: Iterable<Node>): Node[] {
  return [...nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function sortedNodesByNumericId(nodes: Iterable<Node>): Node[] {
  return [...nodes].sort((a, b) => a.numericId - b.numericId);
}

function sortedEdgesById(edges: Edge[]): Edge[] {
  // Graph::Easy uses ord_values() on internal ids; our Edge.id is numeric.
  return edges.slice().sort((a, b) => a.id - b.id);
}

export function renderGraphviz(graph: Graph): string {
  const type = graphType(graph);
  const name = graphName(graph);
  const op = edgeOperator(type);

  const flow = directionAsNumber(graph.graphAttributes.flow);
  const flipEdges = flow === 270 || flow === 0;

  let txt = `${type} ${name} {\n\n`;

  // Keep the Perl-style banner. Note: compare harness normalizes this away.
  // Format differs from Perl's scalar localtime(); that is intentional (compare strips it).
  txt += `  // Generated by Graph::Easy ${GRAPH_EASY_VERSION_FOR_BANNER} at ${new Date().toString()}\n\n`;

  // Class attributes (Perl order: edge, graph, node)
  const classAttrs = collectClassAttributes(graph, flipEdges, flow);
  for (const kind of ["edge", "graph", "node"] as const) {
    const att = attAsGraphviz(classAttrs[kind]);
    if (att === "") continue;
    txt += `  ${kind} [${att}];\n`;
  }

  txt += "\n";

  // HTML-like labels + Graphviz port mappings for relative-placement clusters.
  // Ported from Graph::Easy::As_graphviz::_html_like_label + _graphviz_point.
  const portMap = new Map<Node, string>();
  const relativeHtmlLabels = new Map<Node, string>();
  for (const n of sortedNodesByName(graph.nodes())) {
    if (n.origin) continue;
    if (n.autosplitLabel) continue; // record roots handled separately
    if (n.children.size === 0) continue;
    const html = htmlLikeLabelForRelativePlacementNode(n, portMap);
    relativeHtmlLabels.set(n, html);
  }

  // Groups as subgraphs (clusters)
  const processedNodes = new Set<Node>();
  if (graph.groups.length > 0) {
    // Mimic Perl: assign edges into groups before emitting subgraphs.
    graph._edgesIntoGroups();

    for (const g of sortGroupsById(graph.groups)) {
      txt += renderGraphvizGroup(graph, g, 0, classAttrs.node, relativeHtmlLabels, processedNodes);
    }
  }

  // Nodes with attributes first (Perl emits per-node remapped attrs before edges).
  const nodesWithExplicitStatements = new Set<Node>();
  let anyNodeAttrs = false;
  for (const n of sortedNodesByName(graph.nodes())) {
    if (!shouldEmitNode(n)) continue;
    if (processedNodes.has(n)) continue;

    const attrs = nodeGraphvizStatementAttributes(n, relativeHtmlLabels);
    const att = graphvizInlineAttributes(attrs);
    if (att === "") continue;

    anyNodeAttrs = true;
    nodesWithExplicitStatements.add(n);
    txt += `  ${escapeGraphvizId(n.id)}${att}\n`;
  }
  if (anyNodeAttrs) {
    txt += "\n";
  }

  // Some edges originate from autosplit child nodes but are rendered using the
  // record-root node id (via graphvizEdgeEndpointRef). In those cases the record
  // root can appear "isolated" if we only look at its raw successors()/predecessors().
  // Precompute the set of nodes that are referenced by any edge after endpoint
  // remapping so we don't emit stray standalone node lines like `"C.0"`.
  const nodesReferencedByEdges = new Set<Node>();
  {
    const seenEdgeIds = new Set<number>();
    for (const n of graph.nodes()) {
      for (const e of n.edges()) {
        if (seenEdgeIds.has(e.id)) continue;
        seenEdgeIds.add(e.id);

        const fromNode = e.from.origin ? e.from.findGrandparent() : e.from;
        const toNode = e.to.origin ? e.to.findGrandparent() : e.to;
        nodesReferencedByEdges.add(fromNode);
        nodesReferencedByEdges.add(toNode);
      }
    }
  }

  // Edges + isolated nodes.
  // Perl uses Graph::Easy::sorted_nodes() which is effectively parse/creation-order
  // for these fixtures (not lexical by node name).

  // Perl creates invisible helper nodes ("joint0", "joint1", ...) when multiple
  // edges share a strict start/end port (e.g. start: south,0). Graphviz has no
  // direct equivalent for the join semantics, so we rewrite these edges through
  // helper nodes.
  const jointByKey = new Map<string, string>();
  let nextJointId = 0;
  const allocJointId = (): string => {
    while (graph.node(`joint${nextJointId}`) !== undefined) nextJointId++;
    return `joint${nextJointId++}`;
  };

  const edgesAtPort = (node: Node, attr: "start" | "end", side: string, port: number): Edge[] => {
    const edges: Edge[] = [];
    for (const e of node.edges()) {
      // Skip edges ending here if we look at start.
      if (e.to === node && attr === "start") continue;
      // Skip edges starting here if we look at end.
      if (e.from === node && attr === "end") continue;

      const [s, p] = e.port(attr);
      if (s === side && p === port) {
        edges.push(e);
      }
    }
    return edges;
  };

  const insertEdgeAttribute = (att: string, newAttr: string): string => {
    // Port of Graph::Easy::As_graphviz::_insert_edge_attribute.
    // - remove any potential old attribute with the same name
    // - insert the new attribute at the end
    if (att === "") return ` [ ${newAttr} ]`;

    const attName = newAttr.replace(/=.*/, "");
    const withoutOld = att.replace(new RegExp(`${attName}=(\"(?:\\\\\"|[^\"])*\"|[^\\s]+)`, "g"), "");

    return withoutOld.replace(/\s?\]$/, `,${newAttr} ]`);
  };

  const suppressEdgeLabel = (att: string): string => {
    // Port of Graph::Easy::As_graphviz::_suppress_edge_attribute($att,'label')
    // (minimal: good enough for our fixture corpus).
    const without = att.replace(/label=("(?:\\"|[^"])*"|[^\s\n,;]+)[,;]?/g, "");
    // Cleanup: remove doubled commas introduced by suppression.
    return without.replace(/,\s*,/g, ",").replace(/\[\s*,/g, "[");
  };

  for (const n of sortedNodesByNumericId(graph.nodes())) {
    // Perl iterates `reverse @out` where @out = successors().
    const succ = n.successors().slice().reverse();
    const pred = n.predecessors();

    const first = graphvizEdgeEndpointRef(n, portMap);

    if (succ.length === 0 && pred.length === 0) {
      // Note: Perl does not print semicolons.
      if (
        shouldEmitNode(n) &&
        !processedNodes.has(n) &&
        !nodesReferencedByEdges.has(n) &&
        !nodesWithExplicitStatements.has(n)
      ) {
        txt += `  ${escapeGraphvizId(n.id)}\n`;
      }
      continue;
    }

    // For all outgoing connections
    for (const other of succ) {
      const otherTxt = graphvizEdgeEndpointRef(other, portMap);
      const edges = graph.edgesBetween(n, other);
      for (const e of sortedEdgesById(edges)) {
        let firstPoint = first;
        let otherPoint = otherTxt;
        let edgeAtt = graphvizInlineAttributes(edgeGraphvizAttributes(e, flipEdges));

        let modifyEdge = false;
        const suppressStart = !flipEdges ? "arrowtail=none" : "arrowhead=none";
        const suppressEnd = flipEdges ? "arrowtail=none" : "arrowhead=none";
        let suppress: string | undefined;

        if (e.hasPorts()) {
          // Shared start port -> join at the start via a helper node.
          const [sSide, sPort] = e.port("start");
          if (sSide !== undefined && sPort !== undefined) {
            const shared = edgesAtPort(e.from, "start", sSide, sPort);
            if (shared.length > 1) {
              const key = `${e.from.id},start,${sPort}`;
              let jointId = jointByKey.get(key);
              suppress = suppressStart;
              modifyEdge = true;

              if (!jointId) {
                jointId = allocJointId();
                jointByKey.set(key, jointId);

                let raw = e.attribute("color").trim();
                if (raw === "") raw = "#000000";
                const baseColor = normalizeColorForGraphviz(raw);

                // Helper node
                txt += `  ${jointId} [ label="",shape=none,style=filled,height=0,width=0,fillcolor="${baseColor}" ]\n`;

                // Edge from node -> joint (suppress arrow at the joint).
                let helperAtt = suppressEdgeLabel(edgeAtt);
                helperAtt = insertEdgeAttribute(helperAtt, suppressEnd);
                if (flipEdges) {
                  txt += `  ${jointId} ${op} ${firstPoint}${helperAtt}\n`;
                } else {
                  txt += `  ${firstPoint} ${op} ${jointId}${helperAtt}\n`;
                }
              }

              firstPoint = jointId;
            }
          }

          // Shared end port -> join at the end via a helper node.
          const [eSide, ePort] = e.port("end");
          if (eSide !== undefined && ePort !== undefined) {
            const shared = edgesAtPort(e.to, "end", eSide, ePort);
            if (shared.length > 1) {
              const key = `${e.to.id},end,${ePort}`;
              let jointId = jointByKey.get(key);
              suppress = suppressEnd;
              modifyEdge = true;

              if (!jointId) {
                jointId = allocJointId();
                jointByKey.set(key, jointId);

                let raw = e.attribute("color").trim();
                if (raw === "") raw = "#000000";
                const baseColor = normalizeColorForGraphviz(raw);

                txt += `  ${jointId} [ label="",shape=none,style=filled,height=0,width=0,fillcolor="${baseColor}" ]\n`;

                // Edge from joint -> other (suppress arrow at the joint).
                let helperAtt = insertEdgeAttribute(edgeAtt, suppressStart);
                if (flipEdges) {
                  txt += `  ${otherPoint} ${op} ${jointId}${helperAtt}\n`;
                } else {
                  txt += `  ${jointId} ${op} ${otherPoint}${helperAtt}\n`;
                }
              }

              otherPoint = jointId;
            }
          }
        }

        if (flipEdges) {
          [firstPoint, otherPoint] = [otherPoint, firstPoint];
        }

        if (modifyEdge && suppress) {
          edgeAtt = insertEdgeAttribute(edgeAtt, suppress);
        }

        txt += `  ${firstPoint} ${op} ${otherPoint}${edgeAtt}\n`;
      }
    }
  }

  txt += `\n}\n`;
  return txt;
}
