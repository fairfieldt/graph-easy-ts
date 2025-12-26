import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

type ParsedArgs = {
  maxCases?: number;
  maxFailures: number;
  failFast: boolean;
  only?: string;
  exclude?: string;
};

function parseArgs(argv: string[]): ParsedArgs {
  const res: ParsedArgs = {
    maxFailures: 20,
    failFast: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--fail-fast") {
      res.failFast = true;
      continue;
    }

    if (a === "--max-cases") {
      const v = argv[i + 1];
      if (!v) throw new Error("--max-cases requires a value");
      res.maxCases = Number(v);
      if (!Number.isFinite(res.maxCases) || res.maxCases <= 0) {
        throw new Error("--max-cases must be a positive number");
      }
      i++;
      continue;
    }

    if (a === "--max-failures") {
      const v = argv[i + 1];
      if (!v) throw new Error("--max-failures requires a value");
      res.maxFailures = Number(v);
      if (!Number.isFinite(res.maxFailures) || res.maxFailures <= 0) {
        throw new Error("--max-failures must be a positive number");
      }
      i++;
      continue;
    }

    if (a === "--only") {
      const v = argv[i + 1];
      if (!v) throw new Error("--only requires a value");
      res.only = v;
      i++;
      continue;
    }

    if (a === "--exclude") {
      const v = argv[i + 1];
      if (!v) throw new Error("--exclude requires a value");
      res.exclude = v;
      i++;
      continue;
    }

    throw new Error(`Unknown arg: ${a}`);
  }

  return res;
}

function firstDiffIndex(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a.charCodeAt(i) !== b.charCodeAt(i)) return i;
  }
  return a.length === b.length ? -1 : n;
}

function lineColAt(text: string, idx: number): { line: number; col: number } {
  let line = 1;
  let col = 1;

  for (let i = 0; i < idx && i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 10) {
      line++;
      col = 1;
    } else {
      col++;
    }
  }

  return { line, col };
}

function isSupportedFixture(rel: string): boolean {
  return rel.endsWith(".txt") || rel.endsWith(".dot") || rel.endsWith(".gdl");
}

function listFixtures(fixturesRoot: string): string[] {
  const out: string[] = [];

  const walk = (absDir: string, relDir: string): void => {
    const entries = fs.readdirSync(absDir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const ent of entries) {
      const abs = path.join(absDir, ent.name);
      const rel = relDir ? path.posix.join(relDir, ent.name) : ent.name;

      if (ent.isDirectory()) {
        walk(abs, rel);
        continue;
      }

      if (!ent.isFile()) continue;
      if (!isSupportedFixture(rel)) continue;
      out.push(rel);
    }
  };

  walk(fixturesRoot, "");
  return out;
}

function runTsAscii(nodeExecutable: string, asAsciiJs: string, inputPath: string): childProcess.SpawnSyncReturns<string> {
  return childProcess.spawnSync(nodeExecutable, [asAsciiJs, inputPath], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
}

function runPerlAscii(repoRoot: string, inputPath: string): childProcess.SpawnSyncReturns<string> {
  // Use upstream Perl as the oracle; this makes the compare harness self-contained and avoids
  // stale golden files under GE.bak/examples_output.
  const perlCwd = path.join(repoRoot, "Graph-Easy-0.76");
  return childProcess.spawnSync("perl", ["examples/as_ascii", inputPath], {
    cwd: perlCwd,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
}

function main(): void {
  const { maxCases, maxFailures, failFast, only, exclude } = parseArgs(process.argv.slice(2));

  const repoRoot = process.cwd();
  const inputsRoot = path.join(repoRoot, "Graph-Easy-0.76", "t", "in");
  const asAsciiJs = path.join(repoRoot, "dist", "examples", "as_ascii.js");

  const fixtures = listFixtures(inputsRoot);

  let pass = 0;
  let fail = 0;
  let skip = 0;

  const limitCases = maxCases ?? fixtures.length;

  for (let i = 0; i < fixtures.length && i < limitCases; i++) {
    const rel = fixtures[i];
    const inputRel = path.posix.join("t/in", rel);

    if (only && !inputRel.includes(only)) continue;
    if (exclude && inputRel.includes(exclude)) continue;

    const inputPath = path.join(inputsRoot, rel);

    const perl = runPerlAscii(repoRoot, inputPath);
    if (perl.status !== 0) {
      skip++;
      const stderr = perl.stderr ?? "";
      process.stderr.write(
        `[SKIP:perl] ${inputRel} (exit=${perl.status})\n` +
          (stderr ? stderr.split(/\r?\n/).slice(0, 20).join("\n") + "\n" : "")
      );
      continue;
    }

    const expected = perl.stdout ?? "";

    const ts = runTsAscii(process.execPath, asAsciiJs, inputPath);
    if (ts.status !== 0) {
      fail++;
      const stderr = ts.stderr ?? "";
      process.stderr.write(
        `[FAIL:runtime] ${inputRel} (exit=${ts.status})\n` + (stderr ? stderr.split(/\r?\n/).slice(0, 20).join("\n") + "\n" : "")
      );

      if (failFast || fail >= maxFailures) break;
      continue;
    }

    const stdout = ts.stdout ?? "";
    if (stdout === expected) {
      pass++;
      continue;
    }

    fail++;
    const idx = firstDiffIndex(stdout, expected);
    const pos = idx === -1 ? { line: 1, col: 1 } : lineColAt(expected, idx);
    process.stderr.write(`[FAIL:diff] ${inputRel} (first mismatch at line ${pos.line}, col ${pos.col})\n`);

    if (failFast || fail >= maxFailures) break;
  }

  process.stdout.write(`pass=${pass} fail=${fail} skip=${skip} (maxFailures=${maxFailures})\n`);
  process.exitCode = fail === 0 ? 0 : 1;
}

try {
  main();
} catch (err) {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(msg + "\n");
  process.exitCode = 1;
}
