import type {
  MarkdownDocumentNode,
  MarkdownFootnoteDefinition,
  MarkdownNode,
  MarkdownReferenceDefinition,
  SourceSpan
} from './model.js';
import type { MarkdownParseOptions } from './options.js';
import {
  markdownLineCount,
  normalizeMarkdownIdentifier,
  parseMarkdownInternal,
  type ParsedMarkdownDocument
} from './parse.js';
import { MarkdownBudgetExceededError } from './errors.js';
import { markdownNodeChildren, walkMarkdown } from './analysis.js';
import { BudgetController, resolveBudgets } from './internal/budget.js';
import { assertSourceSpan, createMarkdownSourceIndex } from './source.js';

export interface MarkdownTextEdit {
  readonly span: SourceSpan;
  readonly text: string;
}

export interface AppliedMarkdownEdits {
  readonly source: string;
  readonly edits: readonly MarkdownTextEdit[];
  readonly changedOldSpan: SourceSpan;
  readonly changedNewSpan: SourceSpan;
  readonly codeUnitDelta: number;
}

interface IndexedEdit extends MarkdownTextEdit {
  readonly inputIndex: number;
}

function freezeSpan(start: number, end: number): SourceSpan {
  return Object.freeze({ start, end });
}

function normalizeEdits(sourceLength: number, edits: readonly MarkdownTextEdit[]): readonly IndexedEdit[] {
  if (!Array.isArray(edits)) throw new TypeError('edits must be an array.');
  const normalized = edits.map((edit, inputIndex) => {
    if (typeof edit !== 'object' || edit === null) throw new TypeError(`edit ${inputIndex} must be an object.`);
    assertSourceSpan(edit.span, sourceLength);
    if (typeof edit.text !== 'string') throw new TypeError(`edit ${inputIndex}.text must be a string.`);
    return Object.freeze({
      span: freezeSpan(edit.span.start, edit.span.end),
      text: edit.text,
      inputIndex
    });
  }).sort((left, right) => (
    left.span.start - right.span.start
    || left.span.end - right.span.end
    || left.inputIndex - right.inputIndex
  ));

  for (let index = 1; index < normalized.length; index += 1) {
    const previous = normalized[index - 1];
    const current = normalized[index];
    if (previous === undefined || current === undefined) continue;
    const overlaps = current.span.start < previous.span.end;
    const sharesReplacementBoundary = current.span.start === previous.span.start
      && (current.span.end > current.span.start || previous.span.end > previous.span.start);
    if (overlaps || sharesReplacementBoundary) {
      throw new RangeError(`edit ${current.inputIndex} overlaps edit ${previous.inputIndex}.`);
    }
  }
  return Object.freeze(normalized);
}

/** Apply non-overlapping edits in one deterministic pass. */
export function applyMarkdownTextEdits(
  source: string,
  edits: readonly MarkdownTextEdit[]
): AppliedMarkdownEdits {
  if (typeof source !== 'string') throw new TypeError('source must be a string.');
  const normalized = normalizeEdits(source.length, edits);
  if (normalized.length === 0) {
    return Object.freeze({
      source,
      edits: Object.freeze([]),
      changedOldSpan: freezeSpan(0, 0),
      changedNewSpan: freezeSpan(0, 0),
      codeUnitDelta: 0
    });
  }

  let output = '';
  let cursor = 0;
  let delta = 0;
  for (const edit of normalized) {
    output += source.slice(cursor, edit.span.start);
    output += edit.text;
    cursor = edit.span.end;
    delta += edit.text.length - (edit.span.end - edit.span.start);
  }
  output += source.slice(cursor);

  const first = normalized[0];
  const last = normalized.at(-1);
  if (first === undefined || last === undefined) throw new Error('Normalized edit set unexpectedly became empty.');
  let deltaBeforeLastEnd = 0;
  for (const edit of normalized) {
    if (edit === last) break;
    deltaBeforeLastEnd += edit.text.length - (edit.span.end - edit.span.start);
  }
  const changedOldSpan = freezeSpan(first.span.start, last.span.end);
  const changedNewSpan = freezeSpan(
    first.span.start,
    last.span.start + deltaBeforeLastEnd + last.text.length
  );

  return Object.freeze({
    source: output,
    edits: Object.freeze(normalized.map((edit) => Object.freeze({ span: edit.span, text: edit.text }))),
    changedOldSpan,
    changedNewSpan,
    codeUnitDelta: delta
  });
}

