import { mergeAttributes, type Attributes } from "./attributes";
import { Edge } from "./edge";
import { Group } from "./group";
import { Node, type FlowDirection } from "./node";
import type { EdgeCell } from "./layout/edgeCell";
import type { GroupCell } from "./layout/groupCell";
import type { NodeCell } from "./layout/nodeCell";

import { renderAscii } from "./ascii";

import { layoutGraph } from "./layout/layout";

import type { LayoutAction } from "./layout/chain";

function inferEdgeStyleFromOperators(leftOp: string, rightOp: string): string {
  // Graph::Easy encodes the edge line style directly in the operator token.
  // Examples from fixtures:
  //   ==>   -> double
  //   ..->  -> dot-dot-dash
  //   .->   -> dot-dash
  //   ..>   -> dotted
  //   ->    -> dashed
  //   -->   -> solid
  const op = leftOp === rightOp ? leftOp : leftOp + rightOp;

  // Strip arrowheads.
  const core = op.replace(/[<>]/g, "");

  if (core.includes("~~")) return "wave";
  if (core.includes("..-")) return "dot-dot-dash";
  if (core.includes(".-")) return "dot-dash";
  if (core.includes("..")) return "dotted";
  if (core.includes("==")) return "double";
  if (core.includes("=")) return "double-dash";
  if (core.includes("--")) return "solid";
  if (core.includes("-")) return "dashed";

  return "solid";
}

export class Graph {
  public id = "";
  public timeout = 360;

  public seed = 0;

  public readonly graphAttributes: Attributes = Object.create(null);
  public readonly defaultNodeAttributes: Attributes = Object.create(null);
  public readonly defaultEdgeAttributes: Attributes = Object.create(null);
  public readonly defaultGroupAttributes: Attributes = Object.create(null);

  public readonly nodeClassAttributes = new Map<string, Attributes>();
  public readonly edgeClassAttributes = new Map<string, Attributes>();
  public readonly groupClassAttributes = new Map<string, Attributes>();

  private readonly nodesById = new Map<string, Node>();

  private nextEdgeId = 1;

  public readonly edges: Edge[] = [];
  public readonly groups: Group[] = [];

  // The laid out grid cells (keyed by "x,y" in grid coordinates).
  public cells: Map<string, Node | EdgeCell | NodeCell | GroupCell> | undefined;

  public node(id: string): Node | undefined {
    return this.nodesById.get(id);
  }

  public nodes(): Iterable<Node> {
    return this.nodesById.values();
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
    if (kind === "node") mergeAttributes(this.defaultNodeAttributes, attrs);
    else if (kind === "edge") mergeAttributes(this.defaultEdgeAttributes, attrs);
    else mergeAttributes(this.defaultGroupAttributes, attrs);
  }

  public setClassAttributes(kind: "node" | "edge" | "group", className: string, attrs: Attributes): void {
    const map =
      kind === "node" ? this.nodeClassAttributes : kind === "edge" ? this.edgeClassAttributes : this.groupClassAttributes;

    const existing = map.get(className);
    if (existing) {
      mergeAttributes(existing, attrs);
      return;
    }

    const copy: Attributes = Object.create(null);
    mergeAttributes(copy, attrs);
    map.set(className, copy);
  }

  public addNode(label: string): Node {
    const id = label;
    const existing = this.nodesById.get(id);
    if (existing) return existing;

    const node = new Node(id, label);
    node.graph = this;
    node.setAttributes(this.defaultNodeAttributes);
    this.nodesById.set(id, node);
    return node;
  }

  public addEdge(from: Node, to: Node, leftOp: string, rightOp: string, label: string): Edge {
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

    const edge = new Edge(this.nextEdgeId++, actualFrom, actualTo, leftOp, rightOp, label);
    edge.setAttributes(this.defaultEdgeAttributes);

    // If no explicit style was provided via attributes, infer it from the edge operator.
    if (edge.attribute("style").trim() === "") {
      edge.setAttributes({ style: inferEdgeStyleFromOperators(leftOp, rightOp) });
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
    out.sort((a, b) => a.id - b.id);
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
}
