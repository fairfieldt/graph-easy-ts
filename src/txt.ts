import type { Attributes } from "./attributes";
import type { Edge } from "./edge";
import type { Graph } from "./graph";
import type { Group } from "./group";
import type { Node } from "./node";

function cmpStr(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function encodeValue(v: string): string {
  // Ported from Graph::Easy::Attributes::_remap_attributes (encode+noquote mode).
  // Only percent-encode if the value contains critical chars other than '%'
  // (so rgb(10%,0,0) stays as-is).
  const norm = (() => {
    // Perl normalizes whitespace in rgb()/hsl()/hsv() values (no spaces after commas).
    if (/^(rgb|hsl|hsv)\(/i.test(v)) {
      return v.replace(/,\s+/g, ",").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")");
    }
    return v;
  })();

  if (!/[;"\x00-\x1f]/.test(norm)) return norm;
  return norm.replace(/[;"%\x00-\x1f]/g, (m) => {
    return `%${m.charCodeAt(0).toString(16).padStart(2, "0")}`;
  });
}

function normalizeClassValue(v: string): string {
  const parts = v
    .trim()
    .split(/[\s,]+/)
    .map((p) => p.trim())
    .filter(Boolean);

  if (parts.length === 0) return "";
  return parts.map((p) => p.toLowerCase()).join(" ");
}

function escapeWith(name: string, re: RegExp): string {
  return name.replace(re, "\\$1");
}

function escapeNodeName(name: string): string {
  // Perl: $name =~ s/([\[\]\|\{\}\#])/\\$1/g;
  return escapeWith(name, /([\[\]\|\{\}#])/g);
}

function escapeAutosplitLabel(name: string): string {
  // Perl: for autosplit label, quote special chars but not '|'
  // $name =~ s/([\[\]\{\}\#])/\\$1/g;
  return escapeWith(name, /([\[\]\{\}#])/g);
}

function escapeGroupName(name: string): string {
  // Perl: $n =~ s/([\[\]\(\)\{\}\#])/\\$1/g;
  return escapeWith(name, /([\[\]\(\)\{\}#])/g);
}

const DEFAULT_BORDERSTYLE = "solid";
const DEFAULT_BORDERWIDTH = "1";
const DEFAULT_BORDERCOLOR = "#000000";

function borderAttribute(style: string | undefined, width: string | undefined, color: string | undefined): string {
  // Ported from Graph::Easy::_border_attribute (As_txt.pm uses this).
  const s = style ?? "";
  let w = width ?? "";
  const c = color ?? "";

  if (/^(none|)$/.test(s)) return s;

  if (/^\s*\d+\s*$/.test(w)) {
    w = `${w}px`;
  }

  // NOTE: Perl preserves the “empty slot” as a double-space when width is omitted but color is present
  // (e.g. "dotted  black"). Do not collapse internal whitespace here.
  return [s, w, c].join(" ").trim();
}

function isAnonymousNodeId(n: Node): boolean {
  // Perl Graph::Easy::Node::Anon: internal ids like "#0" serialize as the empty node "[ ]".
  return /^#\d+$/.test(n.id);
}

function isTrivialAnonymousNodeDefinition(n: Node): boolean {
  // Many fixtures create anonymous helper nodes like `[ ] { shape: invisible; }` or
  // `[ ] { shape: edge; }`. Perl does not emit a separate node definition line for these.
  if (!isAnonymousNodeId(n)) return false;
  const keys = Object.keys(n.explicitAttributes);
  if (keys.length !== 1 || keys[0] !== "shape") return false;
  const shape = (n.explicitAttributes.shape ?? "").trim().toLowerCase();
  return shape === "invisible" || shape === "edge";
}

function collapseLabelWhitespace(graph: Graph | undefined, s: string): string {
  if (!graph || graph.preserveLabelWhitespace) return s;
  return s.trim().replace(/\s+/g, " ");
}

function borderAttributeWithDefaults(style: string | undefined, width: string | undefined, color: string | undefined): string {
  const s0 = (style ?? "").trim();
  if (s0 === "none") return "none";

  const s = s0 === "" ? DEFAULT_BORDERSTYLE : s0;

  const w0 = (width ?? "").trim();
  const c0 = (color ?? "").trim();

  const w = w0 === "" || w0 === DEFAULT_BORDERWIDTH ? "" : w0;
  const c = c0 === "" || c0 === DEFAULT_BORDERCOLOR ? "" : c0;

  if (s === DEFAULT_BORDERSTYLE && w === "" && c === "") return "";
  return borderAttribute(s, w, c);
}

function assignRanksForTxt(graph: Graph): void {
  // Ported from Graph::Easy::Layout::_assign_ranks via our TS layout.ts implementation.
  const stableInsertByAbsRank = (queue: Array<[number, Node]>, elem: [number, Node]): void => {
    const abs = Math.abs(elem[0]);
    let i = 0;
    while (i < queue.length && Math.abs(queue[i][0]) <= abs) i++;
    queue.splice(i, 0, elem);
  };

  const rootName = graph.graphAttributes.root ? graph.graphAttributes.root.trim() : undefined;
  const root = rootName ? graph.node(rootName) : undefined;

  const todo: Array<[number, Node]> = [];
  const also: Node[] = [];

  const nodes = [...graph.nodes()].sort((a, b) => cmpStr(String(a.numericId), String(b.numericId)));

  if (root) {
    root.rank = -1;
    stableInsertByAbsRank(todo, [-1, root]);
  }

  for (const n of nodes) {
    if (root && n === root) continue;

    const rawRank = n.rawAttribute("rank");

    let rankAtt: number | undefined;

    if (rawRank !== undefined) {
      const trimmed = rawRank.trim();
      if (trimmed === "auto") {
        rankAtt = undefined;
      } else if (trimmed === "same") {
        rankAtt = 0;
      } else if (trimmed !== "") {
        const parsed = Number(trimmed);
        if (!Number.isFinite(parsed)) {
          throw new Error(`Invalid node rank: ${rawRank}`);
        }
        rankAtt = parsed;
      }
    }

    if (rankAtt !== undefined) {
      rankAtt += 1;
    }

    n.rank = rankAtt;

    if (n.rank === undefined && n.predecessors().length === 0) {
      n.rank = -1;
    }

    if (n.rank !== undefined) {
      stableInsertByAbsRank(todo, [n.rank, n]);
    } else {
      also.push(n);
    }
  }

  while (also.length !== 0 || todo.length !== 0) {
    while (todo.length !== 0) {
      const [rank, n] = todo.shift() as [number, Node];

      let l = n.rank ?? rank;
      if (l > 0) l = -l;
      l -= 1;

      for (const o of n.successors()) {
        if (o.rank === undefined) {
          o.rank = l;
          stableInsertByAbsRank(todo, [l, o]);
        }
      }
    }

    if (also.length === 0) break;

    while (also.length) {
      const n = also.shift();
      if (!n) break;
      if (n.rank !== undefined) continue;

      n.rank = -1;
      stableInsertByAbsRank(todo, [-1, n]);
      break;
    }
  }
}

function formatAttributeEntries(attrs: Attributes, opts?: { skipBorderParts?: boolean; skipInternal?: boolean }): string {
  const skipBorderParts = opts?.skipBorderParts ?? false;
  const skipInternal = opts?.skipInternal ?? false;

  const keys = Object.keys(attrs).sort(cmpStr);

  let out = "";
  for (const k of keys) {
    if (skipInternal && /^autosplit_/.test(k)) continue;
    const v0 = attrs[k];
    if (v0 === undefined || v0 === "") continue;
    if (skipBorderParts && /^border/.test(k)) continue;

    const v = k === "class" ? normalizeClassValue(v0) : v0;
    if (v === "") continue;
    out += `${k}: ${encodeValue(v)}; `;
  }

  return out;
}

function nodeAsPureTxt(n: Node): string {
  if (isAnonymousNodeId(n)) {
    return "[ ]";
  }
  if (n.autosplitLabel !== undefined) {
    // Perl normalizes record labels differently from plain labels:
    // - remove physical newlines from multi-line record syntax,
    // - keep meaningful spaces inside whitespace-only cells (e.g. `||  ||`),
    // - but collapse long whitespace-only cells like `|     |` down to two spaces.
    let label = n.autosplitLabel;
    label = label.replace(/\r?\n[ \t]+/g, " ");
    label = label.replace(/\r?\n/g, "");
    label = label.replace(/\| {3,}\|/g, "|  |");

    // For record labels, Perl does not invent whitespace around `||` separators; it only
    // normalizes whitespace that is already present (including indentation from multi-line
    // record syntax).
    label = label.replace(/([^ |])\s+\|\|/g, "$1 ||");
    label = label.replace(/\|\|\s+([^ |])/g, "|| $1");

    // Empty-row marker `||  ||` spacing depends on how much whitespace follows it:
    // - For Graph::Easy multi-line records, exactly one space before text => Perl keeps it tight (`||  ||B`).
    // - Two+ spaces before text => Perl collapses to a single separating space
    //   (`||  || Compose()`).
    const fromDot = n.attributes.autosplit_from_dot !== undefined;
    if (!fromDot) {
      label = label.replace(/\|\|\s{2}\|\|\s([^ |])/g, "||  ||$1");
    }
    label = label.replace(/\|\|\s{2}\|\|\s{2,}([^ |])/g, "||  || $1");

    label = label.trim();
    return `[ ${escapeAutosplitLabel(label)} ]`;
  }

  return `[ ${escapeNodeName(n.id)} ]`;
}

function nodeAsPartTxt(n: Node): string {
  if (isAnonymousNodeId(n)) {
    return "[ ]";
  }
  return `[ ${escapeNodeName(n.id)} ]`;
}

function nodeSortedSuccessors(n: Node): Node[] {
  // Ported from Graph::Easy::Node->sorted_successors.
  return n
    .successors()
    .slice()
    .sort((a, b) => b.successors().length - a.successors().length || cmpStr(a.id, b.id));
}

function nodeEdgesTo(n: Node, other: Node): Edge[] {
  // Ported from Graph::Easy::Node->edges_to.
  const out: Edge[] = [];
  for (const e of n.edges()) {
    if (e.from === n && e.to === other) out.push(e);
  }
  out.sort((a, b) => a.id - b.id);
  return out;
}

function asAttributesBlock(text: string): string {
  if (text === "") return "";
  return ` { ${text}}`;
}

function computeInheritedNodeBorder(graph: Graph, n: Node): string {
  const clsAttrs: Attributes = Object.create(null);
  // base class defaults
  for (const [k, v] of Object.entries(graph.defaultNodeAttributes)) {
    clsAttrs[k] = v;
  }

  const classList = (n.attribute("class") ?? "").trim();
  if (classList !== "") {
    for (const cls of classList.split(/[\s,]+/).filter(Boolean)) {
      const c = graph.nodeClassAttributes.get(cls.toLowerCase());
      if (!c) continue;
      for (const [k, v] of Object.entries(c)) {
        clsAttrs[k] = v;
      }
    }
  }

  return borderAttributeWithDefaults(clsAttrs.borderstyle, clsAttrs.borderwidth, clsAttrs.bordercolor);
}

function nodeAttributesAsTxt(n: Node): string {
  if (isTrivialAnonymousNodeDefinition(n)) {
    return "";
  }
  // autosplit parts: only the first node in the cluster carries autosplitLabel.
  const isAutosplitPart = Object.prototype.hasOwnProperty.call(n.attributes, "autosplit_basename");
  if (isAutosplitPart && n.autosplitLabel === undefined) {
    return "";
  }

  const graph = n.graph;
  if (!graph) throw new Error(`nodeAttributesAsTxt: missing graph for node ${n.id}`);

  let attrs: Attributes;

  if (isAutosplitPart && n.autosplitLabel !== undefined) {
    // For the first node in an autosplit cluster, build pipe-separated values
    // across all parts (ported from Graph::Easy::As_txt.pm).
    const base = n.attributes.autosplit_basename;
    const parts = [...graph.nodes()].filter((m) => m !== n && m.attributes.autosplit_basename === base);

    const parseIdx = (id: string): number => {
      const m = /\.(\d+)$/.exec(id);
      return m ? Number(m[1]) : 0;
    };

    parts.sort((a, b) => parseIdx(a.id) - parseIdx(b.id));

    const all = [n, ...parts];

    const names = new Set<string>();
    for (const child of all) {
      for (const k of Object.keys(child.explicitAttributes)) {
        names.add(k);
      }
    }

    const merged: Attributes = Object.create(null);
    const keys = [...names].sort(cmpStr);

    for (const k of keys) {
      if (k === "basename") continue;

      if (k === "class") {
        const perPart = all.map((child) => normalizeClassValue(child.explicitAttributes.class ?? ""));
        const rootClass = perPart[0] ?? "";

        if (rootClass === "") {
          continue;
        }

        const rest = perPart.slice(1);
        if (rest.every((v) => v === "") || rest.every((v) => v === rootClass)) {
          merged.class = rootClass;
          continue;
        }

        const trimmed = perPart.slice();
        while (trimmed.length && trimmed[trimmed.length - 1] === "") trimmed.pop();
        merged.class = trimmed.join("|");
        continue;
      }

      const first = n.explicitAttributes[k] ?? "";
      let val = `${first}|`;
      let notEqual = 0;

      for (const child of parts) {
        const v = child.explicitAttributes[k] ?? "";
        if (v !== first) notEqual += 1;
        val += `${v}|`;
      }

      if (notEqual === 0) {
        val = first;
      }

      val = val.replace(/\|+$/, "|");
      if (/\|.*\|/.test(val)) {
        val = val.replace(/\|$/, "");
      }

      if (val !== "|") {
        merged[k] = val;
      }
    }

    if (n.explicitAttributes.basename !== undefined) {
      merged.basename = n.explicitAttributes.basename;
    }

    attrs = merged;
  } else {
    attrs = n.explicitAttributes;
  }

  // Shallow copy; we mutate during formatting.
  const out: Attributes = Object.create(null);
  for (const [k, v] of Object.entries(attrs)) {
    // Internal TS autosplit metadata must never be serialized.
    if (/^autosplit_/.test(k)) continue;
    if (k === "group") continue;
    out[k] = v;
  }

  if (out.label !== undefined) {
    out.label = collapseLabelWhitespace(graph, out.label);
  }

  // Relative placement.
  if (n.origin) {
    out.origin = n.origin.id;
    out.offset = `${n.dx},${n.dy}`;
  }

  // Shorten output for multi-celled nodes.
  if (Object.prototype.hasOwnProperty.call(out, "columns")) {
    out.size = `${out.columns || 1},${out.rows || 1}`;
    delete out.rows;
    delete out.columns;
    if (out.size === "1,1") delete out.size;
  }

  // Perl as_txt marks certain record roots as `class: empty` when the record begins with
  // a truly empty cell (i.e. the first autosplit part label is the empty string, not
  // whitespace). This preserves borderless empty-cell semantics on round-trip.
  if (
    isAutosplitPart &&
    n.autosplitLabel !== undefined &&
    n.attributes.autosplit_first_empty === "1" &&
    out.class === undefined
  ) {
    out.class = "empty";
  }

  const entries = formatAttributeEntries(out, { skipBorderParts: true, skipInternal: true });

  let borderEntry = "";

  // Autosplit nodes can have per-part border split-values like `border: dashed|;`.
  if (isAutosplitPart && n.autosplitLabel !== undefined) {
    const base = n.attributes.autosplit_basename;
    const parts = [...graph.nodes()].filter((m) => m !== n && m.attributes.autosplit_basename === base);
    const parseIdx = (id: string): number => {
      const m = /\.(\d+)$/.exec(id);
      return m ? Number(m[1]) : 0;
    };
    parts.sort((a, b) => parseIdx(a.id) - parseIdx(b.id));
    const all = [n, ...parts];

    const borderParts = all.map((child) =>
      borderAttribute(child.explicitAttributes.borderstyle, child.explicitAttributes.borderwidth, child.explicitAttributes.bordercolor)
    );

    if (borderParts.some((b) => b !== "")) {
      const first = borderParts[0] ?? "";
      let val = `${first}|`;
      let notEqual = 0;
      for (let i = 1; i < borderParts.length; i++) {
        const v = borderParts[i] ?? "";
        if (v !== first) notEqual += 1;
        val += `${v}|`;
      }
      if (notEqual === 0) {
        val = first;
      }
      val = val.replace(/\|+$/, "|");
      if (/\|.*\|/.test(val)) {
        val = val.replace(/\|$/, "");
      }

      if (val !== "|") {
        borderEntry = `border: ${val}; `;
      }
    }
  }

  // Border is handled special when not using autosplit split-values.
  if (borderEntry === "") {
    const inheritedBorder = computeInheritedNodeBorder(graph, n);
    const border = borderAttributeWithDefaults(n.attribute("borderstyle"), n.attribute("borderwidth"), n.attribute("bordercolor"));
    borderEntry = border !== "" && border !== inheritedBorder ? `border: ${border}; ` : "";
  }

  const txt = entries + borderEntry;
  return asAttributesBlock(txt);
}

function groupAsTxt(g: Group, processed: Set<Node>): string {
  // Nested groups in Perl as_txt are serialized as standalone group blocks *before*
  // their parent group, and they reference the parent via a `{ group: Parent; }`
  // attribute block.
  let txt = "";

  const children = g.groups.slice().sort((a, b) => cmpStr(a.name, b.name));
  for (const child of children) {
    txt += groupAsTxt(child, processed);
  }

  const name = escapeGroupName(g.name);
  const header = name === "" ? "(" : `( ${name}`;

  const nodes = [...g.nodes].sort((a, b) => cmpStr(a.id, b.id));

  txt += header;
  txt += nodes.length > 0 ? "\n" : " ";

  for (const n of nodes) {
    processed.add(n);
    txt += `  ${nodeAsPureTxt(n)}\n`;
  }

  txt += `)`;

  const att = (() => {
    const attrs: Attributes = Object.create(null);

    if (g.parent) {
      attrs.group = g.parent.name;
    }

    for (const [k, v] of Object.entries(g.explicitAttributes)) {
      if (k === "group") continue;
      attrs[k] = v;
    }

    const entries = formatAttributeEntries(attrs, { skipBorderParts: true, skipInternal: true });
    const border = borderAttributeWithDefaults(g.attribute("borderstyle"), g.attribute("borderwidth"), g.attribute("bordercolor"));
    const borderEntry = border !== "" ? `border: ${border}; ` : "";
    return asAttributesBlock(entries + borderEntry);
  })();

  txt += att;
  txt += "\n\n";
  return txt;
}

const EDGE_STYLES: Record<string, string> = {
  solid: "--",
  dotted: "..",
  double: "==",
  "double-dash": "= ",
  dashed: "- ",
  "dot-dash": ".-",
  "dot-dot-dash": "..-",
  wave: "~~",
};

function edgeAttributesAsTxt(e: Edge, suppressStyle: boolean): string {
  const attrs: Attributes = Object.create(null);
  for (const [k, v] of Object.entries(e.explicitAttributes)) {
    if (k === "label") continue;
    if (suppressStyle && k === "style") continue;
    if (/^border/.test(k)) continue;
    attrs[k] = v;
  }

  const txt = formatAttributeEntries(attrs, { skipBorderParts: true, skipInternal: true });
  return asAttributesBlock(txt);
}

function edgeAsTxt(e: Edge): string {
  let label = e.explicitAttributes.label;
  if (label === undefined) label = e.label;
  if (label === undefined) label = "";

  label = collapseLabelWhitespace(e.graph, label);

  const left = e.bidirectional ? " <" : " ";
  const right = e.undirected ? " " : "> ";

  const styleToken = (e.explicitAttributes.style ?? e.attribute("style") ?? "solid").trim().toLowerCase() || "solid";

  const isSpecial = /^(bold|bold-dash|broad|wide|invisible)$/.test(styleToken);

  let style = "--";
  let suppressStyle = false;

  if (isSpecial) {
    style = "--";
  } else {
    suppressStyle = true;
    const mapped = EDGE_STYLES[styleToken];
    if (!mapped) {
      throw new Error(`Unknown edge style '${styleToken}'`);
    }
    style = mapped;
  }

  let labelMid = "";
  if (label !== "") {
    labelMid = `${style} ${label} `;
  }

  // make " -  " into " - -  "
  if (e.undirected && style.length > 1 && style[1] === " ") {
    style = style + style;
  }

  const a = edgeAttributesAsTxt(e, suppressStyle);
  const aWithSpace = a !== "" ? a + " " : " ";
  const aTrimmed = aWithSpace.replace(/^\s/, "");

  return left + labelMid + style + right + aTrimmed;
}

function classDefinitions(graph: Graph): string {
  const items: Array<{ name: string; attrs: Attributes; kind: "edge" | "node" | "group" | "graph" }> = [];

  if (Object.keys(graph.graphAttributes).length) items.push({ name: "graph", attrs: graph.graphAttributes, kind: "graph" });
  if (Object.keys(graph.defaultNodeAttributes).length) items.push({ name: "node", attrs: graph.defaultNodeAttributes, kind: "node" });
  if (Object.keys(graph.defaultEdgeAttributes).length) items.push({ name: "edge", attrs: graph.defaultEdgeAttributes, kind: "edge" });
  if (Object.keys(graph.defaultGroupAttributes).length) items.push({ name: "group", attrs: graph.defaultGroupAttributes, kind: "group" });

  for (const [k, v] of graph.nodeClassAttributes.entries()) {
    items.push({ name: `node.${k}`, attrs: v, kind: "node" });
  }
  for (const [k, v] of graph.edgeClassAttributes.entries()) {
    items.push({ name: `edge.${k}`, attrs: v, kind: "edge" });
  }
  for (const [k, v] of graph.groupClassAttributes.entries()) {
    items.push({ name: `group.${k}`, attrs: v, kind: "group" });
  }

  items.sort((a, b) => cmpStr(a.name, b.name));

  let txt = "";

  for (const it of items) {
    let attLines = "";

    const keys = Object.keys(it.attrs).sort(cmpStr);
    for (const k of keys) {
      if (/^border/.test(k)) continue;
      const v0 = it.attrs[k];
      if (v0 === undefined || v0 === "") continue;
      const v = k === "label" ? collapseLabelWhitespace(graph, v0) : v0;
      attLines += `  ${k}: ${encodeValue(v)};\n`;
    }

    if (it.kind !== "edge") {
      const border = (() => {
        const styleRaw = it.attrs.borderstyle;
        const style = styleRaw === undefined || styleRaw === "" ? DEFAULT_BORDERSTYLE : styleRaw;
        if (style === "none") return "none";

        const width = it.attrs.borderwidth === DEFAULT_BORDERWIDTH ? "" : it.attrs.borderwidth ?? "";
        const color = it.attrs.bordercolor === DEFAULT_BORDERCOLOR ? "" : it.attrs.bordercolor ?? "";

        let b = borderAttribute(style, width, color);
        if (b === "") return "";

        const def = borderAttribute(DEFAULT_BORDERSTYLE, DEFAULT_BORDERWIDTH, DEFAULT_BORDERCOLOR);
        if (def.startsWith(b)) b = "";

        return b;
      })();

      if (border !== "") {
        attLines += `  border: ${border};\n`;
      }
    }

    if (attLines === "") continue;

    let att = attLines;

    // the following makes short, single definitions to fit on one line
    if (!/\n.*\n/.test(att) && att.length < 40) {
      att = att.replace(/\n/, " ");
      att = att.replace(/^  /, " ");
    } else {
      att = `\n${att}`;
    }

    txt += `${it.name} {${att}}\n`;
  }

  return txt;
}

export function renderTxt(graph: Graph): string {
  assignRanksForTxt(graph);

  let txt = "";

  txt += classDefinitions(graph);
  if (txt !== "") {
    txt += "\n";
  }

  const nodesByName = [...graph.nodes()].sort((a, b) => cmpStr(a.id, b.id) || a.numericId - b.numericId);

  const processed = new Set<Node>();

  let count = 0;
  for (const n of nodesByName) {
    const att = nodeAttributesAsTxt(n);
    if (att !== "") {
      processed.add(n);
      count++;
      txt += nodeAsPureTxt(n) + att + "\n";
    }
  }

  if (count > 0) {
    txt += "\n";
  }

  const groups = graph.groups.slice().sort((a, b) => cmpStr(a.name, b.name));
  for (const g of groups) {
    txt += groupAsTxt(g, processed);
  }

  const nodesByRank = [...graph.nodes()].sort((a, b) => {
    const ar = Math.abs(a.rank ?? 0);
    const br = Math.abs(b.rank ?? 0);
    return ar - br || cmpStr(a.id, b.id);
  });

  for (const n of nodesByRank) {
    const out = nodeSortedSuccessors(n);

    const isAutosplitPart = Object.prototype.hasOwnProperty.call(n.attributes, "autosplit_basename");
    const isAutosplitVisible = isAutosplitPart && n.autosplitLabel !== undefined;

    if (isAutosplitVisible || (out.length === 0 && n.predecessors().length === 0)) {
      // single node without any connections (unless already output)
      if (isAutosplitPart && !isAutosplitVisible) {
        continue;
      }

      if (!processed.has(n)) {
        txt += nodeAsPureTxt(n) + "\n";
      }
    }

    const first = nodeAsPartTxt(n);

    for (const other of out) {
      const edges = nodeEdgesTo(n, other);
      for (const e of edges) {
        txt += first + edgeAsTxt(e) + nodeAsPartTxt(other) + "\n";
      }
    }
  }

  return txt;
}