export type MarkdownOffsetAffinity = 'backward' | 'forward';

function mapNormalizedOffset(
  offset: number,
  edits: readonly MarkdownTextEdit[],
  affinity: MarkdownOffsetAffinity
): number {
  let delta = 0;
  for (const edit of edits) {
    if (offset < edit.span.start) break;
    if (offset > edit.span.end || (offset === edit.span.end && edit.span.start !== edit.span.end)) {
      delta += edit.text.length - (edit.span.end - edit.span.start);
      continue;
    }
    if (offset === edit.span.start && edit.span.start === edit.span.end) {
      return edit.span.start + delta + (affinity === 'forward' ? edit.text.length : 0);
    }
    return edit.span.start + delta + (affinity === 'forward' ? edit.text.length : 0);
  }
  return offset + delta;
}

/** Map a source offset through the same non-overlapping edit semantics. */
export function mapMarkdownOffsetThroughEdits(
  sourceLength: number,
  offset: number,
  edits: readonly MarkdownTextEdit[],
  affinity: MarkdownOffsetAffinity = 'forward'
): number {
  if (!Number.isSafeInteger(sourceLength) || sourceLength < 0) {
    throw new RangeError('sourceLength must be a non-negative safe integer.');
  }
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > sourceLength) {
    throw new RangeError(`offset must be between 0 and ${sourceLength}.`);
  }
  if (affinity !== 'backward' && affinity !== 'forward') {
    throw new TypeError('affinity must be either "backward" or "forward".');
  }
  const normalized = normalizeEdits(sourceLength, edits);
  return mapNormalizedOffset(offset, normalized, affinity);
}

export interface MarkdownSessionSnapshot {
  readonly revision: number;
  readonly source: string;
  readonly document: ParsedMarkdownDocument;
}

export interface MarkdownSessionUpdate {
  readonly strategy: 'incremental' | 'full';
  readonly previousRevision: number;
  readonly snapshot: MarkdownSessionSnapshot;
  readonly changedOldSpan: SourceSpan;
  readonly changedNewSpan: SourceSpan;
  /** New-source range passed through the block parser for this update. */
  readonly parsedSpan: SourceSpan;
  readonly codeUnitDelta: number;
  readonly reusedNodes: number;
}

export interface MarkdownDocumentSession {
  snapshot(): MarkdownSessionSnapshot;
  applyEdits(edits: readonly MarkdownTextEdit[]): MarkdownSessionUpdate;
  replaceSource(source: string): MarkdownSessionUpdate;
}

function blockBoundaryBefore(source: string, offset: number): number {
  let lineStart = source.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
  while (lineStart > 0) {
    const previousEnd = lineStart - 1;
    const previousStart = source.lastIndexOf('\n', Math.max(0, previousEnd - 1)) + 1;
    const line = source.slice(previousStart, previousEnd).replace(/\r$/u, '');
    if (/^[\t ]*$/u.test(line)) return lineStart;
    lineStart = previousStart;
  }
  return 0;
}

function containsGlobalDefinitions(source: string, document: ParsedMarkdownDocument): boolean {
  return document.definitions.length > 0
    || document.footnotes.length > 0
    || /(?:^|\n)[^\r\n]*\[[^\]\r\n]+\]:/u.test(source);
}

function isSpan(value: unknown): value is SourceSpan {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.start === 'number'
    && typeof record.end === 'number'
    && Object.keys(record).length === 2;
}

