import { appendFileSync } from "node:fs";

import { EdgeCell } from "./edgeCell";
import { GroupCell } from "./groupCell";
import { NodeCell } from "./nodeCell";
import { fillGroupCells } from "./repair";
import {
  EDGE_CROSS,
  EDGE_END_E,
  EDGE_END_N,
  EDGE_END_S,
  EDGE_END_W,
  EDGE_FLAG_MASK,
  EDGE_HOLE,
  EDGE_HOR,
  EDGE_LABEL_CELL,
  EDGE_N_E,
  EDGE_N_W,
  EDGE_NO_M_MASK,
  EDGE_S_E,
  EDGE_S_W,
  EDGE_SHORT_UN_EW,
  EDGE_SHORT_UN_NS,
  EDGE_START_E,
  EDGE_START_N,
  EDGE_START_S,
  EDGE_START_MASK,
  EDGE_START_W,
  EDGE_TYPE_MASK,
  EDGE_VER,
} from "./edgeCellTypes";

import { applyEndPoints, astarEdgeType, directionSign, type Direction } from "./scout";

import { Heap } from "./heap";

import { LayoutChain, type LayoutAction } from "./chain";
import { ACTION_CHAIN, ACTION_NODE, ACTION_TRACE } from "./actionTypes";

import type { Edge } from "../edge";
import type { Graph } from "../graph";
import type { Node, FlowDirection } from "../node";

type CellMap = Map<string, Node | EdgeCell | NodeCell | GroupCell>;

function debugRunId(): string {
  return process.env.GE_DEBUG_RUN_ID ?? "r1";
}

function debugLog(event: Record<string, unknown>): void {
  const file = process.env.GE_DEBUG_FILE;
  if (!file) return;
  try {
    appendFileSync(file, JSON.stringify(event) + "\n");
  } catch {
    // Best-effort only.
  }
}

function stableInsertByAbsRank(queue: Array<[number, Node]>, elem: [number, Node]): void {
  const abs = Math.abs(elem[0]);
  let i = 0;
  while (i < queue.length && Math.abs(queue[i][0]) <= abs) i++;
  queue.splice(i, 0, elem);
}

function parseGraphRootName(graph: Graph): string | undefined {
  const v = graph.graphAttributes.root;
  return v ? v.trim() : undefined;
}

function assignRanks(graph: Graph, root: Node | undefined): void {
  const todo: Array<[number, Node]> = [];
  const also: Node[] = [];

  const nodes = [...graph.nodes()].sort((a, b) => a.id.localeCompare(b.id));

  if (root) {
    root.rank = -1;
    stableInsertByAbsRank(todo, [-1, root]);
  }

  for (const n of nodes) {
    if (root && n === root) continue;

    const rawRank = n.rawAttribute("rank");

    let rankAtt: number | undefined;

    if (rawRank !== undefined) {
      const trimmed = rawRank.trim();
      if (trimmed === "auto") {
        rankAtt = undefined;
      } else if (trimmed === "same") {
        // TODO(perl parity): this probably shouldn't happen; the parser should assign
        // an automatic rank ID.
        rankAtt = 0;
      } else if (trimmed !== "") {
        const parsed = Number(trimmed);
        if (!Number.isFinite(parsed)) {
          throw new Error(`Invalid node rank: ${rawRank}`);
        }
        rankAtt = parsed;
      }
    }

    // User-defined ranks range from 1..inf; bump by 1.
    if (rankAtt !== undefined) {
      rankAtt += 1;
    }

    n.rank = rankAtt;

    // Auto-rank starting points (no predecessors) as -1.
    if (n.rank === undefined && n.predecessors().length === 0) {
      n.rank = -1;
    }

    if (n.rank !== undefined) {
      stableInsertByAbsRank(todo, [n.rank, n]);
    } else {
      also.push(n);
    }
  }

  while (also.length !== 0 || todo.length !== 0) {
    while (todo.length !== 0) {
      const [rank, n] = todo.shift() as [number, Node];

      let l = n.rank ?? rank;

      // If the rank comes from a user-supplied rank, make the next node have an
      // automatic rank (e.g. 4 => -4).
      if (l > 0) l = -l;
      l -= 1;

      for (const o of n.successors()) {
        if (o.rank === undefined) {
          o.rank = l;
          stableInsertByAbsRank(todo, [l, o]);
        }
      }
    }

    if (also.length === 0) break;

    while (also.length) {
      const n = also.shift();
      if (!n) break;
      if (n.rank !== undefined) continue;

      n.rank = -1;
      stableInsertByAbsRank(todo, [-1, n]);
      break;
    }
  }
}

