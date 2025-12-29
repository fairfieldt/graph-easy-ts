#!/usr/bin/env node

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { Parser } from "./parser";
import { parseDot } from "./parser_dot";
import { parseGdl } from "./parser_gdl";
import type { Graph } from "./graph";

type Options = {
  input?: string;
  output?: string;
  as?: string;
  from?: string;
  help?: boolean;
  version?: boolean;
  verbose?: boolean;
  debug?: number;
  parse?: boolean;
  stats?: boolean;
  timeout?: number;
  renderer?: string;
};

const externalFormats = ["png", "bmp", "gif", "jpg", "pdf", "ps", "ps2", "tif", "tga", "pcl", "hpgl"];
const externalSet = new Set(externalFormats);

const supportedOutputs = new Set([
  "ascii",
  "boxart",
  "txt",
  "graphviz",
  "dot",
  "html",
  "graphml",
  "svg",
  "vcg",
  "gdl",
  ...externalFormats,
]);
const supportedInputs = new Set(["txt", "graphviz", "dot", "gdl", "vcg"]);

function printHelp(): void {
  const out = `graph-easy (TypeScript port of Graph::Easy 0.76)

Usage:
  graph-easy [options] [inputfile [outputfile]]

Examples:
  echo "[ Bonn ] - car -> [ Berlin ]" | graph-easy
  graph-easy --input=graph.dot --as_ascii
  graph-easy graph.txt graphviz.dot
  graph-easy graph.txt --png

Options:
  --help, -?, -h        Show this help
  --version             Print version info
  --input=FILE          Input file (defaults to STDIN)
  --output=FILE         Output file (defaults to STDOUT)
  --from=FORMAT         Input format: txt, graphviz|dot, gdl|vcg
  --as=FORMAT           Output format: ascii, boxart, txt, graphviz|dot
                        html, graphml, svg, vcg, gdl
                        External via renderer: ${externalFormats.join(", ")}
  --renderer=CMD        Graphviz renderer for external formats (default: dot)
  --parse               Parse only, no output
  --stats               Print graph stats to STDERR
  --timeout=SECONDS     Layout timeout (ASCII/boxart only; best-effort)
  --verbose             Verbose logging to STDERR

Format shortcuts:
  --ascii, --boxart, --txt, --graphviz, --dot, --html, --graphml, --svg, --vcg, --gdl
  --as_ascii, --as_boxart, --as_txt, --as_graphviz, --as_dot, --as_html, --as_graphml, --as_svg, --as_vcg, --as_gdl
  --from_txt, --from_graphviz, --from_dot, --from_gdl, --from_vcg
  --png, --gif, --pdf, ... (external formats)
`;
  process.stderr.write(out);
}

function printVersion(): void {
  const pkgPath = path.resolve(__dirname, "../../package.json");
  let version = "unknown";
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: string };
    if (pkg.version) version = pkg.version;
  } catch {
    // Best-effort version output.
  }
  process.stdout.write(`graph-easy-ts ${version} (port of Graph::Easy 0.76)\n`);
}

