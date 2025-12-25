import * as fs from "node:fs";
import * as path from "node:path";

import { parseAttributesBlock, type Attributes } from "./attributes";
import { Graph } from "./graph";
import { Group } from "./group";
import type { Edge } from "./edge";
import type { Node } from "./node";
import { parseDot } from "./parser_dot";
import { parseGdl } from "./parser_gdl";

type ParseBlock = {
  blockText: string;
  nextPos: number;
};

type PendingEdge = {
  from: Node;
  leftOp: string;
  rightOp: string;
  label: string;
  attrs?: Attributes;
};

function skipWs(s: string, pos: number): number {
  while (pos < s.length && /\s/.test(s[pos])) pos++;
  return pos;
}

function startsWithEdgeOp(s: string): boolean {
  // Edges start with characters like '-', '=', '.', '<', '>'
  return /^[\-\.=<>]/.test(s);
}

function isBalancedForLine(line: string): boolean {
  let square = 0;
  let curly = 0;
  let escaped = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }

    if (ch === "[") square++;
    else if (ch === "]" && square > 0) square--;
    else if (ch === "{") curly++;
    else if (ch === "}" && curly > 0) curly--;
  }

  return square === 0 && curly === 0;
}

function splitTopLevel(input: string, sep: string): string[] {
  const parts: string[] = [];

  let square = 0;
  let curly = 0;
  let paren = 0;
  let escaped = false;

  let last = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }

    if (ch === "[") square++;
    else if (ch === "]" && square > 0) square--;
    else if (ch === "{") curly++;
    else if (ch === "}" && curly > 0) curly--;
    else if (ch === "(") paren++;
    else if (ch === ")" && paren > 0) paren--;

    if (ch === sep && square === 0 && curly === 0 && paren === 0) {
      parts.push(input.slice(last, i));
      last = i + 1;
    }
  }

  parts.push(input.slice(last));
  return parts;
}

function parseSquareBlock(s: string, pos: number): ParseBlock {
  if (s[pos] !== "[") {
    throw new Error(`Expected '[' at pos ${pos}`);
  }

  let i = pos + 1;
  let escaped = false;
  for (; i < s.length; i++) {
    const ch = s[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "]") break;
  }

  if (i >= s.length || s[i] !== "]") {
    throw new Error("Unterminated [...] node label");
  }

  return {
    blockText: s.slice(pos + 1, i),
    nextPos: i + 1,
  };
}

function parseCurlyBlock(s: string, pos: number): ParseBlock {
  if (s[pos] !== "{") {
    throw new Error(`Expected '{' at pos ${pos}`);
  }

  let i = pos + 1;
  let depth = 1;
  for (; i < s.length; i++) {
    const ch = s[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) break;
    }
  }

  if (i >= s.length || s[i] !== "}") {
    throw new Error("Unterminated {...} attribute block");
  }

  return {
    blockText: s.slice(pos, i + 1),
    nextPos: i + 1,
  };
}

function parseParenBlock(s: string, pos: number): ParseBlock {
  if (s[pos] !== "(") {
    throw new Error(`Expected '(' at pos ${pos}`);
  }

  let i = pos + 1;
  let depth = 1;

  let square = 0;
  let curly = 0;
  let escaped = false;

  for (; i < s.length; i++) {
    const ch = s[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }

    if (ch === "[") square++;
    else if (ch === "]" && square > 0) square--;
    else if (ch === "{") curly++;
    else if (ch === "}" && curly > 0) curly--;

    if (square !== 0 || curly !== 0) continue;

    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) break;
    }
  }

  if (i >= s.length || s[i] !== ")") {
    throw new Error("Unterminated (...) group block");
  }

  return {
    blockText: s.slice(pos + 1, i),
    nextPos: i + 1,
  };
}

class GraphEasyParser {
  private readonly graph = new Graph();
  private readonly groupStack: Group[] = [];

  private lastChainNode: Node | undefined;
  private pendingEdge: PendingEdge | undefined;

