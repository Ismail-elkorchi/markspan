import type {
  MarkdownDocumentNode,
  MarkdownDiagnostic,
  MarkdownFootnoteDefinition,
  MarkdownNode,
  MarkdownReferenceDefinition,
  SourceSpan
} from './model.js';
import type { MarkdownParseOptions } from './options.js';
import { parseMarkdownInternal, type ParsedMarkdownDocument } from './parse.js';
import { MarkdownBudgetExceededError } from './errors.js';
import { markdownNodeChildren, walkMarkdown } from './analysis.js';
import { BudgetController, resolveBudgets } from './internal/budget.js';
import { mapOrderedSourceOffset } from './internal/edit-offset.js';
import { normalizeMarkdownIdentifier } from './internal/identifier.js';
import { markdownSourceIndexScanLength } from './internal/source-index-instrumentation.js';
import {
  assertSourceSpan,
  updateMarkdownSourceIndex,
  type MarkdownSourceIndex
} from './source.js';

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
  const effective = normalized.filter((edit) => source.slice(edit.span.start, edit.span.end) !== edit.text);
  if (effective.length === 0) {
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
  for (const edit of effective) {
    output += source.slice(cursor, edit.span.start);
    output += edit.text;
    cursor = edit.span.end;
    delta += edit.text.length - (edit.span.end - edit.span.start);
  }
  output += source.slice(cursor);

  const first = effective[0];
  const last = effective.at(-1);
  if (first === undefined || last === undefined) throw new Error('Normalized edit set unexpectedly became empty.');
  let deltaBeforeLastEnd = 0;
  for (const edit of effective) {
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
    edits: Object.freeze(effective.map((edit) => Object.freeze({ span: edit.span, text: edit.text }))),
    changedOldSpan,
    changedNewSpan,
    codeUnitDelta: delta
  });
}

export type MarkdownOffsetAffinity = 'backward' | 'forward';

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
  return mapOrderedSourceOffset(offset, normalized, affinity);
}

export interface MarkdownSessionSnapshot {
  readonly revision: number;
  readonly source: string;
  readonly document: ParsedMarkdownDocument;
}

export interface MarkdownSessionUpdate {
  readonly previousRevision: number;
  readonly snapshot: MarkdownSessionSnapshot;
  readonly changedOldSpan: SourceSpan;
  readonly changedNewSpan: SourceSpan;
  /** New-source range passed through the block parser for this update. */
  readonly parsedSpan: SourceSpan;
  readonly codeUnitDelta: number;
  readonly instrumentation: MarkdownParseInstrumentation;
}

export interface MarkdownParseInstrumentation {
  /** Code units supplied to the block and inline parser for this update. */
  readonly parsedCodeUnits: number;
  /** Code units rescanned to update the line index. */
  readonly sourceIndexCodeUnits: number;
  readonly parsedNodes: number;
  /** Old and new syntax nodes visited while mapping and reconciling identities. */
  readonly reconciledNodes: number;
  /** Old/new source code units compared during identity reconciliation. */
  readonly comparedCodeUnits: number;
  /** Aggregate code-unit visits for source construction, parsing, line indexing, and reconciliation. */
  readonly sourceTraversalCodeUnits: number;
  readonly reusedNodes: number;
  readonly fullParse: boolean;
}

export interface MarkdownDocumentSession {
  snapshot(): MarkdownSessionSnapshot;
  applyEdits(edits: readonly MarkdownTextEdit[]): MarkdownSessionUpdate;
  replaceSource(source: string): MarkdownSessionUpdate;
}

function incrementalBlockBoundary(document: ParsedMarkdownDocument, offset: number): number {
  const blocks = document.tree.children;
  if (blocks.length === 0) return 0;
  let lower = 0;
  let upper = blocks.length;
  while (lower < upper) {
    const middle = (lower + upper) >>> 1;
    if ((blocks[middle]?.span.end ?? Number.POSITIVE_INFINITY) < offset) lower = middle + 1;
    else upper = middle;
  }
  const candidate = blocks[lower];
  if (candidate !== undefined && candidate.span.start <= offset) return candidate.span.start;
  return blocks[Math.max(0, lower - 1)]?.span.start ?? 0;
}

