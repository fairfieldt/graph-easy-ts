import { mergeAttributes, type Attributes } from "./attributes.js";
import { Edge } from "./edge.js";
import { Group } from "./group.js";
import { Node, type FlowDirection } from "./node.js";
import type { EdgeCell } from "./layout/edgeCell.js";
import type { EdgeCellEmpty } from "./layout/edgeCellEmpty.js";
import type { GroupCell } from "./layout/groupCell.js";
import type { NodeCell } from "./layout/nodeCell.js";

import { renderAscii, renderBoxart } from "./ascii.js";
import { renderTxt } from "./txt.js";
import { renderGraphviz } from "./graphviz.js";
import { renderHtml, renderHtmlFile } from "./html.js";
import { renderGraphml } from "./graphml.js";
import { renderSvg } from "./svg.js";
import { renderVcg } from "./vcg.js";

import { validateGroupAttributes } from "./validate.js";

import { layoutGraph } from "./layout/layout.js";

import type { LayoutAction } from "./layout/chain.js";

function inferEdgeStyleFromOperators(leftOp: string, rightOp: string): string {
  // Graph::Easy encodes the edge line style directly in the operator token.
  // Examples from fixtures:
  //   ==>   -> double
  //   ..->  -> dot-dot-dash
  //   .->   -> dot-dash
  //   ..>   -> dotted
  //   - >   -> dashed
  //   -->   -> solid

  // Strip arrowheads but preserve spaces so we can distinguish e.g. "- >" from "->".
  const coreLeft = leftOp.replace(/[<>]/g, "");
  const coreRight = rightOp.replace(/[<>]/g, "");
  const core = coreLeft + coreRight;

  if (core.includes("~~")) return "wave";
  if (core.includes("..-")) return "dot-dot-dash";
  if (core.includes(".-")) return "dot-dash";
  if (core.includes("..")) return "dotted";

  // Dashed variants preserve a space in the operator ("- ", "= ").
  // Check these before the solid/double fallbacks because mixed cases like
  // "-  label - >" otherwise look like "--" after concatenation.
  if (core.includes("= ")) return "double-dash";
  if (core.includes("- ")) return "dashed";

  if (core.includes("==")) return "double";
  if (core.includes("=")) return "double-dash";
  if (core.includes("--")) return "solid";
  if (core.includes("-")) return "solid";

  return "solid";
}

export class Graph {
  public id = "";
  public timeout = 360;

  public seed = 0;

  // Graph::Easy collapses internal whitespace in labels, but the DOT fixtures expect
  // Graphviz string continuation whitespace (e.g. double spaces) to be preserved.
  public preserveLabelWhitespace = false;

  // Internal: matches Perl Graph::Easy->{_ascii_style}. The ASCII/boxart renderer sets
  // this transiently so Node/Edge->labelText() can apply the correct autolabel
  // shortening rules (ASCII uses " ... "; boxart uses " … ").
  public _asciiStyleIndex: 0 | 1 = 0;

  public readonly graphAttributes: Attributes = Object.create(null);
  public readonly defaultNodeAttributes: Attributes = Object.create(null);
  public readonly defaultEdgeAttributes: Attributes = Object.create(null);
  public readonly defaultGroupAttributes: Attributes = Object.create(null);

  public readonly nodeClassAttributes = new Map<string, Attributes>();
  public readonly edgeClassAttributes = new Map<string, Attributes>();
  public readonly groupClassAttributes = new Map<string, Attributes>();

  private readonly nodesById = new Map<string, Node>();

  // Graph::Easy uses a single shared counter for both node IDs and edge IDs.
  // The resulting ID strings are later compared lexicographically via ord_values(),
  // so matching the exact interleaving (nodes/edges created in parse order) matters
  // for deterministic placement.
  private nextId = 0;

  public readonly edges: Edge[] = [];
  public readonly groups: Group[] = [];