function warn(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

function setAs(opt: Options, format: string): void {
  if (opt.as && opt.as !== format) {
    warn(`Warning: Output format '${format}' overrides specified '${opt.as}'`);
  }
  opt.as = format;
}

function setFrom(opt: Options, format: string): void {
  opt.from = format;
}

function parseArgs(argv: string[]): { opt: Options; positional: string[] } {
  const opt: Options = {
    as: "",
    from: "",
    renderer: "dot",
    timeout: 240,
  };
  const positional: string[] = [];

  const expectValue = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (!v) throw new Error(`${flag} requires a value`);
    return v;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }

    if (!arg.startsWith("-")) {
      positional.push(arg);
      continue;
    }

    if (arg === "--help" || arg === "-?" || arg === "-h") {
      opt.help = true;
      continue;
    }
    if (arg === "--version") {
      opt.version = true;
      continue;
    }
    if (arg === "--verbose") {
      opt.verbose = true;
      continue;
    }
    if (arg === "--parse") {
      opt.parse = true;
      continue;
    }
    if (arg === "--stats") {
      opt.stats = true;
      continue;
    }

    if (arg.startsWith("--input=")) {
      opt.input = arg.slice("--input=".length);
      continue;
    }
    if (arg.startsWith("--output=")) {
      opt.output = arg.slice("--output=".length);
      continue;
    }
    if (arg.startsWith("--as=")) {
      setAs(opt, arg.slice("--as=".length));
      continue;
    }
    if (arg.startsWith("--from=")) {
      setFrom(opt, arg.slice("--from=".length));
      continue;
    }
    if (arg.startsWith("--renderer=")) {
      opt.renderer = arg.slice("--renderer=".length);
      continue;
    }
    if (arg.startsWith("--debug=")) {
      opt.debug = Number(arg.slice("--debug=".length));
      continue;
    }
    if (arg.startsWith("--timeout=")) {
      opt.timeout = Number(arg.slice("--timeout=".length));
      continue;
    }

    if (arg === "--input") {
      opt.input = expectValue(i, "--input");
      i++;
      continue;
    }
    if (arg === "--output") {
      opt.output = expectValue(i, "--output");
      i++;
      continue;
    }
    if (arg === "--as") {
      setAs(opt, expectValue(i, "--as"));
      i++;
      continue;
    }
    if (arg === "--from") {
      setFrom(opt, expectValue(i, "--from"));
      i++;
      continue;
    }
    if (arg === "--renderer") {
      opt.renderer = expectValue(i, "--renderer");
      i++;
      continue;
    }
    if (arg === "--debug") {
      opt.debug = Number(expectValue(i, "--debug"));
      i++;
      continue;
    }
    if (arg === "--timeout") {
      opt.timeout = Number(expectValue(i, "--timeout"));
      i++;
      continue;
    }

    if (arg === "--ascii" || arg === "--as_ascii") {
      setAs(opt, "ascii");
      continue;
    }
    if (arg === "--boxart" || arg === "--as_boxart") {
      setAs(opt, "boxart");
      continue;
    }
    if (arg === "--txt" || arg === "--as_txt") {
      setAs(opt, "txt");
      continue;
    }
    if (arg === "--graphviz" || arg === "--as_graphviz" || arg === "--dot" || arg === "--as_dot") {
      setAs(opt, "graphviz");
      continue;
    }
    if (arg === "--from_txt") {
      setFrom(opt, "txt");
      continue;
    }
    if (arg === "--from_graphviz" || arg === "--from_dot") {
      setFrom(opt, "graphviz");
      continue;
    }
    if (arg === "--from_gdl") {
      setFrom(opt, "gdl");
      continue;
    }
    if (arg === "--from_vcg") {
      setFrom(opt, "vcg");
      continue;
    }

    if (arg.startsWith("--as_")) {
      const fmt = arg.slice("--as_".length);
      if (supportedOutputs.has(fmt)) {
        setAs(opt, fmt);
        continue;
      }
    }

    if (arg.startsWith("--from_")) {
      const fmt = arg.slice("--from_".length);
      if (supportedInputs.has(fmt)) {
        setFrom(opt, fmt);
        continue;
      }
    }

    if (arg.startsWith("--")) {
      const fmt = arg.slice(2);
      if (supportedOutputs.has(fmt)) {
        setAs(opt, fmt);
        continue;
      }
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { opt, positional };
}

function normalizeAs(raw: string | undefined): string {
  const v = (raw || "").trim().toLowerCase();
  if (v === "dot") return "graphviz";
  return v;
}

function normalizeFrom(raw: string | undefined): string {
  const v = (raw || "").trim().toLowerCase();
  if (v === "dot") return "graphviz";
  if (v === "vcg") return "gdl";
  return v;
}

function inferFormatFromPath(filePath: string): string | undefined {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".dot") return "graphviz";
  if (ext === ".gdl" || ext === ".vcg") return "gdl";
  if (ext === ".txt") return "txt";
  return undefined;
}

function detectFormatFromText(text: string): string {
  const trimmed = text.trimStart();
  if (/^(strict\s+)?(graph|digraph)\b/i.test(trimmed)) return "graphviz";
  if (/^graph\s*:\s*\{/i.test(trimmed)) return "gdl";
  return "txt";
}

function parseGraph(text: string, format: string): Graph {
  if (format === "graphviz") return parseDot(text);
  if (format === "gdl") return parseGdl(text);
  if (format === "txt") return Parser.fromText(text);
  throw new Error(`Unknown input format '${format}'`);
}

function isUndirectedGraph(graph: Graph): boolean {
  for (const edge of graph.edges) {
    if (!edge.undirected) return false;
  }
  return true;
}

function isSimpleGraph(graph: Graph): boolean {
  const seen = new Set<string>();
  for (const edge of graph.edges) {
    const a = edge.from.id;
    const b = edge.to.id;
    const key = edge.undirected ? [a, b].sort().join("--") : `${a}->${b}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

function printStats(graph: Graph): void {
  const nodes = graph.getNodeCount();
  const edges = graph.edges.length;
  const groups = graph.groups.length;

  const simple = isSimpleGraph(graph) ? "simple" : "multi-edged";
  const directed = isUndirectedGraph(graph) ? "undirected" : "directed";

  process.stderr.write(`\nInput is a ${simple}, ${directed} graph with:\n`);
  process.stderr.write(
    `    ${nodes} node${nodes !== 1 ? "s" : ""}, ${edges} edge${edges !== 1 ? "s" : ""} and ${groups} group${
      groups !== 1 ? "s" : ""
    }\n\n`
  );

  for (const g of graph.groups) {
    const groupNodes = g.nodes.size;
    const groupEdges = graph.edges.filter((e) => e.group === g).length;
    const groupGroups = g.groups.length;
    process.stderr.write(`  Group '${g.name}':\n`);
    process.stderr.write(
      `    ${groupNodes} node${groupNodes !== 1 ? "s" : ""}, ${groupEdges} edge${
        groupEdges !== 1 ? "s" : ""
      } and ${groupGroups} group${groupGroups !== 1 ? "s" : ""}\n\n`
    );
  }
}

function outputText(data: string, outputPath?: string): void {
  if (!outputPath) {
    process.stdout.write(data);
    return;
  }
  fs.writeFileSync(outputPath, data, "utf8");
}

function outputExternal(data: string, format: string, outputPath: string, renderer: string): void {
  const result = childProcess.spawnSync(renderer, ["-T" + format, "-o", outputPath], {
    input: data,
    encoding: "utf8",
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${renderer} exited with status ${result.status ?? "unknown"}`);
  }
}

