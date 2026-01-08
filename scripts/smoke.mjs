import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";

import { Parser } from "../dist/src/index.js";

const sample = "[ Bonn ] - car -> [ Berlin ]";

const graph = Parser.fromText(sample);
const ascii = graph.asAscii();
assert.ok(ascii.includes("Bonn"), "library output should include Bonn");
assert.ok(ascii.includes("Berlin"), "library output should include Berlin");

const cliOut = execSync("node dist/src/cli.js", { input: sample, encoding: "utf8" });
assert.ok(cliOut.includes("Bonn"), "cli output should include Bonn");
assert.ok(cliOut.includes("Berlin"), "cli output should include Berlin");

const require = createRequire(import.meta.url);
const cjs = require("../dist-cjs/src/index.js");
const cjsGraph = cjs.Parser.fromText(sample);
const cjsOut = cjsGraph.asAscii();
assert.ok(cjsOut.includes("Bonn"), "cjs output should include Bonn");
assert.ok(cjsOut.includes("Berlin"), "cjs output should include Berlin");
