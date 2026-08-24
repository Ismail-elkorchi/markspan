import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MarkdownBudgetExceededError,
  parseMarkdown
} from '../dist/mod.js';

test('enforces input, line, node, and depth budgets', () => {
  assert.throws(
    () => parseMarkdown('12345', { budgets: { maxInputCodeUnits: 4 } }),
    MarkdownBudgetExceededError
  );
  assert.throws(
    () => parseMarkdown('a\nb\nc', { budgets: { maxLines: 2 } }),
    MarkdownBudgetExceededError
  );
  assert.throws(
    () => parseMarkdown('# a\n\nb', { budgets: { maxNodes: 2 } }),
    MarkdownBudgetExceededError
  );
  assert.throws(
    () => parseMarkdown('> > > deep', { budgets: { maxDepth: 2 } }),
    MarkdownBudgetExceededError
  );
});

test('parses delimiter runs with bounded linear work', () => {
  assert.throws(
    () => parseMarkdown(`${'*'.repeat(600)}a${'*'.repeat(600)}`),
    (error) => {
      assert(error instanceof MarkdownBudgetExceededError);
      assert.equal(error.budget, 'maxDepth');
      assert.equal(error.limit, 256);
      assert.equal(error.observed, 257);
      return true;
    }
  );
  const bracketSource = `${'['.repeat(4_000)}x${']'.repeat(4_000)}`;
  const bracketDocument = parseMarkdown(bracketSource);
  assert.equal(bracketDocument.tree.children.length, 1);
  assert.equal(bracketDocument.metadata.resourceUsage.inputCodeUnits, bracketSource.length);
});

test('does not execute or sanitize raw HTML', () => {
  const source = '<script>alert(1)</script>';
  const parsed = parseMarkdown(source);
  const html = parsed.tree.children[0];
  assert.equal(html?.kind, 'htmlBlock');
  assert.equal(html?.value, source);
});
