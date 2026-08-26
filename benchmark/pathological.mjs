import { performance } from 'node:perf_hooks';
import { createMarkdownDocumentSession, parseMarkdown } from '../dist/mod.js';

const cases = {
  emphasisRuns: `${'*'.repeat(8_000)}a${'*'.repeat(8_000)}`,
  unmatchedBrackets: `${'['.repeat(4_000)}x${']'.repeat(4_000)}`,
  longCodeFence: `${'`'.repeat(8_000)} value ${'`'.repeat(8_000)}`,
  tabIndented: `${'\tvalue\tsemantic\n'.repeat(10_000)}`,
  manyBlocks: Array.from({ length: 5_000 }, (_, index) => `block ${index}\n\n`).join('')
};

const results = [];
for (const [name, source] of Object.entries(cases)) {
  const start = performance.now();
  try {
    const document = parseMarkdown(source, {
      dialect: 'gfm',
      budgets: { maxNodes: 1_000_000 }
    });
    results.push({ name, codeUnits: source.length, milliseconds: performance.now() - start, nodes: document.metadata.nodeCount, outcome: 'parsed' });
  } catch (error) {
    results.push({
      name,
      codeUnits: source.length,
      milliseconds: performance.now() - start,
      nodes: null,
      outcome: error?.code ?? error?.name ?? 'error',
      budget: error?.budget ?? null,
      observed: error?.observed ?? null,
      limit: error?.limit ?? null
    });
  }
}

const editorSource = cases.manyBlocks;
const session = createMarkdownDocumentSession(editorSource);
const editStart = editorSource.lastIndexOf('4999');
const editAt = performance.now();
const update = session.applyEdits([{ span: { start: editStart, end: editStart + 4 }, text: 'last' }]);
results.push({
  name: 'incrementalTailEdit',
  codeUnits: editorSource.length,
  milliseconds: performance.now() - editAt,
  nodes: update.snapshot.document.metadata.nodeCount,
  outcome: update.instrumentation.fullParse ? 'full' : 'incremental',
  parsedCodeUnits: update.parsedSpan.end - update.parsedSpan.start,
  reusedNodes: update.instrumentation.reusedNodes
});

console.log(JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
