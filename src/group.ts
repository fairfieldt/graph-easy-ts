import { mergeAttributes, type Attributes } from "./attributes";

import type { Graph } from "./graph";
import type { Node } from "./node";
import type { GroupCell } from "./layout/groupCell";

export class Group {
  public readonly attributes: Attributes = Object.create(null);
  public readonly nodes = new Set<Node>();
  public readonly groups: Group[] = [];

  private readonly cellsByXY = new Map<string, GroupCell>();

  public graph: Graph | undefined;
  public parent: Group | undefined;

  public constructor(public readonly name: string) {}

  public setAttributes(attrs: Attributes): void {
    mergeAttributes(this.attributes, attrs);
  }

  public rawAttribute(key: string): string | undefined {
    return this.attributes[key];
  }

  public attribute(key: string): string {
    return this.attributes[key] ?? "";
  }

  public label(): string {
    return this.name.endsWith(":") ? this.name : `${this.name}:`;
  }

  public addNode(node: Node): void {
    this.nodes.add(node);
    node.group = this;
  }

  public addGroup(group: Group): void {
    group.parent = this;
    group.graph = this.graph;
    this.groups.push(group);
  }

  // ---------------------------------------------------------------------------
  // GroupCell bookkeeping (used by the layouter)

  public _clearCells(): void {
    this.cellsByXY.clear();
  }

  public _addCell(cell: GroupCell): void {
    this.cellsByXY.set(`${cell.x},${cell.y}`, cell);
  }

  public _delCellAt(x: number, y: number): void {
    this.cellsByXY.delete(`${x},${y}`);
  }

  public _setCellTypes(cells: Map<string, unknown>): void {
    for (const cell of this.cellsByXY.values()) {
      cell.setType(cells);
    }
  }

  public _findLabelCell(): void {
    // Ported from Graph::Easy::Group::_find_label_cell.
    const align = this.attribute("align").trim().toLowerCase() || "left";
    const loc = this.attribute("labelpos").trim().toLowerCase();

    const want = loc === "bottom" ? "gb" : "gt";

    let lc: GroupCell | undefined;

    const entries = [...this.cellsByXY.entries()].sort(([a], [b]) => a.localeCompare(b));
    for (const [, c] of entries) {
      if (c.cellClass.trim() !== want) continue;

      if (!lc) {
        lc = c;
        continue;
      }

      if (align === "left") {
        // top-most, left-most
        if (lc.y < c.y) continue;
        if (lc.y === c.y && lc.x <= c.x) continue;
      } else if (align === "center") {
        // any top-most
        if (lc.y < c.y) continue;
      } else if (align === "right") {
        // top-most, right-most
        if (lc.y < c.y) continue;
        if (lc.y === c.y && lc.x >= c.x) continue;
      }

      lc = c;
    }

    if (lc && align === "center") {
      let left: number | undefined;
      let right: number | undefined;

      for (const c of this.cellsByXY.values()) {
        if (c.y !== lc.y) continue;
        left = left === undefined ? c.x : Math.min(left, c.x);
        right = right === undefined ? c.x : Math.max(right, c.x);
      }

      if (left !== undefined && right !== undefined) {
        const center = Math.trunc((right - left) / 2 + left);
        let minDist: number | undefined;
        for (const c of this.cellsByXY.values()) {
          if (c.y !== lc.y) continue;
          const d = center - c.x;
          const dist = d * d;
          if (minDist !== undefined && dist > minDist) continue;
          minDist = dist;
          lc = c;
        }
      }
    }

    lc?.setLabel();
  }
}
