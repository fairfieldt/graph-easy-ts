/// <reference types="vite/client" />

import { Parser } from "../../src/parser";
import { instance as vizInstance, type Viz } from "@viz-js/viz";

const EXAMPLE = String.raw`# graph-easy-ts (TypeScript port) — rough module map

# Entry points
[ site/src/main.ts ] --> { label: imports } [ src/parser.ts ]
[ src/index.ts ] --> { label: exports } [ src/parser.ts ]
[ src/index.ts ] --> { label: exports } [ src/graph.ts ]

# Core pipeline
[ src/parser.ts ] --> { label: fromText() } [ src/graph.ts ]
[ src/graph.ts ] --> { label: layout() } [ src/layout/layout.ts ]

# Layout engine (simplified)
[ src/layout/layout.ts ] --> [ src/layout/scout.ts ]
[ src/layout/layout.ts ] --> [ src/layout/repair.ts ]
[ src/layout/layout.ts ] --> [ src/layout/chain.ts ]
[ src/layout/layout.ts ] --> [ src/layout/heap.ts ]

# Graph model
[ src/graph.ts ] --> { label: owns } [ src/node.ts ]
[ src/graph.ts ] --> { label: owns } [ src/edge.ts ]
[ src/graph.ts ] --> { label: owns } [ src/group.ts ]

# Renderers
[ src/graph.ts ] --> { label: asAscii() } [ src/ascii.ts ]
[ src/graph.ts ] --> { label: asBoxart() } [ src/ascii.ts ]
[ src/graph.ts ] --> { label: asTxt() } [ src/txt.ts ]
[ src/graph.ts ] --> { label: asGraphviz() } [ src/graphviz.ts ]
`;

type StatusKind = "idle" | "ok" | "err" | "busy";

type OutputFormat = "ascii" | "boxart" | "txt" | "graphviz";

function setPill(el: HTMLElement, kind: StatusKind, text: string): void {
  el.textContent = text;
  if (kind === "ok") {
    el.style.color = "rgba(125,211,252,0.95)";
    return;
  }
  if (kind === "err") {
    el.style.color = "rgba(251,113,133,0.95)";
    return;
  }
  if (kind === "busy") {
    el.style.color = "rgba(167,139,250,0.95)";
    return;
  }
  el.style.color = "rgba(255,255,255,0.65)";
}

function debounce<TArgs extends unknown[]>(fn: (...args: TArgs) => void, waitMs: number) {
  let t: number | undefined;
  return (...args: TArgs) => {
    if (t !== undefined) window.clearTimeout(t);
    t = window.setTimeout(() => fn(...args), waitMs);
  };
}

function diffAscii(a: string, b: string): string {
  if (a === b) return "(exact match)";

  const aLines = a.replace(/\r\n?/g, "\n").split("\n");
  const bLines = b.replace(/\r\n?/g, "\n").split("\n");
  const max = Math.max(aLines.length, bLines.length);

  const out: string[] = [];
  for (let i = 0; i < max; i++) {
    const al = aLines[i] ?? "";
    const bl = bLines[i] ?? "";
    if (al === bl) continue;
    out.push(`L${String(i + 1).padStart(3, "0")}: TS: ${al}`);
    out.push(`      PERL: ${bl}`);
    out.push("");
  }

  return out.join("\n");
}

function parseOutputFormat(raw: string): OutputFormat {
  if (raw === "ascii" || raw === "boxart" || raw === "txt" || raw === "graphviz") return raw;
  throw new Error(`Unknown output format: ${raw}`);
}

declare const Perl: any;

type GraphvizView = "rendered" | "text";

let vizPromise: Promise<Viz> | undefined;
function getViz(): Promise<Viz> {
  if (!vizPromise) vizPromise = vizInstance();
  return vizPromise;
}

type WebPerlState =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "error"; error: string };

let webPerlState: WebPerlState = { kind: "loading" };

