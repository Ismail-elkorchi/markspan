import type {
  MarkdownBlockNode,
  MarkdownDocumentNode,
  MarkdownHeadingNode,
  MarkdownImageNode,
  MarkdownInlineNode,
  MarkdownLinkDefinitionNode,
  MarkdownLinkNode,
  MarkdownNode,
  MarkdownNodeKind,
  MarkdownNodeOfKind,
  SourceSpan
} from './model.js';
import { sourceSpanIntersects } from './source.js';

const emptyNodes: readonly MarkdownNode[] = Object.freeze([]);

/** Return direct syntax children without allocating parent pointers. */
export function markdownNodeChildren(node: MarkdownNode): readonly MarkdownNode[] {
  switch (node.kind) {
    case 'document':
    case 'blockQuote':
    case 'listItem':
      return node.children;
    case 'list':
      return node.items;
    case 'table':
      return Object.freeze([node.header, ...node.rows]);
    case 'tableRow':
      return node.cells;
    case 'tableCell':
    case 'footnoteDefinition':
    case 'paragraph':
    case 'heading':
    case 'emphasis':
    case 'strong':
    case 'strikethrough':
    case 'link':
    case 'image':
      return node.children;
    case 'codeBlock':
    case 'thematicBreak':
    case 'htmlBlock':
    case 'linkDefinition':
    case 'text':
    case 'escape':
    case 'characterReference':
    case 'codeSpan':
    case 'softBreak':
    case 'hardBreak':
    case 'htmlInline':
    case 'footnoteReference':
      return emptyNodes;
  }
}

export interface MarkdownWalkEntry {
  readonly node: MarkdownNode;
  readonly parent: MarkdownNode | null;
  readonly depth: number;
  readonly index: number;
}

/** Pre-order traversal. The iterator is safe for deeply nested valid trees. */
export function* walkMarkdown(root: MarkdownNode): Generator<MarkdownWalkEntry, void, undefined> {
  const stack: Array<{
    readonly node: MarkdownNode;
    readonly parent: MarkdownNode | null;
    readonly depth: number;
    readonly index: number;
  }> = [{ node: root, parent: null, depth: 0, index: 0 }];

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    yield Object.freeze(current);
    const children = markdownNodeChildren(current.node);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child !== undefined) {
        stack.push({ node: child, parent: current.node, depth: current.depth + 1, index });
      }
    }
  }
}

export type MarkdownVisitControl = void | 'skip' | 'stop';

export function visitMarkdown(
  root: MarkdownNode,
  visitor: (entry: MarkdownWalkEntry) => MarkdownVisitControl
): void {
  if (typeof visitor !== 'function') throw new TypeError('visitor must be a function.');
  const stack: MarkdownWalkEntry[] = [Object.freeze({ node: root, parent: null, depth: 0, index: 0 })];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    const control = visitor(current);
    if (control === 'stop') return;
    if (control === 'skip') continue;
    const children = markdownNodeChildren(current.node);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child !== undefined) {
        stack.push(Object.freeze({ node: child, parent: current.node, depth: current.depth + 1, index }));
      }
    }
  }
}

export function collectMarkdownNodes<Kind extends MarkdownNodeKind>(
  root: MarkdownNode,
  kind: Kind
): readonly MarkdownNodeOfKind<Kind>[] {
  const nodes: MarkdownNodeOfKind<Kind>[] = [];
  for (const entry of walkMarkdown(root)) {
    if (entry.node.kind === kind) nodes.push(entry.node as MarkdownNodeOfKind<Kind>);
  }
  return Object.freeze(nodes);
}

function containsOffset(span: SourceSpan, offset: number, includeEnd: boolean): boolean {
  return span.start <= offset && (offset < span.end || (includeEnd && offset === span.end));
}

/** Return the root-to-deepest path containing an original-source offset. */
export function markdownPathAt(
  root: MarkdownNode,
  offset: number,
  options: { readonly includeEnd?: boolean } = {}
): readonly MarkdownNode[] {
  if (!Number.isInteger(offset) || offset < 0) throw new RangeError('offset must be a non-negative integer.');
  const includeEnd = options.includeEnd === true;
  if (!containsOffset(root.span, offset, includeEnd)) return emptyNodes;

  const path: MarkdownNode[] = [];
  let current: MarkdownNode | undefined = root;
  while (current !== undefined) {
    path.push(current);
    const children = markdownNodeChildren(current);
    current = children
      .filter((child) => containsOffset(child.span, offset, includeEnd))
      .sort((left, right) => {
        const leftSize = left.span.end - left.span.start;
        const rightSize = right.span.end - right.span.start;
        return leftSize - rightSize || right.span.start - left.span.start;
      })[0];
  }
  return Object.freeze(path);
}

