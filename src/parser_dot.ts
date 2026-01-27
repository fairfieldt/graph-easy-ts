import { Graph } from "./graph.js";
import { Group } from "./group.js";
import type { Attributes } from "./attributes.js";
import type { Node } from "./node.js";

type Token =
  | { type: "punct"; value: string }
  | { type: "edgeOp"; value: "->" | "--" }
  | { type: "id"; value: string };

type NodeRef = {
  id: string;
  port?: string;
  compass?: string;
};

type Endpoint = {
  refs: NodeRef[];
  contributesToEdges: boolean;
};

type EdgeSpec = {
  id: number;
  from: NodeRef;
  to: NodeRef;
  directed: boolean;
  label: string;
  attrs: Attributes;
};

type RecordInfo = {
  primaryId: string;
  portIndexByName: Map<string, number>;
};

function newAttrs(): Attributes {
  return Object.create(null) as Attributes;
}

function copyAttrs(attrs: Attributes): Attributes {
  const out = newAttrs();
  Object.assign(out, attrs);
  return out;
}

function normalizeDotText(text: string): string {
  // Normalize line endings and handle DOT line continuations ("\\\n    ").
  const lf = text.replace(/\r\n?/g, "\n");
  return lf.replace(/\\\n\s*/g, " ");
}

function tokenizeDot(text: string): Token[] {
  const tokens: Token[] = [];

  const s = text;
  let i = 0;

  const pushPunct = (value: string) => tokens.push({ type: "punct", value });
  const pushEdgeOp = (value: "->" | "--") => tokens.push({ type: "edgeOp", value });
  const pushId = (value: string) => tokens.push({ type: "id", value });

  while (i < s.length) {
    const ch = s[i];

    // whitespace
    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    // line comments
    if (ch === "#") {
      while (i < s.length && s[i] !== "\n") i++;
      continue;
    }

    if (ch === "/" && s[i + 1] === "/") {
      i += 2;
      while (i < s.length && s[i] !== "\n") i++;
      continue;
    }

    // block comments
    if (ch === "/" && s[i + 1] === "*") {
      i += 2;
      while (i < s.length && !(s[i] === "*" && s[i + 1] === "/")) i++;
      if (i < s.length) i += 2;
      continue;
    }

    // edge operators
    if (ch === "-" && s[i + 1] === ">") {
      pushEdgeOp("->");
      i += 2;
      continue;
    }

    if (ch === "-" && s[i + 1] === "-") {
      pushEdgeOp("--");
      i += 2;
      continue;
    }

    // punctuation
    if ("{}[]();=,:+".includes(ch)) {
      pushPunct(ch);
      i++;
      continue;
    }

    // quoted string
    if (ch === "\"") {
      i++;
      let out = "";
      while (i < s.length) {
        const c = s[i];
        if (c === "\\") {
          // Preserve escapes verbatim.
          if (i + 1 < s.length) {
            out += s.slice(i, i + 2);
            i += 2;
            continue;
          }
          out += c;
          i++;
          continue;
        }
        if (c === "\"") {
          i++;
          break;
        }
        out += c;
        i++;
      }
      pushId(out);
      continue;
    }

    // HTML-like label/id: <...>
    if (ch === "<") {
      const start = i;
      i++;
      while (i < s.length && s[i] !== ">") i++;
      if (i >= s.length) {
        throw new Error("Unterminated <...> token in DOT input");
      }
      i++; // include '>'
      pushId(s.slice(start, i));
      continue;
    }

    // identifier / number / bare token
    const start = i;
    while (i < s.length) {
      const c = s[i];

      // stop on whitespace
      if (/\s/.test(c)) break;

      // stop on comment start
      if (c === "#") break;
      if (c === "/" && (s[i + 1] === "/" || s[i + 1] === "*")) break;

      // stop on punctuation / operators
      if ("{}[]();=,:+\"<>".includes(c)) break;
      if (c === "-" && (s[i + 1] === ">" || s[i + 1] === "-")) break;

      i++;
    }

    const raw = s.slice(start, i);
    if (raw.length) {
      // Graph::Easy::Parser::Graphviz treats a digit-prefixed token like "123abc" as
      // two tokens: "123" and "abc".
      const m = /^(\d+)([A-Za-z_].*)$/.exec(raw);
      if (m) {
        pushId(m[1]);
        pushId(m[2]);
      } else {
        pushId(raw);
      }
      continue;
    }

    throw new Error(`Unexpected character in DOT input: ${JSON.stringify(ch)}`);
  }

  return tokens;
}

function htmlLikeToText(value: string): string {
  const trimmed = value.trim();
  // Record labels frequently start/end with "<port>" tags (e.g. "<f0>|<f1> A|<f2>")
  // and must *not* be treated as HTML-like labels.
  if (trimmed.includes("|")) return value;
  if (trimmed.startsWith("<") && trimmed.endsWith(">")) {
    // Perl Graph::Easy preserves whitespace *inside* the HTML-like label (e.g. `< ] >`
    // becomes ` ] `, not `]`).
    const inner = trimmed.slice(1, -1);
    // dot/4_html_like.dot: empty HTML-like labels `<>` are treated as a single-space
    // label (not an empty string).
    return inner === "" ? " " : inner;
  }
  return value;
}

function normalizeDotHexColor(raw: string): string {
  if (!raw.startsWith("#")) return raw;
  return "#" + raw.slice(1).replace(/\s+/g, "").toLowerCase();
}

