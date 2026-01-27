import type { Edge } from "../edge.js";
import type { Group } from "../group.js";

import {
  EDGE_CROSS,
  EDGE_FLAG_MASK,
  EDGE_NO_M_MASK,
  EDGE_TYPE_MASK,
  EDGE_VER,
  EDGE_HOR,
} from "./edgeCellTypes.js";

export class EdgeCell {
  public w: number | undefined;
  public h: number | undefined;

  public cx: number | undefined;
  public cy: number | undefined;

  // For cross sections we may need both the horizontal and vertical edge styles.
  public crossHorEdge: Edge | undefined;
  public crossVerEdge: Edge | undefined;

  public constructor(
    public readonly edge: Edge,
    public x: number,
    public y: number,
    public type: number,
    after?: EdgeCell | number,
    before?: EdgeCell
  ) {
    edge.addCell(this, after, before);
  }

  public isEdgeCell(): boolean {
    return true;
  }

  public get group(): Group | undefined {
    return this.edge.group;
  }

  public makeCross(crossingEdge: Edge, flags: number): void {
    const base = this.type & EDGE_TYPE_MASK;
    if (base !== EDGE_HOR && base !== EDGE_VER) {
      throw new Error(`Trying to cross non hor/ver piece at ${this.x},${this.y}`);
    }

    if (base === EDGE_HOR) {
      this.crossHorEdge = this.edge;
      this.crossVerEdge = crossingEdge;
    } else {
      this.crossHorEdge = crossingEdge;
      this.crossVerEdge = this.edge;
    }

    this.type = EDGE_CROSS + (flags & EDGE_FLAG_MASK);
  }

  public makeJoint(_joiningEdge: Edge, newType: number): void {
    const base = this.type & EDGE_TYPE_MASK;
    if (base >= EDGE_NO_M_MASK) {
      throw new Error(`Trying to join invalid edge piece at ${this.x},${this.y}`);
    }

    this.type = newType;
  }
}
