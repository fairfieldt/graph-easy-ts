import type { Edge } from "../edge";
import type { Graph } from "../graph";
import type { Node } from "../node";

import { ACTION_CHAIN, ACTION_NODE, ACTION_TRACE } from "./actionTypes";

export type LayoutAction = readonly [number, ...unknown[]];

export class LayoutChain {
  public end: Node;
  public len = 1;
  public done = false;

  public constructor(
    public readonly id: number,
    public readonly start: Node,
    public readonly graph: Graph
  ) {
    this.end = start;
    start.chain = this;
    start.chainNext = undefined;
  }

  public addNode(node: Node): void {
    this.end.chainNext = node;
    this.end = node;
    node.chain = this;
    node.chainNext = undefined;
    this.len++;
  }

  public length(from?: Node): number {
    if (!from) return this.len;

    let n: Node | undefined = from;
    let l = 0;
    while (n) {
      l++;
      n = n.chainNext;
    }
    return l;
  }

  public nodes(): Node[] {
    const out: Node[] = [];
    let n: Node | undefined = this.start;
    while (n) {
      out.push(n);
      n = n.chainNext;
    }
    return out;
  }

  public layout(_edge?: Edge): LayoutAction[] {
    // Ported from Graph::Easy::Layout::Chain::layout (Graph-Easy 0.76).
    // Returns an action stack for placing nodes in the chain and routing
    // edges within/between chains.
    if (this.done) return [];
    this.done = true;

    const edge = _edge;

    const todo: LayoutAction[] = [];
    const g = this.graph;

    // --- Place chain nodes ---
    let pre: Node = this.start;
    let n: Node | undefined = pre.chainNext;

    if (pre.todo) {
      // Edges with a flow attribute or ports must be handled differently.
      if (edge && edge.to === pre && (edge.attribute("flow") !== "" || edge.hasPorts())) {
        todo.push(g._layoutAction(ACTION_CHAIN, pre, 0, edge.from, edge));
      } else {
        todo.push(g._layoutAction(ACTION_NODE, pre, 0, edge));
      }
    }

    while (n) {
      if (n.todo) {
        const edges = g.edgesBetween(pre, n);
        todo.push(g._layoutAction(ACTION_CHAIN, n, 0, pre, edges[0]));
      }
      pre = n;
      n = n.chainNext;
    }

    // --- Link each node to the next (forward edges) ---
    pre = this.start;
    n = pre.chainNext;
    while (n) {
      for (const e of pre.edges()) {
        if (e.to !== n) continue;
        if (!e.todo) continue;
        todo.push([ACTION_TRACE, e]);
        e.todo = false;
      }

      pre = n;
      n = n.chainNext;
    }

    // --- Other links inside the chain (shortest first) ---
    n = this.start;
    while (n) {
      const edges: Array<[number, Edge]> = [];

      // Gather edges starting at `n`.
      for (const e of n.edges()) {
        if (e.from !== n) continue;
        if (e.to === n) continue; // selfloop
        if (!e.todo) continue;
        if (!e.to.chain || e.to.chain !== this) continue; // leaving chain
        if (e.hasPorts()) continue;

        // Calculate how far the edge goes.
        let count = 0;
        let curr: Node | undefined = n;
        while (curr && curr !== e.to) {
          curr = curr.chainNext;
          count++;
        }

        if (!curr) {
          // Edge goes backward.
          curr = e.to;
          count = 0;
          while (curr && curr !== e.from) {
            curr = curr.chainNext;
            count++;
          }
          if (!curr) count = 100000;
        }

        edges.push([count, e]);
      }

      edges.sort((a, b) => a[0] - b[0]);
      for (const [, e] of edges) {
        todo.push([ACTION_TRACE, e]);
        e.todo = false;
      }

      n = n.chainNext;
    }

    // --- Selfloops on chain nodes ---
    n = this.start;
    while (n) {
      for (const e of n.edges()) {
        if (!e.todo) continue;
        if (e.from !== n || e.to !== n) continue;
        todo.push([ACTION_TRACE, e]);
        e.todo = false;
      }
      n = n.chainNext;
    }

    // --- Recurse into other chains starting from nodes in this chain ---
    n = this.start;
    while (n) {
      const edges = n
        .edges()
        .slice()
        .sort((a, b) => a.to.id.localeCompare(b.to.id) || a.id - b.id);

      for (const e of edges) {
        const to = e.to;
        const chain = to.chain;
        if (!chain) continue;
        if (chain.done) continue;
        todo.push(...chain.layout(e));

        if (!e.todo) continue;
        todo.push([ACTION_TRACE, e]);
        e.todo = false;
      }

      n = n.chainNext;
    }

    return todo;
  }

  public merge(_other: LayoutChain, _where?: Node): void {
    // Ported from Graph::Easy::Layout::Chain::merge (Graph-Easy 0.76).
    const other = _other;
    if (this === other) return;

    let where = _where;
    if (where && where.chain !== other) where = undefined;
    if (!where) where = other.start;

    // Mark all nodes from this chain as belonging to us.
    let n: Node | undefined = this.start;
    while (n) {
      n.chain = this;
      n = n.chainNext;
    }

    // Terminate at `where`.
    this.end.chainNext = where;
    this.end = other.end;

    // Start at joiner.
    n = where;
    while (n) {
      n.chain = this;
      const pre = n;
      n = n.chainNext;

      // Already points into ourself? Then terminate.
      if (n && n.chain === this) {
        pre.chainNext = undefined;
        this.end = pre;
        break;
      }
    }

    // Recompute length.
    this.len = 0;
    n = this.start;
    while (n) {
      this.len++;
      n = n.chainNext;
    }

    // If we absorbed the other chain completely, mark it as empty so the caller
    // can drop it.
    if (where === other.start) {
      other.len = 0;
      other.done = true;
    }
  }
}
