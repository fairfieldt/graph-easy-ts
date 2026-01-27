import type { Group } from "../group.js";

export class GroupCell {
  public w: number | undefined;
  public h: number | undefined;

  public cx: number | undefined;
  public cy: number | undefined;

  public cellClass = " gi";

  public hasLabel = false;
  public label = "";

  public constructor(
    public readonly group: Group,
    public x: number,
    public y: number
  ) {
    group._addCell(this);
  }

  public isGroupCell(): boolean {
    return true;
  }

  public setType(cells: Map<string, unknown>): void {
    // Ported from Graph::Easy::Group::Cell::_set_type.
    const coord: Array<[number, number, string]> = [
      [0, -1, " gt"],
      [+1, 0, " gr"],
      [0, +1, " gb"],
      [-1, 0, " gl"],
    ];

    const sx = this.x;
    const sy = this.y;

    let cls = "";
    for (const [dx, dy, c] of coord) {
      const other = cells.get(`${sx + dx},${sy + dy}`) as { group?: Group } | undefined;
      const go = other?.group;
      if (!(go && go === this.group)) {
        cls += c;
      }
    }

    if (cls === " gt gr gb gl") {
      cls = " ga";
    }

    this.cellClass = cls;
  }

  public setLabel(): void {
    this.hasLabel = true;
    this.label = this.group.label();
  }
}
