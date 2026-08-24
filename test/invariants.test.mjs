import assert from 'node:assert/strict';
import test from 'node:test';
import {
  markdownNodeChildren,
  parseMarkdown,
  walkMarkdown
} from '../dist/mod.js';

function assertTreeInvariants(parsed, source) {
  const ids = new Set();
  for (const { node } of walkMarkdown(parsed.tree)) {
    assert.equal(Number.isInteger(node.id), true);
    assert.equal(ids.has(node.id), false, `duplicate node id ${node.id}`);
    ids.add(node.id);
    assert(node.span.start >= 0);
    assert(node.span.end >= node.span.start);
    assert(node.span.end <= source.length);
    assert.equal(Object.isFrozen(node), true);
    for (const child of markdownNodeChildren(node)) {
      assert(child.span.start >= node.span.start, `${child.kind} starts before ${node.kind}`);
      assert(child.span.end <= node.span.end, `${child.kind} ends after ${node.kind}`);
    }
  }
  assert.equal(ids.size, parsed.metadata.nodeCount);
}

test('tree invariants hold for mixed nested syntax and tabs', () => {
  const source = [
    '\t- not a list at the document margin',
    '',
    '> 1. item',
    '>    - nested **value**',
    '>',
    '> continuation',
    '',
    '| A | B |',
    '| - | :-: |',
    '| `x|y` | [z](u) |'
  ].join('\r\n');
  const parsed = parseMarkdown(source, { dialect: 'gfm' });
  assertTreeInvariants(parsed, source);
});

test('deterministic generated inputs always produce bounded immutable trees', () => {
  let state = 0x5eed1234;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  const alphabet = '#*-_~`[]()<>!&;:\\| abcXYZ019\n\r\t東京é';
  for (let sample = 0; sample < 200; sample += 1) {
    const length = next() % 220;
    let source = '';
    for (let index = 0; index < length; index += 1) {
      source += alphabet[next() % alphabet.length];
    }
    const parsed = parseMarkdown(source, {
      dialect: sample % 2 === 0 ? 'commonmark' : 'gfm',
      budgets: { maxNodes: 50_000 }
    });
    assertTreeInvariants(parsed, source);
  }
});