function followChain(
  graph: Graph,
  chains: Map<number, LayoutChain>,
  nextChainId: { value: number },
  root: Node | undefined,
  node: Node
): number {
  const chain = new LayoutChain(nextChainId.value++, node, graph);
  chains.set(chain.id, chain);

  let done = 1;

  // Stop backward loops.
  const inBranch = new Set<Node>();

  let curr: Node = node;

  while (true) {
    inBranch.add(curr);

    // Count unique successors, ignoring selfloops and multi-edges.
    const suc = new Map<string, Node>();
    for (const e of curr.edges()) {
      if (e.from === e.to) continue;

      // Determine outgoing direction.
      let to = e.to;
      if (e.bidirectional && to === curr) {
        to = e.from;
      }

      // Edge leads to this node instead of away from it?
      if (to === curr) continue;

      // Backloop into current branch?
      if (inBranch.has(to)) continue;

      // Ignore backloops into the same chain.
      if (to.chain && to.chain === chain) continue;

      if (!suc.has(to.id)) {
        suc.set(to.id, to);
      }
    }

    if (suc.size === 0) break;

    if (suc.size === 1) {
      const next = suc.values().next().value as Node;
      if (!next.chain) {
        chain.addNode(next);
        curr = next;
        done++;
        continue;
      }
    }

    // Select the longest chain from successors and join it.
    let max = -1;
    let nextChain: LayoutChain | undefined;
    let nextNode: Node | undefined;

    for (const s of suc.values()) {
      if (!s.chain) {
        done += followChain(graph, chains, nextChainId, root, s);
      }

      const ch = s.chain;
      if (!ch || ch === chain) continue;

      if (ch.len > max) {
        max = ch.len;
        nextChain = ch;
        nextNode = s;
      }
    }

    if (nextChain && nextNode) {
      // Avoid merging into the root chain (Perl bug workaround).
      if (!root || nextNode !== root) {
        chain.merge(nextChain, nextNode);
        if (nextChain.len === 0) {
          chains.delete(nextChain.id);
        }
      }
    }

    break;
  }

  return done;
}

function findChains(graph: Graph): { root: Node | undefined; chains: Map<number, LayoutChain> } {
  // Drop old chain info.
  for (const n of graph.nodes()) {
    n.chain = undefined;
    n.chainNext = undefined;
  }

  const nodes = [...graph.nodes()].sort((a, b) => a.id.localeCompare(b.id));

  const rootName = parseGraphRootName(graph);

  const p: Array<{ name: string; hasPredecessors: number; hasOrigin: number; absRank: number }> = [];
  for (const n of nodes) {
    p.push({
      name: n.id,
      hasPredecessors: n.hasPredecessors(),
      hasOrigin: 0,
      absRank: Math.abs(n.rank ?? 0),
    });
  }

  const sortedNames = p
    .slice()
    .sort((a, b) => {
      return (
        a.absRank - b.absRank ||
        a.hasOrigin - b.hasOrigin ||
        a.hasPredecessors - b.hasPredecessors ||
        a.name.localeCompare(b.name)
      );
    })
    .map((e) => e.name);

  const names: Array<string | undefined> = [rootName, ...sortedNames];

  const chains = new Map<number, LayoutChain>();
  const nextChainId = { value: 1 };

  let root: Node | undefined;
  let done = 0;
  const todoCount = nodes.length;

  for (const name of names) {
    if (!name) continue;
    const n = graph.node(name);
    if (!n) continue;

    if (!root) root = n;

    if (done === todoCount) break;

    if (!n.chain) {
      done += followChain(graph, chains, nextChainId, root, n);
    }
  }

  return { root, chains };
}

function rankCoordForFlow(flow: FlowDirection): "x" | "y" {
  // Does rank_pos store rows or columns?
  // Perl stores 'y' for left/right flow and 'x' for up/down flow.
  return flow === 0 || flow === 180 ? "x" : "y";
}

function placeNode(
  graph: Graph,
  cells: CellMap,
  rankPos: Map<number, number>,
  flow: FlowDirection,
  node: Node
): void {
  const rank = node.rank ?? -1;
  const absRank = Math.abs(rank);

  const nodeCx = node.cx ?? 1;
  const nodeCy = node.cy ?? 1;

  const canPlace = (x0: number, y0: number): boolean => {
    for (let dx = 0; dx < nodeCx; dx++) {
      for (let dy = 0; dy < nodeCy; dy++) {
        if (cells.has(`${x0 + dx},${y0 + dy}`)) return false;
      }
    }
    return true;
  };

  // Along-flow coordinate.
  const along = (absRank - 1) * 2;

  const rankCoord = rankCoordForFlow(flow);

  let x: number;
  let y: number;

  if (rankCoord === "y") {
    // Left/right flow: ranks are columns (x fixed), stack nodes by y.
    x = flow === 270 ? -along : along;
    y = rankPos.get(rank) ?? 0;
    while (!canPlace(x, y)) y += 2;
    rankPos.set(rank, y + nodeCy + 1);
  } else {
    // Up/down flow: ranks are rows (y fixed), stack nodes by x.
    y = flow === 0 ? -along : along;
    x = rankPos.get(rank) ?? 0;
    while (!canPlace(x, y)) x += 2;
    rankPos.set(rank, x + nodeCx + 1);
  }

  node.x = x;
  node.y = y;

  // Mark occupied rectangle. Store the node itself at the anchor, and use
  // placeholder NodeCell entries for the remaining occupied cells.
  cells.set(`${x},${y}`, node);
  for (let dx = 0; dx < nodeCx; dx++) {
    for (let dy = 0; dy < nodeCy; dy++) {
      if (dx === 0 && dy === 0) continue;
      cells.set(`${x + dx},${y + dy}`, new NodeCell(node, x + dx, y + dy));
    }
  }
}

