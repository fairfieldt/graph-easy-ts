import { mergeAttributes, type Attributes } from "./attributes";

import { EDGE_END_E, EDGE_END_N, EDGE_END_S, EDGE_END_W } from "./layout/edgeCellTypes";

import type { Edge } from "./edge";
import type { Graph } from "./graph";
import type { Group } from "./group";
import type { LayoutChain } from "./layout/chain";

export type FlowDirection = 0 | 90 | 180 | 270;

function directionAsNumber(dir: string): FlowDirection | undefined {
  const v = dir.trim().toLowerCase();
  if (v === "0" || v === "90" || v === "180" || v === "270") return Number(v) as FlowDirection;

  // Absolute directions.
  if (v === "east" || v === "right" || v === "forward" || v === "front") return 90;
  if (v === "west" || v === "left" || v === "back") return 270;
  if (v === "north" || v === "up") return 0;
  if (v === "south" || v === "down") return 180;

  return undefined;
}

export class Node {
  public readonly attributes: Attributes = Object.create(null);

  public graph: Graph | undefined;
  public group: Group | undefined;

  public readonly edgesById = new Map<number, Edge>();

  // Layout fields (grid cell coordinates)
  public x: number | undefined;
  public y: number | undefined;
  public cx: number | undefined;
  public cy: number | undefined;
  public rank: number | undefined;

  public w: number | undefined;
  public h: number | undefined;

  public cache: Record<string, unknown> = Object.create(null);

  // Layout bookkeeping.
  public todo = true;

  // Chain info (set during layout).
  public chain: LayoutChain | undefined;
  public chainNext: Node | undefined;

