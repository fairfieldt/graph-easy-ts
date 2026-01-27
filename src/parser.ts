declare const require: ((id: string) => unknown) | undefined;

type NodeFs = typeof import("fs");
type NodePath = typeof import("path");

function requireNodeFs(): NodeFs {
  if (typeof require !== "function") {
    throw new Error("Parser.fromFile() is only supported in Node.js");
  }
  return require("f" + "s") as NodeFs;
}

function requireNodePath(): NodePath {
  if (typeof require !== "function") {
    throw new Error("Parser.fromFile() is only supported in Node.js");
  }
  return require("pa" + "th") as NodePath;
}

import { parseAttributesBlock, type Attributes } from "./attributes.js";
import { Graph } from "./graph.js";
import { Group } from "./group.js";
import type { Edge } from "./edge.js";
import type { Node } from "./node.js";
import { parseDot } from "./parser_dot.js";
import { parseGdl } from "./parser_gdl.js";

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
  fanoutSources?: Node[];
};

function skipWs(s: string, pos: number): number {
  while (pos < s.length && /\s/.test(s[pos])) pos++;
  return pos;
}

function startsWithEdgeOp(s: string): boolean {
  // Edges start with characters like '-', '=', '.', '<', '>'
  return /^[\-\.=<>~]/.test(s);
}

function hasUnescapedPipe(s: string): boolean {
  // Perl uses /[^\\]\|/ to detect autosplit; we treat any unescaped pipe as autosplit.
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "|" && (i === 0 || s[i - 1] !== "\\")) return true;
  }
  return false;
}

