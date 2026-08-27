import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyMarkdownTextEdits,
  collectMarkdownLinks,
  collectMarkdownNodes,
  collectMarkdownSyntaxTokens,
  countMarkdownDocumentWords,
  createMarkdownDocumentSession,
  createMarkdownTreeIndex,
  extractMarkdownOutline,
  extractMarkdownText,
  markdownNodeAt,
  markdownPathAt,
  mapMarkdownOffsetThroughEdits,
  parseMarkdown
} from '../dist/mod.js';

test('extracts outline, links, and configurable plain text', () => {
  const source = [
    '# Project',
    '',
    'See [guide](https://example.com) and ![diagram](image.png).',
    '',
    '## Setup',
    '',
    'Run `npm install`.'
  ].join('\n');
  const parsed = parseMarkdown(source, { dialect: 'gfm' });
  const outline = extractMarkdownOutline(parsed.tree);
  assert.equal(outline.length, 1);
  assert.equal(outline[0]?.text, 'Project');
  assert.equal(outline[0]?.children[0]?.text, 'Setup');
  const links = collectMarkdownLinks(parsed.tree);
  assert.deepEqual(links.map((link) => link.kind), ['link', 'image']);
  const text = extractMarkdownText(parsed.tree, { image: 'alt', code: 'include' });
  assert.match(text, /Project/u);
  assert.match(text, /diagram/u);
  assert.match(text, /npm install/u);
  assert.equal(countMarkdownDocumentWords(parsed.tree), 9);
});

test('maps source positions to the deepest syntax node', () => {
  const source = 'A **bold** value.';
  const parsed = parseMarkdown(source);
  const offset = source.indexOf('bold') + 1;
  const node = markdownNodeAt(parsed.tree, offset);
  assert.equal(node?.kind, 'text');
  const path = markdownPathAt(parsed.tree, offset);
  assert.deepEqual(path.map((entry) => entry.kind), ['document', 'paragraph', 'strong', 'text']);
});

test('applies deterministic non-overlapping edits and maps offsets', () => {
  const source = '# One\n\nBody';
  const result = applyMarkdownTextEdits(source, [
    { span: { start: 2, end: 5 }, text: 'New title' },
    { span: { start: source.length, end: source.length }, text: '\n' }
  ]);
  assert.equal(result.source, '# New title\n\nBody\n');
  assert.equal(result.codeUnitDelta, 7);
  assert.equal(mapMarkdownOffsetThroughEdits(source.length, source.indexOf('Body'), [
    { span: { start: 2, end: 5 }, text: 'New title' }
  ]), result.source.indexOf('Body'));
  assert.throws(() => applyMarkdownTextEdits(source, [
    { span: { start: 0, end: 4 }, text: '' },
    { span: { start: 2, end: 5 }, text: '' }
  ]), /overlaps/u);
});

test('maps every insertion at one source boundary and removes semantic no-op edits', () => {
  const edits = [
    { span: { start: 1, end: 1 }, text: 'first' },
    { span: { start: 1, end: 1 }, text: 'second' }
  ];
  const applied = applyMarkdownTextEdits('ab', edits);
  assert.equal(applied.source, 'afirstsecondb');
  assert.equal(mapMarkdownOffsetThroughEdits(2, 1, edits, 'backward'), 1);
  assert.equal(mapMarkdownOffsetThroughEdits(2, 1, edits, 'forward'), 12);

  const unchanged = applyMarkdownTextEdits('same', [
    { span: { start: 0, end: 4 }, text: 'same' },
    { span: { start: 4, end: 4 }, text: '' }
  ]);
  assert.deepEqual(unchanged.edits, []);
  assert.equal(unchanged.source, 'same');
  const session = createMarkdownDocumentSession('same');
  const update = session.applyEdits([{ span: { start: 0, end: 4 }, text: 'same' }]);
  assert.equal(update.instrumentation.parsedNodes, 0);
  assert.equal(update.instrumentation.reconciledNodes, 0);
  assert.equal(update.snapshot.source, 'same');
});

test('document session reparses a block suffix and preserves unaffected identities', () => {
  const source = '# One\n\nFirst block.\n\nSecond block.\n\nThird block.';
  const session = createMarkdownDocumentSession(source, { dialect: 'gfm' });
  assert.equal(session.snapshot().revision, 0);
  const before = session.snapshot();
  const start = source.indexOf('Second');
  const update = session.applyEdits([{ span: { start, end: start + 6 }, text: 'Changed' }]);
  assert.equal(update.instrumentation.fullParse, false);
  assert.equal(update.snapshot.revision, 1);
  assert(update.parsedSpan.start > 0);
  assert(update.instrumentation.reusedNodes >= 5);
  assert.equal(update.snapshot.document.tree.id, before.document.tree.id);
  assert.equal(update.snapshot.document.tree.children[0], before.document.tree.children[0]);
  assert.equal(update.snapshot.document.tree.children[1], before.document.tree.children[1]);
  assert.equal(update.snapshot.document.tree.children[3]?.id, before.document.tree.children[3]?.id);
  const full = parseMarkdown(update.snapshot.source, { dialect: 'gfm' });
  const withoutIds = (value) => JSON.stringify(value, (key, entry) => key === 'id' ? 0 : entry);
  assert.equal(withoutIds(update.snapshot.document.tree), withoutIds(full.tree));
});

