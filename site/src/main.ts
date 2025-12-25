import { Parser } from "../../src/parser";

const EXAMPLE = String.raw`# Minimal example
[ A ] --> [ B ]
[ B ] --> { label: ships } [ C ]
`;

type StatusKind = "idle" | "ok" | "err" | "busy";

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

declare const Perl: any;

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

  // Manifest lists Perl files relative to /Graph-Easy-0.76/lib
  const manifestUrl = "/Graph-Easy-0.76/manifest.json";
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
    const url = `/Graph-Easy-0.76/lib/${rel}`;
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

function renderTs(text: string): { ascii: string; ms: number } {
  const t0 = performance.now();
  const graph = Parser.fromText(text);
  graph.timeout = 360;
  graph.layout();
  const ascii = graph.asAscii();
  const ms = performance.now() - t0;
  return { ascii, ms };
}

function renderPerl(text: string): { ascii: string; ms: number } {
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
  const code = String.raw`
use lib '/Graph-Easy-0.76/lib';
use Graph::Easy::Parser;

my $out = eval {
  my $parser = Graph::Easy::Parser->new();
  my $txt = do { local $/; open my $fh, '<', '/tmp/input.txt' or die $!; <$fh> };
  my $graph = $parser->from_text($txt);
  $graph->layout();
  $graph->as_ascii();
};

if ($@) {
  "ERROR: $@";
} else {
  $out;
}
`;

  let ascii: string;
  try {
    ascii = String(Perl.eval(code) ?? "");
  } catch (e) {
    const msg = String(e);
    // If Perl entered an unrecoverable state, restart it once and retry.
    if (msg.toLowerCase().includes("state ended")) {
      Perl.start(["-e", "0"]);
      ascii = String(Perl.eval(code) ?? "");
    } else {
      throw e;
    }
  }
  const ms = performance.now() - t0;
  return { ascii, ms };
}

function main(): void {
  const input = document.getElementById("input") as HTMLTextAreaElement;
  const btnRun = document.getElementById("btn-run") as HTMLButtonElement;
  const btnReset = document.getElementById("btn-reset") as HTMLButtonElement;

  const tsOut = document.getElementById("ts-output") as HTMLElement;
  const perlOut = document.getElementById("perl-output") as HTMLElement;
  const diffOut = document.getElementById("diff-output") as HTMLElement;

  const tsStatus = document.getElementById("ts-status") as HTMLElement;
  const perlStatus = document.getElementById("perl-status") as HTMLElement;
  const diffStatus = document.getElementById("diff-status") as HTMLElement;

  input.value = EXAMPLE;

  const run = () => {
    const text = input.value;

    // TS
    try {
      setPill(tsStatus, "busy", "running…");
      const { ascii, ms } = renderTs(text);
      tsOut.textContent = ascii;
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
        const { ascii, ms } = renderPerl(text);
        perlAscii = ascii;
        perlOut.textContent = ascii;
        if (ascii.trimStart().startsWith("ERROR:")) {
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

  const runDebounced = debounce(run, 150);

  // Kick off WebPerl init, but don’t block TS renders. Once Perl is ready,
  // trigger a rerender so the Perl pane fills in without requiring user input.
  initWebPerl(perlStatus, perlOut)
    .then(() => run())
    .catch((e) => {
      webPerlState = { kind: "error", error: String(e) };
      setPill(perlStatus, "err", "init failed");
      perlOut.textContent = String(e);
      run();
    });

  input.addEventListener("input", runDebounced);
  btnRun.addEventListener("click", run);
  btnReset.addEventListener("click", () => {
    input.value = EXAMPLE;
    run();
  });

  // Initial render
  run();
}

main();