function mapOldValue(
  value: unknown,
  mapOffset: (offset: number, affinity: MarkdownOffsetAffinity) => number
): unknown {
  if (isSpan(value)) {
    const start = mapOffset(value.start, 'forward');
    const end = mapOffset(value.end, 'backward');
    if (start === value.start && end === value.end) return value;
    return freezeSpan(Math.min(start, end), Math.max(start, end));
  }
  if (Array.isArray(value)) {
    const mapped = value.map((entry) => mapOldValue(entry, mapOffset));
    return mapped.every((entry, index) => entry === value[index]) ? value : Object.freeze(mapped);
  }
  if (typeof value !== 'object' || value === null) return value;
  const record = value as Record<string, unknown>;
  let changed = false;
  const mapped: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    const next = mapOldValue(entry, mapOffset);
    mapped[key] = next;
    if (next !== entry) changed = true;
  }
  return changed ? Object.freeze(mapped) : value;
}

function equivalentSyntax(left: unknown, right: unknown, key = ''): boolean {
  if (key === 'id') return true;
  if (left === right) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((entry, index) => equivalentSyntax(entry, right[index]));
  }
  if (typeof left !== 'object' || typeof right !== 'object') return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  if (leftKeys.length !== rightKeys.length || leftKeys.some((entry) => !Object.hasOwn(rightRecord, entry))) return false;
  return leftKeys.every((entry) => equivalentSyntax(leftRecord[entry], rightRecord[entry], entry));
}

function rebuildWithChildren(node: MarkdownNode, reconcile: (node: MarkdownNode) => MarkdownNode): MarkdownNode {
  const children = markdownNodeChildren(node);
  if (children.length === 0) return node;
  const next = children.map(reconcile);
  if (next.every((child, index) => child === children[index])) return node;
  switch (node.kind) {
    case 'document':
    case 'blockQuote':
    case 'listItem':
    case 'footnoteDefinition':
      return Object.freeze({ ...node, children: Object.freeze(next) }) as MarkdownNode;
    case 'list':
      return Object.freeze({ ...node, items: Object.freeze(next) }) as MarkdownNode;
    case 'table':
      return Object.freeze({ ...node, header: next[0], rows: Object.freeze(next.slice(1)) }) as MarkdownNode;
    case 'tableRow':
      return Object.freeze({ ...node, cells: Object.freeze(next) }) as MarkdownNode;
    case 'tableCell':
    case 'paragraph':
    case 'heading':
    case 'emphasis':
    case 'strong':
    case 'strikethrough':
    case 'link':
    case 'image':
      return Object.freeze({ ...node, children: Object.freeze(next) }) as MarkdownNode;
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
      return node;
  }
}

function reconcileTree(
  oldTree: MarkdownDocumentNode,
  newTree: MarkdownDocumentNode,
  oldSource: string,
  newSource: string,
  edits: readonly MarkdownTextEdit[]
): MarkdownDocumentNode {
  const normalized = normalizeEdits(oldSource.length, edits);
  const mappedTree = mapOldValue(
    oldTree,
    (offset, affinity) => mapNormalizedOffset(offset, normalized, affinity)
  ) as MarkdownDocumentNode;
  const originalById = new Map([...walkMarkdown(oldTree)].map(({ node }) => [node.id, node]));
  const candidates = new Map<string, MarkdownNode[]>();
  for (const { node } of walkMarkdown(mappedTree)) {
    if (node.kind === 'document') continue;
    const original = originalById.get(node.id);
    if (original === undefined) continue;
    if (oldSource.slice(original.span.start, original.span.end) !== newSource.slice(node.span.start, node.span.end)) continue;
    const key = `${node.kind}:${node.span.start}:${node.span.end}`;
    const values = candidates.get(key) ?? [];
    values.push(node);
    candidates.set(key, values);
  }
  const used = new Set<number>();
  const reconcile = (node: MarkdownNode): MarkdownNode => {
    const key = `${node.kind}:${node.span.start}:${node.span.end}`;
    const candidate = candidates.get(key)?.find((entry) => !used.has(entry.id) && equivalentSyntax(node, entry));
    if (candidate !== undefined) {
      used.add(candidate.id);
      return candidate;
    }
    return rebuildWithChildren(node, reconcile);
  };
  const reconciled = reconcile(newTree) as MarkdownDocumentNode;
  if (reconciled === oldTree || reconciled.id === oldTree.id) return reconciled;
  return Object.freeze({ ...reconciled, id: oldTree.id });
}