export function markdownNodeAt(
  root: MarkdownNode,
  offset: number,
  options?: { readonly includeEnd?: boolean }
): MarkdownNode | null {
  return markdownPathAt(root, offset, options).at(-1) ?? null;
}

export function markdownNodesIntersecting(root: MarkdownNode, query: SourceSpan): readonly MarkdownNode[] {
  if (!Number.isInteger(query.start) || !Number.isInteger(query.end) || query.start < 0 || query.end < query.start) {
    throw new TypeError('query must be a valid source span.');
  }
  const result: MarkdownNode[] = [];
  visitMarkdown(root, ({ node }) => {
    if (!sourceSpanIntersects(node.span, query) && !(query.start === query.end && node.span.start === query.start)) {
      return 'skip';
    }
    result.push(node);
    return undefined;
  });
  return Object.freeze(result);
}

export interface MarkdownTextExtractionOptions {
  readonly softBreak?: 'space' | 'lineBreak' | 'omit';
  readonly hardBreak?: 'space' | 'lineBreak';
  readonly code?: 'include' | 'omit';
  readonly image?: 'alt' | 'destination' | 'omit';
  readonly html?: 'raw' | 'omit';
  readonly linkDestination?: 'omit' | 'append';
  readonly definitions?: 'omit' | 'include';
  readonly blockSeparator?: string;
  readonly maxOutputCodeUnits?: number;
}

export type MarkdownTextTokenKind =
  | 'text'
  | 'separator'
  | 'code'
  | 'imageAlt'
  | 'imageDestination'
  | 'linkDestination'
  | 'html'
  | 'definition';

export interface MarkdownTextToken {
  readonly kind: MarkdownTextTokenKind;
  readonly value: string;
  readonly sourceSpans: readonly SourceSpan[];
  readonly nodeId: number;
}

interface ResolvedTextOptions {
  readonly softBreak: 'space' | 'lineBreak' | 'omit';
  readonly hardBreak: 'space' | 'lineBreak';
  readonly code: 'include' | 'omit';
  readonly image: 'alt' | 'destination' | 'omit';
  readonly html: 'raw' | 'omit';
  readonly linkDestination: 'omit' | 'append';
  readonly definitions: 'omit' | 'include';
  readonly blockSeparator: string;
  readonly maxOutputCodeUnits: number;
}

function resolveTextOptions(options: MarkdownTextExtractionOptions): ResolvedTextOptions {
  const max = options.maxOutputCodeUnits ?? 10_000_000;
  if (!Number.isSafeInteger(max) || max < 0) {
    throw new TypeError('maxOutputCodeUnits must be a non-negative safe integer.');
  }
  return Object.freeze({
    softBreak: options.softBreak ?? 'space',
    hardBreak: options.hardBreak ?? 'lineBreak',
    code: options.code ?? 'include',
    image: options.image ?? 'alt',
    html: options.html ?? 'omit',
    linkDestination: options.linkDestination ?? 'omit',
    definitions: options.definitions ?? 'omit',
    blockSeparator: options.blockSeparator ?? '\n\n',
    maxOutputCodeUnits: max
  });
}

class TextCollector {
  readonly tokens: MarkdownTextToken[] = [];
  private length = 0;

  constructor(private readonly options: ResolvedTextOptions) {}

  add(kind: MarkdownTextTokenKind, value: string, node: MarkdownNode, spans: readonly SourceSpan[] = [node.span]): void {
    if (value.length === 0) return;
    const available = this.options.maxOutputCodeUnits - this.length;
    if (available <= 0) return;
    const limited = value.slice(0, available);
    this.length += limited.length;
    const previous = this.tokens.at(-1);
    if (previous !== undefined && previous.kind === kind && previous.nodeId === node.id) {
      this.tokens[this.tokens.length - 1] = Object.freeze({
        kind,
        value: previous.value + limited,
        sourceSpans: Object.freeze([...previous.sourceSpans, ...spans]),
        nodeId: node.id
      });
    } else {
      this.tokens.push(Object.freeze({
        kind,
        value: limited,
        sourceSpans: Object.freeze([...spans]),
        nodeId: node.id
      }));
    }
  }

  separator(value: string, node: MarkdownNode): void {
    this.add('separator', value, node, []);
  }
}