function findShortPath(cells: CellMap, edge: Edge, dx: Direction, dy: Direction): number[] | undefined {
  if (edge.from.x === undefined || edge.from.y === undefined || edge.to.x === undefined || edge.to.y === undefined) {
    throw new Error(`Edge ${edge.id} connects unplaced nodes`);
  }

  const dx1 = edge.to.x - edge.from.x;
  const dy1 = edge.to.y - edge.from.y;

  // Distance to node.
  const x = edge.from.x + dx;
  const y = edge.from.y + dy;

  if (Math.abs(dx1) !== 2 && Math.abs(dy1) !== 2) return undefined;
  if (cells.has(`${x},${y}`)) return undefined;

  let type: number;
  if (edge.undirected) {
    type = EDGE_LABEL_CELL + (dy === 0 ? EDGE_SHORT_UN_EW : EDGE_SHORT_UN_NS);
  } else {
    const coords = [x, y, EDGE_LABEL_CELL + (dy === 0 ? EDGE_HOR : EDGE_VER)];
    applyEndPoints(edge, coords, dx, dy);
    type = coords[2];
  }

  // If one of the end points of the edge is of shape 'edge', remove end/start flag.
  // Ported from Graph::Easy::Layout::Scout::_find_path() short-path special case.
  if (edge.to.attribute("shape") === "edge") {
    // Remove one start point, namely the one at the "end".
    if (dx > 0) type &= ~EDGE_START_E;
    else if (dx < 0) type &= ~EDGE_START_W;
  }
  if (edge.from.attribute("shape") === "edge") {
    type &= ~EDGE_START_MASK;
  }

  return [x, y, type];
}

type AstarClosedEntry = [
  number | undefined,
  number | undefined,
  number,
  number,
  number | undefined,
  number | undefined,
  number | undefined,
  number | undefined,
];

type AstarHeapElem = [
  number,
  number,
  number,
  number | undefined,
  number | undefined,
  number | undefined,
  number | undefined,
];

type Bend = [number, number, number, number];

const ASTAR_BIAS = 0.001;

function astarModifier(
  x1: number | undefined,
  y1: number | undefined,
  x: number,
  y: number,
  px: number | undefined,
  py: number | undefined,
  cells?: CellMap
): number {
  // Ported from Graph::Easy::_astar_modifier.
  let add = 1;

  if (x1 !== undefined && y1 !== undefined && cells) {
    const c = cells.get(`${x1},${y1}`);
    // Add a harsh penalty for crossing an edge.
    add += c instanceof EdgeCell ? 30 : 0;
  }

  if (px !== undefined && py !== undefined && x1 !== undefined && y1 !== undefined) {
    // Check whether the new position px,py is a continuation from x1,y1 => x,y.
    const dx1 = directionSign(px - x);
    const dy1 = directionSign(py - y);
    const dx2 = directionSign(x - x1);
    const dy2 = directionSign(y - y1);
    add += dx1 === dx2 || dy1 === dy2 ? 0 : 6;
  }

  return add;
}

function astarDistance(x1: number, y1: number, x2: number, y2: number): number {
  // Ported from Graph::Easy::_astar_distance.
  let dx = Math.abs(x2 - x1);
  const dy = Math.abs(y2 - y1);

  // plus 1 because we need to go around one corner if $dx != 0 && $dy != 0
  if (dx !== 0 && dy !== 0) dx += 1;
  return dx + dy;
}

function astarBoundaries(cells: CellMap): [number, number, number, number] {
  // Ported from Graph::Easy::_astar_boundaries.
  let minX = 10000000;
  let minY = 10000000;
  let maxX = -10000000;
  let maxY = -10000000;

  for (const key of cells.keys()) {
    const [xs, ys] = key.split(",");
    const x = Number(xs);
    const y = Number(ys);
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }

  // Graph::Easy uses a +/-1 boundary around occupied cells. Since our layouter
  // does not yet backtrack/re-pack nodes, give A* a bit more room to route
  // around congested layouts.
  const pad = 5;
  minX -= pad;
  minY -= pad;
  maxX += pad;
  maxY += pad;

  return [minX, minY, maxX, maxY];
}

function astarNearNodes(
  nx: number,
  ny: number,
  cells: CellMap,
  closed: Map<string, AstarClosedEntry>,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number
): number[] {
  // Ported from Graph::Easy::_astar_near_nodes.
  let tries = [
    nx + 1,
    ny, // right
    nx,
    ny + 1, // down
    nx - 1,
    ny, // left
    nx,
    ny - 1, // up
  ];

  // On crossings, only allow one direction (NS or EW).
  let type = EDGE_CROSS;
  const current = cells.get(`${nx},${ny}`);
  if (current instanceof EdgeCell) {
    type = current.type & EDGE_TYPE_MASK;
  }
  if (type === EDGE_HOR) {
    tries = [
      nx,
      ny + 1, // down
      nx,
      ny - 1, // up
    ];
  } else if (type === EDGE_VER) {
    tries = [
      nx + 1,
      ny, // right
      nx - 1,
      ny, // left
    ];
  }

  const places: number[] = [];

  for (let i = 0; i < tries.length; i += 2) {
    const x = tries[i];
    const y = tries[i + 1];

    // Drop cells outside our working space.
    if (x < minX || x > maxX || y < minY || y > maxY) continue;

    const p = `${x},${y}`;
    if (closed.has(p)) continue;

    const cell = cells.get(p);
    if (cell instanceof EdgeCell) {
      // If the existing cell is an VER/HOR edge, then we may cross it.
      const t = cell.type & EDGE_TYPE_MASK;
      if (t === EDGE_HOR || t === EDGE_VER) {
        places.push(x, y);
      }
      continue;
    }

    if (cell) continue; // uncrossable cell

    places.push(x, y);
  }

  return places;
}