function assembleSessionDocument(
  parsed: ParsedMarkdownDocument,
  tree: MarkdownDocumentNode,
  source: string,
  options: MarkdownParseOptions
): ParsedMarkdownDocument {
  const definitions: MarkdownReferenceDefinition[] = [];
  const footnotes: MarkdownFootnoteDefinition[] = [];
  let nodeCount = 0;
  let maximumDepth = 0;
  for (const { node, depth } of walkMarkdown(tree)) {
    nodeCount += 1;
    maximumDepth = Math.max(maximumDepth, depth);
    if (node.kind === 'linkDefinition' && node.active) {
      definitions.push(Object.freeze({
        label: node.label,
        normalizedLabel: node.normalizedLabel,
        destination: node.destination,
        title: node.title,
        span: node.span,
        nodeId: node.id
      }));
    } else if (node.kind === 'footnoteDefinition' && node.active) {
      footnotes.push(Object.freeze({
        label: node.label,
        normalizedLabel: node.normalizedLabel,
        span: node.span,
        nodeId: node.id
      }));
    }
  }
  const limits = resolveBudgets(options.budgets);
  if (nodeCount > limits.maxNodes) throw new MarkdownBudgetExceededError('maxNodes', limits.maxNodes, nodeCount);
  if (maximumDepth > limits.maxDepth) throw new MarkdownBudgetExceededError('maxDepth', limits.maxDepth, maximumDepth);
  const definitionLookup = new Map(definitions.map((entry) => [entry.normalizedLabel, entry]));
  const footnoteLookup = new Map(footnotes.map((entry) => [entry.normalizedLabel, entry]));
  const totalLines = markdownLineCount(source);
  const usage = Object.freeze({
    inputCodeUnits: source.length,
    lines: totalLines,
    nodes: nodeCount,
    maximumDepth
  });
  return Object.freeze({
    tree,
    sourceText: source,
    sourceIndex: createMarkdownSourceIndex(source),
    definitions: Object.freeze(definitions),
    footnotes: Object.freeze(footnotes),
    diagnostics: parsed.diagnostics,
    metadata: Object.freeze({
      dialect: parsed.metadata.dialect,
      commonMarkVersion: parsed.metadata.commonMarkVersion,
      gfmVersion: parsed.metadata.gfmVersion,
      sourceCodeUnits: source.length,
      lineCount: totalLines,
      nodeCount,
      maximumDepth,
      resourceUsage: usage
    }),
    definitionFor(label: string): MarkdownReferenceDefinition | null {
      if (typeof label !== 'string') throw new TypeError('label must be a string.');
      return definitionLookup.get(normalizeMarkdownIdentifier(label).toLowerCase()) ?? null;
    },
    footnoteFor(label: string): MarkdownFootnoteDefinition | null {
      if (typeof label !== 'string') throw new TypeError('label must be a string.');
      return footnoteLookup.get(normalizeMarkdownIdentifier(label).toLowerCase()) ?? null;
    }
  });
}

