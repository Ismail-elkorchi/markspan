import type { SourceSpan } from './model.js';
import { mapOrderedSourceOffset } from './internal/edit-offset.js';
import { recordMarkdownSourceIndexScanLength } from './internal/source-index-instrumentation.js';

export interface SourcePosition {
  readonly offset: number;
  /** Zero-based line. */
  readonly line: number;
  /** Zero-based UTF-16 column. */
  readonly column: number;
}

export interface MarkdownSourceIndex {
  readonly length: number;
  readonly lineCount: number;
  positionAt(offset: number): SourcePosition;
  offsetAt(line: number, column: number): number;
  lineSpan(line: number, includeEnding?: boolean): SourceSpan;
}

export interface MarkdownSourceIndexEdit {
  readonly span: SourceSpan;
  readonly text: string;
}

interface SourceIndexData {
  readonly starts: readonly number[];
  readonly contentEnds: readonly number[];
  readonly endingEnds: readonly number[];
}

const sourceIndexData = new WeakMap<object, SourceIndexData>();

function integer(value: number, name: string): number {
  if (!Number.isInteger(value)) throw new TypeError(`${name} must be an integer.`);
  return value;
}

function freezeSpan(start: number, end: number): SourceSpan {
  return Object.freeze({ start, end });
}

/** Build a line/column index without normalizing the source text. */
export function createMarkdownSourceIndex(source: string): MarkdownSourceIndex {
  if (typeof source !== 'string') throw new TypeError('source must be a string.');
  return sourceIndex(source, scanLines(source), source.length);
}