function hsv01ToRgbHex(hRaw: string, sRaw: string, vRaw: string): string {
  const h0 = Number(hRaw);
  const s0 = Number(sRaw);
  const v0 = Number(vRaw);

  const h = ((h0 % 1) + 1) % 1;
  const s = Math.max(0, Math.min(1, s0));
  const v = Math.max(0, Math.min(1, v0));

  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);

  let r = 0;
  let g = 0;
  let b = 0;
  switch (i % 6) {
    case 0:
      r = v;
      g = t;
      b = p;
      break;
    case 1:
      r = q;
      g = v;
      b = p;
      break;
    case 2:
      r = p;
      g = v;
      b = t;
      break;
    case 3:
      r = p;
      g = q;
      b = v;
      break;
    case 4:
      r = t;
      g = p;
      b = v;
      break;
    case 5:
      r = v;
      g = p;
      b = q;
      break;
  }

  const toHex = (x: number): string => {
    const clamped = Math.max(0, Math.min(255, Math.round(x * 255)));
    return clamped.toString(16).padStart(2, "0");
  };

  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function normalizeDotColor(value: string): string {
  const v0 = value.trim();

  // "//" means empty colorscheme (Graphviz syntax).
  const v1 = v0.startsWith("//") ? v0.slice(2) : v0;

  // Colorscheme prefix: /scheme/value
  const schemeMatch = /^\/([^/]+)\/(.+)$/.exec(v1);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    const rest = schemeMatch[2];

    if (scheme === "x11") {
      return rest;
    }

    if (scheme === "accent4") {
      const idx = Number(rest);
      const colors = ["#7fc97f", "#beaed4", "#fdc086", "#ffff99"];
      if (Number.isFinite(idx) && idx >= 1 && idx <= colors.length) return colors[idx - 1];
    }
  }

  // HSV forms.
  const hsvComma = /^([0-9]+(?:\.[0-9]+)?)\s*,\s*([0-9]+(?:\.[0-9]+)?)\s*,\s*([0-9]+(?:\.[0-9]+)?)$/.exec(v1);
  if (hsvComma) {
    return `hsv(${hsvComma[1]},${hsvComma[2]},${hsvComma[3]})`;
  }

  const hsvSpace = /^([0-9]+(?:\.[0-9]+)?)\s+([0-9]+(?:\.[0-9]+)?)\s+([0-9]+(?:\.[0-9]+)?)$/.exec(v1);
  if (hsvSpace) {
    return hsv01ToRgbHex(hsvSpace[1], hsvSpace[2], hsvSpace[3]);
  }

  return normalizeDotHexColor(v1);
}

function compassToDir(compass: string): string {
  const c = compass.trim().toLowerCase();
  const first = c.slice(0, 1);
  if (first === "n") return "north";
  if (first === "s") return "south";
  if (first === "e") return "east";
  if (first === "w") return "west";
  return "east";
}

function mapRankdirToFlow(rankdir: string): string {
  const d = rankdir.trim().toUpperCase();
  if (d === "LR") return "east";
  if (d === "RL") return "west";
  if (d === "TB") return "south";
  if (d === "BT") return "north";
  return "east";
}

function mapLabeljustToAlign(labeljust: string): string {
  const v = labeljust.trim().toLowerCase();
  if (v === "l") return "left";
  if (v === "r") return "right";
  return "center";
}

function mapLabellocToLabelpos(labelloc: string): string {
  const v = labelloc.trim().toLowerCase();
  return v.startsWith("b") ? "bottom" : "top";
}

function mapDotNodeShape(shapeRaw: string): string {
  const s0 = shapeRaw.trim().toLowerCase();

  let s = s0;
  if (s.startsWith("double")) s = s.slice("double".length);
  if (s.startsWith("triple")) s = s.slice("triple".length);
  s = s.trim();

  if (s === "plaintext") return "none";
  if (s === "none") return "none";

  if (s === "box" || s === "polygon" || s === "egg" || s === "rectangle" || s === "msquare") return "rect";
  if (s === "mdiamond") return "diamond";

  return s;
}

function removeRecordPortTags(text: string): string {
  // Remove "<port>" tokens at the start of record fields.
  return text.replace(/(^|\|)\s*<[^>]*>/g, "$1");
}

function parseRecord(labelRaw: string, flow: string): { displayLabel: string; ports: (string | undefined)[] } {
  let label = labelRaw;

  // Graph::Easy::Parser::Graphviz.pm special-case: simple {..|..} record notation.
  if (/^\s*\{[^{}]+\}\s*$/.test(label)) {
    label = label.replace(/[{}]/g, "");

    if (/^(east|west)$/.test(flow)) {
      // {A|B} => A||  B (cheat for horizontal flow)
      label = label.replace(/\|/g, "||  ");
    }

    if (/^(north|south)$/.test(flow)) {
      // {A||B} => A|  |B (avoid empty record parts)
      label = label.replace(/\|\|/g, "|  |");
    }
  }

  const ports: (string | undefined)[] = [];
  let remaining = label;
  let add = 0;

  while (remaining !== "") {
    // Regex-equivalent of: ^((\\\||[^\|])*)(\|\|?|\z)
    let i = 0;
    while (i < remaining.length) {
      const ch = remaining[i];
      if (ch === "|") break;
      if (ch === "\\" && i + 1 < remaining.length && remaining[i + 1] === "|") {
        i += 2;
        continue;
      }
      i += 1;
    }

    const partRaw = remaining.slice(0, i);

    let sep = "";
    let sepLen = 0;
    if (i < remaining.length && remaining[i] === "|") {
      if (i + 1 < remaining.length && remaining[i + 1] === "|") {
        sep = "||";
        sepLen = 2;
      } else {
        sep = "|";
        sepLen = 1;
      }
    }

    remaining = remaining.slice(i + sepLen);

    // fix [|G|] to have one empty part as last part
    if (add === 0 && remaining === "" && (sep === "|" || sep === "||")) {
      add += 1;
      remaining += "|";
    }

    const m = /^\s*<([^>]*)>/.exec(partRaw);
    ports.push(m ? m[1] : undefined);
  }

  let display = removeRecordPortTags(label);
  // Avoid empty parts in downstream renderers by ensuring at least two spaces for empty record fields.
  // Note: `| | |` contains overlapping `| |` matches, so apply twice to catch consecutive empty fields.
  display = display.replace(/\|\s\|/g, "|  |");
  display = display.replace(/\|\s\|/g, "|  |");

  return { displayLabel: display, ports };
}