async function initWebPerl(perlStatus: HTMLElement, perlOutput: HTMLElement): Promise<void> {
  if (typeof Perl === "undefined") {
    webPerlState = { kind: "error", error: "WebPerl is not available (script failed to load)." };
    setPill(perlStatus, "err", "webperl missing");
    perlOutput.textContent = webPerlState.error;
    return;
  }

  setPill(perlStatus, "busy", "initializing…");

  await new Promise<void>((resolve) => {
    Perl.init(() => resolve());
  });

  // Start a minimal Perl process. This loads the interpreter.
  Perl.start(["-e", "0"]);

  // Ensure Graph::Easy modules are available in the virtual FS.
  setPill(perlStatus, "busy", "loading Graph::Easy modules…");

  const FS: any = (globalThis as any).FS;
  if (!FS) {
    webPerlState = { kind: "error", error: "WebPerl initialized, but FS API is missing." };
    setPill(perlStatus, "err", "fs missing");
    perlOutput.textContent = webPerlState.error;
    return;
  }

  // Manifest lists Perl files relative to Graph-Easy-0.76/lib.
  // Use Vite's BASE_URL so this works on GitHub Pages (/REPO_NAME/).
  const manifestUrl = `${import.meta.env.BASE_URL}Graph-Easy-0.76/manifest.json`;
  const manifestRes = await fetch(manifestUrl);
  if (!manifestRes.ok) {
    webPerlState = {
      kind: "error",
      error: `Failed to load Graph::Easy manifest (${manifestRes.status} ${manifestRes.statusText})`,
    };
    setPill(perlStatus, "err", "manifest missing");
    perlOutput.textContent = webPerlState.error;
    return;
  }

  const files: string[] = await manifestRes.json();

  // Emscripten helper exists on newer builds; fall back to manual mkdir.
  const mkdirTree = (path: string) => {
    if (typeof FS.mkdirTree === "function") {
      FS.mkdirTree(path);
      return;
    }

    const parts = path.split("/").filter(Boolean);
    let cur = "";
    for (const part of parts) {
      cur += `/${part}`;
      try {
        FS.mkdir(cur);
      } catch {
        // ignore EEXIST
      }
    }
  };

  for (const rel of files) {
    const url = `${import.meta.env.BASE_URL}Graph-Easy-0.76/lib/${rel}`;
    const res = await fetch(url);
    if (!res.ok) {
      webPerlState = { kind: "error", error: `Failed to fetch ${url}` };
      setPill(perlStatus, "err", "module fetch failed");
      perlOutput.textContent = webPerlState.error;
      return;
    }

    const content = await res.text();
    const fullPath = `/Graph-Easy-0.76/lib/${rel}`;

    const dir = fullPath.split("/").slice(0, -1).join("/") || "/";
    mkdirTree(dir);

    // Write as UTF-8 text.
    FS.writeFile(fullPath, content);
  }

  webPerlState = { kind: "ready" };
  setPill(perlStatus, "ok", `ready (${files.length} files)`);
}

function renderTs(text: string, format: OutputFormat): { out: string; ms: number } {
  const t0 = performance.now();
  const graph = Parser.fromText(text);
  graph.timeout = 360;
  graph.layout();
  let out = "";
  if (format === "ascii") out = graph.asAscii();
  else if (format === "boxart") out = graph.asBoxart();
  else if (format === "txt") out = graph.asTxt();
  else out = graph.asGraphviz();
  const ms = performance.now() - t0;
  return { out, ms };
}

function renderPerl(text: string, format: OutputFormat): { out: string; ms: number } {
  if (webPerlState.kind !== "ready") {
    if (webPerlState.kind === "error") {
      throw new Error(webPerlState.error);
    }
    throw new Error("WebPerl is still initializing.");
  }

  const FS: any = (globalThis as any).FS;
  if (!FS) {
    throw new Error("FS API is missing (unexpected after init).");
  }

  // Write input to FS so Perl can read it without needing extra modules.
  try {
    FS.mkdir("/tmp");
  } catch {
    // ignore
  }
  FS.writeFile("/tmp/input.txt", text);

  const t0 = performance.now();
  const formatLiteral = JSON.stringify(format);
  const code = String.raw`
use lib '/Graph-Easy-0.76/lib';
use Graph::Easy::Parser;

my $format = ${formatLiteral};

my $out = eval {
  my $parser = Graph::Easy::Parser->new();
  my $txt = do { local $/; open my $fh, '<', '/tmp/input.txt' or die $!; <$fh> };
  my $graph = $parser->from_text($txt);
  $graph->layout();
  if ($format eq 'ascii') {
    $graph->as_ascii();
  } elsif ($format eq 'boxart') {
    $graph->as_boxart();
  } elsif ($format eq 'txt') {
    $graph->as_txt();
  } elsif ($format eq 'graphviz') {
    $graph->as_graphviz();
  } else {
    die "Unknown format: $format";
  }
};

if ($@) {
  "ERROR: $@";
} else {
  $out;
}
`;

  let out: string;
  try {
    out = String(Perl.eval(code) ?? "");
  } catch (e) {
    const msg = String(e);
    // If Perl entered an unrecoverable state, restart it once and retry.
    if (msg.toLowerCase().includes("state ended")) {
      Perl.start(["-e", "0"]);
      out = String(Perl.eval(code) ?? "");
    } else {
      throw e;
    }
  }
  const ms = performance.now() - t0;
  return { out, ms };
}

