import type { Group } from "../group.js";

// Ported from Graph::Easy::Edge::Cell::Empty.
//
// In Perl this is a Node::Cell placeholder inserted by _optimize_layout when
// compacting straight edge runs. It reserves the grid slot so sizing/bounds
// calculations stay Perl-compatible, but it is not a renderable node or edge.
export class EdgeCellEmpty {
  public constructor(
    public x: number,
    public y: number
  ) {}

  public isNodeCell(): boolean {
    return true;
  }

  public get group(): Group | undefined {
    return undefined;
  }
}
