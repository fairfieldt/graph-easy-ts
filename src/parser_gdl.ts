import { Graph } from "./graph";
import type { Attributes } from "./attributes";

type Token = { type: "punct"; value: string } | { type: "id"; value: string } | { type: "string"; value: string };

type EdgeSpec = {
  source: string;
  target: string;
};

function newAttrs(): Attributes {
  return Object.create(null) as Attributes;
}

function normalizeGdlText(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

function tokenizeGdl(text: string): Token[] {
  const tokens: Token[] = [];
  const s = text;
  let i = 0;

  const pushId = (value: string) => tokens.push({ type: "id", value });
  const pushPunct = (value: string) => tokens.push({ type: "punct", value });
  const pushString = (value: string) => tokens.push({ type: "string", value });

  while (i < s.length) {
    const ch = s[i];

    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    // // comments
    if (ch === "/" && s[i + 1] === "/") {
      i += 2;
      while (i < s.length && s[i] !== "\n") i++;
      continue;
    }

    if ("{}:".includes(ch)) {
      pushPunct(ch);
      i++;
      continue;
    }

    if (ch === "\"") {
      i++;
      let out = "";
      while (i < s.length) {
        const c = s[i];
        if (c === "\\" && i + 1 < s.length) {
          out += s.slice(i, i + 2);
          i += 2;
          continue;
        }
        if (c === "\"") {
          i++;
          break;
        }
        out += c;
        i++;
      }
      pushString(out);
      continue;
    }

    const start = i;
    while (i < s.length) {
      const c = s[i];
      if (/\s/.test(c)) break;
      if (c === "/" && s[i + 1] === "/") break;
      if ("{}:\"".includes(c)) break;
      i++;
    }

    const raw = s.slice(start, i);
    if (!raw) throw new Error("Unexpected empty token while parsing GDL");
    pushId(raw);
  }

  return tokens;
}

function mapOrientationToFlow(value: string): string {
  const v = value.trim();
  if (v === "top_to_bottom") return "south";
  if (v === "bottom_to_top") return "north";
  if (v === "left_to_right") return "east";
  if (v === "right_to_left") return "west";
  return "south";
}

function stripColorCodes(label: string): string {
  // VCG color codes: \fNN prefix sequences.
  return label.replace(/\f\d+/g, "");
}

class GdlParser {
  private readonly tokens: Token[];
  private pos = 0;

  private readonly graph = new Graph();
  private readonly edges: EdgeSpec[] = [];

  public constructor(text: string) {
    this.tokens = tokenizeGdl(normalizeGdlText(text));

    // Defaults observed in t/txt/gdl fixtures.
    this.graph.setDefaultAttributes("edge", { arrowstyle: "filled" });
    this.graph.setDefaultAttributes("node", { align: "left" });
    this.graph.setGraphAttributes({ flow: "south" });

    // GDL/VCG labels can contain intentional spacing (e.g. assembly columns) and
    // literal newlines inside quoted strings. Preserve internal label whitespace so
    // ASCII output matches Graph::Easy.
    this.graph.preserveLabelWhitespace = true;
  }

  public parse(): Graph {
    this.expectId("graph");
    this.expectPunct(":");
    this.expectPunct("{");

    while (!this.peekPunct("}") && !this.isEof()) {
      const key = this.consumeId();
      this.expectPunct(":");

      if (key === "node") {
        this.expectPunct("{");
        this.parseNodeBlock();
        this.expectPunct("}");
        continue;
      }

      if (key === "edge") {
        this.expectPunct("{");
        this.parseEdgeBlock();
        this.expectPunct("}");
        continue;
      }

      const value = this.parseScalar();
      this.applyGraphAttr(key, value);
    }

    this.expectPunct("}");

    for (const e of this.edges) {
      const from = this.graph.addNode(e.source);
      const to = this.graph.addNode(e.target);
      this.graph.addEdge(from, to, "-->", "-->", "");
    }

    return this.graph;
  }

  private parseNodeBlock(): void {
    let title: string | undefined;
    const attrs = newAttrs();

    while (!this.peekPunct("}") && !this.isEof()) {
      const key = this.consumeId();
      this.expectPunct(":");
      const value = this.parseScalar();

      if (key === "title") {
        title = value;
        continue;
      }

      if (key === "label") {
        // Perl serializes multi-line VCG/GDL labels using literal "\\n" sequences
        // in as_txt output, not raw newline characters.
        attrs.label = stripColorCodes(value).replace(/\n/g, "\\n");
        continue;
      }

      if (key === "vertical_order") {
        // Mirror _vertical_order_from_vcg: save original + set rank.
        attrs["x-vcg-vertical_order"] = value;
        attrs.rank = value === "maxdepth" ? "1000000" : value;
        continue;
      }

      // Keep other node attrs as x-vcg-*.
      attrs[`x-vcg-${key}`] = value;
    }

    if (!title) {
      throw new Error("VCG/GDL node missing required 'title' attribute");
    }

    const node = this.graph.addNode(title);
    if (Object.keys(attrs).length) node.setAttributes(attrs);
  }

  private parseEdgeBlock(): void {
    let source: string | undefined;
    let target: string | undefined;

    while (!this.peekPunct("}") && !this.isEof()) {
      const key = this.consumeId();
      this.expectPunct(":");
      const value = this.parseScalar();

      if (key === "source" || key === "sourcename") source = value;
      else if (key === "target" || key === "targetname") target = value;
      // else ignore
    }

    if (!source || !target) {
      throw new Error("VCG/GDL edge missing required 'source'/'target' fields");
    }

    this.edges.push({ source, target });
  }

  private applyGraphAttr(key: string, value: string): void {
    if (key === "title") {
      // Perl remap: graph.title => graph.label
      this.graph.setGraphAttributes({ label: value });
      return;
    }

    if (key === "orientation") {
      this.graph.setGraphAttributes({ flow: mapOrientationToFlow(value) });
      return;
    }

    // Keep other graph attrs as x-vcg-*.
    this.graph.setGraphAttributes({ [`x-vcg-${key}`]: value });
  }

  private parseScalar(): string {
    const t = this.peekToken();
    if (!t) throw new Error("Unexpected EOF while parsing GDL");

    if (t.type === "string") {
      this.pos++;
      return t.value;
    }

    if (t.type === "id") {
      this.pos++;
      return t.value;
    }

    throw new Error(`Unexpected token while parsing GDL scalar: ${JSON.stringify(t)}`);
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

  private expectId(value: string): void {
    const t = this.peekToken();
    if (!t || t.type !== "id" || t.value !== value) {
      throw new Error(`Expected '${value}', got: ${t ? JSON.stringify(t) : "<eof>"}`);
    }
    this.pos++;
  }

  private consumeId(): string {
    const t = this.peekToken();
    if (!t || t.type !== "id") {
      throw new Error(`Expected identifier, got: ${t ? JSON.stringify(t) : "<eof>"}`);
    }
    this.pos++;
    return t.value;
  }
}

export function parseGdl(text: string): Graph {
  return new GdlParser(text).parse();
}