function blockPrefixLength(document: ParsedMarkdownDocument, offset: number): number {
  const blocks = document.tree.children;
  let lower = 0;
  let upper = blocks.length;
  while (lower < upper) {
    const middle = (lower + upper) >>> 1;
    if ((blocks[middle]?.span.end ?? Number.POSITIVE_INFINITY) <= offset) lower = middle + 1;
    else upper = middle;
  }
  return lower;
}

function mayContainDefinition(value: string): boolean {
  return /(?:^|[\r\n])[ \t]{0,3}\[(?:\^)?[^\]\r\n]+\]:/u.test(value);
}

function isSpan(value: unknown): value is SourceSpan {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.start === 'number'
    && typeof record.end === 'number'
    && Object.keys(record).length === 2;
}

interface ReconciliationWork {
  visitedNodes: number;
  comparedCodeUnits: number;
  reusedNodes: number;
}

function isMarkdownNodeRecord(value: Record<string, unknown>): boolean {
  return typeof value['id'] === 'number'
    && typeof value['kind'] === 'string'
    && isSpan(value['span']);
}

function mapOldValue(
  value: unknown,
  mapOffset: (offset: number, affinity: MarkdownOffsetAffinity) => number,
  work?: ReconciliationWork
): unknown {
  if (isSpan(value)) {
    const start = mapOffset(value.start, 'forward');
    const end = mapOffset(value.end, 'backward');
    if (start === value.start && end === value.end) return value;
    return freezeSpan(Math.min(start, end), Math.max(start, end));
  }
  if (Array.isArray(value)) {
    const mapped = value.map((entry) => mapOldValue(entry, mapOffset, work));
    return mapped.every((entry, index) => entry === value[index]) ? value : Object.freeze(mapped);
  }
  if (typeof value !== 'object' || value === null) return value;
  const record = value as Record<string, unknown>;
  if (work !== undefined && isMarkdownNodeRecord(record)) work.visitedNodes += 1;
  let changed = false;
  const mapped: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    const next = mapOldValue(entry, mapOffset, work);
    mapped[key] = next;
    if (next !== entry) changed = true;
  }
  return changed ? Object.freeze(mapped) : value;
}

function syntaxNeutralText(value: string): boolean {
  return /^[\p{L}\p{N}\p{M}\p{Extended_Pictographic}]*$/u.test(value);
}

interface ReusableLeafEdit {
  readonly kind: 'text' | 'codeBlock';
  readonly nodeId: number;
  readonly valueStart: number;
  readonly valueEnd: number;
  readonly pathNodeIds: readonly number[];
}

function reusableLeafEdit(
  document: ParsedMarkdownDocument,
  source: string,
  edit: MarkdownTextEdit,
  work: ReconciliationWork
): ReusableLeafEdit | null {
  const removed = source.slice(edit.span.start, edit.span.end);
  if ((!syntaxNeutralText(removed) || !syntaxNeutralText(edit.text)) || removed.length + edit.text.length === 0) return null;
  const path: MarkdownNode[] = [];
  let node: MarkdownNode | undefined = document.tree;
  let resolutionSensitive = false;
  while (node !== undefined) {
    work.visitedNodes += 1;
    path.push(node);
    if (node.kind === 'text'
      && !resolutionSensitive
      && edit.span.start > node.span.start
      && edit.span.end < node.span.end) {
      work.comparedCodeUnits += (node.span.end - node.span.start) * 2;
      if (source.slice(node.span.start, node.span.end) !== node.value) return null;
      return {
        kind: 'text',
        nodeId: node.id,
        valueStart: edit.span.start - node.span.start,
        valueEnd: edit.span.end - node.span.start,
        pathNodeIds: Object.freeze(path.map((entry) => entry.id))
      };
    }
    if (node.kind === 'codeBlock') {
      const segment = node.valueSourceMap.segments.find((candidate) => (
        candidate.kind === 'text'
        && candidate.sourceSpan.end - candidate.sourceSpan.start === candidate.valueEnd - candidate.valueStart
        && edit.span.start > candidate.sourceSpan.start
        && edit.span.end < candidate.sourceSpan.end
      ));
      if (segment === undefined) return null;
      return {
        kind: 'codeBlock',
        nodeId: node.id,
        valueStart: segment.valueStart + edit.span.start - segment.sourceSpan.start,
        valueEnd: segment.valueStart + edit.span.end - segment.sourceSpan.start,
        pathNodeIds: Object.freeze(path.map((entry) => entry.id))
      };
    }
    resolutionSensitive ||= node.kind === 'link' || node.kind === 'image';
    node = childContainingEdit(node, edit, work);
  }
  return null;
}

