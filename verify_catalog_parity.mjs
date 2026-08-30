import fs from 'node:fs';
import { MCP_TOOL_CATALOG } from './netlify/functions/tools.mjs';

const bridgeSource = fs.readFileSync(new URL('./public/mcp_bridge.js', import.meta.url), 'utf8');
const manifestStart = bridgeSource.indexOf('const MANIFEST_TOOLS = [');
const manifestEnd = bridgeSource.indexOf('for (const entry of MANIFEST_TOOLS)', manifestStart);
if (manifestStart < 0 || manifestEnd < 0) throw new Error('Could not locate the native MANIFEST_TOOLS block.');

const manifestSource = bridgeSource.slice(manifestStart, manifestEnd);
const nativeNames = [...manifestSource.matchAll(/name:\s*'(?<name>godot_[^']+)'/g)].map(match => match.groups.name);
const catalogNames = MCP_TOOL_CATALOG.map(tool => tool.name);
const duplicates = names => names.filter((name, index) => names.indexOf(name) !== index);
const missingSchemas = MCP_TOOL_CATALOG.filter(tool => !tool.input_schema || tool.input_schema.type !== 'object').map(tool => tool.name);
const missingAnnotations = MCP_TOOL_CATALOG.filter(tool => !tool.annotations || typeof tool.annotations.readOnlyHint !== 'boolean').map(tool => tool.name);

const nativeSet = new Set(nativeNames);
const catalogSet = new Set(catalogNames);
const nativeOnly = nativeNames.filter(name => !catalogSet.has(name));
const catalogOnly = catalogNames.filter(name => !nativeSet.has(name));
const failures = {
  native_duplicates: duplicates(nativeNames),
  catalog_duplicates: duplicates(catalogNames),
  native_only: nativeOnly,
  catalog_only: catalogOnly,
  missing_schemas: missingSchemas,
  missing_annotations: missingAnnotations
};

if (Object.values(failures).some(items => items.length > 0)) {
  console.error(JSON.stringify(failures, null, 2));
  process.exit(1);
}

console.log(`Catalog parity verified: ${nativeNames.length} native and HTTP tools with typed schemas and annotations.`);
