import type { Edge } from "../edge.js";

import {
  EDGE_E_S_W,
  EDGE_END_E,
  EDGE_END_N,
  EDGE_END_S,
  EDGE_END_W,
  EDGE_HOR,
  EDGE_N_E,
  EDGE_N_W,
  EDGE_N_W_S,
  EDGE_S_E,
  EDGE_S_W,
  EDGE_S_W_N,
  EDGE_START_E,
  EDGE_START_N,
  EDGE_START_S,
  EDGE_START_W,
  EDGE_TYPE_MASK,
  EDGE_VER,
  EDGE_W_S_E,
} from "./edgeCellTypes.js";

// Ported from Graph::Easy::Layout::Scout (Graph-Easy 0.76).
// These helpers compute the EDGE_START_* / EDGE_END_* flags for a traced path.

export type Direction = -1 | 0 | 1;

export function directionSign(delta: number): Direction {
  if (delta === 0) return 0;
  return delta < 0 ? -1 : 1;
}

// From Graph::Easy::Layout::Scout::_astar_edge_type.
const ASTAR_EDGE_TYPE: Record<string, number> = {
  "0,1,-1,0": EDGE_N_W,
  "0,1,0,1": EDGE_VER,
  "0,1,1,0": EDGE_N_E,

  "-1,0,0,-1": EDGE_N_E,
  "-1,0,-1,0": EDGE_HOR,
  "-1,0,0,1": EDGE_S_E,

  "0,-1,-1,0": EDGE_S_W,
  "0,-1,0,-1": EDGE_VER,
  "0,-1,1,0": EDGE_S_E,

  "1,0,0,-1": EDGE_N_W,
  "1,0,1,0": EDGE_HOR,
  "1,0,0,1": EDGE_S_W,

  // Loops (left-right-left etc)
  "0,-1,0,1": EDGE_N_W_S,
  "0,1,0,-1": EDGE_S_W_N,
  "1,0,-1,0": EDGE_E_S_W,
  "-1,0,1,0": EDGE_W_S_E,
};

export function astarEdgeType(x: number, y: number, x1: number, y1: number, x2: number, y2: number): number {
  // From three consecutive positions calculate the edge type (VER, HOR, N_W etc).
  let dx1 = directionSign(x1 - x);
  let dy1 = directionSign(y1 - y);

  let dx2 = directionSign(x2 - x1);
  let dy2 = directionSign(y2 - y1);

  // In some cases we get (0,-1,0,0), so set the missing parts.
  if (dx2 === 0 && dy2 === 0) {
    dx2 = dx1;
    dy2 = dy1;
  }
  // Can this case happen?
  if (dx1 === 0 && dy1 === 0) {
    dx1 = dx2;
    dy1 = dy2;
  }

  const key = `${dx1},${dy1},${dx2},${dy2}`;
  return ASTAR_EDGE_TYPE[key] ?? EDGE_HOR;
}

// Mapping edge type (HOR/VER/N_E/...) and dx/dy to start/end flags.
// The 8-element array layout matches the Perl comment:
//   [ dx==1, dx==-1, dy==1, dy==-1,  dx==1, dx==-1, dy==1, dy==-1 ]
//   ^ start flags ------------------   ^ end flags -----------------
const START_POINTS = new Map<number, readonly number[]>([
  [
    EDGE_HOR,
    [EDGE_START_W, EDGE_START_E, 0, 0, EDGE_END_E, EDGE_END_W, 0, 0] as const,
  ],
  [
    EDGE_VER,
    [0, 0, EDGE_START_N, EDGE_START_S, 0, 0, EDGE_END_S, EDGE_END_N] as const,
  ],
  [
    EDGE_N_E,
    [0, EDGE_START_E, EDGE_START_N, 0, EDGE_END_E, 0, 0, EDGE_END_N] as const,
  ],
  [
    EDGE_N_W,
    [EDGE_START_W, 0, EDGE_START_N, 0, 0, EDGE_END_W, 0, EDGE_END_N] as const,
  ],
  [
    EDGE_S_E,
    [0, EDGE_START_E, 0, EDGE_START_S, EDGE_END_E, 0, EDGE_END_S, 0] as const,
  ],
  [
    EDGE_S_W,
    [EDGE_START_W, 0, 0, EDGE_START_S, 0, EDGE_END_W, EDGE_END_S, 0] as const,
  ],
]);

const START_TO_END = new Map<number, number>([
  [EDGE_START_W, EDGE_END_W],
  [EDGE_START_E, EDGE_END_E],
  [EDGE_START_S, EDGE_END_S],
  [EDGE_START_N, EDGE_END_N],
]);

// In Perl this is `_end_points`. It mutates `coords` in place.
//
// coords is [x,y,type, x1,y1,type1, ...] (triples). dx/dy are -1/0/1.
export function applyEndPoints(edge: Edge, coords: number[], dx: Direction, dy: Direction): number[] {
  if (edge.undirected) return coords;

  if (coords.length < 3 || coords.length % 3 !== 0) {
    throw new Error(`applyEndPoints: invalid coords length ${coords.length}`);
  }

  // There are two cases (for each dx and dy).
  let i = 0;
  let typeIndex = 2; // modify first cell type

  for (const d of [dx, dy, dx, dy] as const) {
    if (d !== 0) {
      const cellType = coords[typeIndex] & EDGE_TYPE_MASK;
      const sp = START_POINTS.get(cellType);
      if (!sp) {
        throw new Error(`applyEndPoints: unsupported edge cell type ${cellType}`);
      }

      const caseIdx = d === -1 ? 1 : 0;
      const idx = caseIdx + i;
      const raw = sp[idx];
      if (raw === undefined) {
        throw new Error(`applyEndPoints: start-points index out of range (idx=${idx})`);
      }

      // On bidirectional edges, turn START_* into END_*.
      let t = raw;
      if (edge.bidirectional) {
        t = START_TO_END.get(t) ?? t;
      }

      coords[typeIndex] += t;
    }

    // In Perl this is in the `continue` block (so it runs even when d==0).
    i += 2;
    if (i === 4) {
      // Modify now last cell type.
      typeIndex = coords.length - 1;
    }
  }

  return coords;
}