/** Update line positions by rescanning only lines adjacent to an exact edit set. */
export function updateMarkdownSourceIndex(
  previous: MarkdownSourceIndex,
  source: string,
  edits: readonly MarkdownSourceIndexEdit[]
): MarkdownSourceIndex {
  const data = sourceIndexData.get(previous);
  if (data === undefined) throw new TypeError('previous must be a Markspan source index.');
  if (typeof source !== 'string') throw new TypeError('source must be a string.');
  if (!Array.isArray(edits)) throw new TypeError('edits must be an array.');
  if (edits.length === 0) {
    if (source.length !== previous.length) throw new RangeError('source length cannot change without an edit.');
    return previous;
  }
  const validated = edits.map((edit, index) => {
    if (typeof edit !== 'object' || edit === null || typeof edit.text !== 'string') {
      throw new TypeError(`edit ${String(index)} is invalid.`);
    }
    assertSourceSpan(edit.span, previous.length);
    return edit;
  });
  const sorted = validated.sort((left, right) => left.span.start - right.span.start || left.span.end - right.span.end);
  for (let index = 1; index < sorted.length; index += 1) {
    const previousEdit = sorted[index - 1];
    const edit = sorted[index];
    if (edit === undefined || previousEdit === undefined) continue;
    const overlaps = edit.span.start < previousEdit.span.end;
    const sharesReplacementBoundary = edit.span.start === previousEdit.span.start
      && (edit.span.end > edit.span.start || previousEdit.span.end > previousEdit.span.start);
    if (overlaps || sharesReplacementBoundary) throw new RangeError('source index edits overlap.');
  }
  const expectedLength = previous.length + sorted.reduce(
    (length, edit) => length + edit.text.length - (edit.span.end - edit.span.start),
    0
  );
  if (source.length !== expectedLength) {
    throw new RangeError(`source length must be ${expectedLength} after applying the edits.`);
  }
  if (editsPreserveLineBoundaries(data, sorted)) {
    const lineDeltas = Array.from({ length: data.starts.length }, () => 0);
    for (const edit of sorted) {
      const line = lineForOffset(data.starts, edit.span.start);
      lineDeltas[line] = (lineDeltas[line] ?? 0) + edit.text.length - (edit.span.end - edit.span.start);
    }
    let precedingDelta = 0;
    const starts: number[] = [];
    const contentEnds: number[] = [];
    const endingEnds: number[] = [];
    for (let line = 0; line < data.starts.length; line += 1) {
      const lineDelta = lineDeltas[line] ?? 0;
      starts.push((data.starts[line] ?? 0) + precedingDelta);
      contentEnds.push((data.contentEnds[line] ?? source.length) + precedingDelta + lineDelta);
      endingEnds.push((data.endingEnds[line] ?? source.length) + precedingDelta + lineDelta);
      precedingDelta += lineDelta;
    }
    return sourceIndex(source, Object.freeze({
      starts: Object.freeze(starts),
      contentEnds: Object.freeze(contentEnds),
      endingEnds: Object.freeze(endingEnds)
    }), 0);
  }
  const first = sorted[0];
  const last = sorted.at(-1);
  if (first === undefined || last === undefined) return previous;
  const startLine = lineForOffset(data.starts, first.span.start);
  const endLine = lineForOffset(data.starts, last.span.end);
  const regionStartLine = Math.max(0, startLine - 1);
  const regionEndLineExclusive = Math.min(data.starts.length, endLine + 2);
  const oldRegionStart = data.starts[regionStartLine] ?? 0;
  const oldRegionEnd = data.starts[regionEndLineExclusive] ?? previous.length;
  const newRegionStart = mapOrderedSourceOffset(oldRegionStart, sorted, 'backward');
  const newRegionEnd = mapOrderedSourceOffset(oldRegionEnd, sorted, 'forward');
  const local = scanLines(source.slice(newRegionStart, newRegionEnd));
  const localHasSuffixBoundary = newRegionEnd < source.length && local.starts.at(-1) === newRegionEnd - newRegionStart;
  const localLength = localHasSuffixBoundary ? local.starts.length - 1 : local.starts.length;
  let suffixStartLine = regionEndLineExclusive;
  if (newRegionEnd === source.length) {
    while ((data.starts[suffixStartLine] ?? Number.POSITIVE_INFINITY) <= oldRegionEnd) suffixStartLine += 1;
  }
  const starts = [
    ...data.starts.slice(0, regionStartLine),
    ...local.starts.slice(0, localLength).map((offset) => offset + newRegionStart),
    ...data.starts.slice(suffixStartLine).map((offset) => mapOrderedSourceOffset(offset, sorted, 'forward'))
  ];
  const contentEnds = [
    ...data.contentEnds.slice(0, regionStartLine),
    ...local.contentEnds.slice(0, localLength).map((offset) => offset + newRegionStart),
    ...data.contentEnds.slice(suffixStartLine).map((offset) => mapOrderedSourceOffset(offset, sorted, 'forward'))
  ];
  const endingEnds = [
    ...data.endingEnds.slice(0, regionStartLine),
    ...local.endingEnds.slice(0, localLength).map((offset) => offset + newRegionStart),
    ...data.endingEnds.slice(suffixStartLine).map((offset) => mapOrderedSourceOffset(offset, sorted, 'forward'))
  ];
  return sourceIndex(source, Object.freeze({
    starts: Object.freeze(starts),
    contentEnds: Object.freeze(contentEnds),
    endingEnds: Object.freeze(endingEnds)
  }), newRegionEnd - newRegionStart);
}

function editsPreserveLineBoundaries(
  data: SourceIndexData,
  edits: readonly MarkdownSourceIndexEdit[]
): boolean {
  return edits.every((edit) => {
    if (edit.text.includes('\n') || edit.text.includes('\r')) return false;
    const startLine = lineForOffset(data.starts, edit.span.start);
    const endLine = lineForOffset(data.starts, edit.span.end);
    const contentEnd = data.contentEnds[startLine];
    return startLine === endLine
      && contentEnd !== undefined
      && edit.span.start <= contentEnd
      && edit.span.end <= contentEnd;
  });
}

