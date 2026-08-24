import {
  collectMarkdownLinks,
  extractMarkdownOutline,
  parseMarkdown
} from '../dist/mod.js';

const source = `# Example

Visit [the guide](https://example.com).

- [x] Parse
- [ ] Render
`;

const parsed = parseMarkdown(source, { dialect: 'gfm' });
console.log(extractMarkdownOutline(parsed.tree));
console.log(collectMarkdownLinks(parsed.tree));