class DotParser {
  private readonly tokens: Token[];
  private pos = 0;

  private readonly graph = new Graph();
  private readonly groupStack: Group[] = [];

  private readonly edgeSpecs: EdgeSpec[] = [];
  private defaultEdgeLabel = "";

  // DOT `node [ ... ]` defaults should be applied to nodes as they are created.
  // Perl does not serialize these as a `node { ... }` defaults block in as_txt.
  private readonly dotNodeDefaults: Attributes = newAttrs();

  // DOT `edge [ ... ]` defaults should be applied to edges as they are created.
  // Perl does not serialize these as additional `edge { ... }` defaults.
  private readonly dotEdgeDefaults: Attributes = newAttrs();

  // Some DOT fixtures include compass-only node declarations like `c:w;`.
  // Perl's Graph::Easy::Parser::Graphviz defers materializing these nodes in a
  // way that affects the node-id ordering used by as_graphviz sorted_nodes().
  // To match Perl, we defer materializing such nodes *only when* they have no
  // attributes and are not part of an edge statement.
  private readonly pendingCompassOnlyNodeDecls: Array<{
    id: string;
    group: Group | undefined;
    nodeDefaultsSnapshot: Attributes;
  }> = [];

  public constructor(text: string) {
    const normalized = normalizeDotText(text);
    this.tokens = tokenizeDot(normalized);

    // DOT default setup (mirrors expected t/txt/dot outputs).
    this.graph.setGraphAttributes({ colorscheme: "x11", flow: "south" });
    this.graph.setDefaultAttributes("edge", { arrowstyle: "filled" });

    // DOT label parsing (e.g. string continuations) can intentionally produce
    // multiple internal spaces that must be preserved through ASCII rendering.
    this.graph.preserveLabelWhitespace = true;
  }

  public parse(): Graph {
    // optional: strict
    if (this.peekIdValueCi("strict")) {
      this.pos++;
    }

    const graphTypeToken = this.consumeId();
    const graphType = graphTypeToken.toLowerCase();
    if (graphType !== "graph" && graphType !== "digraph") {
      throw new Error(`Expected 'graph' or 'digraph', got: ${graphTypeToken}`);
    }

    // Perl Graph::Easy emits an explicit `type: undirected;` marker for DOT `graph`
    // inputs (see dot/2_no_spaces.dot).
    if (graphType === "graph") {
      this.graph.setGraphAttributes({ type: "undirected" });
    }

    const title = this.peekPunct("{") ? "" : this.parseIdExpr().trim();
    this.graph.setGraphAttributes({ title: title || "unnamed" });

    this.expectPunct("{");

    while (!this.peekPunct("}") && !this.isEof()) {
      this.parseStatement();
      // optional statement separators
      while (this.peekPunct(";") || this.peekPunct(",")) {
        this.pos++;
      }
    }

    this.expectPunct("}");

    for (const decl of this.pendingCompassOnlyNodeDecls) {
      const existing = this.graph.node(decl.id);
      const node = this.graph.addNode(decl.id);
      if (decl.group) {
        decl.group.addNode(node);
      }
      if (!existing && Object.keys(decl.nodeDefaultsSnapshot).length) {
        node.setAttributes(decl.nodeDefaultsSnapshot);
      }
    }

    const recordInfo = this.splitRecordNodes();
    this.materializeEdges(recordInfo);

    return this.graph;
  }

  private currentGroup(): Group | undefined {
    return this.groupStack.length ? this.groupStack[this.groupStack.length - 1] : undefined;
  }

  private addNodeToCurrentGroup(node: Node): void {
    const g = this.currentGroup();
    if (g) g.addNode(node);
  }

  private openGroup(name: string): Group {
    // DOT parser defaults: only materialize the default group attrs if we actually
    // see a subgraph (Perl emits a `group { ... }` block only when groups exist).
    if (Object.keys(this.graph.defaultGroupAttributes).length === 0) {
      this.graph.setDefaultAttributes("group", { align: "center", fill: "inherit" });
    }

    const g = new Group(name, this.graph.allocateId());
    g.applyInheritedAttributes(this.graph.defaultGroupAttributes);

    const parent = this.currentGroup();
    if (parent) parent.addGroup(g);
    else this.graph.addGroup(g);

    this.groupStack.push(g);
    return g;
  }

  private closeGroup(): void {
    if (!this.groupStack.pop()) {
      throw new Error("Encountered end of subgraph with no open group");
    }
  }

