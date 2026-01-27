import { Parser } from '../src/parser.js';
import { Graph } from '../src/graph.js';
import { Node } from '../src/node.js';
import { EdgeCell } from '../src/layout/edgeCell.js';
import { EdgeCellEmpty } from '../src/layout/edgeCellEmpty.js';
import { GroupCell } from '../src/layout/groupCell.js';
import { NodeCell } from '../src/layout/nodeCell.js';
import {
  EDGE_FLAG_MASK,
  EDGE_TYPE_MASK,
} from '../src/layout/edgeCellTypes.js';

function keyToXY(key: string): { x: number; y: number } {
  const [xs, ys] = key.split(',');
  return { x: Number(xs), y: Number(ys) };
}

function str(n: unknown): string {
  return n === undefined || n === null ? '' : String(n);
}

function cellKind(cell: unknown): string {
  if (cell instanceof EdgeCell) return 'EDGE';
  if (cell instanceof EdgeCellEmpty) return 'EMPTY';
  if (cell instanceof NodeCell) return 'NODECELL';
  if (cell instanceof GroupCell) return 'GROUPCELL';
  if (cell && typeof cell === 'object' && (cell as any).isa_node_cell) return 'NODECELL';
  return (cell as any)?.constructor?.name ?? typeof cell;
}

function dump(graph: Graph, file: string) {
  console.log(`FILE\t${file}`);
  console.log(`FLOW\t${str(graph.flow())}`);

  const nodes = Array.from(graph.nodes()).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const n of nodes) {
    console.log(
      `NODE\t${n.id}\trank=${str(n.rank)}\tx=${str(n.x)}\ty=${str(n.y)}\tcx=${str(n.cx)}\tcy=${str(n.cy)}\tw=${str((n as any).w)}\th=${str((n as any).h)}`,
    );
  }

  const edges = Array.from(graph.edges);
  for (const e of edges) {
    console.log(
      `EDGE\t${str(e.id)}\t${e.from.id}\t${e.to.id}\tstart=${str(e.attribute('start'))}\tend=${str(e.attribute('end'))}`,
    );
  }

  if (!graph.cells) {
    throw new Error('graph.cells is undefined (did layout run?)');
  }

  const entries = Array.from(graph.cells.entries()).sort(([a], [b]) => {
    const aa = keyToXY(a);
    const bb = keyToXY(b);
    return aa.y - bb.y || aa.x - bb.x;
  });

  for (const [key, cell] of entries) {
    const { x, y } = keyToXY(key);
    if (cell instanceof EdgeCell) {
      const type = cell.type;
      const base = type & EDGE_TYPE_MASK;
      const flags = type & EDGE_FLAG_MASK;
      console.log(
        `CELL\t${x}\t${y}\tEDGE\tedge=${str(cell.edge?.id)}\ttype=${type}\tbase=${base}\tflags=${flags}`,
      );
      continue;
    }

    if (cell instanceof NodeCell) {
      console.log(`CELL\t${x}\t${y}\tNODECELL\tname=${cell.node.id}\ttype=${str((cell as any).type)}`);
      continue;
    }

    if (cell instanceof EdgeCellEmpty) {
      console.log(`CELL\t${x}\t${y}\tEMPTY`);
      continue;
    }

    if (cell instanceof GroupCell) {
      console.log(
        `CELL\t${x}\t${y}\tGROUPCELL\tname=${cell.group.name}\tclass=${str(cell.cellClass)}\thasLabel=${cell.hasLabel ? 1 : 0}\tlabel=${str(cell.label)}\tw=${str(cell.w)}\th=${str(cell.h)}\tcx=${str(cell.cx)}\tcy=${str(cell.cy)}\tborderstyle=${str(cell.group.attribute('borderstyle'))}\tlabelpos=${str(cell.group.attribute('labelpos'))}`,
      );
      continue;
    }

    if (cell && typeof cell === 'object' && (cell as any).node && (cell as any).node instanceof Node) {
      const node = (cell as any).node as Node;
      console.log(`CELL\t${x}\t${y}\tNODE\tname=${node.id}`);
      continue;
    }

    if (cell && typeof cell === 'object' && (cell as any).group) {
      const group = (cell as any).group;
      console.log(`CELL\t${x}\t${y}\tGROUP\tname=${str(group?.name)}`);
      continue;
    }

    console.log(`CELL\t${x}\t${y}\t${cellKind(cell)}`);
  }
}

async function main() {
  const file = process.argv[2] ?? 'Graph-Easy-0.76/t/in/3_joining.txt';
  const graph = await Parser.fromFile(file);
  graph.layout();
  // Ensure ASCII sizing has run so node.w/node.h are populated.
  graph.asAscii();
  dump(graph, file);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
