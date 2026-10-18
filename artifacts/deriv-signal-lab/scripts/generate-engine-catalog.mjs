// Keep the research reference synchronized with the catalog used by the UI.
// Run with Node's --experimental-strip-types (Node 22+) or built-in TS support.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { ENGINE_CATALOG, ENGINE_CATEGORIES, ENGINE_SOURCES } from '../src/lib/engine-lab/catalog.ts';

const escape = (value) => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
let document = '# Complete 300-engine reference\n\n';
document += 'Generated from `src/lib/engine-lab/catalog.ts`. Do not edit this table by hand.\n\n';
document += 'Read [engine-library.md](engine-library.md) for research assumptions, per-tool use, data requirements, validation and execution rules. Each row is an explicit application definition, not a claim of 300 independent standardized predictors. Context-only, insufficient-data, unavailable and alias states are visible in every tool.\n\n';
for (const category of ENGINE_CATEGORIES) {
  document += `## ${category.name} · ${category.first}–${category.last}\n\n`;
  document += '| # | Engine | Domain / role | Operational definition | References |\n| --- | --- | --- | --- | --- |\n';
  for (const engine of ENGINE_CATALOG.filter((entry) => entry.category === category.name)) {
    const citations = engine.sources.map((key) => { const source = ENGINE_SOURCES[key]; return `[${source.citation}](${source.url})`; }).join(' ');
    document += `| ${engine.id} | ${escape(engine.name)}${engine.aliasOf ? ` (alias of #${engine.aliasOf})` : ''} | ${escape(engine.domain)} / ${engine.role} | ${escape(engine.method)} | ${citations} |\n`;
  }
  document += '\n';
}
document += '## Source index\n\n';
for (const source of Object.values(ENGINE_SOURCES)) document += `- ${source.title}: [${source.citation}](${source.url})\n`;
const output = new URL('../docs/engine-catalog.md', import.meta.url);
if (process.argv.includes('--check')) {
  const current = await readFile(output, 'utf8');
  if (current !== document) throw new Error('Engine catalog documentation is stale. Run docs:engines.');
  console.log('Engine reference is synchronized (300 entries).');
} else {
  await mkdir(new URL('../docs/', import.meta.url), { recursive: true });
  await writeFile(output, document);
  console.log('Wrote docs/engine-catalog.md (300 entries).');
}