  public parse(text: string): Graph {
    const rawLines = text.replace(/\r\n?/g, "\n").split("\n");

    const logicalLines: string[] = [];
    for (let i = 0; i < rawLines.length; i++) {
      let line = rawLines[i];

      // Support multi-line scope headers like:
      //   graph
      //   {
      //     ...
      //   }
      // by joining the header token with the following "{" line.
      const header = line.trim();
      if (
        /^(graph|node|edge|group|\.[A-Za-z0-9_-]+)$/.test(header) &&
        i + 1 < rawLines.length &&
        rawLines[i + 1].trim().startsWith("{")
      ) {
        i++;
        line += " " + rawLines[i].trim();
      }

      while (!isBalancedForLine(line) && i + 1 < rawLines.length) {
        const nextTrim = rawLines[i + 1].trim();
        i++;
        // Perl parser inserts a space for most multi-line joins.
        line += " " + nextTrim;

        // Graph-Easy multiline blocks often close with a dedicated "}" line. We
        // treat that as an unconditional terminator even if values inside the
        // block contain "{" characters (e.g. label text like "digraph G {").
        if (nextTrim === "}") break;
      }
      logicalLines.push(line);
    }

    for (const rawLine of logicalLines) {
      this.parseLogicalLine(rawLine);
    }

    if (this.pendingEdge) {
      throw new Error("Dangling edge at end of input (missing target node)");
    }

    if (this.groupStack.length !== 0) {
      throw new Error("Unclosed group(s) at end of input");
    }

    return this.graph;
  }

  private currentGroup(): Group | undefined {
    return this.groupStack.length ? this.groupStack[this.groupStack.length - 1] : undefined;
  }

  private openGroup(name: string): Group {
    const g = new Group(name);
    g.setAttributes(this.graph.defaultGroupAttributes);

    const parent = this.currentGroup();
    if (parent) parent.addGroup(g);
    else this.graph.addGroup(g);

    this.groupStack.push(g);
    return g;
  }

  private closeGroup(): Group {
    const g = this.groupStack.pop();
    if (!g) throw new Error("Encountered ')' with no open group");
    return g;
  }