test('shifted unchanged blocks retain IDs without retaining stale spans', () => {
  const source = '# Heading\n\nAlpha.\n\nBeta.\n\nGamma.';
  const session = createMarkdownDocumentSession(source);
  const before = session.snapshot().document.tree.children;
  const alphaEnd = source.indexOf('Alpha.') + 'Alpha.'.length;
  const update = session.applyEdits([{ span: { start: alphaEnd, end: alphaEnd }, text: ' Expanded.' }]);
  const after = update.snapshot.document.tree.children;
  assert.equal(update.instrumentation.fullParse, false);
  assert.equal(after[0], before[0]);
  assert.equal(after[2]?.id, before[2]?.id);
  assert.equal(after[3]?.id, before[3]?.id);
  assert.notEqual(after[2], before[2]);
  assert.equal(after[2]?.span.start, (before[2]?.span.start ?? 0) + ' Expanded.'.length);
});

test('edits after definitions retain an incremental suffix and stable resolved links', () => {
  const source = '[guide]: /one\n\n[guide]\n\nTail';
  const session = createMarkdownDocumentSession(source);
  const before = session.snapshot();
  const tail = source.indexOf('Tail');
  const update = session.applyEdits([{ span: { start: tail, end: tail + 4 }, text: 'Changed tail' }]);
  assert.equal(update.instrumentation.fullParse, false);
  assert(update.parsedSpan.start > 0);
  assert.equal(update.snapshot.document.tree.children[0], before.document.tree.children[0]);
  assert.equal(update.snapshot.document.tree.children[1], before.document.tree.children[1]);
  assert.equal(update.snapshot.document.definitionFor('guide')?.destination, '/one');
});

test('definition invalidation recognizes CR-only source lines', () => {
  const source = '[guide]\r\rplaceholder';
  const session = createMarkdownDocumentSession(source);
  const start = source.indexOf('placeholder');
  const update = session.applyEdits([{
    span: { start, end: source.length },
    text: '[guide]: /target'
  }]);
  assert.equal(update.instrumentation.fullParse, true);
  assert.equal(update.snapshot.document.definitionFor('guide')?.destination, '/target');
  assert.equal(collectMarkdownLinks(update.snapshot.document.tree).length, 1);
  const fresh = parseMarkdown(update.snapshot.source);
  const withoutIds = (value) => JSON.stringify(value, (key, entry) => key === 'id' ? 0 : entry);
  assert.equal(withoutIds(update.snapshot.document.tree), withoutIds(fresh.tree));
});

test('point edits inside definitions invalidate earlier resolved references', () => {
  const source = '[guide]\n\nBody\n\n[guide]: /target';
  const session = createMarkdownDocumentSession(source);
  const offset = source.indexOf('/target') + 3;
  const update = session.applyEdits([{ span: { start: offset, end: offset }, text: '\n' }]);
  assert.equal(update.instrumentation.fullParse, true);
  const fresh = parseMarkdown(update.snapshot.source);
  const withoutIds = (value) => JSON.stringify(value, (key, entry) => key === 'id' ? 0 : entry);
  assert.equal(withoutIds(update.snapshot.document.tree), withoutIds(fresh.tree));
  assert.deepEqual(
    collectMarkdownLinks(update.snapshot.document.tree).map((link) => link.destination),
    collectMarkdownLinks(fresh.tree).map((link) => link.destination)
  );
});

test('projects source syntax tokens and builds a per-snapshot tree index', () => {
  const source = '# **Title**\n\n- [x] item';
  const parsed = parseMarkdown(source, { dialect: 'gfm' });
  const tokens = collectMarkdownSyntaxTokens(parsed.tree);
  assert(tokens.some((token) => token.kind === 'headingMarker'));
  assert(tokens.some((token) => token.kind === 'strongMarker'));
  assert(tokens.some((token) => token.kind === 'taskMarker'));
  const index = createMarkdownTreeIndex(parsed.tree);
  const heading = collectMarkdownNodes(parsed.tree, 'heading')[0];
  assert.equal(index.node(heading.id), heading);
  assert.equal(index.path(heading.id).map((node) => node.kind).join('/'), 'document/heading');
  assert.equal(index.nodeAt(source.indexOf('Title'))?.kind, 'text');
});

test('tree index includes GFM footnote definitions as blocks', () => {
  const parsed = parseMarkdown('Text[^note].\n\n[^note]: Explanation.', { dialect: 'gfm' });
  const footnote = parsed.tree.children.find((node) => node.kind === 'footnoteDefinition');
  assert(footnote !== undefined);
  const index = createMarkdownTreeIndex(parsed.tree);
  assert.equal(index.blocks.includes(footnote), true);
  assert.equal(index.node(footnote.id), footnote);
});
