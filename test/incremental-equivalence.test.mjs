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
    sourceLines: Array.from({ length: document.sourceIndex.lineCount }, (_, line) => ({
      content: document.sourceIndex.lineSpan(line),
      ending: document.sourceIndex.lineSpan(line, true)
    })),
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

function assertFreshEquivalent(session, parseOptions = options) {
  const incremental = session.snapshot();
  const fresh = createMarkdownDocumentSession(incremental.source, parseOptions).snapshot();
  assert.deepEqual(canonical(incremental), canonical(fresh));
  assert.equal(incremental.document.sourceText, incremental.source);
  const nodes = [...walkMarkdown(incremental.document.tree)].map(({ node }) => node);
  assert.equal(new Set(nodes.map((node) => node.id)).size, nodes.length);
  for (const definition of [...incremental.document.definitions, ...incremental.document.footnotes]) {
    assert(nodes.some((node) => node.id === definition.nodeId));
  }
  assert.equal(nodes.length, incremental.document.metadata.nodeCount);
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

for (const dialect of ['commonmark', 'gfm']) {
  test(`incremental source regions own whitespace and block boundaries (${dialect})`, () => {
    const parseOptions = { ...options, dialect };
    for (const ending of ['\n', '\r\n', '\r']) {
      const fixtures = [
        '', ' ', '\t', ending, `${ending}text`, ` ${ending}# Heading`,
        `  text${ending}${ending}  tail  `,
        `first${ending}${ending}last${ending}${ending}`,
        `first${ending}# Heading${ending}${ending}tail`,
        `first${ending}${ending}---${ending}${ending}tail`,
        `---${ending}title: Test${ending}---${ending}${ending}tail`,
        `prefix${ending}${ending}  - item${ending}${ending}tail`,
        `- first${ending}${ending}+ second${ending}${ending}tail`,
        `    code${ending}${ending}paragraph${ending}${ending}tail`,
        `> quote${ending}${ending}> second${ending}${ending}tail`,
        `first${ending}${ending}\`\`\`js${ending}value${ending}\`\`\`${ending}${ending}tail`,
        `[label]${ending}${ending}[label]: /target${ending}${ending}tail`
      ];
      for (const source of fixtures) {
        for (let start = 0; start <= source.length; start += 1) {
          for (const text of ['x', '', ending, '    ', '- ']) {
            const end = Math.min(source.length, start + (text === '' ? 1 : 0));
            const session = createMarkdownDocumentSession(source, parseOptions);
            const edit = { span: { start, end }, text };
            const deleted = source.slice(start, end);
            const context = JSON.stringify({ source, edit });
            session.applyEdits([edit]);
            assert.equal(session.snapshot().source, source.slice(0, start) + text + source.slice(end), context);
            try {
              assertFreshEquivalent(session, parseOptions);
              session.applyEdits([{ span: { start, end: start + text.length }, text: deleted }]);
              assertFreshEquivalent(session, parseOptions);
              assert.equal(session.snapshot().source, source, context);
              session.applyEdits([edit]);
              assertFreshEquivalent(session, parseOptions);
            } catch (error) {
              throw new Error(context, { cause: error });
            }
          }
        }
      }
    }
  });
}

test('definition dependencies and inactive syntax are invalidated at their source region', () => {
  const cases = [
    { source: '[a]\n\ntb]\n\n[a]:t', start: 6, end: 10, text: '' },
    { source: '**', start: 1, end: 1, text: '\u0301' },
    { source: 'a\n```', start: 2, end: 4, text: '' },
    { source: '[guide]\n\n.\n\n[guide]:.', start: 11, end: 11, text: '|' },
    { source: 'a\n```', start: 2, end: 2, text: ']' },
    { source: '[^two]\n\nm\n[^two]:', start: 9, end: 10, text: '' },
    { source: '[^one]\n[^one]:\n    \n', start: 19, end: 20, text: ']' },
    { source: '[^a]: [b]\n\n[^a]\n\ntext\n\n[b]: /target', start: 23, end: 23, text: 'x' },
    { source: 'htxtp://example.com', start: 2, end: 3, text: '' },
    { source: 'wwxw.example.com', start: 2, end: 3, text: '' },
    { source: '[a]\n\n```\ncode\n```\n\n[a]: /target', start: 15, end: 16, text: 'x' }
  ];
  for (const { source, start, end, text } of cases) {
    const session = createMarkdownDocumentSession(source, options);
    session.applyEdits([{ span: { start, end }, text }]);
    assertFreshEquivalent(session);
    session.applyEdits([{ span: { start, end: start + text.length }, text: source.slice(start, end) }]);
    assertFreshEquivalent(session);
    assert.equal(session.snapshot().source, source);
  }
});

test('deleting indented-code line content invalidates blank block boundaries', () => {
  for (const ending of ['\n', '\r\n', '\r']) {
    for (const body of [
      '     word ',
      `     word ${ending}    next`,
      `    first${ending}     word `,
      `    first${ending}     word ${ending}    last`,
      `    first${ending}    ${ending}     word ${ending}    `,
      `\t word\t${ending}    next`
    ]) {
      for (const source of [body, `# Prefix${ending}${ending}${body}${ending}${ending}Tail`]) {
        const session = createMarkdownDocumentSession(source, options);
        const start = source.indexOf('word');
        const edit = { span: { start, end: start + 4 }, text: '' };
        const update = session.applyEdits([edit]);
        assertFreshEquivalent(session);
        assert(update.instrumentation.parsedCodeUnits > 0);
        session.applyEdits([{ span: { start, end: start }, text: 'word' }]);
        assertFreshEquivalent(session);
        assert.equal(session.snapshot().source, source);
        session.applyEdits([edit]);
        assertFreshEquivalent(session);
      }
    }
  }
});

test('footnote edits derive ordered definition identities from the rebuilt tree', () => {
  for (const source of ['[^a]: word\n\n[^a]', '[^a]: [^b]: word', '# Title\n\n[^a]: [^b]: word\n\nTail']) {
    for (const text of ['Z', 'ZZ', '', '**Z**']) {
      const session = createMarkdownDocumentSession(source, options);
      const oldDefinitionId = session.snapshot().document.footnotes[0].nodeId;
      const start = source.indexOf('word') + 1;
      const edit = { span: { start, end: start + 1 }, text };
      const update = session.applyEdits([edit]);
      if (text === '**Z**') assert(update.instrumentation.parsedCodeUnits > 0);
      else assert.equal(update.instrumentation.parsedCodeUnits, 0);
      assert.notEqual(update.snapshot.document.footnotes[0].nodeId, oldDefinitionId);
      assertFreshEquivalent(session);
      session.applyEdits([{ span: { start, end: start + text.length }, text: source.slice(start, start + 1) }]);
      assertFreshEquivalent(session);
      assert.equal(session.snapshot().source, source);
    }
  }
});

test('blank-gap edits preserve a bounded suffix and stable prefix identities', () => {
  const source = Array.from({ length: 1_000 }, (_, index) => `paragraph ${index}`).join('\n\n');
  const session = createMarkdownDocumentSession(source, options);
  const before = session.snapshot().document.tree.children;
  const start = source.lastIndexOf('\n\n') + 1;
  const update = session.applyEdits([{ span: { start, end: start }, text: '- item' }]);
  assert.equal(update.instrumentation.fullParse, false);
  assert(update.instrumentation.parsedCodeUnits < source.length / 100);
  assert(update.parsedSpan.start <= start);
  assert(update.instrumentation.reusedNodes >= 1_990);
  for (let index = 0; index < 998; index += 1) {
    assert.equal(update.snapshot.document.tree.children[index], before[index]);
  }
  assertFreshEquivalent(session);
});

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
    `paragraph ${'word '.repeat(50_000)}tail.`
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

test('source-index updates rescan deleted content that joins CR and LF endings', () => {
  for (const edits of [
    [{ span: { start: 2, end: 4 }, text: '' }],
    [{ span: { start: 2, end: 3 }, text: '' }, { span: { start: 3, end: 4 }, text: '' }]
  ]) {
    const source = 'a\rxy\nb';
    const updated = updateMarkdownSourceIndex(createMarkdownSourceIndex(source), 'a\r\nb', edits);
    const fresh = createMarkdownSourceIndex('a\r\nb');
    assert.equal(updated.lineCount, fresh.lineCount);
    for (let line = 0; line < fresh.lineCount; line += 1) {
      assert.deepEqual(updated.lineSpan(line, true), fresh.lineSpan(line, true));
    }
    for (let offset = 0; offset <= fresh.length; offset += 1) {
      assert.deepEqual(updated.positionAt(offset), fresh.positionAt(offset));
    }
  }
});
