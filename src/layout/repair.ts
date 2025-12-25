import { EdgeCell } from "./edgeCell";
import { GroupCell } from "./groupCell";
import { NodeCell } from "./nodeCell";
import {
  EDGE_CROSS,
  EDGE_END_E,
  EDGE_END_MASK,
  EDGE_END_N,
  EDGE_END_S,
  EDGE_END_W,
  EDGE_HOR,
  EDGE_SHORT_CELL,
  EDGE_START_E,
  EDGE_START_MASK,
  EDGE_START_N,
  EDGE_START_S,
  EDGE_START_W,
  EDGE_TYPE_MASK,
  EDGE_VER,
} from "./edgeCellTypes";

import type { Group } from "../group";
import { Node } from "../node";
import type { Edge } from "../edge";
import type { Graph } from "../graph";

type Cell = Node | EdgeCell | NodeCell | GroupCell;
export type CellMap = Map<string, Cell>;

type RowCol = Map<number, Map<number, Cell>>;

type Coords = { x: number; y: number };

function coordsOf(cell: unknown): Coords | undefined {
  const x = (cell as { x?: unknown }).x;
  const y = (cell as { y?: unknown }).y;
  if (typeof x !== "number" || typeof y !== "number") return undefined;
  return { x, y };
}

function repairNodes(graph: Graph, cells: CellMap): void {
  // Ported intent from Graph::Easy::_repair_nodes.
  for (const n of graph.nodes()) {
    const cx = n.cx ?? 1;
    const cy = n.cy ?? 1;

    n.cx = cx * 2 - 1;
    n.cy = cy * 2 - 1;
  }

  for (const n of graph.nodes()) {
    if (n.x === undefined || n.y === undefined) continue;

    const cx = n.cx ?? 1;
    const cy = n.cy ?? 1;

    for (let dx = 0; dx < cx; dx++) {
      for (let dy = 0; dy < cy; dy++) {
        if (dx === 0 && dy === 0) continue;

        const x = n.x + dx;
        const y = n.y + dy;
        const key = `${x},${y}`;
        if (cells.has(key)) continue;

        cells.set(key, new NodeCell(n, x, y));
      }
    }
  }
}

function spliceEdges(cells: CellMap): void {
  // Ported intent from Graph::Easy::_splice_edges.
  // After scaling coords by 2, originally-adjacent edge cells are now 2 units apart.
  // Insert missing EDGE_HOR/EDGE_VER pieces between them.

  const edgeCells = [...cells.values()]
    .filter((c): c is EdgeCell => c instanceof EdgeCell)
    .sort((a, b) => a.x - b.x || a.y - b.y);

  for (const cell of edgeCells) {
    const edge = cell.edge;
    const type = cell.type & EDGE_TYPE_MASK;

    // [ --- ] [ empty ] [ --- ]
    {
      const x2 = cell.x + 2;
      const y = cell.y;
      const right = cells.get(`${x2},${y}`);
      if (right instanceof EdgeCell) {
        if (edge === right.edge || right.type === EDGE_CROSS || cell.type === EDGE_CROSS) {
          const midKey = `${cell.x + 1},${y}`;
          if (!cells.has(midKey)) {
            cells.set(midKey, new EdgeCell(edge, cell.x + 1, y, EDGE_HOR));
          }
        }
      }
    }

    // [ | ] / [ empty ] / [ | ]
    {
      const x = cell.x;
      const y2 = cell.y + 2;
      const below = cells.get(`${x},${y2}`);
      if (below instanceof EdgeCell) {
        if (edge === below.edge || below.type === EDGE_CROSS || cell.type === EDGE_CROSS) {
          const midKey = `${x},${cell.y + 1}`;
          if (!cells.has(midKey)) {
            cells.set(midKey, new EdgeCell(edge, x, cell.y + 1, EDGE_VER));
          }
        }
      }
    }

    // Avoid unused variable warning (we’ll expand joint handling later if needed).
    void type;
  }
}

