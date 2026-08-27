import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collectMarkdownLinks,
  countMarkdownDocumentWords,
  collectMarkdownNodes,
  createMarkdownSourceIndex,
  createMarkdownDocumentSession,
  extractMarkdownOutline,
  extractMarkdownText,
  updateMarkdownSourceIndex,
  walkMarkdown
} from '../dist/mod.js';

const options = Object.freeze({
  dialect: 'gfm',
  extensions: Object.freeze(['frontMatter', 'callouts', 'math'])
});

function withoutSessionIds(value) {
  if (Array.isArray(value)) return value.map(withoutSessionIds);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'id' && key !== 'nodeId')
    .map(([key, entry]) => [key, withoutSessionIds(entry)]));
}

function canonical(snapshot) {
  const { document, source } = snapshot;
  return {
    source,
    tree: withoutSessionIds(document.tree),
    slices: [...walkMarkdown(document.tree)].map(({ node }) => ({
      kind: node.kind,
      span: node.span,
      source: source.slice(node.span.start, node.span.end)
    })),
    definitions: withoutSessionIds(document.definitions),
    footnotes: withoutSessionIds(document.footnotes),
    diagnostics: document.diagnostics,
    metadata: document.metadata,
    plainText: extractMarkdownText(document.tree),
    outline: withoutSessionIds(extractMarkdownOutline(document.tree)),
    links: withoutSessionIds(collectMarkdownLinks(document.tree)),
    wordCount: countMarkdownDocumentWords(document.tree),
    previewPlainText: extractMarkdownText(document.tree, {
      image: 'alt',
      code: 'include',
      blockSeparator: '\n'
    })
  };
}

function assertFreshEquivalent(session) {
  const incremental = session.snapshot();
  const fresh = createMarkdownDocumentSession(incremental.source, options).snapshot();
  assert.deepEqual(canonical(incremental), canonical(fresh));
}

function safeOffset(source, value) {
  let offset = Math.max(0, Math.min(source.length, value));
  if (offset > 0 && offset < source.length) {
    const code = source.charCodeAt(offset);
    if (code >= 0xdc00 && code <= 0xdfff) offset -= 1;
  }
  return offset;
}

function generator(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state;
  };
}

test('seeded incremental edit streams are canonically equivalent to fresh sessions', () => {
  const initial = [
    '---',
    'title: Incremental suite',
    'emoji: 🙂',
    '---',
    '',
    '# Heading é',
    '',
    '> [!NOTE]',
    '> Quoted **strong** text with $x^2$.',
    '',
    '1. [x] first',
    '   - nested [link][guide]',
    '2. [ ] second',
    '',
    '| A | B |',
    '| :- | -: |',
    '| wide 界 | ![image](local.png "title") |',
    '',
    '```ts',
    'const value = "escaped \\*";',
    '```',
    '',
    '$$',
    'x = y + 1',
    '$$',
    '',
    'Reference [guide] and footnote[^one]. &amp;',
    '',
    '[guide]: docs/guide.md "Guide"',
    '[^one]: Footnote body.',
    '',
    'Malformed **tail [text.'
  ].join('\r\n');
  const session = createMarkdownDocumentSession(initial, options);
  assertFreshEquivalent(session);

  const history = [];
  const apply = (start, end, text) => {
    const source = session.snapshot().source;
    const deleted = source.slice(start, end);
    session.applyEdits([{ span: { start, end }, text }]);
    history.push({ start, deleted, inserted: text });
    assertFreshEquivalent(session);
  };

  apply(0, 0, '<!-- beginning -->\r\n\r\n');
  let source = session.snapshot().source;
  apply(Math.floor(source.length / 2), Math.floor(source.length / 2), ' pasted 🙂 ');
  source = session.snapshot().source;
  apply(source.length, source.length, '\r\nEnd.');

  const random = generator(0x5eedc0de);
  const insertions = ['', 'x', '**b**', '\r\n', '\t', '🙂', '[ref][guide]', '$z$', '> quote\r\n'];
  for (let index = 0; index < 72; index += 1) {
    source = session.snapshot().source;
    const first = safeOffset(source, random() % (source.length + 1));
    const width = random() % 7;
    const second = safeOffset(source, Math.min(source.length, first + width));
    apply(first, Math.max(first, second), insertions[random() % insertions.length] ?? '');
  }

  for (const entry of history.slice(-8).toReversed()) {
    session.applyEdits([{
      span: { start: entry.start, end: entry.start + entry.inserted.length },
      text: entry.deleted
    }]);
    assertFreshEquivalent(session);
  }
  for (const entry of history.slice(-8)) {
    session.applyEdits([{
      span: { start: entry.start, end: entry.start + entry.deleted.length },
      text: entry.inserted
    }]);
    assertFreshEquivalent(session);
  }
});