function main(): void {
  const input = document.getElementById("input") as HTMLTextAreaElement;
  const btnRun = document.getElementById("btn-run") as HTMLButtonElement;
  const btnReset = document.getElementById("btn-reset") as HTMLButtonElement;
  const outputFormat = document.getElementById("output-format") as HTMLSelectElement;

  const tsSvg = document.getElementById("ts-svg") as HTMLElement;
  const tsOut = document.getElementById("ts-output") as HTMLElement;
  const tsTabs = document.getElementById("ts-tabs") as HTMLElement;
  const tsTabRendered = document.getElementById("ts-tab-rendered") as HTMLButtonElement;
  const tsTabText = document.getElementById("ts-tab-text") as HTMLButtonElement;

  const perlSvg = document.getElementById("perl-svg") as HTMLElement;
  const perlOut = document.getElementById("perl-output") as HTMLElement;
  const perlTabs = document.getElementById("perl-tabs") as HTMLElement;
  const perlTabRendered = document.getElementById("perl-tab-rendered") as HTMLButtonElement;
  const perlTabText = document.getElementById("perl-tab-text") as HTMLButtonElement;

  const diffOut = document.getElementById("diff-output") as HTMLElement;

  const tsStatus = document.getElementById("ts-status") as HTMLElement;
  const perlStatus = document.getElementById("perl-status") as HTMLElement;
  const diffStatus = document.getElementById("diff-status") as HTMLElement;

  input.value = EXAMPLE;

  let tsView: GraphvizView = "rendered";
  let perlView: GraphvizView = "rendered";
  let lastFormat: OutputFormat | undefined;
  let runSeq = 0;

  const setTabsVisible = (visible: boolean) => {
    if (visible) {
      tsTabs.classList.remove("is-hidden");
      perlTabs.classList.remove("is-hidden");
      return;
    }
    tsTabs.classList.add("is-hidden");
    perlTabs.classList.add("is-hidden");
  };

  const setGraphvizView = (pane: "ts" | "perl", view: GraphvizView) => {
    const isRendered = view === "rendered";

    if (pane === "ts") {
      tsView = view;
      tsTabRendered.classList.toggle("tab--active", isRendered);
      tsTabText.classList.toggle("tab--active", !isRendered);
      tsSvg.classList.toggle("is-hidden", !isRendered);
      tsOut.classList.toggle("is-hidden", isRendered);
      return;
    }

    perlView = view;
    perlTabRendered.classList.toggle("tab--active", isRendered);
    perlTabText.classList.toggle("tab--active", !isRendered);
    perlSvg.classList.toggle("is-hidden", !isRendered);
    perlOut.classList.toggle("is-hidden", isRendered);
  };

  tsTabRendered.addEventListener("click", () => setGraphvizView("ts", "rendered"));
  tsTabText.addEventListener("click", () => setGraphvizView("ts", "text"));
  perlTabRendered.addEventListener("click", () => setGraphvizView("perl", "rendered"));
  perlTabText.addEventListener("click", () => setGraphvizView("perl", "text"));

  const run = async () => {
    const mySeq = ++runSeq;
    const text = input.value;
    const format = parseOutputFormat(outputFormat.value);

    const formatJustChangedToGraphviz = format === "graphviz" && lastFormat !== "graphviz";
    lastFormat = format;

    if (format === "graphviz") {
      setTabsVisible(true);
      if (formatJustChangedToGraphviz) {
        setGraphvizView("ts", "rendered");
        setGraphvizView("perl", "rendered");
      }
    } else {
      setTabsVisible(false);
      tsSvg.classList.add("is-hidden");
      perlSvg.classList.add("is-hidden");
      tsOut.classList.remove("is-hidden");
      perlOut.classList.remove("is-hidden");
      tsView = "text";
      perlView = "text";
    }

    // Clear previous rendered outputs early so we don't show stale SVGs.
    if (format === "graphviz") {
      tsSvg.replaceChildren();
      perlSvg.replaceChildren();
    }

    // TS
    let tsText = "";
    try {
      setPill(tsStatus, "busy", "running…");
      const { out, ms } = renderTs(text, format);
      tsText = out;
      tsOut.textContent = out;
      setPill(tsStatus, "ok", `${ms.toFixed(1)}ms`);
    } catch (e) {
      const msg = e instanceof Error ? e.stack ?? e.message : String(e);
      tsOut.textContent = msg;
      setPill(tsStatus, "err", "error");
    }

    // Perl
    let perlAscii = "";
    try {
      if (webPerlState.kind !== "ready") {
        setPill(perlStatus, webPerlState.kind === "error" ? "err" : "busy", webPerlState.kind);
        perlOut.textContent =
          webPerlState.kind === "error" ? webPerlState.error : "WebPerl is still initializing…";
      } else {
        setPill(perlStatus, "busy", "running…");
        const { out, ms } = renderPerl(text, format);
        perlAscii = out;
        perlOut.textContent = out;
        if (out.trimStart().startsWith("ERROR:")) {
          setPill(perlStatus, "err", "error");
        } else {
          setPill(perlStatus, "ok", `${ms.toFixed(1)}ms`);
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.stack ?? e.message : String(e);
      perlOut.textContent = msg;
      setPill(perlStatus, "err", "error");
    }

    // If graphviz, also render SVG previews (default tab).
    if (format === "graphviz") {
      try {
        const viz = await getViz();

        if (mySeq !== runSeq) return;

        if (tsText.trimStart().startsWith("ERROR:")) {
          tsSvg.textContent = tsText;
          setPill(tsStatus, "err", "dot error");
        } else {
          const svg = viz.renderSVGElement(tsText);
          tsSvg.replaceChildren(svg);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.stack ?? e.message : String(e);
        tsSvg.textContent = msg;
        setPill(tsStatus, "err", "svg error");
      }

      try {
        const viz = await getViz();

        if (mySeq !== runSeq) return;

        if (perlAscii.trimStart().startsWith("ERROR:")) {
          perlSvg.textContent = perlAscii;
          setPill(perlStatus, "err", "dot error");
        } else {
          const svg = viz.renderSVGElement(perlAscii);
          perlSvg.replaceChildren(svg);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.stack ?? e.message : String(e);
        perlSvg.textContent = msg;
        setPill(perlStatus, "err", "svg error");
      }

      // Ensure the currently selected tab state matches view variables.
      setGraphvizView("ts", tsView);
      setGraphvizView("perl", perlView);
    }

    // Diff
    try {
      setPill(diffStatus, "busy", "computing…");
      const tsAscii = tsOut.textContent ?? "";
      const diff = diffAscii(tsAscii, perlAscii || (perlOut.textContent ?? ""));
      diffOut.textContent = diff;
      setPill(diffStatus, "ok", diff === "(exact match)" ? "match" : "diff");
    } catch (e) {
      const msg = e instanceof Error ? e.stack ?? e.message : String(e);
      diffOut.textContent = msg;
      setPill(diffStatus, "err", "error");
    }
  };

  const runDebounced = debounce(() => void run(), 150);

  // Kick off WebPerl init, but don’t block TS renders. Once Perl is ready,
  // trigger a rerender so the Perl pane fills in without requiring user input.
  initWebPerl(perlStatus, perlOut)
    .then(() => void run())
    .catch((e) => {
      webPerlState = { kind: "error", error: String(e) };
      setPill(perlStatus, "err", "init failed");
      perlOut.textContent = String(e);
      void run();
    });

  input.addEventListener("input", runDebounced);
  outputFormat.addEventListener("change", () => void run());
  btnRun.addEventListener("click", () => void run());
  btnReset.addEventListener("click", () => {
    input.value = EXAMPLE;
    void run();
  });

  // Initial render
  void run();
}

main();
