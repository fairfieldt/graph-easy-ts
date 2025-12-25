// A simple sorted-array heap used by the Perl layouter for ranks + A*.
//
// This intentionally matches Graph::Easy::Heap behavior: it keeps elements sorted
// by the first numeric field.

export class Heap<T extends [number, ...unknown[]]> {
  private heap: T[] = [];

  public add(elem: T): void {
    if (this.heap.length === 0) {
      this.heap.push(elem);
      return;
    }

    if (elem[0] < this.heap[0][0]) {
      this.heap.unshift(elem);
      return;
    }

    if (elem[0] > this.heap[this.heap.length - 1][0]) {
      this.heap.push(elem);
      return;
    }

    // Linear insert for small heaps, binary search otherwise.
    if (this.heap.length < 10) {
      for (let i = 0; i < this.heap.length; i++) {
        if (this.heap[i][0] > elem[0]) {
          this.heap.splice(i, 0, elem);
          return;
        }
      }
      this.heap.push(elem);
      return;
    }

    let l = 0;
    let r = this.heap.length;
    while (r - l > 2) {
      const m = Math.floor((r - l) / 2 + l);
      if (this.heap[m][0] <= elem[0]) l = m;
      else r = m;
    }

    while (l < this.heap.length) {
      if (this.heap[l][0] > elem[0]) {
        this.heap.splice(l, 0, elem);
        return;
      }
      l++;
    }

    this.heap.push(elem);
  }

  public elements(): number {
    return this.heap.length;
  }

  public extractTop(): T | undefined {
    return this.heap.shift();
  }

  public deleteByXY(x: number, y: number): void {
    for (let i = 0; i < this.heap.length; i++) {
      const e = this.heap[i];
      // This matches the Perl heap usage where x/y are stored at indices 1/2.
      const ex = e[1] as unknown as number;
      const ey = e[2] as unknown as number;
      if (ex === x && ey === y) {
        this.heap.splice(i, 1);
        return;
      }
    }
  }
}