/** Create a stateful document that reparses only the block suffix after a safe blank-line boundary. */
export function createMarkdownDocumentSession(
  source: string,
  options: MarkdownParseOptions = {}
): MarkdownDocumentSession {
  if (typeof source !== 'string') throw new TypeError('source must be a string.');
  let revision = 0;
  let currentSource = source;
  let nextNodeId = 1;
  let document = parseMarkdownInternal(source, { ...options, sourceRetention: 'text' }, { nextId: () => nextNodeId++ });

  const makeSnapshot = (): MarkdownSessionSnapshot => Object.freeze({
    revision,
    source: currentSource,
    document
  });

  const api: MarkdownDocumentSession = {
    snapshot: makeSnapshot,
    applyEdits(edits: readonly MarkdownTextEdit[]): MarkdownSessionUpdate {
      const previousRevision = revision;
      const applied = applyMarkdownTextEdits(currentSource, edits);
      const oldSource = currentSource;
      const oldDocument = document;
      if (applied.edits.length === 0) {
        revision += 1;
        return Object.freeze({
          strategy: 'incremental',
          previousRevision,
          snapshot: makeSnapshot(),
          changedOldSpan: applied.changedOldSpan,
          changedNewSpan: applied.changedNewSpan,
          parsedSpan: freezeSpan(0, 0),
          codeUnitDelta: 0,
          reusedNodes: oldDocument.metadata.nodeCount
        });
      }
      const limits = resolveBudgets(options.budgets);
      new BudgetController(applied.source.length, markdownLineCount(applied.source), limits);
      const global = containsGlobalDefinitions(oldSource, oldDocument)
        || /(?:^|\n)[^\r\n]*\[[^\]\r\n]+\]:/u.test(applied.source);
      const oldStart = global ? 0 : blockBoundaryBefore(oldSource, applied.changedOldSpan.start);
      const newStart = mapNormalizedOffset(oldStart, applied.edits, 'backward');
      const prefix = oldDocument.tree.children.filter((block) => block.span.end <= oldStart);
      const fragment = parseMarkdownInternal(
        applied.source.slice(newStart),
        { ...options, sourceRetention: 'none' },
        { sourceOffset: newStart, documentLength: applied.source.length, nextId: () => nextNodeId++ }
      );
      const oldSuffixTree: MarkdownDocumentNode = Object.freeze({
        ...oldDocument.tree,
        children: Object.freeze(oldDocument.tree.children.slice(prefix.length))
      });
      const newSuffixTree: MarkdownDocumentNode = Object.freeze({
        ...fragment.tree,
        id: oldDocument.tree.id
      });
      const reconciledSuffix = reconcileTree(
        oldSuffixTree,
        newSuffixTree,
        oldSource,
        applied.source,
        applied.edits
      );
      const tree: MarkdownDocumentNode = Object.freeze({
        id: oldDocument.tree.id,
        kind: 'document',
        span: freezeSpan(0, applied.source.length),
        children: Object.freeze([...prefix, ...reconciledSuffix.children])
      });
      document = assembleSessionDocument(fragment, tree, applied.source, options);
      currentSource = applied.source;
      revision += 1;
      const oldSuffixEntries = [...walkMarkdown(oldSuffixTree)];
      const prefixNodes = oldDocument.metadata.nodeCount - oldSuffixEntries.length;
      const oldSuffixIds = new Set(oldSuffixEntries.map(({ node }) => node.id));
      const reusedSuffixNodes = [...walkMarkdown(reconciledSuffix)].filter(({ node }) => oldSuffixIds.has(node.id)).length;
      const reusedNodes = prefixNodes + reusedSuffixNodes;
      return Object.freeze({
        strategy: newStart === 0 ? 'full' : 'incremental',
        previousRevision,
        snapshot: makeSnapshot(),
        changedOldSpan: applied.changedOldSpan,
        changedNewSpan: applied.changedNewSpan,
        parsedSpan: freezeSpan(newStart, applied.source.length),
        codeUnitDelta: applied.codeUnitDelta,
        reusedNodes
      });
    },
    replaceSource(nextSource: string): MarkdownSessionUpdate {
      if (typeof nextSource !== 'string') throw new TypeError('source must be a string.');
      const previousRevision = revision;
      const previousLength = currentSource.length;
      const oldIds = new Set([...walkMarkdown(document.tree)].map(({ node }) => node.id));
      const oldTree = document.tree;
      const oldSource = currentSource;
      const parsed = parseMarkdownInternal(nextSource, { ...options, sourceRetention: 'text' }, { nextId: () => nextNodeId++ });
      const replacementEdit = Object.freeze({ span: freezeSpan(0, previousLength), text: nextSource });
      const tree = reconcileTree(oldTree, parsed.tree, oldSource, nextSource, [replacementEdit]);
      document = assembleSessionDocument(parsed, tree, nextSource, options);
      currentSource = nextSource;
      revision += 1;
      return Object.freeze({
        strategy: 'full',
        previousRevision,
        snapshot: makeSnapshot(),
        changedOldSpan: freezeSpan(0, previousLength),
        changedNewSpan: freezeSpan(0, nextSource.length),
        parsedSpan: freezeSpan(0, nextSource.length),
        codeUnitDelta: nextSource.length - previousLength,
        reusedNodes: [...walkMarkdown(tree)].filter(({ node }) => oldIds.has(node.id)).length
      });
    }
  };
  return Object.freeze(api);
}
