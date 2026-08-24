import { collectMarkdownNodes, parseMarkdown } from '../dist/mod.js';

const source = '# Browser\n\n- [x] **works**\n\nhttps://example.com';
const document = parseMarkdown(source, { dialect: 'gfm' });
const result = {
  heading: collectMarkdownNodes(document.tree, 'heading').length,
  strong: collectMarkdownNodes(document.tree, 'strong').length,
  tasks: collectMarkdownNodes(document.tree, 'listItem').filter((node) => node.task?.checked === true).length,
  links: collectMarkdownNodes(document.tree, 'link').length,
  source: document.sourceText
};
globalThis.__MARKSPAN_BROWSER_RESULT__ = result;