function childContainingEdit(
  node: MarkdownNode,
  edit: MarkdownTextEdit,
  work: ReconciliationWork
): MarkdownNode | undefined {
  const children = markdownNodeChildren(node);
  let lower = 0;
  let upper = children.length;
  while (lower < upper) {
    const middle = (lower + upper) >>> 1;
    const child = children[middle];
    if (child === undefined) break;
    work.visitedNodes += 1;
    if (child.span.end <= edit.span.start) lower = middle + 1;
    else upper = middle;
  }
  const child = children[lower];
  if (child === undefined) return undefined;
  work.visitedNodes += 1;
  return child.span.start <= edit.span.start && edit.span.end <= child.span.end ? child : undefined;
}

function replaceReusableLeaf(
  node: MarkdownNode,
  target: ReusableLeafEdit,
  insertedText: string,
  nextId: () => number,
  pathNodeIds: ReadonlySet<number>,
  work: ReconciliationWork,
  summaryCache: WeakMap<object, MarkdownTreeSummary>
): MarkdownNode {
  work.visitedNodes += 1;
  if (node.id === target.nodeId) {
    if (target.kind === 'text' && node.kind === 'text') {
      const replacement = Object.freeze({
        ...node,
        id: nextId(),
        value: node.value.slice(0, target.valueStart) + insertedText + node.value.slice(target.valueEnd)
      });
      preserveTreeSummary(node, replacement, summaryCache);
      return replacement;
    }
    if (target.kind === 'codeBlock' && node.kind === 'codeBlock') {
      const delta = insertedText.length - (target.valueEnd - target.valueStart);
      const replacement = Object.freeze({
        ...node,
        id: nextId(),
        value: node.value.slice(0, target.valueStart) + insertedText + node.value.slice(target.valueEnd),
        valueSourceMap: Object.freeze({
          valueLength: node.valueSourceMap.valueLength + delta,
          segments: Object.freeze(node.valueSourceMap.segments.map((segment) => {
            if (segment.valueEnd <= target.valueStart) return segment;
            if (segment.valueStart >= target.valueEnd) {
              return Object.freeze({
                ...segment,
                valueStart: segment.valueStart + delta,
                valueEnd: segment.valueEnd + delta
              });
            }
            return Object.freeze({ ...segment, valueEnd: segment.valueEnd + delta });
          }))
        })
      });
      preserveTreeSummary(node, replacement, summaryCache);
      return replacement;
    }
  }
  const rebuilt = rebuildWithChildren(node, (child) => pathNodeIds.has(child.id)
    ? replaceReusableLeaf(child, target, insertedText, nextId, pathNodeIds, work, summaryCache)
    : child);
  if (rebuilt === node) return rebuilt;
  if (rebuilt.kind === 'document') {
    preserveTreeSummary(node, rebuilt, summaryCache);
    return rebuilt;
  }
  const replacement = Object.freeze({ ...rebuilt, id: nextId() }) as MarkdownNode;
  preserveTreeSummary(node, replacement, summaryCache);
  return replacement;
}

function preserveTreeSummary(
  previous: MarkdownNode,
  next: MarkdownNode,
  summaryCache: WeakMap<object, MarkdownTreeSummary>
): void {
  const summary = summaryCache.get(previous);
  if (summary !== undefined) summaryCache.set(next, summary);
}

