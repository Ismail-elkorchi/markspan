import assert from 'node:assert/strict';
import { collectMarkdownNodes, parseMarkdown } from '../dist/mod.js';

const document = parseMarkdown('Text[^a].\n\n[^a]: note', { dialect: 'gfm' });
assert.equal(collectMarkdownNodes(document.tree, 'footnoteReference').length, 1);
assert.equal(document.footnoteFor('a')?.label, 'a');
console.log('Markspan Bun runtime verified');
