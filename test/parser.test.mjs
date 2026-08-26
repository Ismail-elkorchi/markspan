import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectMarkdownNodes,
  parseMarkdown,
  sliceMarkdownSource
} from '../dist/mod.js';

test('parses source-aware block and inline structure', () => {
  const source = [
    '# Markdown',
    '',
    'A **source-aware** parser with *inline `syntax`* and [docs](https://example.com "Docs").',
    '',
    '> Quoted text',
    '>',
    '> - nested item',
    '',
    '```ts',
    'const answer = 42;',
    '```'
  ].join('\n');
  const parsed = parseMarkdown(source, { dialect: 'gfm' });
  assert.equal(parsed.tree.kind, 'document');
  assert.equal(parsed.tree.span.start, 0);
  assert.equal(parsed.tree.span.end, source.length);
  assert.equal(collectMarkdownNodes(parsed.tree, 'heading').length, 1);
  assert.equal(collectMarkdownNodes(parsed.tree, 'strong').length, 1);
  assert.equal(collectMarkdownNodes(parsed.tree, 'emphasis').length, 1);
  assert.equal(collectMarkdownNodes(parsed.tree, 'codeSpan').length, 1);
  const link = collectMarkdownNodes(parsed.tree, 'link')[0];
  assert.equal(link?.destination, 'https://example.com');
  assert.equal(link?.title, 'Docs');
  const code = collectMarkdownNodes(parsed.tree, 'codeBlock')[0];
  assert.equal(code?.language, 'ts');
  assert.equal(code?.value, 'const answer = 42;');
  assert.equal(sliceMarkdownSource(source, code.span), '```ts\nconst answer = 42;\n```');
});

test('preserves definitions and resolves full, collapsed, and shortcut references', () => {
  const source = [
    '[guide]: https://example.com/guide "Guide"',
    '',
    '[Read][guide], [guide][], and [guide].',
    '',
    '[GUIDE]: https://ignored.example'
  ].join('\n');
  const parsed = parseMarkdown(source);
  const definitions = collectMarkdownNodes(parsed.tree, 'linkDefinition');
  assert.equal(definitions.length, 2);
  assert.equal(definitions[0]?.active, true);
  assert.equal(definitions[1]?.active, false);
  assert.equal(parsed.definitions.length, 1);
  assert.equal(parsed.definitionFor(' GUIDE ')?.destination, 'https://example.com/guide');
  const links = collectMarkdownNodes(parsed.tree, 'link');
  assert.deepEqual(links.map((node) => node.form), [
    'fullReference',
    'collapsedReference',
    'shortcutReference'
  ]);
  assert(parsed.diagnostics.some((diagnostic) => diagnostic.code === 'duplicate-reference-definition'));
});

test('supports GFM tables, tasks, strikethrough, and literal autolinks', () => {
  const source = [
    '| Name | State |',
    '| :--- | ---: |',
    '| 東京 | **open** |',
    '',
    '- [x] shipped',
    '- [ ] pending',
    '',
    '~~removed~~ https://example.com and dev@example.com'
  ].join('\n');
  const parsed = parseMarkdown(source, { dialect: 'gfm' });
  const table = collectMarkdownNodes(parsed.tree, 'table')[0];
  assert.deepEqual(table?.align, ['left', 'right']);
  assert.equal(table?.rows.length, 1);
  const items = collectMarkdownNodes(parsed.tree, 'listItem');
  assert.equal(items[0]?.task?.checked, true);
  assert.equal(items[1]?.task?.checked, false);
  assert.equal(collectMarkdownNodes(parsed.tree, 'strikethrough').length, 1);
  const links = collectMarkdownNodes(parsed.tree, 'link');
  assert(links.some((link) => link.form === 'gfmAutolink' && link.destination === 'https://example.com'));
  assert(links.some((link) => link.form === 'gfmAutolink' && link.destination === 'mailto:dev@example.com'));
});

test('keeps CommonMark profile conservative', () => {
  const parsed = parseMarkdown('~~text~~\n\n- [x] task\n\nhttps://example.com');
  assert.equal(collectMarkdownNodes(parsed.tree, 'strikethrough').length, 0);
  assert.equal(collectMarkdownNodes(parsed.tree, 'listItem')[0]?.task, null);
  assert.equal(collectMarkdownNodes(parsed.tree, 'link').length, 0);
});

test('normalizes CRLF semantics while retaining exact offsets', () => {
  const source = '# Title\r\n\r\nFirst line  \r\nnext.';
  const parsed = parseMarkdown(source, { sourceRetention: 'text' });
  const heading = collectMarkdownNodes(parsed.tree, 'heading')[0];
  const hardBreak = collectMarkdownNodes(parsed.tree, 'hardBreak')[0];
  assert.equal(sliceMarkdownSource(source, heading.span), '# Title');
  assert.equal(sliceMarkdownSource(source, hardBreak.markerSpan), '  ');
  assert.equal(parsed.sourceIndex.positionAt(source.indexOf('next')).line, 3);
  assert.equal(parsed.sourceText, source);
});

test('keeps virtual tab indentation separate from semantic code text', () => {
  const source = '\tfoo\tbaz\t\tbim\n\n>\tcontinuation\n';
  const parsed = parseMarkdown(source);
  const code = collectMarkdownNodes(parsed.tree, 'codeBlock')[0];
  assert.equal(code?.style, 'indented');
  assert.equal(code?.value, 'foo\tbaz\t\tbim');
  assert.equal(sliceMarkdownSource(source, code.span), '\tfoo\tbaz\t\tbim');
  const quote = collectMarkdownNodes(parsed.tree, 'blockQuote')[0];
  assert.equal(sliceMarkdownSource(source, quote.markerSpans[0]), '>');
  assert.equal(parsed.sourceText, source);
});