const BEND_PATTERNS: ReadonlyArray<ReadonlyArray<number>> = [
  // The patterns are duplicated to catch both directions of the path.
  // [ A, B, C, dx, dy,  (coord selectors),  typeA/typeB,  ddx1/ddy1, ddx2/ddy2 ]
  [EDGE_N_W, EDGE_S_E, EDGE_N_W, 0, -1, 2, 1, EDGE_HOR, EDGE_VER, 1, 0, 0, -1], // 0
  [EDGE_N_W, EDGE_S_E, EDGE_N_W, -1, 0, 1, 2, EDGE_VER, EDGE_HOR, 0, 1, -1, 0], // 1

  [EDGE_S_E, EDGE_N_W, EDGE_S_E, 0, -1, 1, 2, EDGE_VER, EDGE_HOR, 0, -1, 1, 0], // 2
  [EDGE_S_E, EDGE_N_W, EDGE_S_E, -1, 0, 2, 1, EDGE_HOR, EDGE_VER, -1, 0, 0, 1], // 3

  [EDGE_S_W, EDGE_N_E, EDGE_S_W, 0, 1, 2, 1, EDGE_HOR, EDGE_VER, 1, 0, 0, 1], // 4
  [EDGE_S_W, EDGE_N_E, EDGE_S_W, -1, 0, 1, 2, EDGE_VER, EDGE_HOR, 0, -1, -1, 0], // 5

  [EDGE_N_E, EDGE_S_W, EDGE_N_E, 1, 0, 1, 2, EDGE_VER, EDGE_HOR, 0, 1, 1, 0], // 6
  [EDGE_N_E, EDGE_S_W, EDGE_N_E, 0, -1, 2, 1, EDGE_HOR, EDGE_VER, -1, 0, 0, -1], // 7
];

function straightenPath(path: number[], bends: Bend[], cells: CellMap): void {
  // Ported from Graph::Easy::_straighten_path.
  let i = 0;

  BEND: while (i < bends.length - 2) {
    const a = bends[i];
    const b = bends[i + 1];
    const c = bends[i + 2];

    const dx = b[1] - a[1];
    const dy = b[2] - a[2];

    for (const pattern of BEND_PATTERNS) {
      if (a[0] !== pattern[0] || b[0] !== pattern[1] || c[0] !== pattern[2] || dx !== pattern[3] || dy !== pattern[4]) {
        continue;
      }

      // pattern matched
      let cx = a[pattern[5]];
      let cy = c[pattern[6]];
      if (pattern[5] === 2) {
        // swap
        const tmp = cx;
        cx = cy;
        cy = tmp;
      }

      if (cells.has(`${cx},${cy}`)) continue BEND;

      // check from A to new corner
      let x = a[1];
      let y = a[2];

      const replace: number[] = [];
      if (x === cx && y === cy) {
        replace.push(cx, cy, pattern[0]);
      }

      let ddx = pattern[9];
      let ddy = pattern[10];
      while (x !== cx || y !== cy) {
        if (cells.has(`${x},${y}`)) continue BEND;
        replace.push(x, y, pattern[7]);
        x += ddx;
        y += ddy;
      }

      x = cx;
      y = cy;

      // check from new corner to C
      ddx = pattern[11];
      ddy = pattern[12];
      while (x !== c[1] || y !== c[2]) {
        if (cells.has(`${x},${y}`)) continue BEND;
        replace.push(x, y, pattern[8]);

        // set the correct type on the corner
        if (x === cx && y === cy) {
          replace[replace.length - 1] = pattern[0];
        }

        x += ddx;
        y += ddy;
      }

      // insert Corner
      replace.push(x, y, pattern[8]);

      // replace the inward bend with the new one
      const diff = a[3] - c[3] ? -3 : 3;

      let idx = 0;
      let pIdx = a[3] + diff;
      while (idx < replace.length) {
        const at = pIdx < 0 ? path.length + pIdx : pIdx;
        path[at] = replace[idx];
        path[at + 1] = replace[idx + 1];
        path[at + 2] = replace[idx + 2];
        pIdx += diff;
        idx += 3;
      }
    }

    i++;
  }
}

