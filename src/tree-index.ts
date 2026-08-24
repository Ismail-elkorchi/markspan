import type { MarkdownBlockNode, MarkdownDocumentNode, MarkdownNode } from './model.js';
import { markdownNodeAt, walkMarkdown } from './analysis.js';

export interface MarkdownTreeIndex {
  readonly nodeCount: number;
  readonly blocks: readonly MarkdownBlockNode[];
  node(id: number): MarkdownNode | null;
  parent(id: number): MarkdownNode | null;
  path(id: number): readonly MarkdownNode[];
  nodeAt(offset: number): MarkdownNode | null;
}

function isBlock(node: MarkdownNode): node is MarkdownBlockNode {
  return node.kind === 'paragraph'
    || node.kind === 'heading'
    || node.kind === 'blockQuote'
    || node.kind === 'list'
    || node.kind === 'codeBlock'
    || node.kind === 'thematicBreak'
    || node.kind === 'htmlBlock'
    || node.kind === 'linkDefinition'
    || node.kind === 'footnoteDefinition'
    || node.kind === 'table';
}

/** Create a per-snapshot lookup index without mutating the tree. */
export function createMarkdownTreeIndex(root: MarkdownDocumentNode): MarkdownTreeIndex {
  const nodes = new Map<number, MarkdownNode>();
  const parents = new Map<number, MarkdownNode | null>();
  const blocks: MarkdownBlockNode[] = [];

  for (const entry of walkMarkdown(root)) {
    nodes.set(entry.node.id, entry.node);
    parents.set(entry.node.id, entry.parent);
    if (isBlock(entry.node)) blocks.push(entry.node);
  }
  blocks.sort((left, right) => left.span.start - right.span.start || left.span.end - right.span.end);

  const api: MarkdownTreeIndex = {
    nodeCount: nodes.size,
    blocks: Object.freeze(blocks),
    node(id: number): MarkdownNode | null {
      if (!Number.isInteger(id) || id < 1) return null;
      return nodes.get(id) ?? null;
    },
    parent(id: number): MarkdownNode | null {
      if (!Number.isInteger(id) || id < 1) return null;
      return parents.get(id) ?? null;
    },
    path(id: number): readonly MarkdownNode[] {
      if (!Number.isInteger(id) || id < 1) return Object.freeze([]);
      const result: MarkdownNode[] = [];
      let current = nodes.get(id) ?? null;
      while (current !== null) {
        result.push(current);
        current = parents.get(current.id) ?? null;
      }
      result.reverse();
      return Object.freeze(result);
    },
    nodeAt(offset: number): MarkdownNode | null {
      return markdownNodeAt(root, offset);
    }
  };
  return Object.freeze(api);
}
