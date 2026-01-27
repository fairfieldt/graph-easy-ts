import type { Group } from "../group.js";
import type { Node } from "../node.js";

export class NodeCell {
  public constructor(
    public readonly node: Node,
    public x: number,
    public y: number
  ) {}

  public isNodeCell(): boolean {
    return true;
  }

  public get group(): Group | undefined {
    return this.node.group;
  }
}