test('unchanged nodes retain session identifiers across insertions and replacements', () => {
  const source = '# First\n\nAlpha.\n\nBeta.\n\nGamma.';
  const session = createMarkdownDocumentSession(source, options);
  const before = session.snapshot().document.tree.children;
  const beta = source.indexOf('Beta');
  const update = session.applyEdits([{ span: { start: beta, end: beta + 4 }, text: 'Changed' }]);
  const after = update.snapshot.document.tree.children;

  assert.equal(after[0], before[0]);
  assert.equal(after[1], before[1]);
  assert.equal(after[3]?.id, before[3]?.id);
  assert(update.instrumentation.reusedNodes >= 5);
  assert.equal(update.instrumentation.fullParse, false);
});

test('syntax-neutral edits reuse parser units inside giant block containers', () => {
  const fixtures = [
    Array.from({ length: 2_000 }, (_, index) => `- list item ${String(index)}`).join('\n'),
    ['| key | value |', '| --- | --- |', ...Array.from({ length: 2_000 }, (_, index) => `| row ${String(index)} | table value ${String(index)} |`)].join('\n'),
    Array.from({ length: 2_000 }, (_, index) => `> quoted value ${String(index)}`).join('\n'),
    `\`\`\`ts\n${Array.from({ length: 2_000 }, (_, index) => `const value${String(index)} = ${String(index)};`).join('\n')}\n\`\`\``,
    `paragraph ${'word '.repeat(50_000)}tail`
  ];
  for (const initial of fixtures) {
    const needle = initial.includes('table value') ? 'table value'
      : initial.includes('quoted value') ? 'quoted value'
        : initial.includes('const value') ? 'const value'
          : initial.includes('list item') ? 'list item'
            : 'word word';
    const occurrence = initial.indexOf(needle, Math.floor(initial.length / 3));
    assert(occurrence >= 0);
    const offset = occurrence + 2;
    for (const edit of [
      { span: { start: offset, end: offset }, text: 'Z' },
      { span: { start: offset, end: offset + 1 }, text: '' },
      { span: { start: offset, end: offset + 1 }, text: 'Z' }
    ]) {
      const session = createMarkdownDocumentSession(initial, options);
      const beforeNodes = [...walkMarkdown(session.snapshot().document.tree)].map(({ node }) => node);
      const beforeContainerId = session.snapshot().document.tree.children[0]?.id;
      const stableLeaf = beforeNodes.find((node) => node.kind === 'text' && node.span.end < offset);
      const update = session.applyEdits([edit]);
      assert.equal(update.instrumentation.fullParse, false);
      assert.equal(update.instrumentation.parsedCodeUnits, 0);
      assert.equal(update.instrumentation.parsedNodes, 0);
      assert(update.instrumentation.sourceTraversalCodeUnits >= update.snapshot.source.length);
      assert(update.instrumentation.sourceIndexCodeUnits <= initial.length);
      if (initial.includes('\n')) assert(update.instrumentation.sourceIndexCodeUnits < initial.length / 10);
      assert(update.instrumentation.reconciledNodes > 0);
      assert.notEqual(update.snapshot.document.tree.children[0]?.id, beforeContainerId);
      assert(update.instrumentation.reusedNodes >= beforeNodes.length - 12);
      assert(update.instrumentation.reusedNodes <= update.snapshot.document.metadata.nodeCount);
      if (stableLeaf !== undefined) {
        assert([...walkMarkdown(update.snapshot.document.tree)].some(({ node }) => node.id === stableLeaf.id));
      }
      assertFreshEquivalent(session);
    }
  }
});

test('malformed YAML front matter reports stable source-exact diagnostics', () => {
  const source = [
    '---',
    'root:',
    '    valid: true',
    '  invalid: indentation',
    'quoted: "unterminated',
    'block: |invalid',
    '---'
  ].join('\n');
  const session = createMarkdownDocumentSession(source, options);
  const diagnostics = session.snapshot().document.diagnostics;
  assert.deepEqual(diagnostics.map((diagnostic) => diagnostic.message), [
    'Unexpected YAML indentation.',
    'A double-quoted YAML scalar is not closed.',
    'A YAML block scalar header is malformed.'
  ]);
  for (const diagnostic of diagnostics) {
    assert(diagnostic.span.start >= 0);
    assert(diagnostic.span.end <= source.length);
    assert(diagnostic.span.end >= diagnostic.span.start);
  }
});