function inlineText(node: MarkdownInlineNode, collector: TextCollector, options: ResolvedTextOptions): void {
  switch (node.kind) {
    case 'text':
    case 'escape':
    case 'characterReference':
      collector.add('text', node.value, node);
      return;
    case 'emphasis':
    case 'strong':
    case 'strikethrough':
      for (const child of node.children) inlineText(child, collector, options);
      return;
    case 'codeSpan':
      if (options.code === 'include') collector.add('code', node.value, node, [node.contentSpan]);
      return;
    case 'link':
      for (const child of node.children) inlineText(child, collector, options);
      if (options.linkDestination === 'append') {
        collector.add('linkDestination', ` ${node.destination}`, node, node.destinationSpan === null ? [] : [node.destinationSpan]);
      }
      return;
    case 'image':
      if (options.image === 'alt') {
        const before = collector.tokens.length;
        for (const child of node.children) inlineText(child, collector, options);
        for (let index = before; index < collector.tokens.length; index += 1) {
          const token = collector.tokens[index];
          if (token !== undefined && token.kind === 'text') {
            collector.tokens[index] = Object.freeze({ ...token, kind: 'imageAlt' });
          }
        }
      } else if (options.image === 'destination') {
        collector.add('imageDestination', node.destination, node, node.destinationSpan === null ? [] : [node.destinationSpan]);
      }
      return;
    case 'softBreak':
      if (options.softBreak === 'space') collector.separator(' ', node);
      else if (options.softBreak === 'lineBreak') collector.separator('\n', node);
      return;
    case 'hardBreak':
      collector.separator(options.hardBreak === 'lineBreak' ? '\n' : ' ', node);
      return;
    case 'htmlInline':
      if (options.html === 'raw') collector.add('html', node.value, node);
      return;
    case 'footnoteReference':
      collector.add('text', node.label, node, [node.labelSpan]);
      return;
  }
}

function blockText(node: MarkdownBlockNode, collector: TextCollector, options: ResolvedTextOptions): void {
  switch (node.kind) {
    case 'paragraph':
    case 'heading':
      for (const child of node.children) inlineText(child, collector, options);
      collector.separator(options.blockSeparator, node);
      return;
    case 'blockQuote':
      for (const child of node.children) blockText(child, collector, options);
      return;
    case 'list':
      for (const item of node.items) {
        for (const child of item.children) blockText(child, collector, options);
        collector.separator('\n', item);
      }
      return;
    case 'codeBlock':
      if (options.code === 'include') collector.add('code', node.value, node, [node.contentSpan]);
      collector.separator(options.blockSeparator, node);
      return;
    case 'thematicBreak':
      collector.separator(options.blockSeparator, node);
      return;
    case 'htmlBlock':
      if (options.html === 'raw') collector.add('html', node.value, node);
      collector.separator(options.blockSeparator, node);
      return;
    case 'linkDefinition':
      if (options.definitions === 'include') {
        collector.add('definition', `${node.label} ${node.destination}${node.title === null ? '' : ` ${node.title}`}`, node);
        collector.separator(options.blockSeparator, node);
      }
      return;
    case 'footnoteDefinition':
      if (options.definitions === 'include') {
        for (const child of node.children) blockText(child, collector, options);
      }
      return;
    case 'table': {
      const rows = [node.header, ...node.rows];
      for (const row of rows) {
        for (let index = 0; index < row.cells.length; index += 1) {
          const cell = row.cells[index];
          if (cell === undefined) continue;
          for (const child of cell.children) inlineText(child, collector, options);
          if (index < row.cells.length - 1) collector.separator('\t', cell);
        }
        collector.separator('\n', row);
      }
      collector.separator(options.blockSeparator, node);
    }
  }
}

export function extractMarkdownTextTokens(
  root: MarkdownDocumentNode | MarkdownBlockNode | MarkdownInlineNode,
  options: MarkdownTextExtractionOptions = {}
): readonly MarkdownTextToken[] {
  const resolved = resolveTextOptions(options);
  const collector = new TextCollector(resolved);
  if (root.kind === 'document') {
    for (const block of root.children) blockText(block, collector, resolved);
  } else if (
    root.kind === 'paragraph'
    || root.kind === 'heading'
    || root.kind === 'blockQuote'
    || root.kind === 'list'
    || root.kind === 'codeBlock'
    || root.kind === 'thematicBreak'
    || root.kind === 'htmlBlock'
    || root.kind === 'linkDefinition'
    || root.kind === 'table'
    || root.kind === 'footnoteDefinition'
  ) blockText(root, collector, resolved);
  else inlineText(root, collector, resolved);
  return Object.freeze(collector.tokens);
}

export function extractMarkdownText(
  root: MarkdownDocumentNode | MarkdownBlockNode | MarkdownInlineNode,
  options: MarkdownTextExtractionOptions = {}
): string {
  return extractMarkdownTextTokens(root, options).map((token) => token.value).join('');
}