function astar(cells: CellMap, start: number[], stop: number[], edge: Edge, perField: number): number[] | undefined {
  // Ported from Graph::Easy::Layout::Scout::_astar.
  const open = new Heap<AstarHeapElem>();
  const openByPos = new Map<string, number>();
  const closed = new Map<string, AstarClosedEntry>();

  const [minX, minY, maxX, maxY] = astarBoundaries(cells);

  const runId = debugRunId();
  const startCount = Math.floor(start.length / 5);
  const stopCount = Math.floor(stop.length / perField);

  const maxTries = 2000000;
  let tries = 0;

  let seedConsidered = 0;
  let seedInserted = 0;
  let seedSkippedNonEdge = 0;
  let seedSkippedBadEdge = 0;

  // Put the start positions into OPEN.
  let i = 0;
  let bias = 0;
  while (i < start.length) {
    seedConsidered += 1;
    const sx = start[i];
    const sy = start[i + 1];
    const type = start[i + 2];
    const px = start[i + 3];
    const py = start[i + 4];
    i += 5;

    const xy = `${sx},${sy}`;
    const cell = cells.get(xy);
    if (cell && !(cell instanceof EdgeCell)) {
      seedSkippedNonEdge += 1;
      continue;
    }

    let t = 0;
    if (cell instanceof EdgeCell) {
      t = cell.type & EDGE_NO_M_MASK;
    }
    if (t !== 0 && t !== EDGE_HOR && t !== EDGE_VER) {
      seedSkippedBadEdge += 1;
      continue;
    }

    // For each start point, calculate the distance to each stop point, then use
    // the smallest as value.
    let lowest = astarDistance(sx, sy, stop[0], stop[1]);
    for (let u = perField; u < stop.length; u += perField) {
      const dist = astarDistance(sx, sy, stop[u], stop[u + 1]);
      if (dist < lowest) lowest = dist;
    }

    // add a penalty for crossings
    let malus = 0;
    if (t !== 0) malus = 30;
    malus += astarModifier(px, py, sx, sy, sx, sy);

    open.add([lowest, sx, sy, px, py, type, 1]);

    const o = malus + bias + lowest;
    openByPos.set(xy, o);

    bias += ASTAR_BIAS;
    seedInserted += 1;
  }

  if (seedInserted === 0) {
    debugLog({
      runId,
      hypothesisId: "h_seed_empty",
      location: "layout.ts:astar:seed",
      edgeId: edge.id,
      from: {
        id: edge.from.id,
        x: edge.from.x,
        y: edge.from.y,
        cx: edge.from.cx ?? 1,
        cy: edge.from.cy ?? 1,
      },
      to: {
        id: edge.to.id,
        x: edge.to.x,
        y: edge.to.y,
        cx: edge.to.cx ?? 1,
        cy: edge.to.cy ?? 1,
      },
      startCount,
      stopCount,
      seedConsidered,
      seedInserted,
      seedSkippedNonEdge,
      seedSkippedBadEdge,
      boundaries: { minX, minY, maxX, maxY },
      startPreview: start.slice(0, 15),
      stopPreview: stop.slice(0, perField * 3),
    });
    return undefined;
  }

  let elem: AstarHeapElem | undefined;
  let reachedStop = false;

  STEP: while ((elem = open.extractTop()) !== undefined) {
    if (tries++ > maxTries) {
      debugLog({
        runId,
        hypothesisId: "h_maxTries",
        location: "layout.ts:astar",
        edgeId: edge.id,
        from: {
          id: edge.from.id,
          x: edge.from.x,
          y: edge.from.y,
          cx: edge.from.cx ?? 1,
          cy: edge.from.cy ?? 1,
        },
        to: {
          id: edge.to.id,
          x: edge.to.x,
          y: edge.to.y,
          cx: edge.to.cx ?? 1,
          cy: edge.to.cy ?? 1,
        },
        startCount,
        stopCount,
        seedInserted,
        seedSkippedNonEdge,
        seedSkippedBadEdge,
        tries,
        maxTries,
        boundaries: { minX, minY, maxX, maxY },
        closedSize: closed.size,
      });
      return undefined;
    }

    const [val, x, y, px, py, type, doStop] = elem;
    const key = `${x},${y}`;

    // Move node into CLOSE and remove from OPEN.
    const g = openByPos.get(key) ?? 0;
    const entry: AstarClosedEntry = [px, py, val - g, g, type, doStop, undefined, undefined];
    closed.set(key, entry);
    openByPos.delete(key);

    // We are done when we hit one of the potential stop positions.
    for (let si = 0; si < stop.length; si += perField) {
      if (x === stop[si] && y === stop[si + 1]) {
        entry[4] = (entry[4] ?? 0) + stop[si + 2];
        reachedStop = true;
        break STEP;
      }
    }

    const next = astarNearNodes(x, y, cells, closed, minX, minY, maxX, maxY);
    for (let ni = 0; ni < next.length; ni += 2) {
      const nx = next[ni];
      const ny = next[ni + 1];

      let lg = g;
      if (px !== undefined && py !== undefined) {
        lg += astarModifier(px, py, x, y, nx, ny, cells);
      }

      const nKey = `${nx},${ny}`;
      if (openByPos.has(nKey)) continue;

      // Calculate distance to each possible stop position, and use the lowest one.
      let lowestDistance = astarDistance(nx, ny, stop[0], stop[1]);
      for (let si = perField; si < stop.length; si += perField) {
        const d = astarDistance(nx, ny, stop[si], stop[si + 1]);
        if (d < lowestDistance) lowestDistance = d;
      }

      open.add([lowestDistance + lg, nx, ny, x, y, undefined, undefined]);
      openByPos.set(nKey, lg);
    }
  }

  if (!reachedStop || !elem) {
    debugLog({
      runId,
      hypothesisId: "h_no_path",
      location: "layout.ts:astar",
      edgeId: edge.id,
      from: {
        id: edge.from.id,
        x: edge.from.x,
        y: edge.from.y,
        cx: edge.from.cx ?? 1,
        cy: edge.from.cy ?? 1,
      },
      to: {
        id: edge.to.id,
        x: edge.to.x,
        y: edge.to.y,
        cx: edge.to.cx ?? 1,
        cy: edge.to.cy ?? 1,
      },
      startCount,
      stopCount,
      seedInserted,
      seedSkippedNonEdge,
      seedSkippedBadEdge,
      tries,
      reachedStop,
      closedSize: closed.size,
      openSize: openByPos.size,
      boundaries: { minX, minY, maxX, maxY },
    });
    return undefined;
  }

  // A* is done, now build a path.
  const path: number[] = [];
  let cx = elem[1];
  let cy = elem[2];

  let lx: number | undefined;
  let ly: number | undefined;
  let labelCell = 0;

  const bends: Bend[] = [];
  let idx = 0;

  while (true) {
    const xy = `${cx},${cy}`;
    const info = closed.get(xy);
    if (!info) break;

    let type = info[4] ?? 0;
    let px = info[0];
    let py = info[1];

    const edgeType = type & EDGE_TYPE_MASK;
    if (edgeType === 0) {
      const edgeFlags = type & EDGE_FLAG_MASK;

      // either a start or a stop cell
      if (px === undefined || py === undefined) {
        // Figure it out from the flag and the position of cx,cy.
        px = cx;
        py = cy;
        if ((edgeFlags & EDGE_START_S) !== 0) py++;
        if ((edgeFlags & EDGE_START_N) !== 0) py--;
        if ((edgeFlags & EDGE_START_E) !== 0) px++;
        if ((edgeFlags & EDGE_START_W) !== 0) px--;
      }

      if (lx === undefined || ly === undefined) {
        // If lx,ly is undefined because px,py is a joint, get it via stored x,y.
        if (info[6] !== undefined && info[7] !== undefined) {
          lx = info[6];
          ly = info[7];
        }
      }

      if (lx === undefined || ly === undefined) {
        // If lx,ly is undefined because we are at the end of the path,
        // we can figure out from the flag and the position of cx,cy.
        lx = cx;
        ly = cy;
        if ((edgeFlags & EDGE_END_S) !== 0) ly++;
        if ((edgeFlags & EDGE_END_N) !== 0) ly--;
        if ((edgeFlags & EDGE_END_E) !== 0) lx++;
        if ((edgeFlags & EDGE_END_W) !== 0) lx--;
      }

      type += astarEdgeType(px, py, cx, cy, lx, ly);
    }

    if ((type & EDGE_TYPE_MASK) === 0) type = EDGE_HOR;

    const t = type & EDGE_TYPE_MASK;
    // Do not put the label on crossings.
    if (labelCell === 0 && !cells.has(xy) && (t === EDGE_HOR || t === EDGE_VER)) {
      labelCell++;
      type += EDGE_LABEL_CELL;
    }

    if (type === EDGE_S_E || t === EDGE_S_W || t === EDGE_N_E || t === EDGE_N_W) {
      bends.push([type, cx, cy, -idx]);
    }

    path.unshift(cx, cy, type);

    if (info[5]) break; // stop here?

    lx = cx;
    ly = cy;
    cx = info[0] as number;
    cy = info[1] as number;
    idx += 3;
  }

  if (bends.length >= 3) {
    straightenPath(path, bends, cells);
  }

  return path;
}