function unquoteName(name: string, noCollapse = false): string {
  // Ported from Graph::Easy::Parser::_unquote.
  let out = name;

  // Unquote special chars (e.g. "\\[" => "[").
  out = out.replace(/\\([\[\(\{\}\]\)\#<>\-\.\=])/g, "$1");

  // Collapse multiple spaces.
  if (!noCollapse) {
    out = out.replace(/\s+/g, " ");
  }

  return out;
}

function isBalancedForLine(line: string): boolean {
  let square = 0;
  let curly = 0;
  let paren = 0;
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
    else if (square === 0 && curly === 0) {
      if (ch === "(") paren++;
      else if (ch === ")" && paren > 0) paren--;
    }
  }

  return square === 0 && curly === 0 && paren === 0;
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

function stripLineComment(rawLine: string): string {
  // Graph::Easy treats '#' as a comment delimiter (unless it's inside a block like
  // "[...]" or "{...}" where '#' can appear in values like hex colors).
  let square = 0;
  let curly = 0;
  let paren = 0;
  let escaped = false;
  let quote: '"' | "'" | undefined;

  for (let i = 0; i < rawLine.length; i++) {
    const ch = rawLine[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch as '"' | "'";
      continue;
    }

    if (ch === "[") square++;
    else if (ch === "]" && square > 0) square--;
    else if (ch === "{") curly++;
    else if (ch === "}" && curly > 0) curly--;
    else if (ch === "(") paren++;
    else if (ch === ")" && paren > 0) paren--;

    if (ch === "#" && square === 0 && curly === 0 && paren === 0) {
      return rawLine.slice(0, i).trimEnd();
    }
  }

  return rawLine;
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

  // Graph::Easy attribute blocks do not nest. Importantly, attribute *values* can
  // contain '{' characters (e.g. labels containing "digraph G {") and these must
  // not confuse the block terminator scan.
  let i = pos + 1;
  let escaped = false;
  let quote: '"' | "'" | undefined;
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

    if (quote) {
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch as '"' | "'";
      continue;
    }

    if (ch === "}") break;
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

  // Used to support comma-list fanout: "[A] --> [B], [C]".
  private lastCreatedEdge: PendingEdge | undefined;

  // Used to support list-attr fanout across lines, e.g.:
  //   [ Bonn ], [ Berlin ]
  //   -- test --> [ Frankfurt ]
  // which should create Bonn->Frankfurt and Berlin->Frankfurt.
  private lastNodeList: Node[] | undefined;

  // Track the explicit attribute block parsed for the most recently parsed node.
  // This is used to implement Graph::Easy list-attribute semantics for comma-separated
  // target lists in edge statements (e.g. "--> [A]{x}, [B]{y}" applies merged attrs
  // to both A and B).
  private lastParsedNodeAttrs: Attributes | undefined;

  // Track generated autosplit basenames so we can make them unique like Perl's
  // Graph::Easy::Parser::_get_cluster_name.
  private readonly clusters = new Set<string>();
  private nextClusterId = 0;

  private clearLastCreatedEdge(): void {
    this.lastCreatedEdge = undefined;
  }

  public parse(text: string): Graph {
    const rawLines = text.replace(/\r\n?/g, "\n").split("\n");

    // When joining multi-line statements, we normally trim the continuation line.
    // However, inside an unterminated [...] node label, leading spaces are
    // semantically significant for autosplit/record empty cells (e.g. "  ||").
    // So in that case we only trim the *end* of the continuation line.
    const inUnclosedSquare = (s: string): boolean => {
      let square = 0;
      let escaped = false;
      for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === "\\") {
          escaped = true;
          continue;
        }
        if (ch === "[") square += 1;
        else if (ch === "]" && square > 0) square -= 1;
      }
      return square > 0;
    };

    const logicalLines: string[] = [];
    for (let i = 0; i < rawLines.length; i++) {
      let line = rawLines[i];

      const shouldJoinContinuationLine = (s: string): boolean => {
        // Multi-line group blocks intentionally start with an unbalanced '(' header line:
        //   ( Group Name
        //     ...
        //   )
        // These must *not* be joined into a single logical line; parseLogicalLine()
        // handles group open/close on separate logical lines.
        const headerLine = s.trim();
        if (
          headerLine.startsWith("(") &&
          !headerLine.includes(")") &&
          !headerLine.includes("[") &&
          !/[\-\.=<>~]/.test(headerLine)
        ) {
          return false;
        }

        if (!isBalancedForLine(s)) return true;

        const trimmedEnd = stripLineComment(s).trimEnd();
        if (!trimmedEnd) return false;

        // A trailing comma indicates the statement continues on the next physical line
        // (e.g. multi-line comma lists of nodes/targets).
        if (/,[\s]*$/.test(trimmedEnd)) return true;

        // A balanced statement that ends with a complete element (`]`, `)`) or a
        // complete attribute block (`}`) is normally a full logical line.
        if (/[\]\)\}]\s*$/.test(trimmedEnd)) return false;

        // Graph::Easy allows splitting an edge label/operator across multiple physical
        // lines, e.g.:
        //   [ A ] -- label
        //     continued --> [ B ]
        // In these cases, Perl keeps joining with a space until the statement reaches
        // the next element.
        const hasNodeOrGroup = /[\[\(]/.test(trimmedEnd);
        const hasEdgeOpChar = /[\-\.=<>~]/.test(trimmedEnd);
        return hasNodeOrGroup && hasEdgeOpChar;
      };

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

      while (shouldJoinContinuationLine(line) && i + 1 < rawLines.length) {
        const nextRaw = rawLines[i + 1];
        const nextTrim = nextRaw.trim();
        const nextForJoin = inUnclosedSquare(line) ? nextRaw.trimEnd() : nextTrim;
        i++;
        // Perl parser inserts a space for most multi-line joins.
        line += " " + nextForJoin;

        // Graph-Easy multiline blocks often close with a dedicated "}" line. We
        // treat that as an unconditional terminator even if values inside the
        // block contain "{" characters (e.g. label text like "digraph G {").
        if (nextTrim === "}") break;
      }

      // Allow node statements to have their attribute block on following lines:
      //   [ A ]
      //   {
      //     ...
      //   }
      // Treat this as a single logical line so it parses like "[A] { ... }".
      if (isBalancedForLine(line)) {
        const trimmedEnd = line.trimEnd();
        if (trimmedEnd.endsWith("]")) {
          let j = i + 1;
          while (j < rawLines.length) {
            const t = rawLines[j].trim();
            if (t === "" || t.startsWith("#")) {
              j += 1;
              continue;
            }
            break;
          }
          if (j < rawLines.length && rawLines[j].trim().startsWith("{")) {
            i = j;
            line += " " + rawLines[i].trim();

            while (!isBalancedForLine(line) && i + 1 < rawLines.length) {
              const nextRaw = rawLines[i + 1];
              const nextTrim = nextRaw.trim();
              const nextForJoin = inUnclosedSquare(line) ? nextRaw.trimEnd() : nextTrim;
              i++;
              line += " " + nextForJoin;
              if (nextTrim === "}") break;
            }
          }
        }
      }

      // The node-attrs join above can introduce a trailing comma (e.g. `} ,`) which
      // indicates a continued comma list on the next physical line. Re-run the
      // continuation join after the node-attrs join so we don't split such lists
      // into separate logical lines.
      while (shouldJoinContinuationLine(line) && i + 1 < rawLines.length) {
        const nextRaw = rawLines[i + 1];
        const nextTrim = nextRaw.trim();
        const nextForJoin = inUnclosedSquare(line) ? nextRaw.trimEnd() : nextTrim;
        i++;
        line += " " + nextForJoin;
        if (nextTrim === "}") break;
      }

      // After pulling in additional elements (e.g. `, [ GHI ]`), the line may now
      // end with a node token whose attribute block starts on the following lines.
      // Attach that block too (so multi-line comma lists like `[X]{...}, [Y]\n{...}`
      // stay on a single logical line).
      if (isBalancedForLine(line)) {
        const trimmedEnd = line.trimEnd();
        if (trimmedEnd.endsWith("]")) {
          let j = i + 1;
          while (j < rawLines.length) {
            const t = rawLines[j].trim();
            if (t === "" || t.startsWith("#")) {
              j += 1;
              continue;
            }
            break;
          }
          if (j < rawLines.length && rawLines[j].trim().startsWith("{")) {
            i = j;
            line += " " + rawLines[i].trim();

            while (!isBalancedForLine(line) && i + 1 < rawLines.length) {
              const nextRaw = rawLines[i + 1];
              const nextTrim = nextRaw.trim();
              const nextForJoin = inUnclosedSquare(line) ? nextRaw.trimEnd() : nextTrim;
              i++;
              line += " " + nextForJoin;
              if (nextTrim === "}") break;
            }
          }
        }
      }

      while (shouldJoinContinuationLine(line) && i + 1 < rawLines.length) {
        const nextRaw = rawLines[i + 1];
        const nextTrim = nextRaw.trim();
        const nextForJoin = inUnclosedSquare(line) ? nextRaw.trimEnd() : nextTrim;
        i++;
        line += " " + nextForJoin;
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

  private getClusterName(base: string): string {
    // Ported from Graph::Easy::Parser::_get_cluster_name.
    // If the base is already used, append "-N" until unique.
    let out = base;
    if (this.clusters.has(out)) {
      if (this.nextClusterId === 0) this.nextClusterId = 1;
      while (true) {
        const tryName = `${base}-${this.nextClusterId}`;
        if (!this.clusters.has(tryName)) {
          out = tryName;
          this.nextClusterId += 1;
          break;
        }
        this.nextClusterId += 1;
      }
    }

    this.clusters.add(out);
    return out;
  }

  private autosplitNodes(name: string, attrs?: Attributes): Node[] {
    // Ported from Graph::Easy::Parser::_autosplit_node.
    // Splits a node label like "a|b||c" into nodes "<basename>.0", "<basename>.1", ...

    // build base name: "A|B |C||D" => "ABCD"
    let baseName = name.replace(/\s*\|\|?\s*/g, "");

    // use user-provided base name
    const basenameOverride = attrs?.basename;
    if (basenameOverride !== undefined) {
      baseName = basenameOverride;
    }

    baseName = baseName.trim();
    baseName = this.getClusterName(baseName);

    const attrNoBasename: Attributes | undefined = attrs
      ? (() => {
          const copy: Attributes = Object.create(null);
          for (const [k, v] of Object.entries(attrs)) {
            if (k === "basename") continue;
            copy[k] = v;
          }
          return copy;
        })()
      : undefined;

    const splitAttrValue = (value: string): string[] => {
      const out: string[] = [];
      let cur = "";

      for (let i = 0; i < value.length; i++) {
        const ch = value[i];
        if (ch === "\\" && i + 1 < value.length && value[i + 1] === "|") {
          cur += "|";
          i += 1;
          continue;
        }
        if (ch === "|") {
          out.push(cur);
          cur = "";
          continue;
        }
        cur += ch;
      }
      out.push(cur);
      return out;
    };

    let firstInRow: Node | undefined;
    let x = 0;
    let y = 0;
    let idx = 0;
    let remaining = name;
    let lastSep = "";
    let add = 0;

    const out: Node[] = [];

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
      const remainingAfterSep = remaining;

      // Perl uses $1 || ' ' (empty parts become a single space).
      let part = partWasEmpty ? " " : partRaw;

      // fix [|G|] to have one empty part as last part
      if (add === 0 && remaining === "" && (sep === "|" || sep === "||")) {
        add += 1;
        remaining += "|";
      }

      // Determine whether to create a borderless empty node or a bordered empty node.
      // allow_empty defaults to true in Perl.
      let isEmptyBorderless = false;
      if (partWasEmpty) {
        isEmptyBorderless = true;
      } else if (/^[ ]+$/.test(part)) {
        // Whitespace-only parts: Graph::Easy treats single-space parts at the beginning/end
        // of a row as borderless spacers, but keeps a bordered empty cell for internal
        // single-space parts (e.g. "2| |3").
        if (partRaw.length === 1) {
          const isRowStart = lastSep === "" || lastSep === "||";
          const hasRightPart = remainingAfterSep !== "";
          if (isRowStart || !hasRightPart) {
            isEmptyBorderless = true;
          } else {
            part = " ";
          }
        } else {
          // Explicit multi-space parts create an empty node *with* a border.
          part = "  ";
        }
      } else {
        // strip spaces at front/end
        part = part.trim();
      }

      const nodeId = `${baseName}.${idx}`;
      const node = this.graph.addNode(nodeId);

      // Apply node attributes to all parts (except basename).
      // For autosplit nodes, Graph::Easy supports split values like:
      //   border: dashed|;
      //   color: red|blue;
      // which apply per part in order; empty/missing parts inherit defaults.
      if (attrNoBasename) {
        const perPartAttrs: Attributes = Object.create(null);
        for (const [k, v] of Object.entries(attrNoBasename)) {
          // Relative-placement attributes apply to the autosplit cluster root only.
          // Applying these to all parts and then overriding origins for internal
          // parts can leave stale children links and break cluster placement.
          if ((k === "origin" || k === "offset") && idx !== 0) {
            continue;
          }
          if (hasUnescapedPipe(v)) {
            const parts = splitAttrValue(v);
            const partV = parts[idx];
            if (partV !== undefined) {
              const trimmed = partV.trim();
              if (trimmed !== "") perPartAttrs[k] = trimmed;
            }
            continue;
          }
          perPartAttrs[k] = v;
        }
        if (Object.keys(perPartAttrs).length) {
          node.setAttributes(perPartAttrs);
        }
      }

      // For borderless empty cells, mirror Graph::Easy::Node::Empty.
      if (isEmptyBorderless) {
        node.applyInheritedAttributes({ shape: "invisible" });
      }

      // Store display label (Graph::Easy uses autosplit_label).
      node.label = part;

      // The first node in the autosplit cluster carries the full record label.
      if (idx === 0) {
        node.autosplitLabel = name;
      }

      // Record autosplit metadata (useful for debugging / future parity).
      {
        const meta: Attributes = Object.create(null);
        meta.autosplit_basename = baseName;
        meta.autosplit_xy = `${x},${y}`;
        // Perl's As_graphviz.pm stores an internal autosplit_portname for use by
        // _html_like_label when rendering relative-placement clusters. For
        // Graph::Easy record/autosplit nodes, this is intentionally the empty
        // string so Graphviz uses PORT="".
        meta.autosplit_portname = "";
        if (idx === 0 && /^[ ]*$/.test(partRaw) && partRaw.length <= 1) {
          meta.autosplit_first_empty = "1";
        }
        node.applyInheritedAttributes(meta);
      }

      // Relative placement.
      if (idx === 0) {
        firstInRow = node;

        // Mirror Perl: first part gets the basename attribute (only part 0).
        if (basenameOverride !== undefined) {
          node.setAttributes({ basename: basenameOverride });
        }
      } else {
        let origin: Node | undefined = out[out.length - 1];
        let sx = 1;
        let sy = 0;
        if (lastSep === "||") {
          origin = firstInRow;
          sx = 0;
          sy = 1;
          firstInRow = node;
        }

        if (!origin) {
          throw new Error(`autosplitNodes: missing origin for ${nodeId}`);
        }

        node.origin = origin;
        node.dx = sx;
        node.dy = sy;

        // Register relative placement relationship (Graph::Easy::Node->relative_to).
        origin.children.set(node.id, node);
      }

      out.push(node);

      idx += 1;
      lastSep = sep;
      x += 1;
      if (sep === "||") {
        x = 0;
        y += 1;
      }
    }

    return out;
  }

  private currentGroup(): Group | undefined {
    return this.groupStack.length ? this.groupStack[this.groupStack.length - 1] : undefined;
  }

  private openGroup(name: string): Group {
    const g = new Group(name, this.graph.allocateId());
    g.applyInheritedAttributes(this.graph.defaultGroupAttributes);

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
    let line = stripLineComment(rawLine).trim();
    if (!line) return;

    const consumeLeadingScopeAttributes = (input: string): string => {
      let rest = input;
      while (true) {
        const trimmed = rest.trimStart();
        if (!trimmed) return "";

        // Don't misinterpret chains as scope definitions.
        const looksLikeClassSelector = /^\.[A-Za-z0-9_-]/.test(trimmed);
        if (trimmed.startsWith("[") || trimmed.startsWith("(") || (startsWithEdgeOp(trimmed) && !looksLikeClassSelector)) {
          return trimmed;
        }

        const braceIdx = trimmed.indexOf("{");
        if (braceIdx === -1) return trimmed;

        // Read the first balanced attribute block and treat `selectors { ... }` as a
        // scope definition prefix (Graph::Easy allows e.g. `graph { ... } [A] -> [B]`).
        const blk = parseCurlyBlock(trimmed, braceIdx);
        const prefix = trimmed.slice(0, blk.nextPos).trim();

        if (!this.tryParseScopeAttributes(prefix)) {
          return trimmed;
        }

        rest = trimmed.slice(blk.nextPos).trim();
      }
    };

    line = consumeLeadingScopeAttributes(line);
    if (!line) return;

    // Cross-line list fanout applies only to the *immediately following* logical line.
    // Capture+clear it up-front so it can't leak further.
    let listEdgeSources: Node[] | undefined = undefined;
    if (startsWithEdgeOp(line)) {
      listEdgeSources = this.lastNodeList;

      // Perl Graph::Easy appears to treat edge-leading continuations after a node list
      // as continuing from the *first* node in that list (which also affects edge
      // creation ordering and layout decisions). Mirror that here.
      if (listEdgeSources && listEdgeSources.length > 0) {
        this.lastChainNode = listEdgeSources[0];
      }
    }
    this.lastNodeList = undefined;

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

    const isNodeStatementOnly = (part: string): boolean => {
      const p0 = part.trim();
      if (!p0.startsWith("[")) return false;

      try {
        const sq = parseSquareBlock(p0, 0);
        let p = skipWs(p0, sq.nextPos);
        if (p < p0.length && p0[p] === "{") {
          const blk = parseCurlyBlock(p0, p);
          p = skipWs(p0, blk.nextPos);
        }
        return p === p0.length;
      } catch {
        return false;
      }
    };

    // Perl Graph::Easy list-attribute semantics:
    // For a comma-separated list of *node statements* on a single logical line,
    // apply each node's attribute block retroactively to all nodes earlier in the
    // list (but do not automatically propagate earlier attrs forward).
    if (!this.pendingEdge && commaParts.length > 1) {
      const nodeParts: string[] = [];
      let allNodeStatements = true;

      for (const partRaw of commaParts) {
        const part = partRaw.trim();
        if (!part) continue;
        nodeParts.push(part);

        if (!isNodeStatementOnly(part)) {
          allNodeStatements = false;
          break;
        }
      }

      if (allNodeStatements && nodeParts.length > 1) {
        const nodes: Node[] = [];
        for (const part of nodeParts) {
          const consumed = this.parseChainStatement(part);
          if (consumed !== part.length) {
            throw new Error(`Unexpected trailing content after node list item: ${part}`);
          }

          const n = this.lastChainNode;
          if (!n) continue;

          // Apply this node's attrs (if any) to all nodes earlier in the list.
          const ownAttrs = this.lastParsedNodeAttrs;
          if (ownAttrs) {
            for (const prev of nodes) {
              prev.setAttributes(ownAttrs);
            }
          }

          nodes.push(n);
        }

        // Remember this list for a possible following edge-leading statement.
        this.lastNodeList = nodes;
        return;
      }
    }

    let commaEdgeList: PendingEdge | undefined;
    let commaSourceNodes: Node[] = [];
    let commaFanoutSources: Node[] | undefined;

    // Track comma-separated edge target list so we can apply Graph::Easy list-attribute
    // semantics across all targets in the list.
    let commaTargetNodes: Node[] = [];
    let commaTargetMergedAttrs: Attributes | undefined;

    for (const partRaw of commaParts) {
      let part = partRaw.trim();
      if (!part) continue;

      // Comma-list fanout: "[ A ] --> { ... } [ B ], [ C ]" should create edges
      // A->B and A->C with the same edge spec/attrs.
      if (commaEdgeList && isNodeStatementOnly(part)) {
        const n = this.parseNodeAt(part, 0);
        const to = n.node;

        // Apply list-attribute semantics for comma-separated targets:
        // - each target inherits merged attrs from prior targets
        // - attrs from this target apply to all previously parsed targets
        const ownAttrs = n.attrs;
        if (commaTargetMergedAttrs && Object.keys(commaTargetMergedAttrs).length > 0) {
          to.setAttributes(commaTargetMergedAttrs);
          // Restore the node's own attrs as the strongest (rightmost) overrides.
          if (ownAttrs) to.setAttributes(ownAttrs);
        }
        if (ownAttrs) {
          for (const prev of commaTargetNodes) {
            prev.setAttributes(ownAttrs);
          }
        }
        if (ownAttrs) {
          if (!commaTargetMergedAttrs) commaTargetMergedAttrs = {};
          Object.assign(commaTargetMergedAttrs, ownAttrs);
        }
        commaTargetNodes.push(to);

        const edge = this.graph.addEdge(
          commaEdgeList.from,
          to,
          commaEdgeList.leftOp,
          commaEdgeList.rightOp,
          commaEdgeList.label
        );
        if (commaEdgeList.attrs) edge.setAttributes(commaEdgeList.attrs);

        // If we fanned out sources for the first target (cross-line list fanout or
        // comma-separated source fanout), apply the same fanout to additional comma
        // targets so we get the full cross product (e.g. Bonn/Berlin -> Frankfurt/(Oder)).
        if (commaFanoutSources && commaFanoutSources.length > 0) {
          for (const srcNode of commaFanoutSources) {
            if (srcNode === commaEdgeList.from) continue;
            const e = this.graph.addEdge(
              srcNode,
              to,
              commaEdgeList.leftOp,
              commaEdgeList.rightOp,
              commaEdgeList.label
            );
            if (commaEdgeList.attrs) e.setAttributes(commaEdgeList.attrs);
          }
        }
        this.lastChainNode = to;
        this.lastParsedNodeAttrs = ownAttrs;
        continue;
      }

      commaEdgeList = undefined;
      commaFanoutSources = undefined;
      commaTargetNodes = [];
      commaTargetMergedAttrs = undefined;
      this.clearLastCreatedEdge();

      // Comma-list source fanout: "[ A ], [ B ] --> { ... } [ C ]" should create edges
      // A->C and B->C with the same edge spec/attrs.
      if (!this.pendingEdge && commaParts.length > 1 && isNodeStatementOnly(part)) {
        const consumed = this.parseChainStatement(part);
        if (consumed !== part.length) {
          throw new Error(`Unexpected trailing content after node list item: ${part}`);
        }
        if (this.lastChainNode) commaSourceNodes.push(this.lastChainNode);
        continue;
      }

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
        const pending = this.pendingEdge;
        const trimmed = part.trimStart();
        const nodeRes = this.parseNodeAt(trimmed, 0);
        const to = nodeRes.node;
        this.lastParsedNodeAttrs = nodeRes.attrs;
        const edge = this.graph.addEdge(
          pending.from,
          to,
          pending.leftOp,
          pending.rightOp,
          pending.label
        );
        if (pending.attrs) edge.setAttributes(pending.attrs);

        // Cross-line list fanout: if this pending edge originated from a node list,
        // create the full fanout when the target node arrives on the next line.
        if (pending.fanoutSources && pending.fanoutSources.length > 0) {
          for (const src of pending.fanoutSources) {
            if (src === pending.from) continue;
            const e = this.graph.addEdge(src, to, pending.leftOp, pending.rightOp, pending.label);
            if (pending.attrs) e.setAttributes(pending.attrs);
          }
        }

        this.pendingEdge = undefined;

        // Ensure comma-target fanout on the *same logical line* works even when the
        // edge spec was provided on the previous line (e.g. "[Dachau] ->" newline
        // "[Berlin], [Ulm], ...").
        this.lastCreatedEdge = {
          from: pending.from,
          leftOp: pending.leftOp,
          rightOp: pending.rightOp,
          label: pending.label,
          attrs: pending.attrs,
        };
        commaEdgeList = this.lastCreatedEdge;
        commaFanoutSources = pending.fanoutSources;
        commaTargetNodes = [to];
        commaTargetMergedAttrs = nodeRes.attrs ? { ...nodeRes.attrs } : undefined;

        this.lastChainNode = to;

        // Continue parsing any remaining content after the node.
        part = trimmed.slice(nodeRes.nextPos);
        part = part.trim();

        // If the statement continues with a new edge operator, we're starting a new
        // edge list from `to`. Do not let comma-target fanout state from the resolved
        // pending edge leak into this new edge list.
        if (startsWithEdgeOp(part)) {
          commaEdgeList = undefined;
          commaFanoutSources = undefined;
          commaTargetNodes = [];
          commaTargetMergedAttrs = undefined;
        }
        if (!part) continue;
      }

      const edgesBefore = this.graph.edges.length;

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

      // If this line started with an edge operator after a node list, and we ended up
      // producing a pending edge (because the target node is on the next logical line),
      // preserve the full source list so we can fan out when the edge is resolved.
      if (this.pendingEdge) {
        const sources = new Set<Node>();
        if (listEdgeSources) {
          for (const src of listEdgeSources) sources.add(src);
        }
        for (const src of commaSourceNodes) sources.add(src);
        if (sources.size > 0) this.pendingEdge.fanoutSources = [...sources];
      }

      const edgesCreated = this.graph.edges.length - edgesBefore;
      const fanoutSources = commaSourceNodes.length > 0 ? commaSourceNodes : listEdgeSources;
      if (fanoutSources && fanoutSources.length > 0 && edgesCreated >= 1) {
        const firstEdge = this.graph.edges[edgesBefore];

        // Persist these sources for any additional comma targets in this edge list.
        // For multi-edge chains we only fan out the *first* edge segment (the one
        // leaving the comma-specified sources).
        if (edgesCreated === 1) {
          commaFanoutSources = fanoutSources;
        }

        for (const srcNode of fanoutSources) {
          if (srcNode === firstEdge.from) continue;
          const e = this.graph.addEdge(srcNode, firstEdge.to, firstEdge.leftOp, firstEdge.rightOp, firstEdge.label);
          if (Object.keys(firstEdge.explicitAttributes).length > 0) {
            e.setAttributes(firstEdge.explicitAttributes);
          }
        }
      }

      // Initialize comma-target list state for this edge list (so subsequent comma
      // parts like ", [C]{...}" can apply list-attribute semantics).
      if (edgesCreated === 1 && this.lastCreatedEdge && this.lastChainNode) {
        commaTargetNodes = [this.lastChainNode];
        commaTargetMergedAttrs = this.lastParsedNodeAttrs ? { ...this.lastParsedNodeAttrs } : undefined;
      } else {
        commaTargetNodes = [];
        commaTargetMergedAttrs = undefined;
      }
      commaSourceNodes = [];
      listEdgeSources = undefined;

      commaEdgeList = this.lastCreatedEdge;
    }

    // Remember the last comma-separated edge target list (if any) so an edge-leading
    // continuation on the next logical line ("--> ...") can fan out from the full set.
    // This is required for inputs like:
    //   [ Hannover ] --> [ Aachen ], [ Berlin ], [ Cuxhaven ]
    //     --> [ Zwickau ]
    if (commaTargetNodes.length > 0) {
      this.lastNodeList = commaTargetNodes;
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
        const className = sel.slice(1);
        this.graph.setClassAttributes("node", className, attrs);
        this.graph.setClassAttributes("edge", className, attrs);
        this.graph.setClassAttributes("group", className, attrs);
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

  private parseNodeAt(s: string, pos: number): {
    node: Node;
    edgeNodes: Node[];
    nextPos: number;
    attrs?: Attributes;
  } {
    const sq = parseSquareBlock(s, pos);
    const rawName = sq.blockText;
    const name = unquoteName(rawName, true);

    let p = sq.nextPos;
    p = skipWs(s, p);

    let attrs: Attributes | undefined;
    if (p < s.length && s[p] === "{") {
      const blk = parseCurlyBlock(s, p);
      attrs = parseAttributesBlock(blk.blockText);
      p = blk.nextPos;
    }

    // Autosplit nodes (record-like) if they contain an unescaped pipe.
    if (hasUnescapedPipe(name)) {
      const parts = this.autosplitNodes(name, attrs);
      const group = this.currentGroup();
      if (group) {
        for (const n of parts) group.addNode(n);
      }
      return { node: parts[0], edgeNodes: parts, nextPos: p, attrs };
    }

    // Ported from Graph::Easy::Parser::_new_node normalization.
    let label = name.trim();
    label = label.replace(/\s+/g, " ");
    label = label.replace(/\\\|/g, "|");

    let node: Node;
    if (label === "") {
      // Perl Graph::Easy::Node::Anon: an anonymous, invisible node.
      const numericId = this.graph.allocateId();
      const id = `#${numericId}`;
      node = this.graph.addNodeWithId(id, " ", numericId);
      node.label = " ";
      node.setAttributes({ shape: "invisible" });
    } else {
      node = this.graph.addNode(label);
    }

    if (attrs) node.setAttributes(attrs);

    const group = this.currentGroup();
    if (group) group.addNode(node);

    return { node, edgeNodes: [node], nextPos: p, attrs };
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

    // Perl Graph::Easy does not treat inline group expressions as edge endpoints.
    // They only define a scoped group and its contents.
    const repNode: Node | undefined = undefined;
    this.closeGroup();

    // Never let inline group parsing affect the outer chain cursor.
    this.lastChainNode = beforeLast;

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

    // Graph::Easy operators include variations like "-->" ".->" "= >" "- >" and also "~~>".
    const isOpChar = (ch: string): boolean => /[<>\-=.~]/.test(ch);
    const isWs = (ch: string): boolean => ch === " " || ch === "\t";

    const readOpForward = (
      text: string,
      pos: number,
    ): { op: string; nextPos: number } | undefined => {
      if (pos >= text.length) return undefined;
      if (!isOpChar(text[pos])) return undefined;

      let i = pos;
      while (i < text.length) {
        const ch = text[i];
        if (isOpChar(ch)) {
          i++;
          continue;
        }

        if (isWs(ch)) {
          let j = i;
          while (j < text.length && isWs(text[j])) j++;
          if (j < text.length && isOpChar(text[j])) {
            // Whitespace that connects operator chunks is part of the operator token
            // (e.g. "- >" or "= >").
            i = j;
            continue;
          }
        }

        break;
      }

      return { op: text.slice(pos, i), nextPos: i };
    };

    const readOpBackward = (
      text: string,
      endPos: number,
    ): { op: string; startPos: number } | undefined => {
      if (endPos <= 0) return undefined;

      let p = endPos - 1;
      while (p >= 0 && isWs(text[p])) p--;
      if (p < 0) return undefined;
      if (!isOpChar(text[p])) return undefined;

      while (p >= 0) {
        const ch = text[p];
        if (isOpChar(ch)) {
          p--;
          continue;
        }

        if (isWs(ch)) {
          let q = p;
          while (q >= 0 && isWs(text[q])) q--;
          if (q >= 0 && isOpChar(text[q])) {
            // Whitespace that connects operator chunks is part of the operator token.
            p = q;
            continue;
          }
        }

        break;
      }

      const startPos = p + 1;
      return { op: text.slice(startPos, endPos), startPos };
    };

    const parseOpAndLabel = (
      rawText: string,
    ): { leftOp: string; rightOp: string; label: string } => {
      const text = rawText.trim();
      if (!text) {
        throw new Error(`Missing edge operator in: ${s.slice(start, end)}`);
      }

      const left = readOpForward(text, 0);
      if (!left) {
        throw new Error(`Missing edge operator in: ${s.slice(start, end)}`);
      }

      if (left.nextPos >= text.length) {
        return { leftOp: text, rightOp: text, label: "" };
      }

      const right = readOpBackward(text, text.length);
      if (!right) {
        throw new Error(`Missing edge operator in: ${s.slice(start, end)}`);
      }

      if (right.startPos <= left.nextPos) {
        return { leftOp: text, rightOp: text, label: "" };
      }

      const label = text.slice(left.nextPos, right.startPos).trim();
      if (!label) {
        return { leftOp: text, rightOp: text, label: "" };
      }

      return { leftOp: left.op, rightOp: right.op, label };
    };

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
        const { leftOp, rightOp, label } = parseOpAndLabel(before + " " + after);
        return { leftOp, rightOp, label, attrs, nextPos: blk.nextPos };
      }
      i++;
    }

    const { leftOp, rightOp, label } = parseOpAndLabel(s.slice(start, end));
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
    let currentEdgeNodes: Node[] = [];

    if (text[pos] === "[") {
      const n = this.parseNodeAt(text, pos);
      current = n.node;
      currentEdgeNodes = n.edgeNodes;
      this.lastParsedNodeAttrs = n.attrs;
      pos = n.nextPos;
      this.lastChainNode = current;
    } else if (text[pos] === "(") {
      // Inline group expression.
      const g = this.parseGroupAt(text, pos);
      current = g.repNode;
      currentEdgeNodes = current ? [current] : [];
      pos = g.nextPos;
      if (current) this.lastChainNode = current;
      this.lastParsedNodeAttrs = undefined;
    } else if (startsWithEdgeOp(text.slice(pos))) {
      if (!this.lastChainNode) {
        throw new Error(`Edge continuation without a previous node: ${text}`);
      }
      current = this.lastChainNode;
      currentEdgeNodes = [current];
      this.lastParsedNodeAttrs = undefined;
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
      let toEdgeNodes: Node[] = [];
      let nextPos: number;
      if (text[nextEl] === "[") {
        const n = this.parseNodeAt(text, nextEl);
        toNode = n.node;
        toEdgeNodes = n.edgeNodes;
        this.lastParsedNodeAttrs = n.attrs;
        nextPos = n.nextPos;
      } else {
        const g = this.parseGroupAt(text, nextEl);
        toNode = g.repNode;
        toEdgeNodes = toNode ? [toNode] : [];
        this.lastParsedNodeAttrs = undefined;
        nextPos = g.nextPos;
      }

      // Create edge if we have endpoints.
      if (currentEdgeNodes.length && toEdgeNodes.length) {
        let setLast = false;
        for (const fromNode of currentEdgeNodes) {
          for (const to of toEdgeNodes) {
            const created = this.graph.addEdge(fromNode, to, leftOp, rightOp, label);
            if (edgeSpec.attrs) created.setAttributes(edgeSpec.attrs);
            if (!setLast) {
              this.lastCreatedEdge = { from: fromNode, leftOp, rightOp, label, attrs: edgeSpec.attrs };
              setLast = true;
            }
          }
        }
      }

      current = toNode;
      currentEdgeNodes = toEdgeNodes;
      if (current) this.lastChainNode = current;
      pos = nextPos;
    }

    return pos;
  }
}

export class Parser {
  public static fromFile(filePath: string): Graph {
    const path = requireNodePath();
    const fs = requireNodeFs();

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
    // Strip hash comments that start with `# ` or `#\t` (including inline comments).
    // Important: do NOT treat hex color values like `#ff00ff` as comments.
    const withoutHashComments = text.replace(/(^|[ \t])#[ \t].*$/gm, "$1");
    const parser = new GraphEasyParser();
    return parser.parse(withoutHashComments);
  }
}