export function countMarkdownWords(value: string): number {
  if (typeof value !== 'string') throw new TypeError('value must be a string.');
  return value.match(/[\p{L}\p{N}]+(?:[’'\-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

export function countMarkdownDocumentWords(
  root: MarkdownDocumentNode | MarkdownBlockNode,
  options: MarkdownTextExtractionOptions = {}
): number {
  return countMarkdownWords(extractMarkdownText(root, options));
}

function inlinePlainText(children: readonly MarkdownInlineNode[]): string {
  return children.map((child) => {
    switch (child.kind) {
      case 'text':
      case 'escape':
      case 'characterReference':
      case 'codeSpan':
        return child.value;
      case 'emphasis':
      case 'strong':
      case 'strikethrough':
      case 'link':
      case 'image':
        return inlinePlainText(child.children);
      case 'softBreak':
      case 'hardBreak':
        return ' ';
      case 'htmlInline':
        return '';
      case 'footnoteReference':
        return child.label;
    }
  }).join('');
}

export interface MarkdownOutlineEntry {
  readonly nodeId: number;
  readonly depth: 1 | 2 | 3 | 4 | 5 | 6;
  readonly text: string;
  readonly span: SourceSpan;
  readonly children: readonly MarkdownOutlineEntry[];
}

export function extractMarkdownOutline(root: MarkdownDocumentNode): readonly MarkdownOutlineEntry[] {
  const headings = collectMarkdownNodes(root, 'heading');
  const roots: Array<MarkdownOutlineEntry & { children: MarkdownOutlineEntry[] }> = [];
  const stack: Array<MarkdownOutlineEntry & { children: MarkdownOutlineEntry[] }> = [];

  for (const heading of headings) {
    const text = inlinePlainText(heading.children).trim();
    const mutable = {
      nodeId: heading.id,
      depth: heading.depth,
      text,
      span: heading.span,
      children: [] as MarkdownOutlineEntry[]
    };
    while (stack.length > 0 && (stack.at(-1)?.depth ?? 0) >= heading.depth) stack.pop();
    const parent = stack.at(-1);
    if (parent === undefined) roots.push(mutable);
    else parent.children.push(mutable);
    stack.push(mutable);
  }

  const freezeEntry = (entry: MarkdownOutlineEntry & { children: MarkdownOutlineEntry[] }): MarkdownOutlineEntry => Object.freeze({
    nodeId: entry.nodeId,
    depth: entry.depth,
    text: entry.text,
    span: entry.span,
    children: Object.freeze(entry.children.map((child) => freezeEntry(child as MarkdownOutlineEntry & { children: MarkdownOutlineEntry[] })))
  });
  return Object.freeze(roots.map(freezeEntry));
}

export interface MarkdownLinkInfo {
  readonly nodeId: number;
  readonly kind: 'link' | 'image' | 'definition';
  readonly destination: string;
  readonly title: string | null;
  readonly text: string;
  readonly span: SourceSpan;
  readonly form: MarkdownLinkNode['form'] | MarkdownImageNode['form'] | 'definition';
}

export interface CollectMarkdownLinksOptions {
  readonly links?: boolean;
  readonly images?: boolean;
  readonly definitions?: boolean;
}

export function collectMarkdownLinks(
  root: MarkdownNode,
  options: CollectMarkdownLinksOptions = {}
): readonly MarkdownLinkInfo[] {
  const includeLinks = options.links ?? true;
  const includeImages = options.images ?? true;
  const includeDefinitions = options.definitions ?? false;
  const result: MarkdownLinkInfo[] = [];
  visitMarkdown(root, ({ node }) => {
    if (node.kind === 'link' && includeLinks) {
      result.push(Object.freeze({
        nodeId: node.id,
        kind: 'link',
        destination: node.destination,
        title: node.title,
        text: inlinePlainText(node.children),
        span: node.span,
        form: node.form
      }));
    } else if (node.kind === 'image' && includeImages) {
      result.push(Object.freeze({
        nodeId: node.id,
        kind: 'image',
        destination: node.destination,
        title: node.title,
        text: inlinePlainText(node.children),
        span: node.span,
        form: node.form
      }));
    } else if (node.kind === 'linkDefinition' && includeDefinitions) {
      result.push(Object.freeze({
        nodeId: node.id,
        kind: 'definition',
        destination: node.destination,
        title: node.title,
        text: node.label,
        span: node.span,
        form: 'definition'
      }));
    }
    return undefined;
  });
  return Object.freeze(result);
}

export function headingText(node: MarkdownHeadingNode): string {
  return inlinePlainText(node.children);
}

export function linkText(node: MarkdownLinkNode | MarkdownImageNode): string {
  return inlinePlainText(node.children);
}

export function definitionText(node: MarkdownLinkDefinitionNode): string {
  return `${node.label}: ${node.destination}${node.title === null ? '' : ` “${node.title}”`}`;
}