function mappedDiagnostics(
  diagnostics: readonly MarkdownDiagnostic[],
  edits: readonly MarkdownTextEdit[]
): readonly MarkdownDiagnostic[] {
  return Object.freeze(diagnostics.map((diagnostic) => mapOldValue(
    diagnostic,
    (offset, affinity) => mapOrderedSourceOffset(offset, edits, affinity)
  ) as MarkdownDiagnostic));
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
    case 'callout':
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
    case 'mathBlock':
    case 'frontMatter':
    case 'thematicBreak':
    case 'htmlBlock':
    case 'linkDefinition':
    case 'text':
    case 'escape':
    case 'characterReference':
    case 'codeSpan':
    case 'mathInline':
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
  edits: readonly MarkdownTextEdit[],
  work: ReconciliationWork,
  summaryCache: WeakMap<object, MarkdownTreeSummary>
): MarkdownDocumentNode {
  const normalized = normalizeEdits(oldSource.length, edits);
  const mappedTree = mapOldValue(
    oldTree,
    (offset, affinity) => mapOrderedSourceOffset(offset, normalized, affinity),
    work
  ) as MarkdownDocumentNode;
  const originalById = new Map<number, MarkdownNode>();
  for (const { node } of walkMarkdown(oldTree)) {
    work.visitedNodes += 1;
    originalById.set(node.id, node);
  }
  const candidates = new Map<string, MarkdownNode[]>();
  for (const { node } of walkMarkdown(mappedTree)) {
    work.visitedNodes += 1;
    if (node.kind === 'document') continue;
    const original = originalById.get(node.id);
    if (original === undefined) continue;
    const oldLength = original.span.end - original.span.start;
    const newLength = node.span.end - node.span.start;
    work.comparedCodeUnits += oldLength + newLength;
    if (oldLength !== newLength
      || oldSource.slice(original.span.start, original.span.end) !== newSource.slice(node.span.start, node.span.end)) continue;
    const key = `${node.kind}:${node.span.start}:${node.span.end}`;
    const values = candidates.get(key) ?? [];
    values.push(node);
    candidates.set(key, values);
  }
  const used = new Set<number>();
  const reconcile = (node: MarkdownNode): MarkdownNode => {
    work.visitedNodes += 1;
    const key = `${node.kind}:${node.span.start}:${node.span.end}`;
    const candidate = candidates.get(key)?.find((entry) => !used.has(entry.id) && equivalentSyntax(node, entry));
    if (candidate !== undefined) {
      used.add(candidate.id);
      work.reusedNodes += summarizeMarkdownTree(candidate, summaryCache, work).nodeCount;
      return candidate;
    }
    return rebuildWithChildren(node, reconcile);
  };
  const reconciled = reconcile(newTree) as MarkdownDocumentNode;
  if (reconciled === oldTree || reconciled.id === oldTree.id) {
    work.reusedNodes += 1;
    return reconciled;
  }
  work.reusedNodes += 1;
  return Object.freeze({ ...reconciled, id: oldTree.id });
}

interface MarkdownTreeSummary {
  readonly nodeCount: number;
  readonly height: number;
  readonly definitions: readonly MarkdownReferenceDefinition[];
  readonly footnotes: readonly MarkdownFootnoteDefinition[];
}

function summarizeMarkdownTree(
  node: MarkdownNode,
  cache: WeakMap<object, MarkdownTreeSummary>,
  work?: ReconciliationWork
): MarkdownTreeSummary {
  if (work !== undefined) work.visitedNodes += 1;
  const cached = cache.get(node);
  if (cached !== undefined) return cached;
  const children = markdownNodeChildren(node);
  const childSummaries = children.map((child) => summarizeMarkdownTree(child, cache, work));
  const definitions: MarkdownReferenceDefinition[] = [];
  const footnotes: MarkdownFootnoteDefinition[] = [];
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
  let nodeCount = 1;
  let height = 1;
  for (const summary of childSummaries) {
    nodeCount += summary.nodeCount;
    height = Math.max(height, summary.height + 1);
    definitions.push(...summary.definitions);
    footnotes.push(...summary.footnotes);
  }
  if (node.kind === 'paragraph'
    || node.kind === 'heading'
    || node.kind === 'tableCell'
    || node.kind === 'link'
    || node.kind === 'image') {
    height = Math.max(height, 2);
  }
  const created: MarkdownTreeSummary = Object.freeze({
    nodeCount,
    height,
    definitions: Object.freeze(definitions),
    footnotes: Object.freeze(footnotes)
  });
  cache.set(node, created);
  return created;
}

interface TopLevelPrefixData {
  readonly nodeCounts: readonly number[];
  readonly heights: readonly number[];
}