  private parseLogicalLine(rawLine: string): void {
    let line = rawLine.trim();
    if (!line) return;
    if (line.startsWith("#")) return;

    // When an edge operator is pending (line ended with an edge), a standalone
    // attribute block applies to that edge.
    if (this.pendingEdge && line.startsWith("{") && line.endsWith("}")) {
      const more = parseAttributesBlock(line);
      if (this.pendingEdge.attrs) {
        Object.assign(this.pendingEdge.attrs, more);
      } else {
        this.pendingEdge.attrs = more;
      }
      return;
    }

    // If this line is a scope/class/default attribute definition, parse it as
    // one unit (important because selector lists are comma-separated).
    if (this.tryParseScopeAttributes(line)) {
      return;
    }

    // Split multiple statements on a single line: "a, b".
    const commaParts = splitTopLevel(line, ",");

    for (const partRaw of commaParts) {
      let part = partRaw.trim();
      if (!part) continue;

      // Handle multi-line group start/end syntax (block groups)
      if (part.startsWith("(") && !part.includes(")")) {
        const name = part.slice(1).trim();
        this.openGroup(name);
        continue;
      }

      if (part.startsWith(")")) {
        const group = this.closeGroup();
        const rest = part.slice(1);
        const p = skipWs(rest, 0);
        if (p < rest.length && rest[p] === "{") {
          const blk = parseCurlyBlock(rest, p);
          group.setAttributes(parseAttributesBlock(blk.blockText));
          if (skipWs(rest, blk.nextPos) < rest.length) {
            throw new Error(`Unexpected trailing content after ')': ${rest}`);
          }
        } else if (skipWs(rest, 0) < rest.length) {
          throw new Error(`Unexpected trailing content after ')': ${rest}`);
        }
        continue;
      }

      // If we have a pending edge from the previous logical line, and the next
      // statement begins with a node, connect it.
      if (this.pendingEdge && part.trimStart().startsWith("[")) {
        const trimmed = part.trimStart();
        const nodeRes = this.parseNodeAt(trimmed, 0);
        const to = nodeRes.node;
        const edge = this.graph.addEdge(
          this.pendingEdge.from,
          to,
          this.pendingEdge.leftOp,
          this.pendingEdge.rightOp,
          this.pendingEdge.label
        );
        if (this.pendingEdge.attrs) edge.setAttributes(this.pendingEdge.attrs);
        this.pendingEdge = undefined;

        this.lastChainNode = to;

        // Continue parsing any remaining content after the node.
        part = trimmed.slice(nodeRes.nextPos);
        part = part.trim();
        if (!part) continue;
      }

      // Parse one or more chain statements from the remaining text.
      while (part.length) {
        // A group end can appear at the end of a statement like:
        //   [ X ] { ... }) { group-attrs }
        // In that case the chain parser stops before the ')', and we need to
        // consume the group end here.
        if (part.startsWith(")")) {
          const group = this.closeGroup();
          const rest = part.slice(1);
          const p = skipWs(rest, 0);
          if (p < rest.length && rest[p] === "{") {
            const blk = parseCurlyBlock(rest, p);
            group.setAttributes(parseAttributesBlock(blk.blockText));
            if (skipWs(rest, blk.nextPos) < rest.length) {
              throw new Error(`Unexpected trailing content after ')': ${rest}`);
            }
          } else if (skipWs(rest, 0) < rest.length) {
            throw new Error(`Unexpected trailing content after ')': ${rest}`);
          }
          part = "";
          continue;
        }

        const consumed = this.parseChainStatement(part);
        part = part.slice(consumed).trim();
      }
    }
  }

  private tryParseScopeAttributes(line: string): boolean {
    const trimmed = line.trim();

    // Don't misinterpret chains like "[A] -> [B] { ... }" as scope definitions.
    // Note: leading '.' is ambiguous (edge operators like '.->' vs class selectors '.red').
    const looksLikeClassSelector = /^\.[A-Za-z0-9_-]/.test(trimmed);
    if (
      trimmed.startsWith("[") ||
      trimmed.startsWith("(") ||
      (startsWithEdgeOp(trimmed) && !looksLikeClassSelector)
    ) {
      return false;
    }

    // Bare attribute block applies to graph.
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      this.graph.setGraphAttributes(parseAttributesBlock(trimmed));
      return true;
    }

    // Generic selector form (possibly a selector list):
    //   .green, .blue, group { color: blue; }
    const braceIdx = trimmed.indexOf("{");
    if (braceIdx === -1 || !trimmed.endsWith("}")) return false;

    const selectorsText = trimmed.slice(0, braceIdx).trim();
    const blockText = trimmed.slice(braceIdx).trim();
    const attrs = parseAttributesBlock(blockText);

    const selectors = splitTopLevel(selectorsText, ",")
      .map((s) => s.trim())
      .filter(Boolean);

    if (!selectors.length) return false;

    for (const sel of selectors) {
      // .class
      if (sel.startsWith(".")) {
        this.graph.setClassAttributes("node", sel.slice(1), attrs);
        continue;
      }

      // kind or kind.class
      const m = /^(graph|node|edge|group)(?:\.([A-Za-z0-9_-]+))?$/.exec(sel);
      if (!m) return false;

      const kind = m[1] as "graph" | "node" | "edge" | "group";
      const className = m[2];

      if (kind === "graph") {
        this.graph.setGraphAttributes(attrs);
        continue;
      }

      if (className) {
        this.graph.setClassAttributes(kind, className, attrs);
        continue;
      }

      this.graph.setDefaultAttributes(kind, attrs);
    }

    return true;