  private parseStatement(): void {
    if (this.isEof() || this.peekPunct("}")) return;

    // subgraph ... { ... }
    if (this.peekIdValueCi("subgraph")) {
      this.parseSubgraph();
      return;
    }

    // a leading '{ ... }' in our fixtures is used for edge scopes like '{ b c d } -> u'
    if (this.peekPunct("{")) {
      const first = this.parseNodeSetEndpoint();
      if (this.peekEdgeOp()) {
        this.parseEdgeStatement(first);
      }
      return;
    }

    // graph/node/edge attribute statement
    if (this.peekIdValueCi("graph") || this.peekIdValueCi("node") || this.peekIdValueCi("edge")) {
      const keyword = this.peekToken();
      if (keyword?.type === "id") {
        // Lookahead: only treat as attribute statement when followed by '['.
        const next = this.tokens[this.pos + 1];
        if (next?.type === "punct" && next.value === "[") {
          this.pos++;
          const attrs = this.parseAttrList();
          const kw = keyword.value.toLowerCase();
          if (kw === "graph") this.applyGraphAttrs(attrs);
          else if (kw === "node") this.applyNodeDefaults(attrs);
          else this.applyEdgeDefaults(attrs);
          return;
        }
      }
    }

    // assignment / edge / node statement
    // NOTE: For `key = value` attribute assignments, we must not materialize a node
    // for `key` (e.g. `label=...` inside a subgraph), so do a token-only lookahead.
    const pos0 = this.pos;
    const key = this.parseIdExpr().trim();
    if (this.peekPunct("=")) {
      this.pos++;
      const value = this.parseIdExpr();
      this.applyAssignment(key, value);
      return;
    }
    this.pos = pos0;

    const ref = this.parseNodeRefNoCreate();

    if (this.peekEdgeOp()) {
      // Materialize the node now (to preserve Graph::Easy node-id allocation order).
      this.materializeNodeId(ref.id);
      this.parseEdgeStatement({ refs: [ref], contributesToEdges: true });
      return;
    }

    // node statement
    const attrs = this.peekPunct("[") ? this.parseAttrList() : newAttrs();
    const isCompassOnly =
      ref.port !== undefined &&
      ref.compass === undefined &&
      /^(n|ne|e|se|s|sw|w|nw)$/.test(ref.port.trim().toLowerCase());

    if (isCompassOnly && Object.keys(attrs).length === 0) {
      this.pendingCompassOnlyNodeDecls.push({
        id: ref.id,
        group: this.currentGroup(),
        nodeDefaultsSnapshot: copyAttrs(this.dotNodeDefaults),
      });
      return;
    }

    this.applyNodeStatement(ref.id, attrs);
  }

  private materializeNodeId(id: string): void {
    const existing = this.graph.node(id);
    const node = this.graph.addNode(id);
    this.addNodeToCurrentGroup(node);
    if (!existing && Object.keys(this.dotNodeDefaults).length) {
      node.setAttributes(this.dotNodeDefaults);
    }
  }

  private parseNodeRefNoCreate(): NodeRef {
    const id = this.parseIdExpr().trim();
    let port: string | undefined;
    let compass: string | undefined;

    if (this.peekPunct(":")) {
      this.pos++;
      port = this.parseIdExpr().trim();

      if (this.peekPunct(":")) {
        this.pos++;
        compass = this.parseIdExpr().trim();
      }
    }

    return { id, port, compass };
  }

  private parseSubgraph(): void {
    // consume 'subgraph'
    this.pos++;

    let name = "";
    if (!this.peekPunct("{")) {
      name = this.parseIdExpr().trim();
    }

    this.expectPunct("{");

    this.openGroup(name);

    while (!this.peekPunct("}") && !this.isEof()) {
      this.parseStatement();
      while (this.peekPunct(";") || this.peekPunct(",")) {
        this.pos++;
      }
    }

    this.expectPunct("}");
    this.closeGroup();
  }

  private parseEdgeStatement(first: Endpoint): void {
    const segments: Array<{ from: Endpoint; to: Endpoint; directed: boolean }> = [];

    let prev = first;

    while (this.peekEdgeOp()) {
      const op = this.consumeEdgeOp();
      const directed = op === "->";
      const next = this.parseEndpoint();
      segments.push({ from: prev, to: next, directed });
      prev = next;
    }

    const attrsRaw = this.peekPunct("[") ? this.parseAttrList() : newAttrs();
    const { edgeLabel, edgeAttrs, dirMod } = this.remapEdgeAttrs(attrsRaw);
    const finalLabel = edgeLabel ?? this.defaultEdgeLabel;

    for (const seg of segments) {
      if (!seg.from.contributesToEdges || !seg.to.contributesToEdges) {
        continue;
      }

      let directed = seg.directed;
      if (dirMod === "none") directed = false;

      for (const from0 of seg.from.refs) {
        for (const to0 of seg.to.refs) {
          let from = from0;
          let to = to0;
          if (dirMod === "back") {
            [from, to] = [to, from];
          }

          const attrs: Attributes = newAttrs();
          Object.assign(attrs, edgeAttrs);

          // Graph::Easy assigns node+edge IDs from one shared counter as it parses.
          // Since we materialize edges later (after record splitting), reserve the
          // edge ID here to preserve the interleaving and ord_values() ordering.
          const id = this.graph.allocateId();
          this.edgeSpecs.push({ id, from, to, directed, label: finalLabel, attrs });
        }
      }
    }
  }

  private parseEndpoint(): Endpoint {
    if (this.peekPunct("{")) {
      return this.parseNodeSetEndpoint();
    }

    return { refs: [this.parseNodeRef()], contributesToEdges: true };
  }