function main(): void {
  const { opt, positional } = parseArgs(process.argv.slice(2));
  const fromExplicit = Boolean(opt.from);

  if (opt.help || (process.argv.length <= 2 && process.stdin.isTTY)) {
    printHelp();
    process.exit(2);
  }

  if (opt.version) {
    printVersion();
    process.exit(0);
  }

  if (positional.length > 2) {
    throw new Error("Too many positional arguments");
  }

  if (positional.length > 0) {
    opt.input = positional[0];
  }
  if (positional.length > 1) {
    opt.output = positional[1];
  }

  const inputName = opt.input ?? "STDIN";
  const text = opt.input ? fs.readFileSync(opt.input, "utf8") : fs.readFileSync(0, "utf8");

  let from =
    normalizeFrom(opt.from) ||
    (opt.input ? inferFormatFromPath(opt.input) : undefined) ||
    detectFormatFromText(text);

  if (!fromExplicit && from === "graphviz") {
    const trimmed = text.trimStart();
    if (trimmed.startsWith("(") || trimmed.startsWith("[")) {
      from = "txt";
    }
  }

  const verbose = Boolean(opt.verbose);
  if (verbose) {
    warn(`Parsing input in ${from} from ${inputName}.`);
  }

  const graph = parseGraph(text, from);

  if (opt.stats) {
    printStats(graph);
  }

  if (opt.parse) {
    return;
  }

  const renderer = opt.renderer || "dot";

  let as = normalizeAs(opt.as);
  if (!as && opt.output) {
    const ext = path.extname(opt.output).toLowerCase().replace(/^\./, "");
    if (externalSet.has(ext)) {
      as = ext;
    } else if (ext === "txt") {
      as = "ascii";
    } else if (ext === "dot") {
      as = "graphviz";
    } else if (ext === "html" || ext === "htm") {
      as = "html";
    } else if (ext === "svg") {
      as = "svg";
    } else if (ext === "graphml") {
      as = "graphml";
    } else if (ext === "vcg") {
      as = "vcg";
    } else if (ext === "gdl") {
      as = "gdl";
    }
  }
  if (!as) as = "ascii";

  if (!supportedOutputs.has(as)) {
    throw new Error(`Unknown output format '${as}'`);
  }

  const external = externalSet.has(as);

  let outputPath = opt.output;
  if (external && !outputPath) {
    const base = opt.input ?? "graph.txt";
    const extRegex = new RegExp(`\\.(txt|dot|vcg|gdl|graphml|${externalFormats.join("|")})$`, "i");
    const stem = base.replace(extRegex, "");
    outputPath = `${stem}.${as}`;
  }

  if (verbose) {
    if (external && outputPath) {
      warn(`Piping output to '${renderer} -T${as} -o "${outputPath}"'.`);
    } else {
      warn(`Writing output as ${as} to ${outputPath ?? "STDOUT"}.`);
    }
  }

  const timeout = Math.abs(opt.timeout ?? 240);
  graph.timeout = timeout;

  if (external) {
    if (!outputPath) throw new Error("External output formats require an output file");
    const graphvizText = graph.asGraphviz();
    outputExternal(graphvizText, as, outputPath, renderer);
  } else {
    let out = "";
    if (as === "ascii") out = graph.asAscii();
    else if (as === "boxart") out = graph.asBoxart();
    else if (as === "txt") out = graph.asTxt();
    else if (as === "html") out = graph.asHtml();
    else if (as === "graphml") out = graph.asGraphml();
    else if (as === "svg") out = graph.asSvg();
    else if (as === "vcg" || as === "gdl") out = graph.asVcg(as);
    else out = graph.asGraphviz();
    outputText(out, outputPath);
  }

  if (verbose) {
    warn("Everything done. Have fun!");
  }
}

try {
  main();
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}