  public constructor() {
    // Graph::Easy defaults for groups (see Attributes.pm).
    this.defaultGroupAttributes.fill = "#a0d0ff";
    this.defaultGroupAttributes.borderstyle = "dashed";
    this.defaultGroupAttributes.bordercolor = "#000000";
    this.defaultGroupAttributes.borderwidth = "1";
  }

  // The laid out grid cells (keyed by "x,y" in grid coordinates).
  public cells: Map<string, Node | EdgeCell | NodeCell | GroupCell | EdgeCellEmpty> | undefined;

  public node(id: string): Node | undefined {
    return this.nodesById.get(id);
  }

  public nodes(): Iterable<Node> {
    return this.nodesById.values();
  }

  public allocateId(): number {
    return this.nextId++;
  }

  public getNodeCount(): number {
    return this.nodesById.size;
  }

  public flow(): FlowDirection {
    const raw = this.graphAttributes.flow;
    if (!raw) return 90;

    const v = raw.trim().toLowerCase();
    if (v === "0" || v === "90" || v === "180" || v === "270") return Number(v) as FlowDirection;

    // Absolute directions.
    if (v === "east" || v === "right" || v === "forward" || v === "front") return 90;
    if (v === "west" || v === "left" || v === "back") return 270;
    if (v === "north" || v === "up") return 0;
    if (v === "south" || v === "down") return 180;

    throw new Error(`Invalid graph flow: ${raw}`);
  }

  public setGraphAttributes(attrs: Attributes): void {
    mergeAttributes(this.graphAttributes, attrs);
  }

  public setDefaultAttributes(kind: "node" | "edge" | "group", attrs: Attributes): void {
    if (kind === "group") {
      validateGroupAttributes(attrs);
    }

    if (kind === "node") mergeAttributes(this.defaultNodeAttributes, attrs);
    else if (kind === "edge") mergeAttributes(this.defaultEdgeAttributes, attrs);
    else mergeAttributes(this.defaultGroupAttributes, attrs);
  }

  public setClassAttributes(kind: "node" | "edge" | "group", className: string, attrs: Attributes): void {
    if (kind === "group") {
      validateGroupAttributes(attrs);
    }

    const map =
      kind === "node" ? this.nodeClassAttributes : kind === "edge" ? this.edgeClassAttributes : this.groupClassAttributes;

    const key = className.trim().toLowerCase();

    const existing = map.get(key);
    if (existing) {
      mergeAttributes(existing, attrs);
      return;
    }

    const copy: Attributes = Object.create(null);
    mergeAttributes(copy, attrs);
    map.set(key, copy);
  }

  public addNode(label: string): Node {
    const id = label;
    const existing = this.nodesById.get(id);
    if (existing) return existing;

    const node = new Node(id, label, this.allocateId());
    node.graph = this;
    node.applyInheritedAttributes(this.defaultNodeAttributes);
    this.nodesById.set(id, node);
    return node;
  }

  public addNodeWithId(id: string, label: string, numericId: number): Node {
    const existing = this.nodesById.get(id);
    if (existing) return existing;

    const node = new Node(id, label, numericId);
    node.graph = this;
    node.applyInheritedAttributes(this.defaultNodeAttributes);
    this.nodesById.set(id, node);
    return node;
  }

  public addEdge(from: Node, to: Node, leftOp: string, rightOp: string, label: string): Edge {
    return this.addEdgeWithId(this.allocateId(), from, to, leftOp, rightOp, label);
  }

