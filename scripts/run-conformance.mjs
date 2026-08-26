import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { parseMarkdown, walkMarkdown } from '../dist/mod.js';
import { renderConformanceDocument } from './render-conformance.mjs';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('fixtures/MANIFEST.json', root), 'utf8'));

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function gfmExamples(source) {
  const lines = source.split('\n');
  const examples = [];
  let section = 'Preamble';
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const heading = /^(#{2,3}) +(.*)$/u.exec(line);
    if (heading !== null) section = heading[2] ?? section;
    const opening = /^(`{10,}) example$/u.exec(line);
    if (opening === null) continue;
    const fence = opening[1]?.trimStart() ?? '';
    const markdown = [];
    const html = [];
    let target = markdown;
    let closed = false;
    for (index += 1; index < lines.length; index += 1) {
      const content = lines[index] ?? '';
      if (content === fence) {
        closed = true;
        break;
      }
      if (content === '.' && target === markdown) {
        target = html;
      } else {
        target.push(content);
      }
    }
    assert.equal(closed, true, `unterminated GFM fixture after example ${examples.length + 1}`);
    examples.push({
      example: examples.length + 1,
      section,
      markdown: `${markdown.join('\n')}\n`,
      html: `${html.join('\n')}\n`
    });
  }
  return examples;
}

function validateTree(document, sourceLength) {
  const ids = new Set();
  let count = 0;
  for (const { node, parent } of walkMarkdown(document.tree)) {
    count += 1;
    assert.equal(Object.isFrozen(node), true);
    assert.equal(Number.isSafeInteger(node.id), true);
    assert.equal(ids.has(node.id), false, `duplicate node id ${node.id}`);
    ids.add(node.id);
    assert(node.span.start >= 0 && node.span.start <= node.span.end && node.span.end <= sourceLength);
    if (parent !== null) {
      assert(parent.span.start <= node.span.start && parent.span.end >= node.span.end);
    }
  }
  assert.equal(count, document.metadata.nodeCount);
}

async function loadFixtures() {
  const commonmarkBytes = await readFile(new URL(`fixtures/${manifest.commonmark.path}`, root));
  const gfmBytes = await readFile(new URL(`fixtures/${manifest.gfm.path}`, root));
  assert.equal(sha256(commonmarkBytes), manifest.commonmark.sha256, 'CommonMark fixture hash changed');
  assert.equal(sha256(gfmBytes), manifest.gfm.sha256, 'GFM fixture hash changed');
  const commonmark = JSON.parse(commonmarkBytes.toString('utf8'));
  const gfmCases = gfmExamples(gfmBytes.toString('utf8'));
  assert.equal(commonmark.length, manifest.commonmark.examples);
  assert.equal(gfmCases.length, manifest.gfm.examples);
  return { commonmark, gfmCases };
}

function runCase(suite, fixture) {
  const dialect = suite === 'commonmark' ? 'commonmark' : 'gfm';
  let render = 'pass';
  let ast = 'pass';
  let renderMessage = null;
  let astMessage = null;
  let document = null;
  try {
    document = parseMarkdown(fixture.markdown, { dialect, sourceRetention: 'none' });
    validateTree(document, fixture.markdown.length);
  } catch (error) {
    ast = 'fail';
    astMessage = error instanceof Error ? error.message : String(error);
  }
  if (document === null) {
    render = 'fail';
    renderMessage = astMessage;
  } else if (fixture.html === '<IGNORE>\n') {
    renderMessage = 'The upstream fixture has no HTML oracle; parsing and AST invariants passed.';
  } else {
    try {
      const actual = renderConformanceDocument(document);
      if (actual !== fixture.html) {
        render = 'fail';
        renderMessage = `expected ${JSON.stringify(fixture.html)}, received ${JSON.stringify(actual)}`;
      }
    } catch (error) {
      render = 'fail';
      renderMessage = error instanceof Error ? error.message : String(error);
    }
  }
  return {
    suite,
    example: fixture.example,
    section: fixture.section,
    render,
    ast,
    renderMessage,
    astMessage
  };
}

function sectionRows(cases) {
  const sections = new Map();
  for (const entry of cases) {
    const key = `${entry.suite}\0${entry.section}`;
    const current = sections.get(key) ?? { suite: entry.suite, section: entry.section, total: 0, render: 0, renderFailed: 0, ast: 0 };
    current.total += 1;
    if (entry.render === 'pass') current.render += 1;
    else current.renderFailed += 1;
    if (entry.ast === 'pass') current.ast += 1;
    sections.set(key, current);
  }
  return [...sections.values()];
}

function markdownMatrix(matrix) {
  const rows = sectionRows(matrix.cases);
  const lines = [
    '# Conformance matrix',
    '',
    `Generated from pinned CommonMark ${manifest.commonmark.version} and cmark-gfm ${manifest.gfm.version} fixtures. The complete per-example results are in \`fixtures/conformance-matrix.json\`.`,
    '',
    '| Suite | Section | Examples | Fixture outcome | Source AST |',
    '| --- | --- | ---: | ---: | ---: |'
  ];
  for (const row of rows) {
    const rendered = `${row.render} pass, ${row.renderFailed} fail`;
    lines.push(`| ${row.suite} | ${row.section.replaceAll('|', '\\|')} | ${row.total} | ${rendered} | ${row.ast}/${row.total} |`);
  }
  lines.push(
    '',
    `Total: **${matrix.summary.renderPassed} fixture passes, ${matrix.summary.renderFailed} render failures**, and **${matrix.summary.astPassed}/${matrix.summary.total} AST/invariant passes**.`,
    '',
    '“Fixture outcome” compares the fixture-only reference renderer byte-for-byte when the upstream fixture supplies HTML. The single upstream `<IGNORE>` case passes only after parsing and AST invariants succeed. “Source AST” validates complete traversal, unique IDs, immutable nodes, bounded spans, containment, and exact node accounting from the same parse.',
    ''
  );
  return lines.join('\n');
}

const fixtures = await loadFixtures();
const cases = [
  ...fixtures.commonmark.map((fixture) => runCase('commonmark', fixture)),
  ...fixtures.gfmCases.map((fixture) => runCase('gfm', fixture))
];
const matrix = {
  generatedBy: 'npm run test:conformance',
  suites: {
    commonmark: manifest.commonmark.version,
    gfm: manifest.gfm.version
  },
  summary: {
    total: cases.length,
    renderPassed: cases.filter((entry) => entry.render === 'pass').length,
    renderFailed: cases.filter((entry) => entry.render === 'fail').length,
    astPassed: cases.filter((entry) => entry.ast === 'pass').length
  },
  cases
};
const matrixJson = `${JSON.stringify(matrix, null, 2)}\n`;
const matrixMarkdown = markdownMatrix(matrix);
const jsonUrl = new URL('fixtures/conformance-matrix.json', root);
const markdownUrl = new URL('docs/CONFORMANCE_MATRIX.md', root);

if (process.argv.includes('--write')) {
  await writeFile(jsonUrl, matrixJson);
  await writeFile(markdownUrl, matrixMarkdown);
} else {
  assert.equal(await readFile(jsonUrl, 'utf8'), matrixJson, 'fixture matrix is stale; run with --write');
  assert.equal(await readFile(markdownUrl, 'utf8'), matrixMarkdown, 'documentation matrix is stale; run with --write');
}

assert.deepEqual(
  cases.filter((entry) => entry.suite === 'commonmark' && entry.render === 'fail').map((entry) => entry.example),
  [],
  'CommonMark render conformance changed'
);
assert.deepEqual(
  cases.filter((entry) => entry.suite === 'gfm' && entry.render === 'fail').map((entry) => entry.example),
  manifest.gfm.expectedRenderFailures,
  'GFM render baseline changed'
);
assert.equal(matrix.summary.astPassed, matrix.summary.total, 'source AST conformance failures');
console.log(`conformance: ${matrix.summary.total} fixtures, ${matrix.summary.renderPassed} render passes, ${matrix.summary.renderFailed} render failures, ${matrix.summary.astPassed} AST passes`);