  private parseNodeSetEndpoint(): Endpoint {
    this.expectPunct("{");

    const refs: NodeRef[] = [];
    const scopedNodeDefaults: Attributes = newAttrs();
    let hasScopeStatements = false;

    // Graphviz-style scoped defaults are not retroactive: nodes that already exist
    // before entering this scope keep their attributes. (See dot/5_scope_atr.dot.)
    const existingNodeIds = new Set<string>();
    for (const n of this.graph.nodes()) existingNodeIds.add(n.id);

    while (!this.peekPunct("}") && !this.isEof()) {
      if (this.peekPunct(";") || this.peekPunct(",")) {
        this.pos++;
        continue;
      }

      // scoped defaults like: node [ shape=plaintext ]
      const kw = this.peekToken();
      const next = this.tokens[this.pos + 1];
      if (kw?.type === "id" && next?.type === "punct" && next.value === "[") {
        const k = kw.value.toLowerCase();
        if (k === "node") {
          hasScopeStatements = true;
          this.pos++;
          const attrs = this.parseAttrList();
          Object.assign(scopedNodeDefaults, this.remapNodeAttrs(attrs));
          continue;
        }

        if (k === "graph" || k === "edge") {
          // In the Graph::Easy Perl parser, these can appear; for now we just
          // treat them as scope statements that should not create edges.
          hasScopeStatements = true;
          this.pos++;
          void this.parseAttrList();
          continue;
        }
      }

      const ref = this.parseNodeRef();
      refs.push(ref);

      // Only apply the scoped defaults to nodes that are first created in this scope.
      if (!existingNodeIds.has(ref.id)) {
        existingNodeIds.add(ref.id);
        const node = this.graph.node(ref.id);
        if (!node) throw new Error(`Internal error: missing node for id '${ref.id}'`);
        node.setAttributes(scopedNodeDefaults);
      }
    }

    this.expectPunct("}");

    return { refs, contributesToEdges: !hasScopeStatements };
  }

  private parseAttrList(): Attributes {
    this.expectPunct("[");
    const attrs: Attributes = newAttrs();

    while (!this.peekPunct("]") && !this.isEof()) {
      // separators
      if (this.peekPunct(",") || this.peekPunct(";")) {
        this.pos++;
        continue;
      }

      const key = this.parseIdExpr();
      if (!key) {
        throw new Error("Empty attribute key in DOT attribute list");
      }

      if (this.peekPunct("=")) {
        this.pos++;
        const value = this.parseIdExpr();
        attrs[key] = value;
      } else {
        // boolean
        attrs[key] = "true";
      }

      // optional separators
      if (this.peekPunct(",") || this.peekPunct(";")) {
        this.pos++;
      }
    }

    this.expectPunct("]");
    return attrs;
  }

  private parseNodeRef(): NodeRef {
    const id = this.parseIdExpr().trim();
    let port: string | undefined;
    let compass: string | undefined;

    if (this.peekPunct(":")) {
      this.pos++;
      port = this.parseIdExpr().trim();

      if (this.peekPunct(":")) {
        this.pos++;
        compass = this.parseIdExpr().trim();
      }
    }

    const existing = this.graph.node(id);
    const node = this.graph.addNode(id);
    this.addNodeToCurrentGroup(node);
    if (!existing && Object.keys(this.dotNodeDefaults).length) {
      node.setAttributes(this.dotNodeDefaults);
    }

    return { id, port, compass };
  }

  private parseIdExpr(): string {
    let out = this.parseIdTerm();
    while (this.peekPunct("+")) {
      this.pos++;
      out += this.parseIdTerm();
    }
    return out;
  }

  private parseIdTerm(): string {
    const t = this.peekToken();
    if (!t || t.type !== "id") {
      throw new Error(`Expected identifier, got: ${t ? JSON.stringify(t) : "<eof>"}`);
    }
    this.pos++;
    return htmlLikeToText(t.value);
  }

  private applyAssignment(keyRaw: string, valueRaw: string): void {
    const key = keyRaw.trim();
    const value = valueRaw;

    const group = this.currentGroup();
    if (group) {
      const mapped = this.remapGroupAttr(key, value);
      if (mapped) group.setAttributes(mapped);
      return;
    }

    const mapped = this.remapGraphAttr(key, value);
    if (mapped) this.graph.setGraphAttributes(mapped);
  }

  private applyGraphAttrs(attrs: Attributes): void {
    const mapped = this.remapGraphAttrs(attrs);
    if (mapped) this.graph.setGraphAttributes(mapped);
  }

  private applyNodeDefaults(attrs: Attributes): void {
    Object.assign(this.dotNodeDefaults, this.remapNodeAttrs(attrs));
  }

  private applyEdgeDefaults(attrs: Attributes): void {
    // Edge defaults are stored for subsequent edges; we apply a remap.
    const { edgeLabel, edgeAttrs } = this.remapEdgeAttrs(attrs);

    if (edgeLabel !== undefined) {
      this.defaultEdgeLabel = edgeLabel;
    }

    if (Object.keys(edgeAttrs).length) Object.assign(this.dotEdgeDefaults, edgeAttrs);
  }

  private applyNodeStatement(nodeId: string, attrs: Attributes): void {
    const existing = this.graph.node(nodeId);
    const node = this.graph.addNode(nodeId);
    this.addNodeToCurrentGroup(node);
    if (!existing && Object.keys(this.dotNodeDefaults).length) {
      node.setAttributes(this.dotNodeDefaults);
    }

    const mapped = this.remapNodeAttrs(attrs);
    if (mapped) node.setAttributes(mapped);
  }

  private remapGraphAttrs(attrs: Attributes): Attributes {
    const out = newAttrs();
    for (const [k0, v0] of Object.entries(attrs)) {
      const k = k0.trim();
      const v = v0;
      const mapped = this.remapGraphAttr(k, v);
      if (mapped) Object.assign(out, mapped);
    }
    return out;
  }

  private remapGraphAttr(key: string, value: string): Attributes | undefined {
    const k = key.toLowerCase();

    if (k === "rankdir") return { flow: mapRankdirToFlow(value) };
    if (k === "labeljust") return { align: mapLabeljustToAlign(value) };
    if (k === "labelloc") return { labelpos: mapLabellocToLabelpos(value) };
    if (k === "label") return { label: value };
    if (k === "colorscheme") return { colorscheme: value };
    if (k === "output") return { output: value };

    // Preserve unknown graph attrs under x-dot-* (matches t/txt/dot fixtures).
    return { [`x-dot-${k}`]: value };
  }