  public constructor(
    public readonly id: string,
    public label: string
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

  public addEdge(edge: Edge): void {
    this.edgesById.set(edge.id, edge);
  }

  public edges(): Edge[] {
    return [...this.edgesById.values()].sort((a, b) => a.id - b.id);
  }

  public predecessors(): Node[] {
    const seen = new Set<Node>();
    for (const e of this.edges()) {
      if (e.to === this) {
        seen.add(e.from);
      } else if (e.bidirectional && e.from === this) {
        seen.add(e.to);
      }
    }
    return [...seen].sort((a, b) => a.id.localeCompare(b.id));
  }

  public successors(): Node[] {
    const seen = new Set<Node>();
    for (const e of this.edges()) {
      if (e.from === this) {
        seen.add(e.to);
      } else if (e.bidirectional && e.to === this) {
        seen.add(e.from);
      }
    }
    return [...seen].sort((a, b) => a.id.localeCompare(b.id));
  }

  public hasPredecessors(): number {
    return this.predecessors().length;
  }

  public flow(): FlowDirection {
    const own = this.attribute("flow");
    if (own && own !== "inherit") {
      const n = directionAsNumber(own);
      if (n !== undefined) return n;
    }

    const graphFlow = this.graph?.graphAttributes.flow;
    if (graphFlow) {
      const n = directionAsNumber(graphFlow);
      if (n !== undefined) return n;
    }

    // Default flow is east.
    return 90;
  }

  private shuffleDir(e: readonly number[], dir: number | undefined): number[] {
    // Ported from Graph::Easy::Node::_shuffle_dir.
    // dir: 0 => north, 90 => east, 180 => south, 270 => west
    const d = dir ?? 90;

    if (d === 90) return [...e];

    let shuffle = [0, 1, 2, 3];
    if (d === 180) shuffle = [1, 2, 0, 3];
    if (d === 270) shuffle = [2, 3, 1, 0];
    if (d === 0) shuffle = [3, 0, 2, 1];

    return [e[shuffle[0]], e[shuffle[1]], e[shuffle[2]], e[shuffle[3]]];
  }

  public shift(turn: number): number {
    // Ported from Graph::Easy::Node::_shift.
    let dir = this.flow();
    dir += turn;
    if (dir < 0) dir += 360;
    if (dir > 360) dir -= 360;
    return dir;
  }

  private calcSize(): { cx?: true; cy?: true } {
    // Ported from Graph::Easy::Node::_calc_size.
    // Calculate the base size in cells from the attributes (before grow()).
    // Returns an object indicating in which direction the node should grow.
    const growSides: { cx?: true; cy?: true } = { cx: true, cy: true };

    // If specified only one of "rows" or "columns", then grow the node only in
    // the unspecified direction. Default is grow both.
    const rRaw = this.rawAttribute("rows");
    const cRaw = this.rawAttribute("columns");
    if (rRaw !== undefined && cRaw === undefined) delete growSides.cy;
    if (cRaw !== undefined && rRaw === undefined) delete growSides.cx;

    const parseDim = (raw: string): number => {
      const trimmed = raw.trim();
      if (trimmed === "") return 1;
      const n = Number(trimmed);
      if (!Number.isFinite(n)) {
        throw new Error(`Invalid node dimension: '${raw}'`);
      }
      const abs = Math.abs(n);
      // Perl uses abs($r || 1) so 0 becomes 1.
      return abs === 0 ? 1 : abs;
    };

    this.cy = parseDim(this.attribute("rows") || "1");
    this.cx = parseDim(this.attribute("columns") || "1");

    return growSides;
  }

  public grow(): void {
    // Ported from Graph::Easy::Node::_grow.
    // Grows the node until it has sufficient cells for all incoming/outgoing edges.

    type Side = "north" | "south" | "east" | "west";
    const sides: Side[] = ["north", "south", "east", "west"];

    // bitmap for each side (we track used port numbers)
    const usedPorts: Record<Side, Set<number>> = {
      north: new Set(),
      south: new Set(),
      east: new Set(),
      west: new Set(),
    };

    // number of edges constrained to one side, but without port number
    const cnt: Record<Side, number> = { north: 0, south: 0, east: 0, west: 0 };
    // number of edges constrained to one side, with port number (unique)
    const portnr: Record<Side, number> = { north: 0, south: 0, east: 0, west: 0 };
    // max number of ports for each side
    const max: Record<Side, number> = { north: 0, south: 0, east: 0, west: 0 };

    // number of slots we need for edges without port restrictions
    let unspecified = 0;

    // count of outgoing edges
    let outgoing = 0;

    const edges = this.edges();

    for (const e of edges) {
      if (e.from === this) outgoing++;

      // do always both ends, because self-loops can start AND end at this node
      for (const end of [0, 1] as const) {
        const which = end === 0 ? "start" : "end";
        const nodeAtEnd = end === 0 ? e.from : e.to;
        if (nodeAtEnd !== this) continue;

        const [side, nr] = e.port(which);
        if (side !== undefined) {
          if (nr === undefined || Number.isNaN(nr)) {
            // no port number specified, so just count
            cnt[side] += 1;
          } else {
            // limit to four digits
            let port = nr;
            if (Math.abs(port) > 9999) port = 9999;

            // if slot was not used yet, count it
            if (!usedPorts[side].has(port)) {
              portnr[side] += 1;
              usedPorts[side].add(port);
            }

            // calculate max number of ports
            let m = port;
            // 3 => 3, -3 => 2
            if (m < 0) m = Math.abs(m) - 1;
            // 3 => 4, -3 => 3
            m += 1;
            if (m > max[side]) max[side] = m;
          }
        } else {
          unspecified += 1;
        }
      }
    }

    // The loop above will count all self-loops twice when they are unrestricted.
    // So subtract these again.
    for (const e of edges) {
      if (e.to === e.from) unspecified -= 1;
    }

    // Shortcut: if the number of edges is < 4 and we have not restrictions,
    // then a 1x1 node suffices.
    if (unspecified < 4 && unspecified === edges.length) {
      this.calcSize();
      return;
    }

    const need: Record<Side, number> = { north: 0, south: 0, east: 0, west: 0 };
    const free: Record<Side, number> = { north: 0, south: 0, east: 0, west: 0 };
    for (const side of sides) {
      // maximum number of ports we need to reserve, minus edges constrained
      // to unique ports: free ports on that side
      free[side] = max[side] - portnr[side];
      need[side] = max[side];
      if (free[side] < 2 * cnt[side]) {
        need[side] += 2 * cnt[side] - free[side] - 1;
      }
    }

    // calculate min. size in X and Y direction
    const minX = Math.max(need.north, need.south);
    const minY = Math.max(need.west, need.east);

    const growSides = this.calcSize();

    // increase the size if the minimum required size is not met
    this.cx = Math.max(this.cx ?? 1, minX);
    this.cy = Math.max(this.cy ?? 1, minY);

    const flow = this.flow();
    let frontSide: Side = "east";
    if (flow === 270) frontSide = "west";
    else if (flow === 180) frontSide = "south";
    else if (flow === 0) frontSide = "north";

    // now grow the node based on the general flow first VER, then HOR
    let grow = 0;
    let growWhat = Object.keys(growSides).sort() as Array<"cx" | "cy">;
    if (growWhat.length > 1) {
      // for left/right flow, swap the growing around
      if (flow === 90 || flow === 270) growWhat = ["cy", "cx"];
    }

    while (true) {
      // calculate whether we already found a space for all edges
      let freePorts = 0;

      for (const side of ["north", "south"] as const) {
        // if this is a sink node, grow it more by ignoring free ports on the front side
        if (outgoing === 0 && frontSide === side) continue;
        freePorts += 1 + Math.floor(((this.cx ?? 1) - cnt[side] - portnr[side]) / 2);
      }
      for (const side of ["east", "west"] as const) {
        // if this is a sink node, grow it more by ignoring free ports on the front side
        if (outgoing === 0 && frontSide === side) continue;
        freePorts += 1 + Math.floor(((this.cy ?? 1) - cnt[side] - portnr[side]) / 2);
      }

      if (freePorts >= unspecified) break;

      const dim = growWhat[grow];
      if (dim === "cx") this.cx = (this.cx ?? 1) + 2;
      else if (dim === "cy") this.cy = (this.cy ?? 1) + 2;
      else break;

      grow += 1;
      if (grow >= growWhat.length) grow = 0;
    }
  }

  public nearPlaces(
    cells: Map<string, unknown>,
    d: number | undefined,
    type: number[] | undefined,
    loose: boolean | undefined,
    dir: number | undefined
  ): number[] {
    // Ported from Graph::Easy::Node::_near_places (single-celled case only).
    if (this.x === undefined || this.y === undefined) {
      throw new Error(`nearPlaces: node ${this.id} is not placed`);
    }

    const cx = this.cx ?? 1;
    const cy = this.cy ?? 1;

    const dist = d ?? 2;

    const flags = type ?? [EDGE_END_W, EDGE_END_N, EDGE_END_E, EDGE_END_S];

    const effectiveDir = dir ?? this.flow();
    const index = this.shuffleDir([0, 3, 6, 9], effectiveDir);

    // single-celled node
    if (cx + cy === 2) {
      const tries = [
        this.x + dist,
        this.y,
        flags[0],
        this.x,
        this.y + dist,
        flags[1],
        this.x - dist,
        this.y,
        flags[2],
        this.x,
        this.y - dist,
        flags[3],
      ];

      const places: number[] = [];
      for (let i = 0; i < 4; i++) {
        const idx = index[i];
        const x = tries[idx];
        const y = tries[idx + 1];
        const t = tries[idx + 2];

        if (!loose && cells.has(`${x},${y}`)) continue;

        places.push(x, y);
        if (type) places.push(t);
      }

      return places;
    }

    // multi-celled node
    // Ported from Graph::Easy::Node::_near_places.
    const nx = this.x;
    const ny = this.y;

    const results: number[][] = [[], [], [], []];

    // Perl decrements cx/cy and then uses inclusive ranges (0..cx / 0..cy)
    const maxX = cx - 1;
    const maxY = cy - 1;

    let idx = 0;
    let t = flags[idx++];

    // right
    let px = nx + maxX + dist;
    for (let y = 0; y <= maxY; y++) {
      const py = ny + y;
      if (!loose && cells.has(`${px},${py}`)) continue;
      results[0].push(px, py);
      if (type) results[0].push(t);
    }

    // below
    let py = ny + maxY + dist;
    t = flags[idx++];
    for (let x = 0; x <= maxX; x++) {
      px = nx + x;
      if (!loose && cells.has(`${px},${py}`)) continue;
      results[1].push(px, py);
      if (type) results[1].push(t);
    }

    // left
    px = nx - dist;
    t = flags[idx++];
    for (let y = 0; y <= maxY; y++) {
      py = ny + y;
      if (!loose && cells.has(`${px},${py}`)) continue;
      results[2].push(px, py);
      if (type) results[2].push(t);
    }

    // top
    py = ny - dist;
    t = flags[idx];
    for (let x = 0; x <= maxX; x++) {
      px = nx + x;
      if (!loose && cells.has(`${px},${py}`)) continue;
      results[3].push(px, py);
      if (type) results[3].push(t);
    }

    // accumulate the results in the requested, shuffled order
    const places: number[] = [];
    for (let i = 0; i < 4; i++) {
      const sideIdx = Math.floor(index[i] / 3);
      places.push(...results[sideIdx]);
    }

    return places;
  }

  public allowedPlaces(places: number[], allowed: number[], step = 2): number[] {
    // Ported from Graph::Easy::Node::_allowed_places.
    const good: number[] = [];

    let i = 0;
    while (i < places.length) {
      const x = places[i];
      const y = places[i + 1];

      let allow = 0;
      let j = 0;
      while (j < allowed.length) {
        const m = allowed[j];
        const n = allowed[j + 1];
        if (m === x && n === y) {
          allow++;
          break;
        }
        j += 2;
      }

      if (allow) {
        for (let k = 0; k < step; k++) good.push(places[i + k]);
      }

      i += step;
    }

    return good;
  }

  public allow(dir: string | number, pos: number | undefined): number[] {
    // Ported from Graph::Easy::Node::_allow.
    let d: string | number = dir;

    // For relative direction, get the absolute flow from the node.
    if (typeof d === "string" && /^(front|forward|back|left|right)$/.test(d)) {
      d = this.flow();
    }

    const place: Record<string, [number, number, number, number, "cx" | "cy", number, number]> = {
      south: [0, 0, 0, 1, "cx", 1, 0],
      north: [0, -1, 0, 0, "cx", 1, 0],
      east: [0, 0, 1, 0, "cy", 0, 1],
      west: [-1, 0, 0, 0, "cy", 0, 1],
      "180": [0, 0, 0, 1, "cx", 1, 0],
      "0": [0, -1, 0, 0, "cx", 1, 0],
      "90": [0, 0, 1, 0, "cy", 0, 1],
      "270": [-1, 0, 0, 0, "cy", 0, 1],
    };

    const p = place[String(d)];
    if (!p) return [];

    if (this.x === undefined || this.y === undefined) {
      throw new Error(`allow: node ${this.id} is not placed`);
    }

    const cx = this.cx ?? 1;
    const cy = this.cy ?? 1;

    // start pos
    let x = p[0] + this.x + p[2] * cx;
    let y = p[1] + this.y + p[3] * cy;

    const allowed: number[] = [];

    const count = p[4] === "cx" ? cx : cy;

    if (pos === undefined) {
      // allow all of them
      for (let i = 0; i < count; i++) {
        allowed.push(x, y);
        x += p[5];
        y += p[6];
      }
    } else {
      // allow only the given position
      let ps = pos;
      if (ps < 0) ps = count + ps;
      if (ps < 0) ps = 0;
      if (ps >= count) ps = count - 1;
      x += p[5] * ps;
      y += p[6] * ps;
      allowed.push(x, y);
    }

    return allowed;
  }
}
