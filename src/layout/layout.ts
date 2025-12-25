import { appendFileSync } from "node:fs";

import { EdgeCell } from "./edgeCell";
import { EdgeCellEmpty } from "./edgeCellEmpty";
import { GroupCell } from "./groupCell";
import { NodeCell } from "./nodeCell";
import { fillGroupCells } from "./repair";
import {
  EDGE_CROSS,
  EDGE_END_MASK,
  EDGE_END_E,
  EDGE_END_N,
  EDGE_END_S,
  EDGE_END_W,
  EDGE_FLAG_MASK,
  EDGE_HOLE,
  EDGE_HOR,
  EDGE_LABEL_CELL,
  EDGE_MISC_MASK,
  EDGE_LOOP_EAST,
  EDGE_LOOP_NORTH,
  EDGE_LOOP_SOUTH,
  EDGE_LOOP_WEST,
  EDGE_N_E,
  EDGE_N_W,
  EDGE_N_E_W,
  EDGE_S_E_W,
  EDGE_E_N_S,
  EDGE_W_N_S,
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
import { ACTION_CHAIN, ACTION_NODE, ACTION_SPLICE, ACTION_TRACE } from "./actionTypes";

import type { Edge } from "../edge";
import type { Graph } from "../graph";
import { Node, type FlowDirection } from "../node";

type CellMap = Map<string, Node | EdgeCell | NodeCell | GroupCell | EdgeCellEmpty>;

function cmpStr(a: string, b: string): number {
  // Perl's sort/cmp is bytewise; use codepoint ordering (not localeCompare)
  // so uppercase/lowercase ordering matches the canonical fixtures.
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

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

  // Perl Layout.pm iterates nodes via ord_values($self->{nodes}), which is keyed
  // by the internal numeric node id (not the node name). Match that ordering.
  const nodes = [...graph.nodes()].sort((a, b) => cmpStr(String(a.numericId), String(b.numericId)));

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
  node: Node,
  branchGuard: Set<Node>
): number {
  const chain = new LayoutChain(nextChainId.value++, node, graph);
  chains.set(chain.id, chain);

  let done = 1;

  // Perl uses `local $node->{_c} = 1` to prevent following edges back into the
  // currently-tracked branch (including across recursion). Model this with a
  // Set that is shared across recursive followChain() calls.
  const locallyMarked: Node[] = [];
  const markInBranch = (n: Node): void => {
    if (branchGuard.has(n)) return;
    branchGuard.add(n);
    locallyMarked.push(n);
  };

  let curr: Node = node;

  while (true) {
    markInBranch(curr);

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

      // If any outgoing edge has an explicit flow, stop the chain here and only
      // consider this one successor (Perl Layout.pm:_follow_chain).
      if (e.edgeFlow() !== undefined) {
        suc.clear();
        suc.set(to.id, to);
        break;
      }

      // Backloop into current branch?
      if (branchGuard.has(to)) continue;

      // Ignore backloops into the same chain.
      if (to.chain && to.chain === chain) continue;

      // If the next node's grandparent is the same as ours, it depends on us.
      // (This matters for autosplit/child nodes.)
      if (to.findGrandparent() === curr.findGrandparent()) continue;

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

    // Perl iterates successors via ord_values(%suc) (sorted by key). This order
    // affects tie-breaking when multiple successor chains have the same length.
    const successors = [...suc.entries()]
      .sort(([a], [b]) => cmpStr(a, b))
      .map(([, s]) => s);

    for (const s of successors) {
      if (!s.chain) {
        done += followChain(graph, chains, nextChainId, root, s, branchGuard);
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

  for (const n of locallyMarked) branchGuard.delete(n);
  return done;
}

function findChains(graph: Graph): { root: Node | undefined; chains: Map<number, LayoutChain> } {
  // Drop old chain info.
  for (const n of graph.nodes()) {
    n.chain = undefined;
    n.chainNext = undefined;
  }

  // Match Perl Layout.pm node ordering (internal numeric id, not name).
  const nodes = [...graph.nodes()].sort((a, b) => cmpStr(String(a.numericId), String(b.numericId)));

  const rootName = parseGraphRootName(graph);

  const p: Array<{ name: string; hasPredecessors: number; hasOrigin: number; absRank: number }> = [];
  for (const n of nodes) {
    p.push({
      name: n.id,
      hasPredecessors: n.hasPredecessors(),
      hasOrigin: n.origin && n.origin !== n ? 1 : 0,
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
        cmpStr(a.name, b.name)
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
      done += followChain(graph, chains, nextChainId, root, n, new Set<Node>());
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

function tryPlaceNodeAt(
  cells: CellMap,
  node: Node,
  x0: number,
  y0: number,
  rankPos?: Map<number, number>,
  flow?: FlowDirection
): boolean {
  const placeSingleNodeAt = (n: Node, px: number, py: number): boolean => {
    const nCx = n.cx ?? 1;
    const nCy = n.cy ?? 1;

    for (let dx = 0; dx < nCx; dx++) {
      for (let dy = 0; dy < nCy; dy++) {
        if (cells.has(`${px + dx},${py + dy}`)) return false;
      }
    }

    n.x = px;
    n.y = py;

    // Mark occupied rectangle. Store the node itself at the anchor, and use
    // placeholder NodeCell entries for the remaining occupied cells.
    cells.set(`${px},${py}`, n);
    for (let dx = 0; dx < nCx; dx++) {
      for (let dy = 0; dy < nCy; dy++) {
        if (dx === 0 && dy === 0) continue;
        cells.set(`${px + dx},${py + dy}`, new NodeCell(n, px + dx, py + dy));
      }
    }

    // Store the first placed node's coordinate for this abs(rank).
    // Ported from Graph::Easy::Node::_place.
    if (rankPos && flow !== undefined) {
      const r = Math.abs(n.rank ?? 0);
      const what = rankCoordForFlow(flow);
      if (!rankPos.has(r)) {
        rankPos.set(r, what === "x" ? px : py);
      }
    }

    return true;
  };

  // Relative-placement clusters: placing any node with an origin (or any node that
  // has children) places the entire origin-chain subtree.
  // Ported from Graph::Easy::Node::_do_place / _place_children.
  if ((node.origin && node.origin !== node) || node.children.size > 0) {
    const [grandpa, ox, oy] = node.findGrandparentWithOffset();
    const gx = x0 + ox;
    const gy = y0 + oy;

    const planned: Array<[Node, number, number]> = [];
    const seen = new Set<Node>();

    const plan = (n: Node, px: number, py: number): void => {
      if (seen.has(n)) {
        throw new Error(`Detected loop in children graph starting at '${grandpa.id}'`);
      }
      seen.add(n);
      planned.push([n, px, py]);

      const children = [...n.children.values()].sort((a, b) => cmpStr(a.id, b.id));
      for (const child of children) {
        // Compute place of children (depending on whether we are multicelled or not)
        // like Graph::Easy::Node::_place_children.
        const baseDx = child.dx > 0 ? (n.cx ?? 1) - 1 : 0;
        const baseDy = child.dy > 0 ? (n.cy ?? 1) - 1 : 0;
        plan(child, px + baseDx + child.dx, py + baseDy + child.dy);
      }
    };

    plan(grandpa, gx, gy);

    // If any node in the cluster is already placed, it must match the planned placement.
    for (const [n, px, py] of planned) {
      if (n.x !== undefined || n.y !== undefined) {
        if (n.x !== px || n.y !== py) return false;
      }
    }

    // Check that all required cells are either empty, or already occupied by this cluster.
    const clusterNodes = new Set<Node>(planned.map(([n]) => n));
    const occupied = new Set<string>();
    for (const [n, px, py] of planned) {
      const nCx = n.cx ?? 1;
      const nCy = n.cy ?? 1;

      for (let dx = 0; dx < nCx; dx++) {
        for (let dy = 0; dy < nCy; dy++) {
          const key = `${px + dx},${py + dy}`;
          if (occupied.has(key)) return false;
          occupied.add(key);

          const existing = cells.get(key);
          if (!existing) continue;

          if (existing instanceof Node) {
            if (!clusterNodes.has(existing)) return false;
            continue;
          }
          if (existing instanceof NodeCell) {
            if (!clusterNodes.has(existing.node)) return false;
            continue;
          }

          // EdgeCell / GroupCell occupy the space.
          return false;
        }
      }
    }

    // Place all currently-unplaced nodes in the cluster.
    for (const [n, px, py] of planned) {
      if (n.x !== undefined && n.y !== undefined) continue;
      if (!placeSingleNodeAt(n, px, py)) return false;
    }

    return true;
  }

  return placeSingleNodeAt(node, x0, y0);
}

function clearTries(node: Node, cells: CellMap, tries: number[]): number[] {
  // Ported from Graph::Easy::Layout::Path::_clear_tries.
  // Remove placements that are immediately adjacent to any other node.
  const out: number[] = [];

  const origX = node.x;
  const origY = node.y;

  for (let src = 0; src < tries.length; src += 2) {
    const x = tries[src];
    const y = tries[src + 1];

    node.x = x;
    node.y = y;

    const near = node.nearPlaces(cells, 1, undefined, true, undefined);

    // Also avoid placing nodes corner-to-corner.
    const cx = node.cx ?? 1;
    const cy = node.cy ?? 1;
    near.push(x - 1, y - 1);
    near.push(x - 1, y + cy);
    near.push(x + cx, y + cy);
    near.push(x + cx, y - 1);

    let blocked = false;
    for (let j = 0; j < near.length; j += 2) {
      const nx = near[j];
      const ny = near[j + 1];
      const cell = cells.get(`${nx},${ny}`);
      // Perl's _clear_tries blocks placements that are adjacent to any
      // Graph::Easy::Node. In Perl, edges and edge cells inherit from Node,
      // so edge cells also block adjacency. Mirror that behavior here.
      if (
        cell instanceof Node ||
        cell instanceof NodeCell ||
        cell instanceof EdgeCell ||
        cell instanceof GroupCell ||
        cell instanceof EdgeCellEmpty
      ) {
        blocked = true;
        break;
      }
    }

    if (!blocked) {
      out.push(x, y);
    }
  }

  node.x = origX;
  node.y = origY;

  return out;
}

function unplaceEdge(cells: CellMap, edge: Edge): void {
  // Ported from Graph::Easy::Edge::_unplace.
  for (const c of edge.cells) {
    cells.delete(`${c.x},${c.y}`);
  }
  edge.clearCells();
}

function unplaceNode(cells: CellMap, node: Node): void {
  // Ported from Graph::Easy::Node::_unplace.
  // Relative-placement clusters must be unplaced as a unit; this also cleans up
  // partial placements from failed cluster placement attempts.
  if ((node.origin && node.origin !== node) || node.children.size > 0) {
    const root = node.findGrandparent();
    const seen = new Set<Node>();

    const unplaceRec = (n: Node): void => {
      if (seen.has(n)) return;
      seen.add(n);

      const children = [...n.children.values()].sort((a, b) => cmpStr(a.id, b.id));
      for (const child of children) {
        unplaceRec(child);
      }

      if (n.x !== undefined && n.y !== undefined) {
        const x0 = n.x;
        const y0 = n.y;
        const cx = n.cx ?? 1;
        const cy = n.cy ?? 1;

        for (let dx = 0; dx < cx; dx++) {
          for (let dy = 0; dy < cy; dy++) {
            cells.delete(`${x0 + dx},${y0 + dy}`);
          }
        }

        n.x = undefined;
        n.y = undefined;
      }

      n.cache = Object.create(null);
      for (const e of n.edges()) {
        unplaceEdge(cells, e);
      }
    };

    unplaceRec(root);
    return;
  }

  if (node.x === undefined || node.y === undefined) return;

  const x0 = node.x;
  const y0 = node.y;
  const cx = node.cx ?? 1;
  const cy = node.cy ?? 1;

  for (let dx = 0; dx < cx; dx++) {
    for (let dy = 0; dy < cy; dy++) {
      cells.delete(`${x0 + dx},${y0 + dy}`);
    }
  }

  node.x = undefined;
  node.y = undefined;
  node.cache = Object.create(null);

  for (const e of node.edges()) {
    unplaceEdge(cells, e);
  }
}

function findNodePlace(
  graph: Graph,
  cells: CellMap,
  rankPos: Map<number, number>,
  flow: FlowDirection,
  node: Node,
  tryIndex: number,
  parent: Node | undefined,
  edge: Edge | undefined
): void {
  // Ported from Graph::Easy::Layout::Path::_find_node_place (Graph-Easy 0.76).
  if (node.x !== undefined && node.y !== undefined) return;

  // Relative-placement nodes (origin/offset): if the origin-chain isn't placed yet,
  // we sometimes need to place the grandparent first to avoid shifting the whole
  // cluster (e.g. Wide/B/C in 6_multicell_offset). However, autosplit record parts
  // can have edges to nodes outside the origin-cluster; in that case, the part's
  // placement may legitimately anchor the cluster.
  if (node.origin && node.origin !== node) {
    const org = node.origin;
    const grandpa = node.findGrandparent();

    const hasExternalEdge = node.edges().some((e) => {
      return e.from.findGrandparent() !== grandpa || e.to.findGrandparent() !== grandpa;
    });

    if (!hasExternalEdge && (org.x === undefined || org.y === undefined)) {
      if (grandpa !== node && (grandpa.x === undefined || grandpa.y === undefined)) {
        findNodePlace(graph, cells, rankPos, flow, grandpa, tryIndex, parent, edge);
        if (node.x !== undefined && node.y !== undefined) return;
      }
    }
  }

  // Relative placement (Graph::Easy::Node->relative_to).
  // If the node has an origin, try to place it at origin + (dx,dy).
  if (node.origin && node.origin !== node) {
    const org = node.origin;

    if (org.x !== undefined && org.y !== undefined) {
      // Compute place of child (depending on whether origin is multicelled) like
      // Graph::Easy::Node::_place_children.
      const baseDx = node.dx > 0 ? (org.cx ?? 1) - 1 : 0;
      const baseDy = node.dy > 0 ? (org.cy ?? 1) - 1 : 0;
      const rx = org.x + baseDx + node.dx;
      const ry = org.y + baseDy + node.dy;
      if (tryPlaceNodeAt(cells, node, rx, ry, rankPos, flow)) return;
    }
  }

  const tryOffset = tryIndex ?? 0;

  // If the node has a user-set rank, see if we already placed another node in that row/column.
  // Ported from Graph::Easy::Layout::Path::_find_node_place.
  if ((node.rank ?? -1) >= 0) {
    const r = Math.abs(node.rank ?? 0);
    const c = rankCoordForFlow(flow);
    const base = rankPos.get(r);

    if (base !== undefined) {
      let x = 0;
      let y = 0;
      if (c === "x") x = base;
      else y = base;

      while (true) {
        if (tryPlaceNodeAt(cells, node, x, y, rankPos, flow)) return;
        if (c === "x") x += 2;
        else y += 2;
      }
    }
  }

  // If the node has outgoing edges (which might be shared), try to place it further away
  // to make space for joints. Ported from Graph::Easy::Layout::Path::_find_node_place.
  let placeEdge: Edge | undefined = edge;
  if (!placeEdge) {
    const all = [...node.edges()].sort((a, b) => cmpStr(String(a.id), String(b.id)));
    if (all.length > 0) placeEdge = all[0];
  }

  let minDist = 2;
  if (edge) {
    const raw = edge.attribute("minlen").trim();
    let minlen = raw === "" ? 1 : Number(raw);
    if (!Number.isFinite(minlen)) {
      throw new Error(`Invalid edge minlen: ${edge.attribute("minlen")}`);
    }
    minlen = Math.abs(minlen);
    if (minlen < 1) minlen = 1;
    minDist = minlen + 1;
  }

  if (placeEdge && node.edges().length > 0) {
    const flowShift = (d: FlowDirection): [number, number] => {
      // Ported from Graph::Easy::Layout::Path.pm ($flow_shift): shift to the
      // right side of the flow.
      if (d === 270) return [0, -1];
      if (d === 90) return [0, 1];
      if (d === 0) return [1, 0];
      if (d === 180) return [-1, 0];
      return [0, 1];
    };

    const placedShared = (shared: Node[]): [number, number] | undefined => {
      for (const n of shared) {
        if (n.x !== undefined && n.y !== undefined) return [n.x, n.y];
      }
      return undefined;
    };

    const nodesSharingStart = (from: Node, side: string, port: number): Node[] => {
      const nodes = new Map<string, Node>();
      for (const e of edgesAtPort(from, "start", side, port)) {
        const to = e.to;
        if (to === from) continue; // ignore self-loops
        nodes.set(to.id, to);
      }
      return [...nodes.entries()]
        .sort((a, b) => cmpStr(a[0], b[0]))
        .map(([, n]) => n);
    };

    const nodesSharingEnd = (to: Node, side: string, port: number): Node[] => {
      const nodes = new Map<string, Node>();
      for (const e of edgesAtPort(to, "end", side, port)) {
        const from = e.from;
        if (from === to) continue; // ignore self-loops
        nodes.set(from.id, from);
      }
      return [...nodes.entries()]
        .sort((a, b) => cmpStr(a[0], b[0]))
        .map(([, n]) => n);
    };

    const bumpMinDistForShared = (): void => {
      if (minDist < 3) minDist = 3;
      if (placeEdge.labelText() !== "") minDist += 1;
    };

    const tryPlaceFromShared = (base: [number, number]): void => {
      const [bx, by] = base;
      const [mx, my] = flowShift(node.flow());

      // Ported from Graph::Easy::Layout::Path.pm: start at ofs=2 and let
      // clearTries()/tryPlaceNodeAt() decide whether the spot is acceptable.
      let ofs = 2;

      for (; ; ofs += 2) {
        const x = bx + mx * ofs;
        const y = by + my * ofs;
        if (clearTries(node, cells, [x, y]).length === 0) continue;
        if (tryPlaceNodeAt(cells, node, x, y, rankPos, flow)) return;
      }
    };

    // Shared start point?
    const [sSide, sPort] = placeEdge.port("start");
    if (sSide !== undefined && sPort !== undefined) {
      const shared = nodesSharingStart(placeEdge.from, sSide, sPort);
      if (shared.length > 1) {
        bumpMinDistForShared();
        const placed = placedShared(shared);
        if (placed) {
          tryPlaceFromShared(placed);
          return;
        }
      }
    }

    // Shared end point?
    const [eSide, ePort] = placeEdge.port("end");
    if (eSide !== undefined && ePort !== undefined) {
      const shared = nodesSharingEnd(placeEdge.to, eSide, ePort);
      if (shared.length > 1) {
        bumpMinDistForShared();
        const placed = placedShared(shared);
        if (placed && shared.some((n) => n === node)) {
          tryPlaceFromShared(placed);
          return;
        }
      }
    }
  }

  const dir = placeEdge ? placeEdge.flow() : undefined;

  // Chained placement: place near parent first.
  if (parent && parent.x !== undefined && parent.y !== undefined) {
    const debugChain = node.id === "U" && parent.id === "B";

    const describeCell = (cell: unknown): Record<string, unknown> | null => {
      if (!cell) return null;
      if (cell instanceof Node) {
        return { kind: "Node", id: cell.id, x: cell.x, y: cell.y, cx: cell.cx ?? 1, cy: cell.cy ?? 1 };
      }
      if (cell instanceof NodeCell) return { kind: "NodeCell", nodeId: cell.node.id };
      if (cell instanceof EdgeCell) return { kind: "EdgeCell", edgeId: cell.edge?.id, type: cell.type };
      if (cell instanceof GroupCell) return { kind: "GroupCell", name: cell.group.name };
      if (cell instanceof EdgeCellEmpty) return { kind: "EdgeCellEmpty" };
      return { kind: typeof cell };
    };

    let tries: number[];
    if (debugChain) {
      const all = parent.nearPlaces(cells, minDist, undefined, true, dir);
      tries = parent.nearPlaces(cells, minDist, undefined, false, dir);

      const filteredKeys = new Set<string>();
      for (let i = 0; i < tries.length; i += 2) {
        filteredKeys.add(`${tries[i]},${tries[i + 1]}`);
      }

      const omitted: Array<Record<string, unknown>> = [];
      for (let i = 0; i < all.length; i += 2) {
        const x = all[i];
        const y = all[i + 1];
        const key = `${x},${y}`;
        if (filteredKeys.has(key)) continue;
        omitted.push({ x, y, cell: describeCell(cells.get(key)) });
      }

      debugLog({
        runId: debugRunId(),
        hypothesisId: "h_chain_near_places",
        location: "layout.ts:findNodePlace",
        node: { id: node.id },
        parent: { id: parent.id, x: parent.x, y: parent.y, cx: parent.cx ?? 1, cy: parent.cy ?? 1 },
        edgeId: placeEdge?.id,
        tryIndex,
        minDist,
        dir,
        all,
        tries,
        omitted,
      });
    } else {
      tries = parent.nearPlaces(cells, minDist, undefined, false, dir);
    }

    const beforeClear = tries;
    tries = clearTries(node, cells, tries);

    if (debugChain) {
      debugLog({
        runId: debugRunId(),
        hypothesisId: "h_chain_clear_tries",
        location: "layout.ts:findNodePlace",
        nodeId: node.id,
        parentId: parent.id,
        tryIndex,
        minDist,
        dir,
        before: beforeClear,
        after: tries,
      });
    }

    if (tryOffset > 0) tries = tries.slice(tryOffset);

    for (let i = 0; i < tries.length; i += 2) {
      const x = tries[i];
      const y = tries[i + 1];

      if (debugChain) {
        debugLog({
          runId: debugRunId(),
          hypothesisId: "h_chain_try",
          location: "layout.ts:findNodePlace",
          nodeId: node.id,
          parentId: parent.id,
          edgeId: placeEdge?.id,
          tryIndex,
          minDist,
          dir,
          x,
          y,
          cell: describeCell(cells.get(`${x},${y}`)),
        });
      }

      if (tryPlaceNodeAt(cells, node, x, y, rankPos, flow)) {
        if (debugChain) {
          debugLog({
            runId: debugRunId(),
            hypothesisId: "h_chain_place_success",
            location: "layout.ts:findNodePlace",
            nodeId: node.id,
            parentId: parent.id,
            edgeId: placeEdge?.id,
            tryIndex,
            minDist,
            dir,
            x,
            y,
          });
        }
        return;
      }
    }
  }

  // First node: try 0,0.
  if (tryOffset === 0) {
    if (tryPlaceNodeAt(cells, node, 0, 0, rankPos, flow)) return;
  }

  let tries: number[] = [];

  // Placed predecessors.
  const preAll = node.predecessors();
  let pre = preAll.filter((p) => p.x !== undefined && p.y !== undefined);
  pre = pre.sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0));

  if (pre.length > 0 && pre.length <= 2) {
    if (pre.length === 1) {
      tries.push(...pre[0].nearPlaces(cells, minDist, undefined, false, undefined));
      tries.push(...pre[0].nearPlaces(cells, minDist + 2, undefined, false, undefined));
    } else {
      const dx = (pre[0].x as number) - (pre[1].x as number);
      const dy = (pre[0].y as number) - (pre[1].y as number);

      if (dx !== 0 && dy !== 0) {
        // Crossing point.
        tries.push(pre[0].x as number, pre[1].y as number);
        // (Intentional parity with Perl: swapped x/y)
        tries.push(pre[0].y as number, pre[1].x as number);
      } else {
        // Middle point.
        if (dx === 0) {
          tries.push(pre[1].x as number, (pre[1].y as number) + Math.trunc(dy / 2));
        } else {
          tries.push((pre[1].x as number) + Math.trunc(dx / 2), pre[1].y as number);
        }
      }

      for (const n of pre) {
        tries.push(...n.nearPlaces(cells, minDist, undefined, false, undefined));
      }
    }
  }

  // Placed successors.
  const sucAll = node.successors();
  const suc = sucAll.filter((s) => s.x !== undefined && s.y !== undefined);
  for (const s of suc) {
    tries.push(...s.nearPlaces(cells, minDist, undefined, false, undefined));
    tries.push(...s.nearPlaces(cells, minDist + 2, undefined, false, undefined));
  }

  tries = clearTries(node, cells, tries);
  if (tryOffset > 0) tries = tries.slice(tryOffset);
  for (let i = 0; i < tries.length; i += 2) {
    const x = tries[i];
    const y = tries[i + 1];
    if (tryPlaceNodeAt(cells, node, x, y, rankPos, flow)) return;
  }

  // Generic fallback: scan down in a column.
  let col = 0;
  if (pre.length > 0) {
    col = (node.rank ?? 0) * 2;
    col = pre[0].x as number;
  }

  let y = 0;
  while (cells.has(`${col},${y}`)) y += 2;
  if (cells.has(`${col},${y - 1}`)) y += 1;

  while (true) {
    const ok = clearTries(node, cells, [col, y]);
    if (ok.length !== 0 && tryPlaceNodeAt(cells, node, col, y, rankPos, flow)) return;
    y += 2;
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

  if (px !== undefined && py !== undefined) {
    // Check whether the new position px,py is a continuation from x1,y1 => x,y.
    const dx1 = directionSign(px - x);
    const dy1 = directionSign(py - y);
    const dx2 = directionSign(x - (x1 ?? 0));
    const dy2 = directionSign(y - (y1 ?? 0));
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

  // Graph::Easy uses a +/-1 boundary around occupied cells.
  const pad = 1;
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
    // Deliberately include flags: Graph::Easy only restricts direction for flagless HOR/VER.
    type = current.type;
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
      // Deliberately include flags: Graph::Easy only allows crossing flagless HOR/VER.
      const t = cell.type;
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
      // Perl only allows seeding on empty cells or plain HOR/VER pieces.
      if (t !== 0 && t !== EDGE_HOR && t !== EDGE_VER) {
        seedSkippedBadEdge += 1;
        continue;
      }
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
        // For shared joints, also store the reached stop's (lx,ly) so the path
        // reconstruction can compute the proper first/last cell type.
        if (perField > 3) {
          entry[6] = stop[si + 3];
          entry[7] = stop[si + 4];
        }
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

  // Ported from Graph::Easy::Layout::Scout::_astar path reconstruction:
  // the label cell is chosen near the *end* of the path (first straight segment
  // encountered while walking the path in reverse), and never on crossings.
  // Note: do this *after* straightening, since straightening rewrites cell types.
  // Perl sets a label cell even for empty labels; this also prevents EDGE_HOR/EDGE_VER
  // segments from being compressed to width/height 0 during ASCII sizing.
  for (let i = path.length - 3; i >= 0; i -= 3) {
    const x = path[i];
    const y = path[i + 1];
    const type = path[i + 2];
    const edgeType = type & EDGE_TYPE_MASK;
    if (edgeType !== EDGE_HOR && edgeType !== EDGE_VER) continue;
    if (cells.has(`${x},${y}`)) continue; // avoid putting labels on crossings
    if ((type & EDGE_LABEL_CELL) === 0) path[i + 2] = type + EDGE_LABEL_CELL;
    break;
  }

  return path;
}

// Shared-port join helpers (ported from Graph::Easy::Layout::Scout.pm).

type JointFieldSpec = readonly [number, number, number, number, number, number];

const NEXT_FIELDS: Record<number, JointFieldSpec> = {
  [EDGE_VER]: [-1, 0, EDGE_W_N_S, +1, 0, EDGE_E_N_S],
  [EDGE_HOR]: [0, -1, EDGE_N_E_W, 0, +1, EDGE_S_E_W],
  [EDGE_N_E]: [0, +1, EDGE_E_N_S, -1, 0, EDGE_N_E_W],
  [EDGE_N_W]: [0, +1, EDGE_W_N_S, +1, 0, EDGE_N_E_W],
  [EDGE_S_E]: [0, -1, EDGE_E_N_S, -1, 0, EDGE_S_E_W],
  [EDGE_S_W]: [0, -1, EDGE_W_N_S, +1, 0, EDGE_S_E_W],
};

// For Graph::Easy 0.76 these are identical.
const PREV_FIELDS: Record<number, JointFieldSpec> = NEXT_FIELDS;

function edgesAtPort(node: Node, attr: "start" | "end", side: string, port: number): Edge[] {
  // Ported from Graph::Easy::Node->edges_at_port.
  const edges: Edge[] = [];
  for (const e of node.edges()) {
    // Skip edges ending here if we look at start.
    if (e.to === node && attr === "start") continue;
    // Skip edges starting here if we look at end.
    if (e.from === node && attr === "end") continue;

    const [s, p] = e.port(attr);
    if (s === undefined) continue;
    if (p === undefined) continue;
    if (s === side && p === port) edges.push(e);
  }
  return edges;
}

function getJoints(
  shared: Edge[],
  mask: number,
  types: Map<string, number>,
  jointCells: Map<string, number[]>,
  nextFields: Record<number, JointFieldSpec>
): number[] {
  // Ported from Graph::Easy::Layout::Scout::_get_joints.
  for (const e of shared) {
    for (const c of e.cells) {
      const base = c.type & EDGE_TYPE_MASK;
      const fields = nextFields[base];
      if (!fields) continue;

      // Don't consider end/start (depending on mask) cells for HOR/VER.
      if ((base === EDGE_HOR || base === EDGE_VER) && (c.type & mask)) {
        continue;
      }

      const px = c.x;
      const py = c.y;

      for (let i = 0; i < fields.length; i += 3) {
        const sx = px + fields[i];
        const sy = py + fields[i + 1];
        const jt = fields[i + 2];

        const key = `${sx},${sy}`;
        if (jointCells.has(key)) continue;

        jointCells.set(key, [sx, sy, 0, px, py]);
        // Keep eventually set start/end points on the original cell.
        types.set(key, jt + (c.type & EDGE_FLAG_MASK));
      }
    }
  }

  const out: number[] = [];
  const keys = [...jointCells.keys()].sort(cmpStr);
  for (const k of keys) {
    const v = jointCells.get(k);
    if (!v) continue;
    out.push(...v);
  }
  return out;
}

function joinEdge(node: Node, edge: Edge, shared: Edge[], cells: CellMap, end?: true): number[] | undefined {
  // Ported from Graph::Easy::Layout::Scout::_join_edge.
  let flags: number[] = [
    EDGE_W_N_S + EDGE_START_W,
    EDGE_N_E_W + EDGE_START_N,
    EDGE_E_N_S + EDGE_START_E,
    EDGE_S_E_W + EDGE_START_S,
  ];

  if (end || edge.bidirectional) {
    flags = [
      EDGE_W_N_S + EDGE_END_W,
      EDGE_N_E_W + EDGE_END_N,
      EDGE_E_N_S + EDGE_END_E,
      EDGE_S_E_W + EDGE_END_S,
    ];
  }

  const places = node.nearPlaces(cells, 1, flags, true, undefined);

  for (let i = 0; i < places.length; i += 3) {
    const x = places[i];
    const y = places[i + 1];
    const jointType = places[i + 2];

    const cell = cells.get(`${x},${y}`);
    if (!(cell instanceof EdgeCell)) continue;

    const cellType = cell.type & EDGE_TYPE_MASK;
    if (cellType !== EDGE_HOR && cellType !== EDGE_VER) continue;

    // The cell must belong to one of the shared edges.
    if (!shared.some((e) => e === cell.edge)) continue;

    // Make the cell at the current pos a joint.
    cell.makeJoint(edge, jointType);

    // The layouter will check that each edge has a cell, so add a dummy one.
    new EdgeCell(edge, x, y, EDGE_HOLE);

    return [];
  }

  return undefined;
}

function findPathAstar(cells: CellMap, edge: Edge): number[] | undefined {
  // Ported from Graph::Easy::Layout::Scout::_find_path_astar.
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

  const jointType = new Map<string, number>();
  const jointTypeEnd = new Map<string, number>();
  const startCells = new Map<string, number[]>();
  const endCells = new Map<string, number[]>();

  // End fields first (because maybe an edge runs alongside the node).

  let perField = 5;
  let B: number[];

  if (ePortSide !== undefined && ePortPos !== undefined) {
    const sharedEndAll = edgesAtPort(dst, "end", ePortSide, ePortPos);
    const sharedEnd = sharedEndAll.filter((e) => e.cells.length > 0);

    if (sharedEnd.length > 0) {
      const joined = joinEdge(src, edge, sharedEnd, cells);
      if (joined) return joined;

      B = getJoints(sharedEnd, EDGE_START_MASK, jointTypeEnd, endCells, PREV_FIELDS);
    } else {
      B = dst.nearPlaces(cells, 1, endFlags, true, undefined);
      B = dst.allowedPlaces(B, dst.allow(ePortSide, ePortPos), 3);
      perField = 3;
    }
  } else {
    B = dst.nearPlaces(cells, 1, endFlags, true, undefined);
    if (ePortSide !== undefined) {
      B = dst.allowedPlaces(B, dst.allow(ePortSide, ePortPos), 3);
    }
    perField = 3;
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

  // Start fields.

  let A: number[] = [];

  if (sPortSide !== undefined && sPortPos !== undefined) {
    const sharedStartAll = edgesAtPort(src, "start", sPortSide, sPortPos);
    const sharedStart = sharedStartAll.filter((e) => e.cells.length > 0);

    if (sharedStart.length > 0) {
      const joined = joinEdge(dst, edge, sharedStart, cells, true);
      if (joined) return joined;

      A = getJoints(sharedStart, EDGE_END_MASK, jointType, startCells, NEXT_FIELDS);
    }
  }

  if (A.length === 0) {
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

    for (let i = 0; i < start.length; i += 3) {
      const sx = start[i];
      const sy = start[i + 1];
      const type = start[i + 2];

      // Compute the field inside the node from where sx,sy is reached.
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
  }

  const path = astar(cells, A, B, edge, perField);
  if (!path) return undefined;

  if (path.length > 0 && startCells.size > 0) {
    // Convert the edge piece of the starting edge-cell to a joint.
    const x = path[0];
    const y = path[1];
    const xy = `${x},${y}`;
    const info = startCells.get(xy);
    if (info) {
      const px = info[3];
      const py = info[4];
      const jt = jointType.get(xy);
      const base = cells.get(`${px},${py}`);
      if (!(base instanceof EdgeCell) || jt === undefined) {
        throw new Error(`Unable to convert start joint at ${px},${py} for edge ${edge.id}`);
      }
      base.makeJoint(edge, jt);
    }
  }

  if (path.length > 0 && endCells.size > 0) {
    // Convert the edge piece of the ending edge-cell to a joint.
    const x = path[path.length - 3];
    const y = path[path.length - 2];
    const xy = `${x},${y}`;
    const info = endCells.get(xy);
    if (info) {
      const px = info[3];
      const py = info[4];
      const jt = jointTypeEnd.get(xy);
      const base = cells.get(`${px},${py}`);
      if (!(base instanceof EdgeCell) || jt === undefined) {
        throw new Error(`Unable to convert end joint at ${px},${py} for edge ${edge.id}`);
      }
      base.makeJoint(edge, jt);
    }
  }

  return path;
}

function findPathLoop(cells: CellMap, edge: Edge): number[] | undefined {
  // Ported from Graph::Easy::Layout::Scout::_find_path_loop.
  const src = edge.from;

  // Get a list of possible loop positions.
  const places = src.nearPlaces(
    cells,
    1,
    [EDGE_LOOP_EAST, EDGE_LOOP_SOUTH, EDGE_LOOP_WEST, EDGE_LOOP_NORTH],
    false,
    90
  );

  // We cannot use Node.shuffleDir() directly here; Graph::Easy tries self-loops
  // in a different order depending on node flow.
  const flow = src.flow();
  let order = [EDGE_LOOP_NORTH, EDGE_LOOP_SOUTH, EDGE_LOOP_WEST, EDGE_LOOP_EAST];
  if (flow === 270) {
    order = [EDGE_LOOP_SOUTH, EDGE_LOOP_NORTH, EDGE_LOOP_EAST, EDGE_LOOP_WEST];
  } else if (flow === 0) {
    order = [EDGE_LOOP_WEST, EDGE_LOOP_EAST, EDGE_LOOP_SOUTH, EDGE_LOOP_NORTH];
  } else if (flow === 180) {
    order = [EDGE_LOOP_EAST, EDGE_LOOP_WEST, EDGE_LOOP_NORTH, EDGE_LOOP_SOUTH];
  }

  for (const thisTry of order) {
    for (let i = 0; i < places.length; i += 3) {
      if (places[i + 2] !== thisTry) continue;
      const x = places[i];
      const y = places[i + 1];
      if (cells.has(`${x},${y}`)) continue;
      return [x, y, thisTry];
    }
  }

  return undefined;
}

function findPath(graph: Graph, cells: CellMap, edge: Edge): number[] | undefined {
  const src = edge.from;
  const dst = edge.to;

  if (src === dst) {
    return findPathLoop(cells, edge);
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

  return undefined;
}

function edgeDirMask(base: number): number {
  // N=1, E=2, S=4, W=8
  switch (base) {
    case EDGE_CROSS:
      return 15;
    case EDGE_HOR:
      return 10;
    case EDGE_VER:
      return 5;
    case EDGE_N_E:
      return 3;
    case EDGE_N_W:
      return 9;
    case EDGE_S_E:
      return 6;
    case EDGE_S_W:
      return 12;
    case EDGE_S_E_W:
      return 14;
    case EDGE_N_E_W:
      return 11;
    case EDGE_E_N_S:
      return 7;
    case EDGE_W_N_S:
      return 13;
    default:
      return 0;
  }
}

function edgeBaseFromDirMask(mask: number): number | undefined {
  switch (mask) {
    case 15:
      return EDGE_CROSS;
    case 10:
      return EDGE_HOR;
    case 5:
      return EDGE_VER;
    case 3:
      return EDGE_N_E;
    case 9:
      return EDGE_N_W;
    case 6:
      return EDGE_S_E;
    case 12:
      return EDGE_S_W;
    case 14:
      return EDGE_S_E_W;
    case 11:
      return EDGE_N_E_W;
    case 7:
      return EDGE_E_N_S;
    case 13:
      return EDGE_W_N_S;
    default:
      return undefined;
  }
}

function createCell(cells: CellMap, edge: Edge, x: number, y: number, type: number): void {
  const xy = `${x},${y}`;
  const existing = cells.get(xy);

  if (existing instanceof EdgeCell) {
    const aBase = existing.type & EDGE_TYPE_MASK;
    const bBase = type & EDGE_TYPE_MASK;

    const mergedBase = edgeBaseFromDirMask(edgeDirMask(aBase) | edgeDirMask(bBase));
    if (mergedBase === undefined) {
      throw new Error(`Cannot merge edge cell types at ${x},${y} (${aBase} vs ${bBase})`);
    }

    const mergedFlags = (existing.type & EDGE_FLAG_MASK) | (type & EDGE_FLAG_MASK);

    // If we are turning a straight hor/ver piece into a crossing, record both edges
    // so the ASCII renderer can use the correct style for each direction.
    const existingBase = existing.type & EDGE_TYPE_MASK;
    const newBase = type & EDGE_TYPE_MASK;
    if (mergedBase === EDGE_CROSS && (existingBase === EDGE_HOR || existingBase === EDGE_VER) && (newBase === EDGE_HOR || newBase === EDGE_VER)) {
      existing.makeCross(edge, mergedFlags);
    } else {
      existing.type = mergedBase + mergedFlags;
    }

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

function tracePath(graph: Graph, cells: CellMap, edge: Edge): number | undefined {
  if (edge.from.x === undefined || edge.from.y === undefined || edge.to.x === undefined || edge.to.y === undefined) {
    throw new Error(`Edge ${edge.id} connects unplaced nodes`);
  }

  const coords = findPath(graph, cells, edge);
  if (!coords) return undefined;

  // path is empty, happens for sharing edges with only a joint
  if (coords.length === 0) return 0;

  for (let i = 0; i < coords.length; i += 3) {
    const x = coords[i];
    const y = coords[i + 1];
    const type = coords[i + 2];
    createCell(cells, edge, x, y, type);
  }

  return 0;
}

function optimizeLayout(graph: Graph, cells: CellMap): void {
  // Ported from Graph::Easy::Layout::_optimize_layout.
  //
  // This compacts consecutive straight EDGE_HOR/EDGE_VER cells into one cell by merging
  // their cx/cy spans (default 1) and carrying over EDGE_MISC_MASK bits (label/short).
  // Deleted slots are replaced with Edge::Cell::Empty placeholders.
  //
  // It also removes EDGE_HOLE placeholders that were inserted during layout when merging
  // overlapping edge pieces.

  for (const e of graph.edges) {
    const edgeCells = e.cells;
    if (edgeCells.length < 2) continue;

    let f = edgeCells[0];
    let i = 1;

    while (i < edgeCells.length) {
      const c = edgeCells[i];

      const t1 = f.type & EDGE_NO_M_MASK;
      const t2 = c.type & EDGE_NO_M_MASK;

      if (t1 === t2 && (t1 === EDGE_HOR || t1 === EDGE_VER)) {
        // Carry over misc bits (label/short) from the removed cell.
        f.type |= c.type & EDGE_MISC_MASK;

        const isHor = t1 === EDGE_HOR;
        const cSpan = (isHor ? c.cx : c.cy) ?? 1;

        if (isHor) {
          f.cx = (f.cx ?? 1) + cSpan;
        } else {
          f.cy = (f.cy ?? 1) + cSpan;
        }

        // Drop removed cell from the global cell map.
        cells.delete(`${c.x},${c.y}`);

        // Placeholder coordinate defaults to the removed cell.
        let px = c.x;
        let py = c.y;

        // Reverse order: move merged cell to the new start position.
        if ((isHor && f.x > c.x) || (!isHor && f.y > c.y)) {
          px = f.x;
          py = f.y;

          cells.delete(`${f.x},${f.y}`);

          if (isHor) {
            f.x -= cSpan;
          } else {
            f.y -= cSpan;
          }

          cells.set(`${f.x},${f.y}`, f);
        }

        // Remove from edge and replace with placeholder.
        edgeCells.splice(i, 1);
        const xy = `${px},${py}`;
        if (!cells.has(xy)) {
          cells.set(xy, new EdgeCellEmpty(px, py));
        }
        continue;
      }

      if (c.type === EDGE_HOLE) {
        // Holes are inserted during layout and removed during optimization.
        edgeCells.splice(i, 1);
        if (i >= edgeCells.length) break;

        // Do not combine across holes.
        f = edgeCells[i];
        i++;
        continue;
      }

      f = c;
      i++;
    }
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

    return bRoot - aRoot || b.len - a.len || cmpStr(a.start.id, b.start.id);
  });

  for (const c of chainList) {
    todo.push(...c.layout());
  }

  // Left-over nodes and their edges. Graph::Easy queues edges per-node.
  // Match Perl ord_values($self->{nodes}) ordering (internal numeric id).
  const nodes = [...graph.nodes()].sort((a, b) => cmpStr(String(a.numericId), String(b.numericId)));
  for (const n of nodes) {
    todo.push(graph._layoutAction(ACTION_NODE, n, 0));

    // Gather outgoing to-do edges sorted by destination name.
    const edges = n
      .edges()
      .filter((e) => e.todo && e.from === n)
      .sort((a, b) => cmpStr(a.to.id, b.to.id));

    for (const e of edges) {
      todo.push([ACTION_TRACE, e]);
      e.todo = false;
    }
  }

  if (graph.groups.length > 0) {
    todo.push([ACTION_SPLICE] as unknown as LayoutAction);
  }

  // Execute action stack (ported from Graph::Easy::Layout.pm TRY loop).
  let cells: CellMap = new Map();
  const rankPos = new Map<number, number>();

  const flow = graph.flow();
  let score = 0;
  let tries = 16;
  const done: LayoutAction[] = [];

  while (todo.length > 0) {
    const action = todo.shift() as unknown as unknown[];
    done.push(action as unknown as LayoutAction);

    const at = action[0] as number;

    let mod: number | undefined;
    let src: Node | undefined;
    let dst: Node | undefined;

    if (at === ACTION_NODE) {
      const node = action[1] as Node;
      const tryIndex = action[2] as number;
      const edge = action[3] as Edge | undefined;

      if (node.x === undefined || node.y === undefined) {
        findNodePlace(graph, cells, rankPos, flow, node, tryIndex, undefined, edge);
      }
      mod = 0;
    } else if (at === ACTION_CHAIN) {
      const node = action[1] as Node;
      const tryIndex = action[2] as number;
      const parent = action[3] as Node;
      const edge = action[4] as Edge;

      if (node.x === undefined || node.y === undefined) {
        findNodePlace(graph, cells, rankPos, flow, node, tryIndex, parent, edge);
      }
      mod = 0;
    } else if (at === ACTION_TRACE) {
      const edge = action[1] as Edge;
      src = edge.from;
      dst = edge.to;

      if (dst.x === undefined || dst.y === undefined) {
        findNodePlace(graph, cells, rankPos, flow, dst, 0, undefined, edge);
      }
      if (src.x === undefined || src.y === undefined) {
        findNodePlace(graph, cells, rankPos, flow, src, 0, undefined, edge);
      }

      mod = tracePath(graph, cells, edge);
    } else if (at === ACTION_SPLICE) {
      cells = fillGroupCells(graph, cells);
      mod = 0;
    } else {
      throw new Error(`Illegal action ${String(at)} on layout stack`);
    }

    if (mod === undefined) {
      if (at === ACTION_NODE || at === ACTION_CHAIN) {
        const node = action[1] as Node;
        if (node.x !== undefined && node.y !== undefined) {
          unplaceNode(cells, node);
        }

        (action as unknown as any[])[2] = (action[2] as number) + 1;
        tries--;
        if (tries === 0) break;

        todo.unshift(action as unknown as LayoutAction);
        continue;
      }

      tries--;
      if (tries === 0) break;
      continue;
    }

    score += mod;
  }

  void score;

  optimizeLayout(graph, cells);

  return cells;
}
