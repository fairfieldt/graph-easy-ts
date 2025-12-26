import { mergeAttributes, type Attributes } from "./attributes";

import type { Graph } from "./graph";
import type { Group } from "./group";
import type { FlowDirection, Node } from "./node";
import type { EdgeCell } from "./layout/edgeCell";

// Port parsing helpers (ported from Graph::Easy 0.76).

export type PortSide = "north" | "south" | "east" | "west";

const FLOW_MODIFIER: Record<string, number> = {
  forward: 0,
  front: 0,
  left: -90,
  right: +90,
  back: +180,
};

const DIRS: Record<string, FlowDirection> = {
  up: 0,
  north: 0,
  down: 180,
  south: 180,
  west: 270,
  east: 90,
  "0": 0,
  "180": 180,
  "90": 90,
  "270": 270,
};

// For determining absolute parent flow (Graph::Easy->flow / Node::_parent_flow_absolute).
const PARENT_FLOW: Record<string, FlowDirection> = {
  east: 90,
  west: 270,
  north: 0,
  south: 180,
  up: 0,
  down: 180,
  back: 270,
  left: 270,
  right: 90,
  front: 90,
  forward: 90,
};

const SIDES: Record<string, PortSide> = {
  north: "north",
  south: "south",
  east: "east",
  west: "west",
  up: "north",
  down: "south",
  "0": "north",
  "180": "south",
  "90": "east",
  "270": "west",
};

function directionAsSide(dir: string): PortSide | undefined {
  return SIDES[dir.trim().toLowerCase()];
}

function parentFlowAsDirection(raw: string): FlowDirection {
  const v = raw.trim().toLowerCase();
  const abs = PARENT_FLOW[v];
  if (abs !== undefined) return abs;
  const d = DIRS[v];
  if (d !== undefined) return d;
  throw new Error(`Invalid parent flow: ${raw}`);
}

function flowAsSide(inflow: number, dir: string): PortSide | undefined {
  const d = dir.trim().toLowerCase();

  if (/^(south|north|west|east|up|down|0|90|180|270)$/.test(d)) {
    return SIDES[d];
  }

  const input = DIRS[String(inflow)];
  const modifier = FLOW_MODIFIER[d];

  if (input === undefined) {
    throw new Error(`flowAsSide: ${String(inflow)},${dir} results in undefined inflow`);
  }
  if (modifier === undefined) {
    throw new Error(`flowAsSide: ${String(inflow)},${dir} results in undefined modifier`);
  }

  let out = input + modifier;
  if (out >= 360) out -= 360;

  return SIDES[String(out)];
}

function flowAsDirection(inflow: FlowDirection, dir: string): FlowDirection {
  // Ported from Graph::Easy::Attributes::_flow_as_direction.
  const d = dir.trim().toLowerCase();

  if (/^(south|north|west|east|up|down|0|90|180|270)$/.test(d)) {
    return DIRS[d];
  }

  const input = DIRS[String(inflow)];
  const modifier = FLOW_MODIFIER[d];

  if (input === undefined) {
    throw new Error(`flowAsDirection: ${String(inflow)},${dir} results in undefined inflow`);
  }
  if (modifier === undefined) {
    throw new Error(`flowAsDirection: ${String(inflow)},${dir} results in undefined modifier`);
  }

  let out = input + modifier;
  while (out >= 360) out -= 360;
  while (out < 0) out += 360;
  return out as FlowDirection;
}

export class Edge {
  public readonly attributes: Attributes = Object.create(null);

  // Explicit attributes set directly on this edge. This excludes inherited class
  // defaults like `edge { ... }`.
  public readonly explicitAttributes: Attributes = Object.create(null);

  public graph: Graph | undefined;
  public group: Group | undefined;

  public bidirectional = false;
  public undirected = false;

  public cells: EdgeCell[] = [];

  // Layout bookkeeping.
  public todo = true;

  public constructor(
    public readonly id: number,
    public from: Node,
    public to: Node,
    public readonly leftOp: string,
    public readonly rightOp: string,
    public readonly label: string
  ) {}

  public applyInheritedAttributes(attrs: Attributes): void {
    this.applyAttributes(attrs, false);
  }

  public setAttributes(attrs: Attributes): void {
    this.applyAttributes(attrs, true);
  }

  private applyAttributes(attrs: Attributes, recordExplicit: boolean): void {
    // Apply class attributes (Graph::Easy "edge.<class> { ... }") before merging
    // explicit edge attributes so inline attrs win.
    if (Object.prototype.hasOwnProperty.call(attrs, "class")) {
      const raw = attrs.class?.trim() ?? "";
      if (raw !== "" && this.graph) {
        for (const cls of raw.split(/[\s,]+/).filter(Boolean)) {
          const classAttrs = this.graph.edgeClassAttributes.get(cls.toLowerCase());
          if (classAttrs) {
            mergeAttributes(this.attributes, classAttrs);
          }
        }
      }
    }

    mergeAttributes(this.attributes, attrs);
    if (recordExplicit) {
      mergeAttributes(this.explicitAttributes, attrs);
    }
  }

  public rawAttribute(key: string): string | undefined {
    return this.attributes[key];
  }

  public attribute(key: string): string {
    const own = this.attributes[key];
    if (own !== undefined) return own;

    // Graph::Easy uses graph-level textwrap as the default for node/edge labels.
    if (key === "textwrap") {
      return this.graph?.graphAttributes.textwrap ?? "";
    }

    // Perl Graph::Easy::Edge->attribute('flow') resolves to the effective flow
    // even when the edge has no raw flow (e.g. defaults to 'east'). Layout::Chain
    // layout checks this attribute, so we need the same behavior to keep chain
    // placement in sync with Perl.
    if (key === "flow") {
      const resolved = this.resolvedAttribute("flow");
      return resolved !== "" ? resolved : "east";
    }

    return "";
  }