  public addEdgeWithId(id: number, from: Node, to: Node, leftOp: string, rightOp: string, label: string): Edge {
    const hasLeftArrow = leftOp.includes("<") || rightOp.includes("<");
    const hasRightArrow = leftOp.includes(">") || rightOp.includes(">");

    let actualFrom = from;
    let actualTo = to;

    const bidirectional = hasLeftArrow && hasRightArrow;
    const undirected = !hasLeftArrow && !hasRightArrow;

    // Only-left arrow means the edge direction is right-to-left.
    if (!bidirectional && !undirected && hasLeftArrow && !hasRightArrow) {
      actualFrom = to;
      actualTo = from;
    }

    const edge = new Edge(id, actualFrom, actualTo, leftOp, rightOp, label);
    edge.applyInheritedAttributes(this.defaultEdgeAttributes);

    // Graph::Easy encodes the edge line style directly in the operator token.
    // However, Graphviz-style defaults like `edge { style: invisible }` are used
    // for layout-only edges: solid edges stay invisible, while non-solid operator
    // styles (dashed/dotted/double/...) still render.
    const operatorStyle = inferEdgeStyleFromOperators(leftOp, rightOp);
    const currentStyle = edge.attribute("style").trim().toLowerCase();
    if (!currentStyle) {
      edge.applyInheritedAttributes({ style: operatorStyle });
    } else if (currentStyle === "invisible" && operatorStyle !== "solid") {
      edge.applyInheritedAttributes({ style: operatorStyle });
    }

    edge.graph = this;
    edge.bidirectional = bidirectional;
    edge.undirected = undirected;

    actualFrom.addEdge(edge);
    actualTo.addEdge(edge);

    this.edges.push(edge);
    return edge;
  }

  public addGroup(group: Group): void {
    group.graph = this;
    this.groups.push(group);
  }

  public deleteNode(nodeId: string): void {
    const node = this.nodesById.get(nodeId);
    if (!node) return;

    this.nodesById.delete(nodeId);

    // Remove edges connected to this node.
    for (let i = this.edges.length - 1; i >= 0; i--) {
      const e = this.edges[i];
      if (e.from === node || e.to === node) {
        e.from.edgesById.delete(e.id);
        e.to.edgesById.delete(e.id);
        this.edges.splice(i, 1);
      }
    }

    // Remove node from all groups (including nested groups).
    const removeFromGroup = (g: Group): void => {
      g.nodes.delete(node);
      for (const child of g.groups) removeFromGroup(child);
    };
    for (const g of this.groups) removeFromGroup(g);
  }

  public edgesBetween(from: Node, to: Node): Edge[] {
    const out: Edge[] = [];
    for (const e of this.edges) {
      if (e.from === from && e.to === to) {
        out.push(e);
        continue;
      }
      if ((e.bidirectional || e.undirected) && e.from === to && e.to === from) {
        out.push(e);
      }
    }
    // Graph::Easy uses ord_values() which sorts keys lexicographically.
    out.sort((a, b) => {
      const ak = String(a.id);
      const bk = String(b.id);
      return ak < bk ? -1 : ak > bk ? 1 : 0;
    });
    return out;
  }

  public _layoutAction(action: number, node: Node, ...params: unknown[]): LayoutAction {
    node.todo = false;
    return [action, node, ...params] as unknown as LayoutAction;
  }

  public _edgesIntoGroups(): void {
    // Ported from Graph::Easy::_edges_into_groups.
    // Put all edges between two nodes with the same group into that group.
    for (const e of this.edges) {
      e.group = undefined;
    }

    for (const e of this.edges) {
      const gf = e.from.group;
      const gt = e.to.group;
      if (gf && gt && gf === gt) {
        e.group = gf;
      }
    }
  }

  public layout(): void {
    this._edgesIntoGroups();
    this.cells = layoutGraph(this);
  }

  public asAscii(): string {
    return renderAscii(this);
  }

  public asBoxart(): string {
    return renderBoxart(this);
  }

  public asTxt(): string {
    return renderTxt(this);
  }

  public asGraphviz(): string {
    return renderGraphviz(this);
  }

  public asHtml(): string {
    return renderHtml(this);
  }

  public asHtmlFile(): string {
    return renderHtmlFile(this);
  }

  public asGraphml(): string {
    return renderGraphml(this);
  }

  public asSvg(): string {
    return renderSvg(this);
  }

  public asVcg(_format: "vcg" | "gdl" = "vcg"): string {
    return renderVcg(this);
  }
}