function findPathAstar(cells: CellMap, edge: Edge): number[] | undefined {
  // Ported from Graph::Easy::Layout::Scout::_find_path_astar (minimal: no shared-edge joints yet).
  const src = edge.from;
  const dst = edge.to;

  if (src.x === undefined || src.y === undefined || dst.x === undefined || dst.y === undefined) {
    throw new Error(`Edge ${edge.id} connects unplaced nodes`);
  }

  let startFlags = [EDGE_START_W, EDGE_START_N, EDGE_START_E, EDGE_START_S];
  let endFlags = [EDGE_END_W, EDGE_END_N, EDGE_END_E, EDGE_END_S];

  // If the target/source node is of shape "edge", remove the endpoint.
  if (edge.to.attribute("shape") === "edge") {
    endFlags = [0, 0, 0, 0];
  }
  if (edge.from.attribute("shape") === "edge") {
    startFlags = [0, 0, 0, 0];
  }

  const [sPortSide, sPortPos] = edge.port("start");
  const [ePortSide, ePortPos] = edge.port("end");

  // potential stop positions
  let B = dst.nearPlaces(cells, 1, endFlags, true, undefined);
  if (ePortSide !== undefined) {
    B = dst.allowedPlaces(B, dst.allow(ePortSide, ePortPos), 3);
  }
  if (B.length === 0) {
    debugLog({
      runId: debugRunId(),
      hypothesisId: "h_stop_empty",
      location: "layout.ts:findPathAstar",
      edgeId: edge.id,
      from: { id: src.id, x: src.x, y: src.y, cx: src.cx ?? 1, cy: src.cy ?? 1 },
      to: { id: dst.id, x: dst.x, y: dst.y, cx: dst.cx ?? 1, cy: dst.cy ?? 1 },
    });
    return undefined;
  }

  // start positions
  const s = edge.bidirectional ? endFlags : startFlags;
  let start = src.nearPlaces(cells, 1, s, true, src.shift(-90));
  if (sPortSide !== undefined) {
    start = src.allowedPlaces(start, src.allow(sPortSide, sPortPos), 3);
  }
  if (start.length === 0) {
    debugLog({
      runId: debugRunId(),
      hypothesisId: "h_start_empty",
      location: "layout.ts:findPathAstar",
      edgeId: edge.id,
      from: { id: src.id, x: src.x, y: src.y, cx: src.cx ?? 1, cy: src.cy ?? 1 },
      to: { id: dst.id, x: dst.x, y: dst.y, cx: dst.cx ?? 1, cy: dst.cy ?? 1 },
    });
    return undefined;
  }

  const A: number[] = [];
  for (let i = 0; i < start.length; i += 3) {
    const sx = start[i];
    const sy = start[i + 1];
    const type = start[i + 2];

    // compute the field inside the node from where sx,sy is reached
    let px = sx;
    let py = sy;

    const srcY = src.y;
    const srcX = src.x;
    const srcCx = src.cx ?? 1;
    const srcCy = src.cy ?? 1;

    if (sy < srcY || sy >= srcY + srcCy) {
      if (sy < srcY) py = sy + 1;
      if (sy > srcY) py = sy - 1;
    } else {
      if (sx < srcX) px = sx + 1;
      if (sx > srcX) px = sx - 1;
    }

    A.push(sx, sy, type, px, py);
  }

  return astar(cells, A, B, edge, 3);
}

