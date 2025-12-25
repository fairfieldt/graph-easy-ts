import * as fs from "node:fs";

import { Parser } from "../src/parser";

function readStdinUtf8(): string {
  // FD 0 is stdin.
  return fs.readFileSync(0, "utf8");
}

function main(): void {
  const [, , fileArg, idArg] = process.argv;

  const graph = fileArg ? Parser.fromFile(fileArg) : Parser.fromText(readStdinUtf8());
  if (idArg) {
    graph.id = idArg;
  }
  graph.timeout = 360;

  graph.layout();
  process.stdout.write(graph.asAscii());
}

try {
  main();
} catch (err) {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(msg + "\n");
  process.exitCode = 1;
}
