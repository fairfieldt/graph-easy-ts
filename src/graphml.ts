import type { Graph } from "./graph";
import type { Group } from "./group";
import type { Node } from "./node";
import type { Edge } from "./edge";

type KeyMap = Map<string, string>;

type KeyMaps = {
  graph: KeyMap;
  node: KeyMap;
  edge: KeyMap;
};

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function isUndirected(graph: Graph): boolean {
  for (const e of graph.edges) {
    if (!e.undirected) return false;
  }
  return true;
}

function collectKeys(graph: Graph): KeyMaps {
  const graphKeys = new Set<string>();
  const nodeKeys = new Set<string>();
  const edgeKeys = new Set<string>();

  for (const k of Object.keys(graph.graphAttributes)) graphKeys.add(k);
  for (const g of graph.groups) collectGroupKeys(g, graphKeys);

  for (const n of graph.nodes()) {
    for (const k of Object.keys(n.attributes)) nodeKeys.add(k);
  }
  for (const e of graph.edges) {
    for (const k of Object.keys(e.attributes)) edgeKeys.add(k);
  }

  let id = 0;
  const assign = (keys: Set<string>): KeyMap => {
    const map = new Map<string, string>();
    for (const name of [...keys].sort()) {
      map.set(name, `d${id++}`);
    }
    return map;
  };

  return {
    graph: assign(graphKeys),
    node: assign(nodeKeys),
    edge: assign(edgeKeys),
  };
}

function collectGroupKeys(group: Group, keys: Set<string>): void {
  for (const k of Object.keys(group.attributes)) keys.add(k);
  for (const child of group.groups) collectGroupKeys(child, keys);
}

function renderKeyDefs(keys: KeyMap, scope: "graph" | "node" | "edge"): string {
  let out = "";
  for (const [name, id] of keys.entries()) {
    out += `  <key id="${id}" for="${scope}" attr.name="${escapeXml(name)}" attr.type="string"/>\n`;
  }
  return out;
}

function renderData(attrs: Record<string, string>, keys: KeyMap, indent: string): string {
  let out = "";
  for (const [name, id] of keys.entries()) {
    const value = attrs[name];
    if (value === undefined || value === "") continue;
    out += `${indent}<data key="${id}">${escapeXml(value)}</data>\n`;
  }
  return out;
}

function nodeAttributes(node: Node): Record<string, string> {
  const attrs: Record<string, string> = { ...node.attributes };
  if (attrs.label === undefined && node.label !== node.id) {
    attrs.label = node.label;
  }
  return attrs;
}

function edgeAttributes(edge: Edge): Record<string, string> {
  const attrs: Record<string, string> = { ...edge.attributes };
  if (attrs.label === undefined && edge.label) {
    attrs.label = edge.label;
  }
  return attrs;
}

function renderNode(node: Node, keys: KeyMap, indent: string): string {
  let out = `${indent}<node id="${escapeXml(node.id)}">\n`;
  out += renderData(nodeAttributes(node), keys, `${indent}  `);
  out += `${indent}</node>\n`;
  return out;
}

function renderEdge(edge: Edge, keys: KeyMap, indent: string): string {
  let out = `${indent}<edge source="${escapeXml(edge.from.id)}" target="${escapeXml(edge.to.id)}">\n`;
  out += renderData(edgeAttributes(edge), keys, `${indent}  `);
  out += `${indent}</edge>\n`;
  return out;
}

function sortedNodes(nodes: Iterable<Node>): Node[] {
  return [...nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function renderGroup(
  graph: Graph,
  group: Group,
  keys: KeyMaps,
  indent: string,
  edgeDefault: string
): string {
  let out = `${indent}<graph id="${escapeXml(group.name)}" edgedefault="${edgeDefault}">\n`;
  out += renderData(group.attributes, keys.graph, `${indent}  `);

  const nodes = sortedNodes(group.nodes);
  for (const n of nodes) {
    out += renderNode(n, keys.node, `${indent}  `);
  }

  if (nodes.length > 0) out += "\n";

  for (const n of nodes) {
    for (const other of n.successors()) {
      const edges = graph.edgesBetween(n, other);
      for (const e of edges) {
        out += renderEdge(e, keys.edge, `${indent}  `);
      }
    }
  }

  if (nodes.length > 0) out += "\n";

  for (const child of group.groups) {
    out += renderGroup(graph, child, keys, `${indent}  `, edgeDefault);
    out += "\n";
  }

  out += `${indent}</graph>\n`;
  return out;
}

export function renderGraphml(graph: Graph): string {
  const keys = collectKeys(graph);
  const edgeDefault = isUndirected(graph) ? "undirected" : "directed";

  const now = new Date().toString();
  let out = `<?xml version="1.0" encoding="UTF-8"?>\n`;
  out += `<graphml xmlns="http://graphml.graphdrawing.org/xmlns"\n`;
  out += `    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"\n`;
  out += `    xsi:schemaLocation="http://graphml.graphdrawing.org/xmlns\n`;
  out += `     http://graphml.graphdrawing.org/xmlns/1.0/graphml.xsd">\n\n`;
  out += `  <!-- Created by graph-easy-ts at ${escapeXml(now)} -->\n\n`;

  out += renderKeyDefs(keys.graph, "graph");
  out += renderKeyDefs(keys.node, "node");
  out += renderKeyDefs(keys.edge, "edge");
  if (keys.graph.size + keys.node.size + keys.edge.size > 0) out += "\n";

  out += `  <graph id="G" edgedefault="${edgeDefault}">\n`;
  out += renderData(graph.graphAttributes, keys.graph, "    ");

  const groupNodes = new Set<Node>();
  for (const g of graph.groups) {
    for (const n of g.nodes) groupNodes.add(n);
  }

  for (const g of graph.groups) {
    out += renderGroup(graph, g, keys, "    ", edgeDefault);
    out += "\n";
  }

  const nodes = sortedNodes(graph.nodes());
  for (const n of nodes) {
    if (groupNodes.has(n)) continue;
    out += renderNode(n, keys.node, "    ");
  }

  out += "\n";

  for (const n of nodes) {
    if (groupNodes.has(n)) continue;
    for (const other of n.successors()) {
      const edges = graph.edgesBetween(n, other);
      for (const e of edges) {
        out += renderEdge(e, keys.edge, "    ");
      }
    }
  }

  out += "  </graph>\n</graphml>\n";
  return out;
}