function topLevelPrefixData(
  tree: MarkdownDocumentNode,
  summaryCache: WeakMap<object, MarkdownTreeSummary>,
  work?: ReconciliationWork
): TopLevelPrefixData {
  const nodeCounts = [0];
  const heights = [0];
  let totalNodes = 0;
  let maximumHeight = 0;
  for (const block of tree.children) {
    const summary = summarizeMarkdownTree(block, summaryCache, work);
    totalNodes += summary.nodeCount;
    maximumHeight = Math.max(maximumHeight, summary.height);
    nodeCounts.push(totalNodes);
    heights.push(maximumHeight);
  }
  return Object.freeze({ nodeCounts: Object.freeze(nodeCounts), heights: Object.freeze(heights) });
}

function extendTopLevelPrefixData(
  previous: TopLevelPrefixData,
  prefixLength: number,
  suffixSummaries: readonly MarkdownTreeSummary[]
): TopLevelPrefixData {
  const nodeCounts = previous.nodeCounts.slice(0, prefixLength + 1);
  const heights = previous.heights.slice(0, prefixLength + 1);
  let totalNodes = nodeCounts.at(-1) ?? 0;
  let maximumHeight = heights.at(-1) ?? 0;
  for (const summary of suffixSummaries) {
    totalNodes += summary.nodeCount;
    maximumHeight = Math.max(maximumHeight, summary.height);
    nodeCounts.push(totalNodes);
    heights.push(maximumHeight);
  }
  return Object.freeze({ nodeCounts: Object.freeze(nodeCounts), heights: Object.freeze(heights) });
}

function assembleSessionDocument(
  parsed: ParsedMarkdownDocument,
  tree: MarkdownDocumentNode,
  source: string,
  options: MarkdownParseOptions,
  totalLines: number,
  sourceIndex: MarkdownSourceIndex,
  summaryCache: WeakMap<object, MarkdownTreeSummary>,
  work?: ReconciliationWork
): ParsedMarkdownDocument {
  const summary = summarizeMarkdownTree(tree, summaryCache, work);
  const definitions = summary.definitions;
  const footnotes = summary.footnotes;
  const nodeCount = summary.nodeCount;
  const maximumDepth = summary.height - 1;
  const limits = resolveBudgets(options.budgets);
  if (nodeCount > limits.maxNodes) throw new MarkdownBudgetExceededError('maxNodes', limits.maxNodes, nodeCount);
  if (maximumDepth > limits.maxDepth) throw new MarkdownBudgetExceededError('maxDepth', limits.maxDepth, maximumDepth);
  const definitionLookup = new Map(definitions.map((entry) => [entry.normalizedLabel, entry]));
  const footnoteLookup = new Map(footnotes.map((entry) => [entry.normalizedLabel, entry]));
  const usage = Object.freeze({
    inputCodeUnits: source.length,
    lines: totalLines,
    nodes: nodeCount,
    maximumDepth
  });
  return Object.freeze({
    tree,
    sourceText: source,
    sourceIndex,
    definitions: Object.freeze(definitions),
    footnotes: Object.freeze(footnotes),
    diagnostics: parsed.diagnostics,
    metadata: Object.freeze({
      dialect: parsed.metadata.dialect,
      commonMarkVersion: parsed.metadata.commonMarkVersion,
      gfmVersion: parsed.metadata.gfmVersion,
      extensions: parsed.metadata.extensions,
      sourceCodeUnits: source.length,
      lineCount: totalLines,
      nodeCount,
      maximumDepth,
      resourceUsage: usage
    }),
    definitionFor(label: string): MarkdownReferenceDefinition | null {
      if (typeof label !== 'string') throw new TypeError('label must be a string.');
      return definitionLookup.get(normalizeMarkdownIdentifier(label)) ?? null;
    },
    footnoteFor(label: string): MarkdownFootnoteDefinition | null {
      if (typeof label !== 'string') throw new TypeError('label must be a string.');
      return footnoteLookup.get(normalizeMarkdownIdentifier(label)) ?? null;
    }
  });
}

function spansIntersectChange(span: SourceSpan, change: SourceSpan): boolean {
  if (change.start === change.end) return span.start <= change.start && change.start <= span.end;
  return span.start < change.end && change.start < span.end;
}

function changedLineWindow(source: string, changed: SourceSpan): string {
  let start = Math.max(0, changed.start);
  while (start > 0 && source[start - 1] !== '\n' && source[start - 1] !== '\r') start -= 1;
  let end = Math.min(source.length, changed.end);
  while (end < source.length && source[end] !== '\n' && source[end] !== '\r') end += 1;
  return source.slice(start, end);
}

