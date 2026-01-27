This is a port of https://metacpan.org/pod/Graph::Easy to TypeScript.

Read more here: https://tomisin.space/projects/graph-easy-ts/

## Install

```sh
npm install graph-easy
```

## CLI (via npx)

```sh
npx graph-easy --help
echo "[ Bonn ] - car -> [ Berlin ]" | npx graph-easy
npx graph-easy graph.txt --svg --output=graph.svg
```

## Library usage (ESM)

```ts
import { Parser } from "graph-easy";

const graph = Parser.fromText("[ Bonn ] - car -> [ Berlin ]");
console.log(graph.asAscii());
```

## Library usage (CommonJS)

```js
const { Parser } = require("graph-easy");

const graph = Parser.fromText("[ Bonn ] - car -> [ Berlin ]");
console.log(graph.asAscii());
```

Note: external output formats like PNG/PDF use Graphviz (`dot`) under the hood, so Graphviz must be installed on your system for those.