  private remapGroupAttr(key: string, value: string): Attributes | undefined {
    const k = key.toLowerCase();

    if (k === "label") return { label: value };
    if (k === "labeljust") return { align: mapLabeljustToAlign(value) };
    if (k === "labelloc") return { labelpos: mapLabellocToLabelpos(value) };

    if (k === "pencolor") {
      // dot/3_colors.dot: clusters with pencolor="#ff 00 00" serialize as a dashed border.
      const c = normalizeDotColor(value);
      return { border: `dashed  ${c}` };
    }

    if (k === "style") {
      const parts = value
        .split(",")
        .map((p) => p.trim().toLowerCase())
        .filter(Boolean);

      // Match Perl DOT behavior for clusters: dashed/dotted/bold map to a border style;
      // filled is covered by the default group fill.
      for (const p of parts) {
        if (p === "dotted" || p === "dashed" || p === "bold") {
          return { border: `${p}  black` };
        }
      }

      return undefined;
    }

    // Preserve unknown group attrs.
    return { [`x-dot-${k}`]: value };
  }

  private remapNodeAttrs(attrs: Attributes): Attributes {
    const out = newAttrs();

    for (const [k0, v0] of Object.entries(attrs)) {
      const k = k0.trim().toLowerCase();
      const v = v0;

      if (k === "label") {
        out.label = v;
        continue;
      }

      if (k === "shape") {
        out.shape = mapDotNodeShape(v);
        continue;
      }

      if (k === "fontsize") {
        const size = v.trim();
        out.fontsize = /^\d+(\.\d+)?$/.test(size) ? `${size}px` : size;
        continue;
      }

      if (k === "fontname") {
        out.font = v;
        continue;
      }

      if (k === "style") {
        // Graphviz style list: apply a handful of common shorthands.
        const parts = v
          .split(",")
          .map((p) => p.trim().toLowerCase())
          .filter(Boolean);

        for (const p of parts) {
          if (p === "filled") out.shape = "rect";
          else if (p === "rounded") out.shape = "rounded";
          else if (p === "invis") out.shape = "invisible";
          else if (p === "dotted" || p === "dashed" || p === "bold") {
            out.border = `${p}  black`;
          } else {
            const m = /setlinewidth\((\d+|\d*\.\d+)\)/.exec(p);
            if (m) {
              const width = Math.abs(Number(m[1] || 1));
              let border = "wide";
              if (width < 3) border = "solid";
              else if (width >= 3 && width < 5) border = "bold";
              else if (width >= 5 && width < 11) border = "broad";
              // Avoid setting the default border explicitly.
              if (border !== "solid") {
                out.border = border;
              }
            }
          }
        }

        continue;
      }

      if (k === "color") {
        out.color = normalizeDotColor(v);
        continue;
      }

      // Perl warns and ignores unknown DOT node attributes.
      // (See dot/2_ignore.dot.)
      continue;
    }

    return out;
  }

  private remapEdgeAttrs(attrs: Attributes): {
    edgeLabel: string | undefined;
    edgeAttrs: Attributes;
    dirMod?: "back" | "none";
  } {
    const out = newAttrs();
    let label: string | undefined;
    let dirMod: "back" | "none" | undefined;

    for (const [k0, v0] of Object.entries(attrs)) {
      const k = k0.trim().toLowerCase();
      const v = v0;

      if (k === "label") {
        label = v;
        continue;
      }

      if (k === "dir") {
        const d = v.trim().toLowerCase();
        if (d === "back") dirMod = "back";
        else if (d === "none") dirMod = "none";
        continue;
      }

      if (k === "headport") {
        out.end = compassToDir(v);
        continue;
      }

      if (k === "tailport") {
        out.start = compassToDir(v);
        continue;
      }

      if (k === "color") {
        out.color = normalizeDotColor(v);
        continue;
      }

      if (k === "style") {
        let style = v.trim();
        if (style === "invis") style = "invisible";
        if (style === "normal") style = "solid";

        const m = /setlinewidth\((\d+|\d*\.\d+)\)/.exec(style);
        if (m) {
          const width = Math.abs(Number(m[1] || 1));
          style = "wide";
          if (width < 3) style = "solid";
          else if (width >= 3 && width < 5) style = "bold";
          else if (width >= 5 && width < 11) style = "broad";
        }

        // Avoid setting the default style explicitly.
        if (style !== "solid") {
          out.style = style;
        }
        continue;
      }

      // Preserve unknown edge attrs.
      // Perl warns and ignores unknown DOT edge attributes.
      // (See dot/2_ignore.dot.)
      continue;
    }

    return { edgeLabel: label, edgeAttrs: out, dirMod };
  }