function insertGroupFillers(cells: CellMap): void {
  // Ported from Graph::Easy::_fill_group_cells (main 8-neighborhood fill pass).
  const snapshot = [...cells.values()];

  for (const cell of snapshot) {
    const group = (cell as { group?: Group }).group;
    if (!group) continue;

    const c = coordsOf(cell);
    if (!c) continue;

    let x = c.x;
    let y = c.y;

    const ofs = [-1, 0, 0, -1, +1, 0, +1, 0, 0, +1, 0, +1, -1, 0, -1, 0];

    for (let i = 0; i < ofs.length; i += 2) {
      x += ofs[i];
      y += ofs[i + 1];

      const key = `${x},${y}`;
      if (!cells.has(key)) {
        cells.set(key, new GroupCell(group, x, y));
      }
    }
  }
}

function closeGroupHoles(cells: CellMap): void {
  // Ported from Graph::Easy::_fill_group_cells (second pass to close 2-step gaps).
  const snapshot = [...cells.values()];

  for (const cell of snapshot) {
    if (!(cell instanceof GroupCell)) continue;

    const sx = cell.x;
    const sy = cell.y;
    const group = cell.group;

    // Vertical: [ group ] / [ empty ] / [ group ]
    {
      const key2 = `${sx},${sy + 2}`;
      const key1 = `${sx},${sy + 1}`;
      if (cells.has(key2) && !cells.has(key1)) {
        const down = cells.get(key2);
        if (down instanceof GroupCell && down.group === group) {
          cells.set(key1, new GroupCell(group, sx, sy + 1));
        }
      }
    }

    // Horizontal: [ group ] [ empty ] [ group ]
    {
      const key2 = `${sx + 2},${sy}`;
      const key1 = `${sx + 1},${sy}`;
      if (cells.has(key2) && !cells.has(key1)) {
        const right = cells.get(key2);
        if (right instanceof GroupCell && right.group === group) {
          cells.set(key1, new GroupCell(group, sx + 1, sy));
        }
      }
    }
  }
}

function buildRowColMaps(cells: CellMap): { rows: RowCol; cols: RowCol } {
  const rows: RowCol = new Map();
  const cols: RowCol = new Map();

  for (const cell of cells.values()) {
    const c = coordsOf(cell);
    if (!c) continue;

    let row = rows.get(c.y);
    if (!row) {
      row = new Map();
      rows.set(c.y, row);
    }
    row.set(c.x, cell);

    let col = cols.get(c.x);
    if (!col) {
      col = new Map();
      cols.set(c.x, col);
    }
    col.set(c.y, cell);
  }

  return { rows, cols };
}

function newEdgeCell(cells: CellMap, group: Group | undefined, edge: Edge, x: number, y: number, type: number): void {
  let t = type;
  if (group) t += EDGE_SHORT_CELL;

  const eCell = new EdgeCell(edge, x, y, t);

  // If we overwrote a group-border cell, remove it from the group’s cell registry.
  if (group) group._delCellAt(x, y);

  cells.set(`${x},${y}`, eCell);
}

function checkEdgeCell(
  cells: CellMap,
  cell: EdgeCell,
  x: number,
  y: number,
  flag: number,
  baseType: number,
  match: RegExp,
  check: Map<number, Cell> | undefined
): void {
  if (!check) return;

  const hasBorder = [...check.values()].some((c) => c instanceof GroupCell && match.test(c.cellClass));
  if (!hasBorder) return;

  cell.type &= ~flag;

  const edge = cell.edge;
  newEdgeCell(cells, edge.group, edge, x, y, baseType + flag);
}

