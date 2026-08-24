import { collectMarkdownNodes, parseMarkdown } from '../dist/mod.js';

const document = parseMarkdown('| A | B |\n| - | - |\n| 1 | 2 |', { dialect: 'gfm' });
if (collectMarkdownNodes(document.tree, 'table').length !== 1) {
  throw new Error('Deno failed to parse a GFM table.');
}
if (document.sourceText !== '| A | B |\n| - | - |\n| 1 | 2 |') {
  throw new Error('Deno did not preserve source text.');
}
console.log('Markspan Deno runtime verified');