function findPath(graph: Graph, cells: CellMap, edge: Edge): number[] | undefined {
  const src = edge.from;
  const dst = edge.to;

  if (src === dst) {
    throw new Error(`Self-loop routing is not implemented yet (edge ${edge.id})`);
  }

  // If one of the two nodes is bigger than 1 cell, or if the edge has ports, use A*
  // because it automatically handles all the possibilities.
  if ((src.cx ?? 1) !== 1 || (src.cy ?? 1) !== 1 || (dst.cx ?? 1) !== 1 || (dst.cy ?? 1) !== 1 || edge.hasPorts()) {
    return findPathAstar(cells, edge);
  }

  if (src.x === undefined || src.y === undefined || dst.x === undefined || dst.y === undefined) {
    throw new Error(`Edge ${edge.id} connects unplaced nodes`);
  }

  const x0 = src.x;
  const y0 = src.y;
  const x1 = dst.x;
  const y1 = dst.y;

  const dx = directionSign(x1 - x0);
  const dy = directionSign(y1 - y0);

  if (dx === 0 || dy === 0) {
    // Try straight path to target.
    const short = findShortPath(cells, edge, dx, dy);
    if (short) return short;

    const type = dx === 0 ? EDGE_VER : EDGE_HOR;
    let done = false;
    let labelDone = 0;

    const coords: number[] = [];
    let x = x0 + dx;
    let y = y0 + dy;

    while (true) {
      // Since we do not handle crossings here, A* will be tried if we hit an edge.
      if (cells.has(`${x},${y}`)) {
        done = true;
        break;
      }

      // The first cell gets the label.
      let t = type;
      if (labelDone++ === 0) t += EDGE_LABEL_CELL;
      coords.push(x, y, t);

      x += dx;
      y += dy;

      if (x === x1 && y === y1) break;
    }

    if (!done) {
      applyEndPoints(edge, coords, dx, dy);
      return coords;
    }
  } else {
    // Try paths with one bend.

    // try first "--+" (aka hor => ver)
    let done = 0;
    let coords: number[] = [];

    let x = x0;
    let y = y0;

    let type = EDGE_HOR;

    // attach label?
    let label = 0;
    if (edge.label === "") label = 1; // no label?

    x += dx;
    while (x !== x1) {
      if (cells.has(`${x},${y}`)) {
        done++;
        break;
      }

      let t = type;
      if (label++ === 0) t += EDGE_LABEL_CELL;
      coords.push(x, y, t);
      x += dx;
    }

    // check the bend itself
    if (done === 0 && cells.has(`${x},${y}`)) done++;

    if (done === 0) {
      const typeBend = astarEdgeType(x - dx, y, x, y, x, y + dy);
      coords.push(x, y, typeBend);

      y += dy;
      type = EDGE_VER;
      while (y !== y1) {
        if (cells.has(`${x},${y}`)) {
          done++;
          break;
        }
        coords.push(x, y, type);
        y += dy;
      }
    }

    if (done === 0) {
      applyEndPoints(edge, coords, dx, dy);
      return coords;
    }

    // try "+---" (aka ver => hor)
    done = 0;
    coords = [];

    x = x0;
    y = y0 + dy;
    type = EDGE_VER;

    while (y !== y1) {
      if (cells.has(`${x},${y}`)) {
        done++;
        break;
      }
      coords.push(x, y, type);
      y += dy;
    }

    // check the bend itself
    if (done === 0 && cells.has(`${x},${y}`)) done++;

    if (done === 0) {
      const typeBend = astarEdgeType(x, y - dy, x, y, x + dx, y);
      coords.push(x, y, typeBend);

      x += dx;
      // attach label?
      label = 0;
      if (edge.label === "") label = 1; // no label?

      type = EDGE_HOR;
      while (x !== x1) {
        if (cells.has(`${x},${y}`)) {
          done++;
          break;
        }
        let t = type;
        if (label++ === 0) t += EDGE_LABEL_CELL;
        coords.push(x, y, t);
        x += dx;
      }
    }

    if (done === 0) {
      applyEndPoints(edge, coords, dx, dy);
      return coords;
    }
  }

  const fallback = findPathAstar(cells, edge);
  if (fallback !== undefined) return fallback;

  throw new Error(`Unable to find path (including A*) for edge ${edge.id} (${edge.from.id} -> ${edge.to.id})`);
}