function scanLines(source: string): SourceIndexData {
  const starts: number[] = [0];
  const contentEnds: number[] = [];
  const endingEnds: number[] = [];

  let index = 0;
  let lineStart = 0;
  while (index < source.length) {
    const code = source.charCodeAt(index);
    if (code === 0x0d) {
      contentEnds.push(index);
      index += source.charCodeAt(index + 1) === 0x0a ? 2 : 1;
      endingEnds.push(index);
      starts.push(index);
      lineStart = index;
      continue;
    }
    if (code === 0x0a) {
      contentEnds.push(index);
      index += 1;
      endingEnds.push(index);
      starts.push(index);
      lineStart = index;
      continue;
    }
    index += 1;
  }

  contentEnds.push(source.length);
  endingEnds.push(source.length);

  // A trailing line ending creates an empty final line. The starts array already
  // contains it and the final content/end entries above describe that line.
  if (starts.at(-1) !== lineStart) starts.push(lineStart);

  return Object.freeze({
    starts: Object.freeze(starts),
    contentEnds: Object.freeze(contentEnds),
    endingEnds: Object.freeze(endingEnds)
  });
}

function sourceIndex(source: string, data: SourceIndexData, scannedCodeUnits: number): MarkdownSourceIndex {
  const { starts, contentEnds, endingEnds } = data;
  const api: MarkdownSourceIndex = {
    length: source.length,
    lineCount: starts.length,
    positionAt(offset: number): SourcePosition {
      integer(offset, 'offset');
      if (offset < 0 || offset > source.length) {
        throw new RangeError(`offset must be between 0 and ${source.length}.`);
      }
      const line = lineForOffset(starts, offset);
      const start = starts[line] ?? 0;
      return Object.freeze({ offset, line, column: offset - start });
    },
    offsetAt(line: number, column: number): number {
      integer(line, 'line');
      integer(column, 'column');
      if (line < 0 || line >= starts.length) {
        throw new RangeError(`line must be between 0 and ${Math.max(0, starts.length - 1)}.`);
      }
      if (column < 0) throw new RangeError('column must not be negative.');
      const start = starts[line] ?? 0;
      const end = contentEnds[line] ?? source.length;
      return Math.min(end, start + column);
    },
    lineSpan(line: number, includeEnding = false): SourceSpan {
      integer(line, 'line');
      if (line < 0 || line >= starts.length) {
        throw new RangeError(`line must be between 0 and ${Math.max(0, starts.length - 1)}.`);
      }
      const start = starts[line] ?? 0;
      const end = includeEnding
        ? (endingEnds[line] ?? source.length)
        : (contentEnds[line] ?? source.length);
      return freezeSpan(start, end);
    }
  };
  const frozen = Object.freeze(api);
  sourceIndexData.set(frozen, data);
  recordMarkdownSourceIndexScanLength(frozen, scannedCodeUnits);
  return frozen;
}

function lineForOffset(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((starts[middle] ?? Number.POSITIVE_INFINITY) <= offset) low = middle + 1;
    else high = middle;
  }
  return Math.max(0, low - 1);
}

export function isSourceSpan(value: unknown): value is SourceSpan {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { readonly start?: unknown; readonly end?: unknown };
  return Number.isInteger(candidate.start)
    && Number.isInteger(candidate.end)
    && (candidate.start as number) >= 0
    && (candidate.end as number) >= (candidate.start as number);
}

export function assertSourceSpan(span: SourceSpan, sourceLength?: number): void {
  if (!isSourceSpan(span)) throw new TypeError('span must contain non-negative integer start and end offsets.');
  if (sourceLength !== undefined) {
    integer(sourceLength, 'sourceLength');
    if (span.end > sourceLength) {
      throw new RangeError(`span ends at ${span.end}, beyond source length ${sourceLength}.`);
    }
  }
}

export function sliceMarkdownSource(source: string, span: SourceSpan): string {
  if (typeof source !== 'string') throw new TypeError('source must be a string.');
  assertSourceSpan(span, source.length);
  return source.slice(span.start, span.end);
}

export function sourceSpanContains(outer: SourceSpan, inner: SourceSpan): boolean {
  return outer.start <= inner.start && outer.end >= inner.end;
}

export function sourceSpanIntersects(left: SourceSpan, right: SourceSpan): boolean {
  return left.start < right.end && right.start < left.end;
}

export function mergeSourceSpans(left: SourceSpan, right: SourceSpan): SourceSpan {
  return freezeSpan(Math.min(left.start, right.start), Math.max(left.end, right.end));
}