    return false;
  }

  private parseNodeAt(s: string, pos: number): { node: Node; nextPos: number } {
    const sq = parseSquareBlock(s, pos);
    const label = sq.blockText.trim();
    const node = this.graph.addNode(label);

    const group = this.currentGroup();
    if (group) group.addNode(node);

    let p = sq.nextPos;
    p = skipWs(s, p);
    if (p < s.length && s[p] === "{") {
      const blk = parseCurlyBlock(s, p);
      node.setAttributes(parseAttributesBlock(blk.blockText));
      p = blk.nextPos;
    }

    return { node, nextPos: p };
  }

  private parseGroupAt(s: string, pos: number): { repNode?: Node; nextPos: number } {
    const beforeLast = this.lastChainNode;

    const par = parseParenBlock(s, pos);
    const inner = par.blockText;

    // Determine group name vs content: take everything before the first element.
    let contentStart = -1;
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i];
      if (ch === "[" || ch === "(") {
        contentStart = i;
        break;
      }
    }

    const name = (contentStart === -1 ? inner : inner.slice(0, contentStart)).trim();
    const content = (contentStart === -1 ? "" : inner.slice(contentStart)).trim();

    const group = this.openGroup(name);

    const nodesBefore = group.nodes.size;
    if (content) {
      // Parse group inline content as if it were a logical line.
      this.parseLogicalLine(content);
    }

    const repNode = group.nodes.size > nodesBefore ? this.lastChainNode : undefined;
    this.closeGroup();

    // If the group had no nodes, don't let it accidentally change the last-chain node.
    if (!repNode) {
      this.lastChainNode = beforeLast;
    }

    let p = par.nextPos;
    p = skipWs(s, p);
    if (p < s.length && s[p] === "{") {
      const blk = parseCurlyBlock(s, p);
      group.setAttributes(parseAttributesBlock(blk.blockText));
      p = blk.nextPos;
    }

    return { repNode, nextPos: p };
  }

  private parseEdgeSpec(s: string, start: number, end: number): {
    leftOp: string;
    rightOp: string;
    label: string;
    attrs?: Attributes;
    nextPos: number;
  } {
    let attrs: Attributes | undefined;

    // Look for an attribute block inside the edge spec (usually at the end).
    let specEnd = end;
    let i = start;
    while (i < specEnd) {
      const ch = s[i];
      if (ch === "{") {
        const blk = parseCurlyBlock(s, i);
        attrs = parseAttributesBlock(blk.blockText);
        // Remove the block from the operator+label text by skipping it.
        // We assume a single attribute block per edge spec.
        const before = s.slice(start, i);
        const after = s.slice(blk.nextPos, specEnd);
        const text = (before + " " + after).trim();
        const parts = text.split(/\s+/).filter(Boolean);
        if (parts.length === 0) {
          throw new Error(`Missing edge operator in: ${s.slice(start, end)}`);
        }

        let leftOp: string;
        let rightOp: string;
        let label: string;
        if (parts.length === 1) {
          leftOp = parts[0];
          rightOp = parts[0];
          label = "";
        } else {
          leftOp = parts[0];
          rightOp = parts[parts.length - 1];
          label = parts.slice(1, -1).join(" ");
        }

        return { leftOp, rightOp, label, attrs, nextPos: blk.nextPos };
      }
      i++;
    }

    const text = s.slice(start, end).trim();
    const parts = text.split(/\s+/).filter(Boolean);
    if (parts.length === 0) {
      throw new Error(`Missing edge operator in: ${s.slice(start, end)}`);
    }

    let leftOp: string;
    let rightOp: string;
    let label: string;
    if (parts.length === 1) {
      leftOp = parts[0];
      rightOp = parts[0];
      label = "";
    } else {
      leftOp = parts[0];
      rightOp = parts[parts.length - 1];
      label = parts.slice(1, -1).join(" ");
    }

    return { leftOp, rightOp, label, nextPos: end };
  }

  private findNextElementStart(s: string, pos: number): number {
    let curly = 0;
    let escaped = false;

    for (let i = pos; i < s.length; i++) {
      const ch = s[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }

      if (ch === "{") curly++;
      else if (ch === "}" && curly > 0) curly--;

      if (curly === 0 && (ch === "[" || ch === "(")) {
        return i;
      }
    }

    return -1;
  }

  private parseChainStatement(text: string): number {
    let pos = skipWs(text, 0);
    if (pos >= text.length) return text.length;

    // Starting point can be:
    // - a node ([...])
    // - a group ((...))
    // - an edge op (continuation from previous node)
    let current: Node | undefined;

    if (text[pos] === "[") {
      const n = this.parseNodeAt(text, pos);
      current = n.node;
      pos = n.nextPos;
      this.lastChainNode = current;
    } else if (text[pos] === "(") {
      // Inline group expression.
      const g = this.parseGroupAt(text, pos);
      current = g.repNode;
      pos = g.nextPos;
      if (current) this.lastChainNode = current;
    } else if (startsWithEdgeOp(text.slice(pos))) {
      if (!this.lastChainNode) {
        throw new Error(`Edge continuation without a previous node: ${text}`);
      }
      current = this.lastChainNode;
      // Do not advance pos here; we still need to read the edge spec.
    } else {
      throw new Error(`Unsupported statement: ${text}`);
    }

    while (true) {
      pos = skipWs(text, pos);
      if (pos >= text.length) break;

      // If the next token is another element without an edge operator between,
      // treat it as a new statement boundary.
      if (text[pos] === "[" || text[pos] === "(" || text[pos] === ")") {
        break;
      }

      const nextEl = this.findNextElementStart(text, pos);
      const edgeEnd = nextEl === -1 ? text.length : nextEl;

      const edgeSpec = this.parseEdgeSpec(text, pos, edgeEnd);
      const leftOp = edgeSpec.leftOp;
      const rightOp = edgeSpec.rightOp;
      const label = edgeSpec.label;

      // If there is no next element, store as pending edge and stop.
      if (nextEl === -1) {
        if (!current) {
          // edge from nowhere -> ignore (e.g. empty-group chains)
          this.pendingEdge = undefined;
          return text.length;
        }
        this.pendingEdge = { from: current, leftOp, rightOp, label, attrs: edgeSpec.attrs };
        return text.length;
      }

      // Parse the next element.
      let toNode: Node | undefined;
      let nextPos: number;
      if (text[nextEl] === "[") {
        const n = this.parseNodeAt(text, nextEl);
        toNode = n.node;
        nextPos = n.nextPos;
      } else {
        const g = this.parseGroupAt(text, nextEl);
        toNode = g.repNode;
        nextPos = g.nextPos;
      }

      // Create edge if we have endpoints.
      let created: Edge | undefined;
      if (current && toNode) {
        created = this.graph.addEdge(current, toNode, leftOp, rightOp, label);
        if (edgeSpec.attrs) created.setAttributes(edgeSpec.attrs);
      }

      current = toNode;
      if (current) this.lastChainNode = current;
      pos = nextPos;
    }

    return pos;
  }
}

export class Parser {
  public static fromFile(filePath: string): Graph {
    const ext = path.extname(filePath).toLowerCase();
    const text = fs.readFileSync(filePath, "utf8");

    if (ext === ".dot") {
      // Some fixtures under t/in/dot are actually Graph-Easy syntax (not DOT).
      // If the content clearly isn't DOT, parse it as Graph-Easy.
      const trimmed = text.trimStart();
      if (trimmed.startsWith("(") || trimmed.startsWith("[")) {
        return Parser.fromText(text);
      }

      return parseDot(text);
    }

    if (ext === ".gdl") {
      return parseGdl(text);
    }

    return Parser.fromText(text);
  }

  public static fromText(text: string): Graph {
    const parser = new GraphEasyParser();
    return parser.parse(text);
  }
}