function createCell(cells: CellMap, edge: Edge, x: number, y: number, type: number): void {
  const xy = `${x},${y}`;
  const existing = cells.get(xy);

  if (existing instanceof EdgeCell) {
    existing.makeCross(edge, type & EDGE_FLAG_MASK);
    // Insert a EDGE_HOLE into the cells of the edge (but not into the list of
    // to-be-rendered cells). This cell will be removed by the optimizer later on.
    new EdgeCell(edge, x, y, EDGE_HOLE);
    return;
  }

  if (existing) {
    throw new Error(`Cannot place edge cell at occupied ${x},${y}`);
  }

  const cell = new EdgeCell(edge, x, y, type);
  cells.set(xy, cell);
}

function tracePath(graph: Graph, cells: CellMap, edge: Edge): void {
  if (edge.from.x === undefined || edge.from.y === undefined || edge.to.x === undefined || edge.to.y === undefined) {
    throw new Error(`Edge ${edge.id} connects unplaced nodes`);
  }

  const coords = findPath(graph, cells, edge);
  if (!coords) {
    throw new Error(
      `Unable to find path from ${edge.from.id} (${edge.from.x},${edge.from.y}) to ${edge.to.id} (${edge.to.x},${edge.to.y})`
    );
  }

  // path is empty, happens for sharing edges with only a joint
  if (coords.length === 0) return;

  for (let i = 0; i < coords.length; i += 3) {
    const x = coords[i];
    const y = coords[i + 1];
    const type = coords[i + 2];
    createCell(cells, edge, x, y, type);
  }
}

export function layoutGraph(graph: Graph): CellMap {
  // Drop caches / previous placement.
  for (const n of graph.nodes()) {
    n.cache = Object.create(null);
    n.x = undefined;
    n.y = undefined;
    n.w = undefined;
    n.h = undefined;
    n.todo = true;

    n.chain = undefined;
    n.chainNext = undefined;
  }

  for (const e of graph.edges) {
    e.clearCells();
    e.todo = true;
  }

  const rootName = parseGraphRootName(graph);
  const root = rootName ? graph.node(rootName) : undefined;

  for (const n of graph.nodes()) {
    n.grow();
  }

  assignRanks(graph, root);

  const { root: chainRoot, chains } = findChains(graph);

  const todo: LayoutAction[] = [];
  if (chainRoot) {
    todo.push(graph._layoutAction(ACTION_NODE, chainRoot, 0));
  }

  // Layout chains.
  const chainList = [...chains.values()].sort((a, b) => {
    const aRoot = chainRoot && a.start === chainRoot ? 1 : 0;
    const bRoot = chainRoot && b.start === chainRoot ? 1 : 0;

    return bRoot - aRoot || b.len - a.len || a.start.id.localeCompare(b.start.id);
  });

  for (const c of chainList) {
    todo.push(...c.layout());
  }

  // Leftover nodes + edges.
  const nodes = [...graph.nodes()].sort((a, b) => a.id.localeCompare(b.id));
  for (const n of nodes) {
    todo.push(graph._layoutAction(ACTION_NODE, n, 0));

    const edges = n
      .edges()
      .slice()
      .sort((a, b) => a.to.id.localeCompare(b.to.id) || a.id - b.id);

    for (const e of edges) {
      if (!e.todo) continue;
      todo.push([ACTION_TRACE, e]);
      e.todo = false;
    }
  }

  // Execute action stack (simplified: no backtracking yet).
  const cells: CellMap = new Map();
  const rankPos = new Map<number, number>();

  const flow = graph.flow();

  for (const a of todo) {
    const at = a[0];

    if (at === ACTION_NODE) {
      const [, node] = a as unknown as [number, Node, number, Edge?];
      if (node.x === undefined || node.y === undefined) {
        placeNode(graph, cells, rankPos, flow, node);
      }
      continue;
    }

    if (at === ACTION_CHAIN) {
      const [, node] = a as unknown as [number, Node, number, Node, Edge];
      if (node.x === undefined || node.y === undefined) {
        placeNode(graph, cells, rankPos, flow, node);
      }
      continue;
    }

    if (at === ACTION_TRACE) {
      const [, edge] = a as unknown as [number, Edge];

      if (edge.from.x === undefined || edge.from.y === undefined) {
        placeNode(graph, cells, rankPos, flow, edge.from);
      }
      if (edge.to.x === undefined || edge.to.y === undefined) {
        placeNode(graph, cells, rankPos, flow, edge.to);
      }

      tracePath(graph, cells, edge);
      continue;
    }

    throw new Error(`Illegal action ${String(at)} on layout stack`);
  }

  return fillGroupCells(graph, cells);
}