test('shifted definition spans update on stable prefix references', () => {
  const source = '# Top\n\n[guide]\n\nFirst.\n\nMiddle.\n\n[guide]: /target';
  const session = createMarkdownDocumentSession(source, options);
  const beforeLink = collectMarkdownNodes(session.snapshot().document.tree, 'link')[0];
  const middle = source.indexOf('Middle');
  const update = session.applyEdits([{ span: { start: middle, end: middle }, text: 'Longer ' }]);
  const afterLink = collectMarkdownNodes(update.snapshot.document.tree, 'link')[0];

  assert.equal(update.instrumentation.fullParse, false);
  assert(update.instrumentation.comparedCodeUnits > 0);
  assert(update.instrumentation.reconciledNodes > 0);
  assert(update.instrumentation.sourceTraversalCodeUnits >= update.instrumentation.parsedCodeUnits);
  assert.equal(afterLink?.nodeId, beforeLink?.nodeId);
  assert.equal(
    afterLink?.definitionSpan?.start,
    (beforeLink?.definitionSpan?.start ?? 0) + 'Longer '.length
  );
  assertFreshEquivalent(session);
});

test('edits to shortcut reference text reparse definition-sensitive syntax', () => {
  const source = '[alpha]\n\n[alpha]: /destination';
  const session = createMarkdownDocumentSession(source, options);
  const update = session.applyEdits([{ span: { start: 3, end: 4 }, text: 'z' }]);
  assert(update.instrumentation.parsedCodeUnits > 0);
  assertFreshEquivalent(session);
  assert.equal(collectMarkdownLinks(update.snapshot.document.tree).length, 0);
});

test('incremental source indexes are identical to indexes created from the resulting source', () => {
  let source = 'first\r\nsecond\nthird\rfourth\n🙂 wide 界\n';
  let index = createMarkdownSourceIndex(source);
  const random = generator(0x1de7cafe);
  const insertions = ['', '\n', '\r\n', 'text', '🙂', '\r', '\n\n'];

  for (let editNumber = 0; editNumber < 160; editNumber += 1) {
    const start = safeOffset(source, random() % (source.length + 1));
    const end = safeOffset(source, Math.min(source.length, start + (random() % 6)));
    const text = insertions[random() % insertions.length] ?? '';
    const edit = { span: { start, end: Math.max(start, end) }, text };
    source = `${source.slice(0, edit.span.start)}${text}${source.slice(edit.span.end)}`;
    index = updateMarkdownSourceIndex(index, source, [edit]);
    const fresh = createMarkdownSourceIndex(source);

    assert.equal(index.length, fresh.length);
    assert.equal(index.lineCount, fresh.lineCount);
    for (let line = 0; line < fresh.lineCount; line += 1) {
      assert.deepEqual(index.lineSpan(line), fresh.lineSpan(line));
      assert.deepEqual(index.lineSpan(line, true), fresh.lineSpan(line, true));
    }
    for (let offset = 0; offset <= source.length; offset += 1) {
      assert.deepEqual(index.positionAt(offset), fresh.positionAt(offset));
    }
  }
});

test('source index updates map ordered line-ending insertions at one boundary', () => {
  const previousSource = 'alpha\nomega';
  const edits = [
    { span: { start: 6, end: 6 }, text: 'first\r\n' },
    { span: { start: 6, end: 6 }, text: 'second\r' }
  ];
  const source = 'alpha\nfirst\r\nsecond\romega';
  const updated = updateMarkdownSourceIndex(createMarkdownSourceIndex(previousSource), source, edits);
  const fresh = createMarkdownSourceIndex(source);
  assert.equal(updated.lineCount, fresh.lineCount);
  for (let line = 0; line < fresh.lineCount; line += 1) {
    assert.deepEqual(updated.lineSpan(line, true), fresh.lineSpan(line, true));
  }
  assert.throws(
    () => updateMarkdownSourceIndex(createMarkdownSourceIndex('abc'), 'wrong', [
      { span: { start: 1, end: 1 }, text: 'x' }
    ]),
    /source length must be 4/u
  );
  assert.throws(
    () => updateMarkdownSourceIndex(createMarkdownSourceIndex('abc'), 'xbc', [
      { span: { start: 0, end: 0 }, text: 'x' },
      { span: { start: 0, end: 1 }, text: '' }
    ]),
    /source index edits overlap/u
  );
});
