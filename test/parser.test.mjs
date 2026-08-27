import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectMarkdownNodes,
  markdownCodeValueSourceSpan,
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
  assert.equal(code?.value, 'const answer = 42;\n');
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

test('uses one Unicode-compatible normalization for definitions and references', () => {
  const source = '[Straße Name]: /road\n\n[STRASSE   NAME]';
  const parsed = parseMarkdown(source);
  assert.equal(parsed.definitionFor(' strasse\tname ')?.destination, '/road');
  assert.equal(collectMarkdownNodes(parsed.tree, 'link')[0]?.destination, '/road');
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
  assert.equal(code?.value, 'foo\tbaz\t\tbim\n');
  assert.equal(sliceMarkdownSource(source, code.span), '\tfoo\tbaz\t\tbim');
  const quote = collectMarkdownNodes(parsed.tree, 'blockQuote')[0];
  assert.equal(sliceMarkdownSource(source, quote.markerSpans[0]), '>');
  assert.equal(parsed.sourceText, source);
});

test('maps normalized code values to exact CRLF, indentation, tab, blank-line, and Unicode source spans', () => {
  const source = '  ```ts\r\n  const emoji = "🙂";\r\n  \twide();\r\n\r\n  ```';
  const code = collectMarkdownNodes(parseMarkdown(source).tree, 'codeBlock')[0];
  assert.equal(code?.value, 'const emoji = "🙂";\n\twide();\n\n');
  assert.deepEqual(code?.valueSourceMap.segments.map((segment) => ({
    kind: segment.kind,
    value: code.value.slice(segment.valueStart, segment.valueEnd),
    source: source.slice(segment.sourceSpan.start, segment.sourceSpan.end)
  })), [
    { kind: 'text', value: 'const emoji = "🙂";', source: 'const emoji = "🙂";' },
    { kind: 'lineEnding', value: '\n', source: '\r\n' },
    { kind: 'text', value: '\twide();', source: '\twide();' },
    { kind: 'lineEnding', value: '\n', source: '\r\n' },
    { kind: 'emptyLine', value: '', source: '' },
    { kind: 'lineEnding', value: '\n', source: '\r\n' }
  ]);
  const tokenStart = code?.value.indexOf('wide') ?? 0;
  const tokenSpan = code === undefined ? { start: 0, end: 0 } : markdownCodeValueSourceSpan(code, tokenStart, tokenStart + 4);
  assert.equal(source.slice(tokenSpan.start, tokenSpan.end), 'wide');

  const indentedSource = '\talpha\r    beta\r\n    界';
  const indented = collectMarkdownNodes(parseMarkdown(indentedSource).tree, 'codeBlock')[0];
  assert.equal(indented?.value, 'alpha\nbeta\n界');
  assert.deepEqual(indented?.valueSourceMap.segments.filter((segment) => segment.kind === 'lineEnding').map((segment) => (
    indentedSource.slice(segment.sourceSpan.start, segment.sourceSpan.end)
  )), ['\r', '\r\n']);

  const virtualSource = '-   \tfoo';
  const virtual = collectMarkdownNodes(parseMarkdown(virtualSource).tree, 'codeBlock')[0];
  assert.equal(virtual?.value, '  foo');
  assert.deepEqual(virtual?.valueSourceMap.segments, [
    { kind: 'virtualSpaces', valueStart: 0, valueEnd: 2, sourceSpan: { start: 4, end: 5 } },
    { kind: 'text', valueStart: 2, valueEnd: 5, sourceSpan: { start: 5, end: 8 } }
  ]);
  assert.deepEqual(markdownCodeValueSourceSpan(virtual, 0, 1), { start: 4, end: 5 });

  const endedSource = '```\nlast line\n```';
  const ended = collectMarkdownNodes(parseMarkdown(endedSource).tree, 'codeBlock')[0];
  assert.equal(ended?.value, 'last line\n');
  assert.equal(endedSource.slice(ended?.valueSourceMap.segments.at(-1)?.sourceSpan.start, ended?.valueSourceMap.segments.at(-1)?.sourceSpan.end), '\n');
  assert.deepEqual(markdownCodeValueSourceSpan(ended, ended.value.length, ended.value.length), {
    start: endedSource.indexOf('\n', endedSource.indexOf('last line')) + 1,
    end: endedSource.indexOf('\n', endedSource.indexOf('last line')) + 1
  });
  const unterminatedSource = '```\nlast line';
  const unterminated = collectMarkdownNodes(parseMarkdown(unterminatedSource).tree, 'codeBlock')[0];
  assert.equal(unterminated?.value, 'last line');
  assert.equal(unterminated?.valueSourceMap.segments.at(-1)?.kind, 'text');

  for (const [partialTabSource, expectedValue, expectedSpaces] of [
    ['  ```\n\tfoo\n  ```', '  foo\n', 2],
    ['   ```\r\n\tfoo\r\n   ```', ' foo\n', 1],
    ['  ```\r\n \t界\r\n  ```', '  界\n', 2]
  ]) {
    const partialTab = collectMarkdownNodes(parseMarkdown(partialTabSource).tree, 'codeBlock')[0];
    assert.equal(partialTab?.value, expectedValue);
    const virtual = partialTab?.valueSourceMap.segments[0];
    assert.equal(virtual?.kind, 'virtualSpaces');
    assert.equal(virtual?.valueEnd - virtual?.valueStart, expectedSpaces);
    assert.equal(partialTabSource.slice(virtual?.sourceSpan.start, virtual?.sourceSpan.end), '\t');
    assert.deepEqual(markdownCodeValueSourceSpan(partialTab, 0, expectedSpaces), virtual?.sourceSpan);
  }
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
  assert.equal(frontMatter?.value?.kind, 'mapping');
  if (frontMatter?.value?.kind === 'mapping') {
    assert.deepEqual(frontMatter.value.entries.map((entry) => [
      entry.key,
      entry.value.kind === 'scalar' ? entry.value.value : entry.value.kind,
      source.slice(entry.keySpan.start, entry.keySpan.end),
      source.slice(entry.valueSpan.start, entry.valueSpan.end)
    ]), [
      ['title', 'Demo', 'title', 'Demo'],
      ['unsafe', '!constructor value', 'unsafe', '!constructor value']
    ]);
  }
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

test('parses nested safe YAML front matter with exact recursive spans and deterministic diagnostics', () => {
  const source = [
    '---',
    '# preserved comment',
    '"display name": \'Markspan\' # inline comment',
    'title: "Demo # title"',
    'authors:',
    "  - name: 'Ada'",
    '    roles:',
    '      - editor',
    '      - reviewer',
    'settings:',
    '  enabled: true',
    '  count: 3',
    'summary: |',
    '  first line',
    '  second line',
    'folded: >-',
    '  one',
    '  two',
    'unsafe: &anchor value',
    'alias: *anchor',
    'tagged: !thing value',
    '---'
  ].join('\r\n');
  const frontMatter = parseMarkdown(source, { extensions: ['frontMatter'] }).tree.children[0];
  assert.equal(frontMatter?.kind, 'frontMatter');
  if (frontMatter?.kind !== 'frontMatter' || frontMatter.value?.kind !== 'mapping') return;
  assert.equal(frontMatter.value.entries[0]?.value.kind, 'scalar');
  assert.equal(frontMatter.value.entries[0]?.key, 'display name');
  assert.equal(source.slice(frontMatter.value.entries[0]?.keySpan.start, frontMatter.value.entries[0]?.keySpan.end), '"display name"');
  assert.equal(frontMatter.value.entries[0]?.value.kind === 'scalar' ? frontMatter.value.entries[0].value.value : undefined, 'Markspan');
  assert.equal(frontMatter.value.entries[1]?.value.kind, 'scalar');
  assert.equal(frontMatter.value.entries[2]?.value.kind, 'sequence');
  const authors = frontMatter.value.entries[2]?.value;
  assert.equal(authors?.kind === 'sequence' ? authors.items[0]?.kind : undefined, 'mapping');
  assert.equal(frontMatter.value.entries[3]?.value.kind, 'mapping');
  assert.equal(frontMatter.value.entries[4]?.value.kind === 'scalar' ? frontMatter.value.entries[4].value.value : undefined, 'first line\nsecond line\n');
  assert.equal(frontMatter.value.entries[5]?.value.kind === 'scalar' ? frontMatter.value.entries[5].value.value : undefined, 'one two');
  for (const entry of frontMatter.value.entries.slice(1)) {
    assert.equal(source.slice(entry.keySpan.start, entry.keySpan.end), entry.key);
    assert(entry.valueSpan.start >= entry.keySpan.end);
  }
  const diagnostics = parseMarkdown(source, { extensions: ['frontMatter'] }).diagnostics;
  assert.deepEqual(diagnostics.map((diagnostic) => diagnostic.message), [
    'YAML anchors are not supported in front matter.',
    'YAML aliases are not supported in front matter.',
    'YAML tags are not supported in front matter.'
  ]);
  const quotedConstructs = parseMarkdown('---\nvalue: "safe &anchor *alias !tag"\n---', { extensions: ['frontMatter'] });
  assert.deepEqual(quotedConstructs.diagnostics, []);
  const flowConstructs = parseMarkdown('---\nvalue: [plain, &anchor item, *anchor, !tag value]\n---', { extensions: ['frontMatter'] });
  assert.deepEqual(flowConstructs.diagnostics.map((diagnostic) => diagnostic.message), [
    'YAML anchors are not supported in front matter.',
    'YAML aliases are not supported in front matter.',
    'YAML tags are not supported in front matter.'
  ]);
  const flowValues = parseMarkdown('---\nvalue: [one, {name: "Ada", roles: [editor, reviewer]}]\n---', { extensions: ['frontMatter'] });
  const flowRoot = flowValues.tree.children[0];
  assert.equal(flowValues.diagnostics.length, 0);
  assert.equal(flowRoot?.kind === 'frontMatter' && flowRoot.value?.kind === 'mapping'
    ? flowRoot.value.entries[0]?.value.kind
    : undefined, 'sequence');
  if (flowRoot?.kind === 'frontMatter' && flowRoot.value?.kind === 'mapping') {
    const sequence = flowRoot.value.entries[0]?.value;
    assert.equal(sequence?.kind === 'sequence' ? sequence.items[1]?.kind : undefined, 'mapping');
    const nested = sequence?.kind === 'sequence' ? sequence.items[1] : undefined;
    assert.equal(nested?.kind === 'mapping' ? nested.entries[1]?.value.kind : undefined, 'sequence');
  }
  const deeplyNested = parseMarkdown(`---\nvalue: ${'['.repeat(300)}item${']'.repeat(300)}\n---`, { extensions: ['frontMatter'] });
  assert.deepEqual(deeplyNested.diagnostics.map((diagnostic) => diagnostic.message), [
    'YAML parsing work exceeds the bounded limit.'
  ]);
});

test('parses root YAML scalars and rejects ambiguous or unsafe YAML deterministically', () => {
  for (const [source, expectedStyle, expectedValue] of [
    ['---\nplain root # comment\n---', 'plain', 'plain root'],
    ['---\n"quoted root"\n---', 'doubleQuoted', 'quoted root'],
    ['---\n|2\n  root\n---', 'literal', 'root\n']
  ]) {
    const parsed = parseMarkdown(source, { extensions: ['frontMatter'] });
    const frontMatter = parsed.tree.children[0];
    assert.equal(frontMatter?.kind, 'frontMatter');
    assert.equal(frontMatter?.kind === 'frontMatter' ? frontMatter.value?.kind : undefined, 'scalar');
    if (frontMatter?.kind === 'frontMatter' && frontMatter.value?.kind === 'scalar') {
      assert.equal(frontMatter.value.style, expectedStyle);
      assert.equal(frontMatter.value.value, expectedValue);
    }
    assert.deepEqual(parsed.diagnostics, []);
  }

  const unsafe = [
    '---',
    '&anchor: value',
    'duplicate: one',
    'duplicate: two',
    'flow: {key: one, key: two}',
    'block: |4',
    '  under-indented',
    'surrogate: "\\uD800"',
    '---'
  ].join('\n');
  const diagnostics = parseMarkdown(unsafe, { extensions: ['frontMatter'] }).diagnostics;
  assert.deepEqual(diagnostics.map((diagnostic) => [
    diagnostic.message,
    unsafe.slice(diagnostic.span.start, diagnostic.span.end)
  ]), [
    ['YAML anchors are not supported in front matter.', '&anchor'],
    ['YAML mapping keys must be unique.', 'duplicate'],
    ['YAML mapping keys must be unique.', 'key'],
    ['A YAML block scalar line does not satisfy its indentation indicator.', '  '],
    ['A double-quoted YAML escape is not a Unicode scalar value.', '\\uD800']
  ]);

  const malformed = parseMarkdown('---\nblock: |++\n  text\n---', { extensions: ['frontMatter'] });
  assert.deepEqual(malformed.diagnostics.map((diagnostic) => diagnostic.message), [
    'A YAML block scalar header is malformed.',
    'Unexpected YAML indentation.'
  ]);
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
