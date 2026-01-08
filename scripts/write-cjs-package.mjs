import fs from "node:fs";
import path from "node:path";

const dir = path.resolve("dist-cjs");
fs.mkdirSync(dir, { recursive: true });

const pkgPath = path.join(dir, "package.json");
const pkg = { type: "commonjs" };
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