function repairGroupEdge(cells: CellMap, cell: EdgeCell, rows: RowCol, cols: RowCol, group: Group): void {
  // Ported from Graph::Easy::_repair_group_edge.
  const type = cell.type;

  // Horizontal cases
  {
    const y = cell.y;

    // [ empty ] [ |---> ]
    if ((type & EDGE_START_MASK) === EDGE_START_W) {
      const x = cell.x - 1;
      checkEdgeCell(cells, cell, x, y, EDGE_START_W, EDGE_HOR, /g[rl]/, cols.get(x));
    }

    // [ <--- ] [ empty ]
    if ((type & EDGE_START_MASK) === EDGE_START_E) {
      const x = cell.x + 1;
      checkEdgeCell(cells, cell, x, y, EDGE_START_E, EDGE_HOR, /g[rl]/, cols.get(x));
    }

    // [ --> ] [ empty ]
    if ((type & EDGE_END_MASK) === EDGE_END_E) {
      const x = cell.x + 1;
      checkEdgeCell(cells, cell, x, y, EDGE_END_E, EDGE_HOR, /g[rl]/, cols.get(x));
    }

    // [ empty ] [ <-- ]
    if ((type & EDGE_END_MASK) === EDGE_END_W) {
      const x = cell.x - 1;
      checkEdgeCell(cells, cell, x, y, EDGE_END_W, EDGE_HOR, /g[rl]/, cols.get(x));
    }
  }

  // Vertical cases
  {
    const x = cell.x;

    // [empty] / [ | ]
    if ((type & EDGE_START_MASK) === EDGE_START_N) {
      const y = cell.y - 1;
      checkEdgeCell(cells, cell, x, y, EDGE_START_N, EDGE_VER, /g[tb]/, rows.get(y));
    }

    // [ | ] / [ empty ]
    if ((type & EDGE_START_MASK) === EDGE_START_S) {
      const y = cell.y + 1;
      checkEdgeCell(cells, cell, x, y, EDGE_START_S, EDGE_VER, /g[tb]/, rows.get(y));
    }

    // [ v ] / [empty]
    if ((type & EDGE_END_MASK) === EDGE_END_S) {
      const y = cell.y + 1;
      checkEdgeCell(cells, cell, x, y, EDGE_END_S, EDGE_VER, /g[tb]/, rows.get(y));
    }

    // [ empty ] / [ ^ ]
    if ((type & EDGE_END_MASK) === EDGE_END_N) {
      const y = cell.y - 1;
      checkEdgeCell(cells, cell, x, y, EDGE_END_N, EDGE_VER, /g[tb]/, rows.get(y));
    }
  }

  void group;
}

function repairEdge(cells: CellMap, cell: EdgeCell, rows: RowCol): void {
  // Ported from Graph::Easy::_repair_edge.
  // Only implements the Perl-covered END_S case for now.
  const x = cell.x;
  const y = cell.y + 1;
  const belowKey = `${x},${y}`;

  if (cells.has(belowKey)) return;

  if ((cell.type & EDGE_END_MASK) !== EDGE_END_S) return;

  const row = rows.get(y);
  if (!row) return;

  const hasBorder = [...row.values()].some((c) => c instanceof GroupCell && /g[tb]/.test(c.cellClass));
  if (!hasBorder) return;

  cell.type &= ~EDGE_END_S;
  newEdgeCell(cells, undefined, cell.edge, x, y, EDGE_VER + EDGE_END_S);
}

function repairEdges(cells: CellMap): void {
  const { rows, cols } = buildRowColMaps(cells);

  const snapshot = [...cells.values()]
    .filter((c): c is EdgeCell => c instanceof EdgeCell)
    .sort((a, b) => a.x - b.x || a.y - b.y);

  for (const cell of snapshot) {
    // skip odd positions
    if ((cell.x & 1) !== 0 || (cell.y & 1) !== 0) continue;

    const group = cell.group;
    if (group) {
      repairGroupEdge(cells, cell, rows, cols, group);
    } else {
      repairEdge(cells, cell, rows);
    }
  }
}

export function fillGroupCells(graph: Graph, cellsLayout: CellMap): CellMap {
  if (graph.groups.length === 0) return cellsLayout;

  // Drop any stale group-cell state from previous layouts.
  for (const g of graph.groups) {
    g._clearCells();
  }

  // Multiply each X and Y by 2 to create room for filler cells.
  const cells: CellMap = new Map();

  const entries = [...cellsLayout.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [key, cell] of entries) {
    const [xs, ys] = key.split(",");
    const x = Number(xs) * 2;
    const y = Number(ys) * 2;

    (cell as { x?: number }).x = x;
    (cell as { y?: number }).y = y;

    cells.set(`${x},${y}`, cell);
  }

  spliceEdges(cells);
  repairNodes(graph, cells);

  insertGroupFillers(cells);
  closeGroupHoles(cells);

  for (const g of graph.groups) {
    g._setCellTypes(cells);
  }

  repairEdges(cells);

  for (const g of graph.groups) {
    g._findLabelCell();
  }

  return cells;
}
