import {
  collectMarkdownNodes,
  createMarkdownDocumentSession,
  extractMarkdownText,
  parseMarkdown,
  type MarkdownHeadingNode,
  type MarkdownTextEdit
} from '../src/mod.js';

const parsed = parseMarkdown('# Title', { dialect: 'gfm' });
const headings: readonly MarkdownHeadingNode[] = collectMarkdownNodes(parsed.tree, 'heading');
const text: string = extractMarkdownText(parsed.tree);
const edits: readonly MarkdownTextEdit[] = [{ span: { start: 2, end: 7 }, text: 'Changed' }];
const session = createMarkdownDocumentSession('# Title');
const revision: number = session.applyEdits(edits).snapshot.revision;
void headings;
void text;
void revision;
