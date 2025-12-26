import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

type Case = {
  inputRel: string;
};

function parseArgs(argv: string[]): {
  maxCases?: number;
  maxFailures: number;
  failFast: boolean;
  only?: string;
  exclude?: string;
} {
  const res: {
    maxCases?: number;
    maxFailures: number;
    failFast: boolean;
    only?: string;
    exclude?: string;
  } = {
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

function readIndexFile(indexPath: string): Case[] {
  const lines = fs.readFileSync(indexPath, "utf8").split(/\r?\n/);
  const cases: Case[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    const m = /^-\s+(\S+)\s*$/.exec(line);
    if (!m) {
      throw new Error(`Bad INDEX.txt line: ${raw}`);
    }

    cases.push({ inputRel: m[1] });
  }

  return cases;
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

function main(): void {
  const { maxCases, maxFailures, failFast, only, exclude } = parseArgs(process.argv.slice(2));

  const repoRoot = process.cwd();

  const casesRoot = path.join(repoRoot, "custom_cases", "ascii");
  const indexPath = path.join(casesRoot, "INDEX.txt");

  const asAsciiJs = path.join(repoRoot, "dist", "examples", "as_ascii.js");

  const perlRoot = path.join(repoRoot, "Graph-Easy-0.76");
  const perlAsAscii = path.join(perlRoot, "examples", "as_ascii");

  const cases = readIndexFile(indexPath);

  let pass = 0;
  let fail = 0;

  const limitCases = maxCases ?? cases.length;

  for (let i = 0; i < cases.length && i < limitCases; i++) {
    const c = cases[i];

    if (only && !c.inputRel.includes(only)) continue;
    if (exclude && c.inputRel.includes(exclude)) continue;

    const inputPath = path.join(casesRoot, c.inputRel);

    const perl = childProcess.spawnSync("perl", [perlAsAscii, inputPath], {
      cwd: perlRoot,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    });

    if (perl.status !== 0) {
      fail++;
      const stderr = perl.stderr ?? "";
      process.stderr.write(`[FAIL:perl-runtime] ${c.inputRel} (exit=${perl.status})\n`);
      if (stderr) process.stderr.write(stderr.split(/\r?\n/).slice(0, 40).join("\n") + "\n");
      if (failFast || fail >= maxFailures) break;
      continue;
    }

    const expected = perl.stdout ?? "";

    const ts = childProcess.spawnSync(process.execPath, [asAsciiJs, inputPath], {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    });

    if (ts.status !== 0) {
      fail++;
      const stderr = ts.stderr ?? "";
      process.stderr.write(`[FAIL:ts-runtime] ${c.inputRel} (exit=${ts.status})\n`);
      if (stderr) process.stderr.write(stderr.split(/\r?\n/).slice(0, 40).join("\n") + "\n");
      if (failFast || fail >= maxFailures) break;
      continue;
    }

    const actual = ts.stdout ?? "";

    if (actual === expected) {
      pass++;
      continue;
    }

    fail++;
    const idx = firstDiffIndex(actual, expected);
    const pos = idx === -1 ? { line: 1, col: 1 } : lineColAt(expected, idx);
    process.stderr.write(`[FAIL:diff] ${c.inputRel} (first mismatch at line ${pos.line}, col ${pos.col})\n`);

    if (failFast || fail >= maxFailures) break;
  }

  process.stdout.write(`pass=${pass} fail=${fail} (maxFailures=${maxFailures})\n`);
  process.exitCode = fail === 0 ? 0 : 1;
}

try {
  main();
} catch (err) {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(msg + "\n");
  process.exitCode = 1;
}
