import * as fs from "node:fs";
import * as path from "node:path";

import { Parser } from "../src/parser.js";

type SweepResult = {
  ok: number;
  fail: number;
};

function listFiles(folder: string, ext: string): string[] {
  const entries = fs.readdirSync(folder, { withFileTypes: true });
  const files: string[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!e.name.toLowerCase().endsWith(ext)) continue;
    files.push(path.join(folder, e.name));
  }
  files.sort();
  return files;
}

function sweepFolder(folder: string, ext: string): SweepResult {
  const files = listFiles(folder, ext);
  let ok = 0;
  let fail = 0;

  for (const f of files) {
    try {
      Parser.fromFile(f);
      ok++;
    } catch (err) {
      fail++;
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[FAIL] ${path.relative(process.cwd(), f)}: ${msg}\n`);
    }
  }

  return { ok, fail };
}

function main(): void {
  const dot = sweepFolder(path.join("Graph-Easy-0.76", "t", "in", "dot"), ".dot");
  const gdl = sweepFolder(path.join("Graph-Easy-0.76", "t", "in", "gdl"), ".gdl");

  process.stdout.write(
    `DOT: ok=${dot.ok} fail=${dot.fail}\nGDL: ok=${gdl.ok} fail=${gdl.fail}\nTOTAL: ok=${dot.ok + gdl.ok} fail=${dot.fail + gdl.fail}\n`
  );

  if (dot.fail + gdl.fail > 0) {
    process.exitCode = 1;
  }
}

main();
