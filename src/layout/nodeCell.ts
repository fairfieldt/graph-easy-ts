import type { Group } from "../group";
import type { Node } from "../node";

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