  private splitRecordNodes(): Map<string, RecordInfo> {
    const recordInfo = new Map<string, RecordInfo>();
    const flow = (this.graph.graphAttributes.flow ?? "south").toLowerCase();

    // Copy nodes list since we might mutate graph.
    const nodes = Array.from(this.graph.nodes());
    for (const n of nodes) {
      const shape = (n.attributes.shape ?? "").toLowerCase();
      if (shape !== "record") continue;

      const rawLabel = n.attributes.label ?? n.label;
      if (!rawLabel.includes("|")) continue;

      const { displayLabel, ports } = parseRecord(rawLabel, flow);

      // If the DOT record used any explicit <port> tags, Perl treats unnamed fields
      // differently than plain records: unnamed/empty fields use a single-space port.
      const hasExplicitPorts = ports.some((p) => p !== undefined && p.trim() !== "");

      const base = n.id;

      // Determine whether a basename attribute should survive (mirrors perl cleanup).
      // Only emit basename when it differs from the visible record label (dot/7_record.dot).
      const cleanedBasename = removeRecordPortTags(base).trim();
      const displayBasename = displayLabel.trim();

      const portIndexByName = new Map<string, number>();

      for (let idx = 0; idx < ports.length; idx++) {
        const p = ports[idx];
        if (p) portIndexByName.set(p, idx);
      }

      // Copy all attributes except 'shape' and 'label'.
      const copied: Attributes = newAttrs();
      for (const [k, v] of Object.entries(n.attributes)) {
        if (k === "shape" || k === "label") continue;
        copied[k] = v;
      }
      const hasCopiedAttrs = Object.keys(copied).length > 0;

      // Materialize the record as a Graph::Easy autosplit cluster (basename.idx),
      // matching Graph::Easy::Parser::_autosplit_node.
      let firstInRow: Node | undefined;
      let x = 0;
      let y = 0;
      let idx = 0;
      let remaining = displayLabel;
      let lastSep = "";
      let add = 0;
      const created: Node[] = [];

      while (remaining !== "") {
        // Regex-equivalent of: ^((\\\||[^\|])*)(\|\|?|\z)
        let i = 0;
        while (i < remaining.length) {
          const ch = remaining[i];
          if (ch === "|") break;
          if (ch === "\\" && i + 1 < remaining.length && remaining[i + 1] === "|") {
            i += 2;
            continue;
          }
          i += 1;
        }

        const partRaw = remaining.slice(0, i);
        const partWasEmpty = partRaw === "";

        let sep = "";
        let sepLen = 0;
        if (i < remaining.length && remaining[i] === "|") {
          if (i + 1 < remaining.length && remaining[i + 1] === "|") {
            sep = "||";
            sepLen = 2;
          } else {
            sep = "|";
            sepLen = 1;
          }
        }

        remaining = remaining.slice(i + sepLen);

        // Perl uses $1 || ' ' (empty parts become a single space).
        let part = partWasEmpty ? " " : partRaw;

        // fix [|G|] to have one empty part as last part
        if (add === 0 && remaining === "" && (sep === "|" || sep === "||")) {
          add += 1;
          remaining += "|";
        }

        // Determine whether to create a borderless empty node or a bordered empty node.
        let isEmptyBorderless = false;
        const isEmptyField = partWasEmpty || /^[ ]+$/.test(partRaw);
        if (isEmptyField || /^[ ]+$/.test(part)) {
          // For Graphviz record nodes, empty fields are still *bordered* cells.
          part = " ";
        } else {
          // strip spaces at front/end
          part = part.trim();
        }

        const partId = `${base}.${idx}`;
        const node = this.graph.addNode(partId);
        if (hasCopiedAttrs) node.setAttributes(copied);
        if (isEmptyBorderless) node.setAttributes({ shape: "invisible" });

        node.label = part;

        // DOT record port naming:
        // - If the record field has an explicit <port> tag, use it.
        // - If any explicit ports exist in this record, unnamed fields use a single-space port.
        // - Otherwise (no explicit ports), Perl uses the cell text as the port name for non-empty
        //   fields and a two-space port name for truly empty fields ("||").
        const portText = partRaw.trimEnd();
        const derivedPortname =
          ports[idx] ??
          (hasExplicitPorts
            ? isEmptyField
              ? " "
              : portText
            : isEmptyField
              ? "  "
              : portText);
        node.setAttributes({
          autosplit_basename: base,
          autosplit_xy: `${x},${y}`,
          autosplit_portname: derivedPortname,
        });

        // Relative placement.
        if (idx === 0) {
          firstInRow = node;
          // The first autosplit part is the visible record root. Store the full
          // record label here so as_txt serializes the record node as
          // `[ <record label> ]` instead of `[ <id> ]`.
          node.autosplitLabel = displayLabel;
          // Internal marker used by the txt renderer to match Perl spacing quirks for
          // DOT-derived record labels.
          node.setAttributes({ autosplit_from_dot: "1" });
          if (cleanedBasename !== "" && cleanedBasename !== displayBasename) {
            node.setAttributes({ basename: cleanedBasename });
          }
        } else {
          let origin: Node | undefined = created[created.length - 1];
          let sx = 1;
          let sy = 0;
          if (lastSep === "||") {
            origin = firstInRow;
            sx = 0;
            sy = 1;
            firstInRow = node;
          }
          if (!origin) {
            throw new Error(`splitRecordNodes: missing origin for ${partId}`);
          }
          node.origin = origin;
          node.dx = sx;
          node.dy = sy;
          origin.children.set(node.id, node);
        }

        this.addNodeToCurrentGroup(node);
        created.push(node);

        idx += 1;
        lastSep = sep;
        x += 1;
        if (sep === "||") {
          x = 0;
          y += 1;
        }
      }

      // Remove the helper record node.
      this.graph.deleteNode(base);

      recordInfo.set(base, { primaryId: `${base}.0`, portIndexByName });
    }

    return recordInfo;
  }

  private materializeEdges(recordInfo: Map<string, RecordInfo>): void {
    for (const spec of this.edgeSpecs) {
      const attrs: Attributes = spec.attrs;

      const from = this.resolveNodeRef(spec.from, recordInfo, "from", attrs);
      const to = this.resolveNodeRef(spec.to, recordInfo, "to", attrs);

      const directed = spec.directed;

      const rightOp = directed ? "-->" : "--";
      const leftOp = directed ? (spec.label ? "--" : "-->") : "--";

      const edge = this.graph.addEdgeWithId(spec.id, from, to, leftOp, rightOp, spec.label);
      if (Object.keys(attrs).length) edge.setAttributes(attrs);

      // Graph::Easy::Parser::Graphviz applies the scope edge defaults again after
      // local edge attributes, meaning defaults like `edge [style=setlinewidth(3)]`
      // override per-edge `style=` values (see dot/9_edge_styles.dot).
      if (Object.keys(this.dotEdgeDefaults).length) {
        // Apply defaults after locals, and record them explicitly so as_txt prints
        // them per-edge (Perl behavior).
        for (const [k, v] of Object.entries(this.dotEdgeDefaults)) {
          edge.attributes[k] = v;
          edge.explicitAttributes[k] = v;
        }
      }
    }
  }

