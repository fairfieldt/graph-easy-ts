import { mergeAttributes, type Attributes } from "./attributes";

import type { Graph } from "./graph";
import type { Group } from "./group";
import type { Node } from "./node";
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

const DIRS: Record<string, number> = {
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

export class Edge {
  public readonly attributes: Attributes = Object.create(null);

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

  public setAttributes(attrs: Attributes): void {
    mergeAttributes(this.attributes, attrs);
  }

  public rawAttribute(key: string): string | undefined {
    return this.attributes[key];
  }

  public attribute(key: string): string {
    return this.attributes[key] ?? "";
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