  private resolvedAttribute(key: string): string {
    const norm = (v: string): string => v.trim().toLowerCase();

    const own = this.rawAttribute(key);
    if (own !== undefined && norm(own) !== "" && norm(own) !== "inherit") return own;

    let g = this.group;
    while (g) {
      const gv = g.rawAttribute(key);
      if (gv !== undefined && norm(gv) !== "" && norm(gv) !== "inherit") return gv;
      g = g.parent;
    }

    const graphV = this.graph?.graphAttributes[key];
    if (graphV !== undefined && norm(graphV) !== "" && norm(graphV) !== "inherit") return graphV;

    return "";
  }

  public labelText(): string {
    // Ported from Graph::Easy::Node->label (Edge objects share the same semantics).
    // Prefer explicit { label: ... } attribute, otherwise fall back to the parsed
    // edge label string.
    let out: string = this.rawAttribute("label") ?? this.label;

    if (out !== "") {
      const lenRaw0 = this.resolvedAttribute("autolabel");
      if (lenRaw0 !== "") {
        let lenRaw = lenRaw0.trim();
        lenRaw = lenRaw.replace(/^name\s*,\s*/i, "");

        let len = Math.abs(Number(lenRaw) || 0);
        if (len > 99999) len = 99999;

        if (out.length > len) {
          let keep = Math.trunc(len / 2) - 3;
          if (keep < 0) keep = 0;
          if (keep === 0) {
            out = " ... ";
          } else {
            out = out.slice(0, keep) + " ... " + out.slice(out.length - keep);
          }
        }
      }
    }

    return out;
  }

  public flow(): FlowDirection {
    // Ported from Graph::Easy::Edge->flow (Graph-Easy 0.76).
    // - Prefer edge flow.
    // - Otherwise inherit from the from-node's raw flow.
    // - Otherwise inherit from parent (group/graph) flow.
    // - Default is east (90).

    const norm = (s: string): string => s.trim().toLowerCase();

    const normalizeFlowToken = (raw: string | undefined): string | undefined => {
      if (raw === undefined) return undefined;
      const v = norm(raw);
      if (v === "" || v === "inherit") return undefined;
      return v;
    };

    let flow = normalizeFlowToken(this.rawAttribute("flow"));
    if (flow === undefined) {
      flow = normalizeFlowToken(this.from.rawAttribute("flow"));
    }

    if (flow === undefined) {
      let g = this.group;
      while (g) {
        const raw = normalizeFlowToken(g.rawAttribute("flow"));
        if (raw !== undefined) {
          flow = String(parentFlowAsDirection(raw));
          break;
        }
        g = g.parent;
      }
    }

    if (flow === undefined) {
      const rawGraphFlow = normalizeFlowToken(this.graph?.graphAttributes.flow);
      if (rawGraphFlow !== undefined) {
        flow = String(parentFlowAsDirection(rawGraphFlow));
      }
    }

    if (flow === undefined) flow = "90";

    // Absolute flow does not depend on the in-flow, so can return early.
    if (flow === "0" || flow === "90" || flow === "180" || flow === "270") {
      return Number(flow) as FlowDirection;
    }

    // in-flow comes from our "from" node
    const inflow = this.from.flow();
    return flowAsDirection(inflow, flow);
  }

  public edgeFlow(): FlowDirection | undefined {
    // Ported from Graph::Easy::Edge->edge_flow.
    const raw = this.rawAttribute("flow");
    if (raw === undefined) return undefined;
    const value = raw.trim().toLowerCase();
    if (value === "" || value === "inherit") return undefined;
    return this.flow();
  }

  public hasPorts(): boolean {
    return this.attribute("start") !== "" || this.attribute("end") !== "";
  }

  public port(which: "start" | "end"): [PortSide | undefined, number | undefined] {
    const sp = this.attribute(which);
    if (!sp) return [undefined, undefined];

    const [sideRaw, portRaw] = sp.split(/\s*,\s*/);
    const port = portRaw !== undefined && portRaw !== "" ? Number(portRaw) : undefined;

    const abs = directionAsSide(sideRaw);
    if (abs) return [abs, port];

    // in_flow comes from our "from" node
    const inflow = this.from.flow();
    const resolved = flowAsSide(inflow, sideRaw);
    return [resolved, port];
  }

  public clearCells(): void {
    this.cells = [];
  }

  public addCell(cell: EdgeCell, after?: EdgeCell | number, before?: EdgeCell): void {
    // Similar to Graph::Easy::Edge::_add_cell.
    if (before && before.edge !== this) before = undefined;
    if (after && typeof after !== "number" && after.edge !== this) after = undefined;
    if (!after && before) {
      after = before;
      before = undefined;
    }

    if (after !== undefined) {
      let idx: number;

      if (typeof after === "number") {
        idx = after;
      } else if (before) {
        idx = -1;
        for (let i = 0; i < this.cells.length - 1; i++) {
          const c1 = this.cells[i];
          const c2 = this.cells[i + 1];
          if ((c1 === after && c2 === before) || (c1 === before && c2 === after)) {
            idx = i + 1;
            break;
          }
        }

        if (idx === -1) {
          // Fallback: insert after `after`.
          idx = this.cells.findIndex((c) => c === after);
          idx = idx === -1 ? this.cells.length : idx + 1;
        }
      } else {
        idx = this.cells.findIndex((c) => c === after);
        idx = idx === -1 ? this.cells.length : idx + 1;
      }

      this.cells.splice(idx, 0, cell);
      return;
    }

    this.cells.push(cell);
  }
}