function definitionEditRequiresFullParse(
  document: ParsedMarkdownDocument,
  applied: AppliedMarkdownEdits
): boolean {
  if (document.definitions.some((definition) => spansIntersectChange(definition.span, applied.changedOldSpan))) return true;
  if (document.footnotes.some((footnote) => spansIntersectChange(footnote.span, applied.changedOldSpan))) return true;
  return mayContainDefinition(changedLineWindow(applied.source, applied.changedNewSpan));
}

function fragmentSeed(
  document: ParsedMarkdownDocument,
  oldStart: number,
  newStart: number
): import('./internal/block-parser.js').BlockParseSeed {
  const definitions = new Map(document.definitions
    .filter((definition) => definition.span.end <= oldStart)
    .map((definition) => [definition.normalizedLabel, {
      label: definition.label,
      normalizedLabel: definition.normalizedLabel,
      destination: definition.destination,
      title: definition.title,
      span: freezeSpan(definition.span.start - newStart, definition.span.end - newStart)
    }]));
  const footnotes = new Map(document.footnotes
    .filter((footnote) => footnote.span.end <= oldStart)
    .map((footnote) => [footnote.normalizedLabel, {
      label: footnote.label,
      normalizedLabel: footnote.normalizedLabel,
      span: freezeSpan(footnote.span.start - newStart, footnote.span.end - newStart)
    }]));
  return Object.freeze({ definitions, footnotes });
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
  const summaryCache = new WeakMap<object, MarkdownTreeSummary>();
  let document = parseMarkdownInternal(source, { ...options, sourceRetention: 'text' }, { nextId: () => nextNodeId++ });
  summarizeMarkdownTree(document.tree, summaryCache);
  let blockPrefixData = topLevelPrefixData(document.tree, summaryCache);

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
          previousRevision,
          snapshot: makeSnapshot(),
          changedOldSpan: applied.changedOldSpan,
          changedNewSpan: applied.changedNewSpan,
          parsedSpan: freezeSpan(0, 0),
          codeUnitDelta: 0,
          instrumentation: Object.freeze({
            parsedCodeUnits: 0,
            sourceIndexCodeUnits: 0,
            parsedNodes: 0,
            reconciledNodes: 0,
            comparedCodeUnits: 0,
            sourceTraversalCodeUnits: 0,
            reusedNodes: oldDocument.metadata.nodeCount,
            fullParse: false
          })
        });
      }
      const reconciliationWork: ReconciliationWork = { visitedNodes: 0, comparedCodeUnits: 0, reusedNodes: 0 };
      const reusable = applied.edits.length === 1 && applied.edits[0] !== undefined
        ? reusableLeafEdit(oldDocument, oldSource, applied.edits[0], reconciliationWork)
        : null;
      if (reusable !== null) {
        const mappedTree = applied.codeUnitDelta === 0
          ? oldDocument.tree
          : mapOldValue(
              oldDocument.tree,
              (offset, affinity) => mapOrderedSourceOffset(offset, applied.edits, affinity),
              reconciliationWork
            ) as MarkdownDocumentNode;
        const pathNodeIds = new Set(reusable.pathNodeIds);
        const tree = replaceReusableLeaf(
          mappedTree,
          reusable,
          applied.edits[0]?.text ?? '',
          () => nextNodeId++,
          pathNodeIds,
          reconciliationWork,
          summaryCache
        ) as MarkdownDocumentNode;
        const sourceIndex = updateMarkdownSourceIndex(oldDocument.sourceIndex, applied.source, applied.edits);
        reconciliationWork.reusedNodes = Math.max(
          0,
          oldDocument.metadata.nodeCount - Math.max(0, reusable.pathNodeIds.length - 1)
        );
        document = assembleSessionDocument(
          Object.freeze({ ...oldDocument, diagnostics: mappedDiagnostics(oldDocument.diagnostics, applied.edits) }),
          tree,
          applied.source,
          options,
          sourceIndex.lineCount,
          sourceIndex,
          summaryCache,
          reconciliationWork
        );
        currentSource = applied.source;
        revision += 1;
        const sourceIndexCodeUnits = markdownSourceIndexScanLength(sourceIndex);
        return Object.freeze({
          previousRevision,
          snapshot: makeSnapshot(),
          changedOldSpan: applied.changedOldSpan,
          changedNewSpan: applied.changedNewSpan,
          parsedSpan: freezeSpan(0, 0),
          codeUnitDelta: applied.codeUnitDelta,
          instrumentation: Object.freeze({
            parsedCodeUnits: 0,
            sourceIndexCodeUnits,
            parsedNodes: 0,
            reconciledNodes: reconciliationWork.visitedNodes,
            comparedCodeUnits: reconciliationWork.comparedCodeUnits,
            sourceTraversalCodeUnits: applied.source.length
              + sourceIndexCodeUnits
              + reconciliationWork.comparedCodeUnits,
            reusedNodes: reconciliationWork.reusedNodes,
            fullParse: false
          })
        });
      }
      const limits = resolveBudgets(options.budgets);
      const fullParse = definitionEditRequiresFullParse(oldDocument, applied);
      const oldStart = fullParse ? 0 : incrementalBlockBoundary(oldDocument, applied.changedOldSpan.start);
      const newStart = mapOrderedSourceOffset(oldStart, applied.edits, 'backward');
      const sourceIndex = newStart === 0
        ? undefined
        : updateMarkdownSourceIndex(oldDocument.sourceIndex, applied.source, applied.edits);
      if (sourceIndex !== undefined) new BudgetController(applied.source.length, sourceIndex.lineCount, limits);
      const oldPrefixLength = blockPrefixLength(oldDocument, oldStart);
      const oldPrefix = oldDocument.tree.children.slice(0, oldPrefixLength);
      const laterDefinitionShifted = applied.codeUnitDelta !== 0 && (
        oldDocument.definitions.some((definition) => definition.span.start >= oldStart)
        || oldDocument.footnotes.some((footnote) => footnote.span.start >= oldStart)
      );
      const prefix = laterDefinitionShifted
        ? oldPrefix.map((block) => mapOldValue(
            block,
            (offset, affinity) => mapOrderedSourceOffset(offset, applied.edits, affinity),
            reconciliationWork
          ) as MarkdownNode as MarkdownDocumentNode['children'][number])
        : oldPrefix;
      const fragment = parseMarkdownInternal(
        applied.source.slice(newStart),
        { ...options, sourceRetention: 'none' },
        {
          sourceOffset: newStart,
          documentLength: applied.source.length,
          seed: fragmentSeed(oldDocument, oldStart, newStart),
          nextId: () => nextNodeId++
        }
      );
      const oldSuffixTree: MarkdownDocumentNode = Object.freeze({
        ...oldDocument.tree,
        children: Object.freeze(oldDocument.tree.children.slice(oldPrefix.length))
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
        applied.edits,
        reconciliationWork,
        summaryCache
      );
      const tree: MarkdownDocumentNode = Object.freeze({
        id: oldDocument.tree.id,
        kind: 'document',
        span: freezeSpan(0, applied.source.length),
        children: Object.freeze([...prefix, ...reconciledSuffix.children])
      });
      const prefixNodes = blockPrefixData.nodeCounts[oldPrefixLength] ?? 0;
      const prefixHeight = blockPrefixData.heights[oldPrefixLength] ?? 0;
      const suffixSummaries = tree.children.slice(oldPrefixLength).map((block) => (
        summarizeMarkdownTree(block, summaryCache, reconciliationWork)
      ));
      const suffixDefinitions = suffixSummaries.flatMap((summary) => summary.definitions);
      const suffixFootnotes = suffixSummaries.flatMap((summary) => summary.footnotes);
      const suffixHeight = suffixSummaries.reduce((height, summary) => Math.max(height, summary.height), 0);
      const prefixDefinitions = oldDocument.definitions.filter((definition) => definition.span.end <= oldStart);
      const prefixFootnotes = oldDocument.footnotes.filter((footnote) => footnote.span.end <= oldStart);
      summaryCache.set(tree, Object.freeze({
        nodeCount: 1 + prefixNodes + suffixSummaries.reduce((count, summary) => count + summary.nodeCount, 0),
        height: 1 + Math.max(prefixHeight, suffixHeight),
        definitions: Object.freeze([...prefixDefinitions, ...suffixDefinitions]),
        footnotes: Object.freeze([...prefixFootnotes, ...suffixFootnotes])
      }));
      const prefixDiagnostics = oldDocument.diagnostics
        .filter((diagnostic) => diagnostic.span.end <= oldStart)
        .map((diagnostic) => mapOldValue(
          diagnostic,
          (offset, affinity) => mapOrderedSourceOffset(offset, applied.edits, affinity)
        ) as MarkdownDiagnostic);
      const assembledInput: ParsedMarkdownDocument = prefixDiagnostics.length === 0
        ? fragment
        : Object.freeze({
            ...fragment,
            diagnostics: Object.freeze([...prefixDiagnostics, ...fragment.diagnostics])
          });
      document = assembleSessionDocument(
        assembledInput,
        tree,
        applied.source,
        options,
        sourceIndex?.lineCount ?? fragment.metadata.lineCount,
        sourceIndex ?? fragment.sourceIndex,
        summaryCache,
        reconciliationWork
      );
      blockPrefixData = extendTopLevelPrefixData(blockPrefixData, oldPrefixLength, suffixSummaries);
      currentSource = applied.source;
      revision += 1;
      const reusedNodes = prefixNodes + reconciliationWork.reusedNodes;
      const parsedCodeUnits = applied.source.length - newStart;
      const sourceIndexCodeUnits = sourceIndex === undefined
        ? fragment.metadata.sourceCodeUnits
        : markdownSourceIndexScanLength(sourceIndex);
      return Object.freeze({
        previousRevision,
        snapshot: makeSnapshot(),
        changedOldSpan: applied.changedOldSpan,
        changedNewSpan: applied.changedNewSpan,
        parsedSpan: freezeSpan(newStart, applied.source.length),
        codeUnitDelta: applied.codeUnitDelta,
        instrumentation: Object.freeze({
          parsedCodeUnits,
          sourceIndexCodeUnits,
          parsedNodes: fragment.metadata.nodeCount,
          reconciledNodes: reconciliationWork.visitedNodes,
          comparedCodeUnits: reconciliationWork.comparedCodeUnits,
          sourceTraversalCodeUnits: applied.source.length
            + parsedCodeUnits
            + sourceIndexCodeUnits
            + reconciliationWork.comparedCodeUnits,
          reusedNodes,
          fullParse: newStart === 0
        })
      });
    },
    replaceSource(nextSource: string): MarkdownSessionUpdate {
      if (typeof nextSource !== 'string') throw new TypeError('source must be a string.');
      const previousRevision = revision;
      const previousLength = currentSource.length;
      const oldTree = document.tree;
      const oldSource = currentSource;
      const parsed = parseMarkdownInternal(nextSource, { ...options, sourceRetention: 'text' }, { nextId: () => nextNodeId++ });
      const replacementEdit = Object.freeze({ span: freezeSpan(0, previousLength), text: nextSource });
      const reconciliationWork: ReconciliationWork = { visitedNodes: 0, comparedCodeUnits: 0, reusedNodes: 0 };
      const tree = reconcileTree(
        oldTree,
        parsed.tree,
        oldSource,
        nextSource,
        [replacementEdit],
        reconciliationWork,
        summaryCache
      );
      document = assembleSessionDocument(
        parsed,
        tree,
        nextSource,
        options,
        parsed.metadata.lineCount,
        parsed.sourceIndex,
        summaryCache,
        reconciliationWork
      );
      blockPrefixData = topLevelPrefixData(tree, summaryCache, reconciliationWork);
      currentSource = nextSource;
      revision += 1;
      return Object.freeze({
        previousRevision,
        snapshot: makeSnapshot(),
        changedOldSpan: freezeSpan(0, previousLength),
        changedNewSpan: freezeSpan(0, nextSource.length),
        parsedSpan: freezeSpan(0, nextSource.length),
        codeUnitDelta: nextSource.length - previousLength,
        instrumentation: Object.freeze({
          parsedCodeUnits: nextSource.length,
          sourceIndexCodeUnits: nextSource.length,
          parsedNodes: parsed.metadata.nodeCount,
          reconciledNodes: reconciliationWork.visitedNodes,
          comparedCodeUnits: reconciliationWork.comparedCodeUnits,
          sourceTraversalCodeUnits: nextSource.length * 2 + reconciliationWork.comparedCodeUnits,
          reusedNodes: reconciliationWork.reusedNodes,
          fullParse: true
        })
      });
    }
  };
  return Object.freeze(api);
}
