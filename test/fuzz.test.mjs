import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import {
  createMarkdownDocumentSession,
  MarkdownBudgetExceededError,
  parseMarkdown,
  walkMarkdown
} from '../dist/mod.js';

function assertPositionInvariants(document, source) {
  const ids = new Set();
  const visited = new Set();
  const inspect = (value) => {
    if (typeof value !== 'object' || value === null || visited.has(value)) return;
    visited.add(value);
    if (!Array.isArray(value)) {
      const keys = Object.keys(value);
      if (keys.length === 2 && keys.includes('start') && keys.includes('end')) {
        assert.equal(Number.isSafeInteger(value.start), true);
        assert.equal(Number.isSafeInteger(value.end), true);
        assert(value.start >= 0 && value.start <= value.end && value.end <= source.length);
      }
    }
    for (const child of Array.isArray(value) ? value : Object.values(value)) inspect(child);
  };
  inspect(document.tree);
  for (const { node, parent } of walkMarkdown(document.tree)) {
    assert.equal(ids.has(node.id), false);
    ids.add(node.id);
    if (parent !== null) {
      assert(parent.span.start <= node.span.start);
      assert(parent.span.end >= node.span.end);
    }
  }
  assert.equal(ids.size, document.metadata.nodeCount);
}

const markdownCharacter = fc.constantFrom(
  '#', '*', '_', '~', '`', '[', ']', '(', ')', '<', '>', '!', '&', ';', ':',
  '\\', '|', ' ', '\t', '\n', '\r', '\0', 'a', 'Z', '0', 'é', '東', '🙂'
);
const markdownString = fc.array(markdownCharacter, { maxLength: 500 }).map((characters) => characters.join(''));

test('arbitrary Unicode and Markdown punctuation preserve all position invariants', () => {
  fc.assert(fc.property(markdownString, fc.boolean(), (source, useGfm) => {
    const document = parseMarkdown(source, { dialect: useGfm ? 'gfm' : 'commonmark' });
    assertPositionInvariants(document, source);
  }), { numRuns: 300, seed: 0x5eedc0de });
});

test('incremental edits are structurally identical to a clean parse', () => {
  fc.assert(fc.property(
    markdownString.filter((source) => source.length > 0),
    fc.nat(),
    fc.nat(),
    markdownString,
    fc.boolean(),
    (source, first, second, replacement, useGfm) => {
      const left = Math.min(first % (source.length + 1), second % (source.length + 1));
      const right = Math.max(first % (source.length + 1), second % (source.length + 1));
      const dialect = useGfm ? 'gfm' : 'commonmark';
      const session = createMarkdownDocumentSession(source, { dialect });
      const update = session.applyEdits([{ span: { start: left, end: right }, text: replacement.slice(0, 80) }]);
      const clean = parseMarkdown(update.snapshot.source, { dialect });
      const normalize = (value) => JSON.stringify(value, (key, entry) => key === 'id' ? 0 : entry);
      assert.equal(normalize(update.snapshot.document.tree), normalize(clean.tree));
      assertPositionInvariants(update.snapshot.document, update.snapshot.source);
    }
  ), { numRuns: 75, seed: 0x1cedb10c });
});

test('pathological delimiter runs remain bounded and deterministic', () => {
  const cases = [
    { source: `${'*'.repeat(4_000)}a${'*'.repeat(4_000)}`, expectedBudget: 'maxDepth' },
    { source: `${'['.repeat(2_000)}x${']'.repeat(2_000)}`, expectedBudget: null },
    { source: `${'> '.repeat(100)}value\n`, expectedBudget: null },
    { source: `${'`'.repeat(4_000)} value ${'`'.repeat(4_000)}`, expectedBudget: null },
    { source: `${'www.'.repeat(1_000)}example.com`, expectedBudget: null }
  ];
  for (const { source, expectedBudget } of cases) {
    try {
      const first = parseMarkdown(source, { dialect: 'gfm', budgets: { maxNodes: 200_000, maxDepth: 1_000 } });
      const second = parseMarkdown(source, { dialect: 'gfm', budgets: { maxNodes: 200_000, maxDepth: 1_000 } });
      assert.equal(expectedBudget, null);
      assert.deepEqual(first.tree, second.tree);
      assertPositionInvariants(first, source);
    } catch (error) {
      assert(error instanceof MarkdownBudgetExceededError);
      assert.equal(error.budget, expectedBudget);
    }
  }
});