  private expandGraphvizLabels(): void {
    const graphName = this.graph.graphAttributes.title ?? "";

    if ("label" in this.graph.graphAttributes) {
      this.graph.graphAttributes.label = this.expandGraphvizLabel(this.graph.graphAttributes.label, { graphName });
    }

    for (const node of this.graph.nodes()) {
      if ("label" in node.attributes) {
        node.attributes.label = this.expandGraphvizLabel(node.attributes.label, { graphName, nodeName: node.id });
      }
    }

    for (const edge of this.graph.edges) {
      const raw = "label" in edge.attributes ? edge.attributes.label : edge.label;

      const tail = edge.from.id;
      const head = edge.to.id;

      // Graphviz renders \E as "tail->head" for directed edges.
      const directed = edge.rightOp.includes(">") || edge.leftOp.includes(">");
      const edgeName = `${tail}${directed ? "->" : "--"}${head}`;

      edge.attributes.label = this.expandGraphvizLabel(raw, {
        graphName,
        tailName: tail,
        headName: head,
        edgeName,
      });
    }
  }

  private expandGraphvizLabel(
    raw: string,
    ctx: {
      graphName: string;
      nodeName?: string;
      tailName?: string;
      headName?: string;
      edgeName?: string;
    }
  ): string {
    let out = raw;

    out = out.replace(/\\G/g, ctx.graphName);

    if (ctx.nodeName !== undefined) out = out.replace(/\\N/g, ctx.nodeName);
    if (ctx.tailName !== undefined) out = out.replace(/\\T/g, ctx.tailName);
    if (ctx.headName !== undefined) out = out.replace(/\\H/g, ctx.headName);
    if (ctx.edgeName !== undefined) out = out.replace(/\\E/g, ctx.edgeName);

    return out;
  }

  private resolveNodeRef(ref: NodeRef, recordInfo: Map<string, RecordInfo>, side: "from" | "to", attrs: Attributes): Node {
    const base = ref.id;
    const rec = recordInfo.get(base);

    let nodeId = base;

    // Graphviz allows `node:compass` when no explicit port is provided. In record
    // nodes, this is ambiguous with port names (e.g. `w` could be a port name),
    // so we disambiguate here using the parsed record port list.
    let compass = ref.compass;

    if (ref.port) {
      const portLower = ref.port.trim().toLowerCase();
      const isCompassOnly = /^(n|ne|e|se|s|sw|w|nw)$/.test(portLower);

      if (rec) {
        const idxExact = rec.portIndexByName.get(ref.port);
        if (idxExact !== undefined) {
          nodeId = `${base}.${idxExact}`;
        } else if (isCompassOnly) {
          // `node:s` where no matching record port exists is treated as a compass
          // point. If a record port differs only by case (e.g. `S`), Graph::Easy
          // resolves it to that port and also sets the start/end direction.
          compass ??= ref.port;

          let idxCi: number | undefined;
          for (const [name, idx] of rec.portIndexByName.entries()) {
            if (name.trim().toLowerCase() === portLower) {
              idxCi = idx;
              break;
            }
          }

          nodeId = `${base}.${idxCi ?? 0}`;
        } else {
          nodeId = `${base}.0`;
        }
      } else if (!compass && isCompassOnly) {
        // `node:s` with no record ports -> compass-only attachment.
        compass = ref.port;
        nodeId = base;
      } else {
        nodeId = `${base}:${ref.port}`;
      }
    } else if (rec) {
      nodeId = rec.primaryId;
    }

    const node = this.graph.addNode(nodeId);

    // Handle port compass overrides ("node:port:ne") and compass-only endpoints
    // ("node:s").
    if (compass) {
      const d = compassToDir(compass);
      if (side === "from") attrs.start = attrs.start ?? d;
      else attrs.end = attrs.end ?? d;
    }

    return node;
  }

  private peekToken(): Token | undefined {
    return this.tokens[this.pos];
  }

  private isEof(): boolean {
    return this.pos >= this.tokens.length;
  }

  private peekPunct(value: string): boolean {
    const t = this.peekToken();
    return !!t && t.type === "punct" && t.value === value;
  }

  private expectPunct(value: string): void {
    const t = this.peekToken();
    if (!t || t.type !== "punct" || t.value !== value) {
      throw new Error(`Expected '${value}', got: ${t ? JSON.stringify(t) : "<eof>"}`);
    }
    this.pos++;
  }

  private peekIdValueCi(valueLower: string): boolean {
    const t = this.peekToken();
    return !!t && t.type === "id" && t.value.toLowerCase() === valueLower;
  }

  private consumeId(): string {
    const t = this.peekToken();
    if (!t || t.type !== "id") {
      throw new Error(`Expected identifier, got: ${t ? JSON.stringify(t) : "<eof>"}`);
    }
    this.pos++;
    return t.value;
  }

  private peekEdgeOp(): boolean {
    const t = this.peekToken();
    return !!t && t.type === "edgeOp";
  }

  private consumeEdgeOp(): "->" | "--" {
    const t = this.peekToken();
    if (!t || t.type !== "edgeOp") {
      throw new Error(`Expected edge operator, got: ${t ? JSON.stringify(t) : "<eof>"}`);
    }
    this.pos++;
    return t.value;
  }
}

export function parseDot(text: string): Graph {
  return new DotParser(text).parse();
}