test('supports GFM footnote definitions and stable resolution records', () => {
  const source = 'Text[^note].\n\n[^note]: Footnote *body*.\n';
  const parsed = parseMarkdown(source, { dialect: 'gfm' });
  const call = collectMarkdownNodes(parsed.tree, 'footnoteReference')[0];
  const definition = collectMarkdownNodes(parsed.tree, 'footnoteDefinition')[0];
  assert.equal(call?.definitionSpan.start, definition?.span.start);
  assert.equal(parsed.footnoteFor(' NOTE ')?.nodeId, definition?.id);
});

test('assigns a nested task marker only to its owning list item', () => {
  const parsed = parseMarkdown('- parent\n  - [x] child\n', { dialect: 'gfm' });
  const items = collectMarkdownNodes(parsed.tree, 'listItem');
  assert.equal(items[0]?.task, null);
  assert.equal(items[1]?.task?.checked, true);
});

test('reports list and item looseness independently', () => {
  const source = '- first paragraph\n\n  second paragraph\n- compact item\n';
  const parsed = parseMarkdown(source);
  const list = collectMarkdownNodes(parsed.tree, 'list')[0];
  assert.equal(list?.tight, false);
  assert.deepEqual(list?.items.map((item) => item.spread), [true, false]);
});

test('returns deeply immutable public values', () => {
  const parsed = parseMarkdown('# Frozen\n\nA **tree**.');
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.tree), true);
  assert.equal(Object.isFrozen(parsed.tree.children), true);
  for (const node of collectMarkdownNodes(parsed.tree, 'strong')) {
    assert.equal(Object.isFrozen(node), true);
    assert.equal(Object.isFrozen(node.children), true);
  }
});

test('parses explicit front matter, callout, and math extensions with exact spans', () => {
  const source = [
    '---',
    'title: Demo',
    'unsafe: !constructor value',
    'invalid line',
    '---',
    '',
    '> [!WARNING]',
    '> Body with $x^2$ and \\$literal$.',
    '',
    '$$',
    'y = x + 1',
    '$$'
  ].join('\n');
  const parsed = parseMarkdown(source, {
    dialect: 'gfm',
    extensions: ['frontMatter', 'callouts', 'math']
  });
  const [frontMatter, callout, mathBlock] = parsed.tree.children;

  assert.equal(frontMatter?.kind, 'frontMatter');
  assert.equal(frontMatter?.raw, 'title: Demo\nunsafe: !constructor value\ninvalid line\n');
  assert.deepEqual(frontMatter?.entries.map((entry) => [
    entry.key,
    entry.value,
    source.slice(entry.keySpan.start, entry.keySpan.end),
    source.slice(entry.valueSpan.start, entry.valueSpan.end)
  ]), [
    ['title', 'Demo', 'title', 'Demo'],
    ['unsafe', '!constructor value', 'unsafe', '!constructor value']
  ]);
  assert.equal(callout?.kind, 'callout');
  assert.equal(callout?.calloutKind, 'warning');
  assert.equal(callout?.children[0]?.kind, 'paragraph');
  if (callout?.children[0]?.kind === 'paragraph') {
    assert.deepEqual(callout.children[0].children.map((node) => node.kind), [
      'text', 'mathInline', 'text', 'escape', 'text'
    ]);
  }
  assert.equal(mathBlock?.kind, 'mathBlock');
  assert.equal(mathBlock?.value, 'y = x + 1\n');
  assert(parsed.diagnostics.some((diagnostic) => diagnostic.code === 'invalid-front-matter'));
  assert.equal(source.slice(mathBlock?.contentSpan.start, mathBlock?.contentSpan.end), 'y = x + 1\n');
});

test('unknown callouts remain block quotes and unclosed extension blocks report diagnostics', () => {
  const unknown = parseMarkdown('> [!UNKNOWN]\n> body', {
    dialect: 'gfm',
    extensions: ['callouts']
  });
  assert.equal(unknown.tree.children[0]?.kind, 'blockQuote');

  const unclosed = parseMarkdown('---\ntitle: Demo', { extensions: ['frontMatter'] });
  assert.equal(unclosed.tree.children[0]?.kind, 'frontMatter');
  assert.equal(unclosed.diagnostics[0]?.code, 'unclosed-front-matter');
});

test('large multiline paragraphs retain exact soft-break spans', () => {
  const line = 'const value = 1;';
  const source = `${line}\n`.repeat(15_000);
  const parsed = parseMarkdown(source, { dialect: 'gfm' });
  const paragraph = parsed.tree.children[0];
  assert.equal(paragraph?.kind, 'paragraph');
  if (paragraph?.kind !== 'paragraph') return;
  const breaks = paragraph.children.filter((node) => node.kind === 'softBreak');
  assert.equal(breaks.length, 14_999);
  assert.equal(source.slice(breaks[0]?.span.start, breaks[0]?.span.end), '\n');
  assert.equal(source.slice(breaks.at(-1)?.span.start, breaks.at(-1)?.span.end), '\n');
  assert.equal(paragraph.children.length, 29_999);
});
