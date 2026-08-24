import type { SourceSpan } from './model.js';

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

  const findLine = (offset: number): number => {
    let low = 0;
    let high = starts.length - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      const value = starts[middle] ?? 0;
      if (value <= offset) low = middle + 1;
      else high = middle - 1;
    }
    return Math.max(0, high);
  };

  const api: MarkdownSourceIndex = {
    length: source.length,
    lineCount: starts.length,
    positionAt(offset: number): SourcePosition {
      integer(offset, 'offset');
      if (offset < 0 || offset > source.length) {
        throw new RangeError(`offset must be between 0 and ${source.length}.`);
      }
      const line = findLine(offset);
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

  return Object.freeze(api);
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
