import type {
  MarkdownCodeBlockNode,
  MarkdownCodeValueSourceMap,
  MarkdownCodeValueSourceSegment,
  SourceSpan
} from './model.js';

function assertValueOffset(value: number, length: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > length) {
    throw new RangeError(`${name} must be an integer between 0 and ${String(length)}.`);
  }
}

function segmentAtStart(
  segments: readonly MarkdownCodeValueSourceSegment[],
  offset: number
): MarkdownCodeValueSourceSegment | undefined {
  let lower = 0;
  let upper = segments.length;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    if ((segments[middle]?.valueEnd ?? Number.POSITIVE_INFINITY) <= offset) lower = middle + 1;
    else upper = middle;
  }
  return segments[lower] ?? segments.at(-1);
}

function segmentAtEnd(
  segments: readonly MarkdownCodeValueSourceSegment[],
  offset: number
): MarkdownCodeValueSourceSegment | undefined {
  let lower = 0;
  let upper = segments.length;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    if ((segments[middle]?.valueStart ?? Number.POSITIVE_INFINITY) < offset) lower = middle + 1;
    else upper = middle;
  }
  return segments[Math.max(0, lower - 1)] ?? segments[0];
}

function offsetInsideSegment(
  segment: MarkdownCodeValueSourceSegment,
  offset: number,
  affinity: 'start' | 'end'
): number {
  const valueLength = segment.valueEnd - segment.valueStart;
  const sourceLength = segment.sourceSpan.end - segment.sourceSpan.start;
  if (valueLength === sourceLength && valueLength > 0) {
    return segment.sourceSpan.start + Math.max(0, Math.min(valueLength, offset - segment.valueStart));
  }
  return affinity === 'start' ? segment.sourceSpan.start : segment.sourceSpan.end;
}

/**
 * Map a half-open range in `MarkdownCodeBlockNode.value` to the smallest
 * enclosing absolute UTF-16 source span.
 */
export function markdownCodeValueSourceSpan(
  node: MarkdownCodeBlockNode,
  start: number,
  end: number
): SourceSpan {
  const map: MarkdownCodeValueSourceMap = node.valueSourceMap;
  assertValueOffset(start, map.valueLength, 'start');
  assertValueOffset(end, map.valueLength, 'end');
  if (end < start) throw new RangeError('end must not precede start.');
  const segments = map.segments;
  if (segments.length === 0) {
    const point = node.contentSpan.start;
    return Object.freeze({ start: point, end: point });
  }
  if (start === end) {
    if (start === map.valueLength) {
      const point = segments.at(-1)?.sourceSpan.end ?? node.contentSpan.end;
      return Object.freeze({ start: point, end: point });
    }
    const segment = segmentAtStart(segments, start) ?? segmentAtEnd(segments, start);
    const point = segment === undefined ? node.contentSpan.start : offsetInsideSegment(segment, start, 'start');
    return Object.freeze({ start: point, end: point });
  }
  const first = segmentAtStart(segments, start);
  const last = segmentAtEnd(segments, end);
  if (first === undefined || last === undefined) {
    throw new RangeError('The code value source map does not cover the requested range.');
  }
  return Object.freeze({
    start: offsetInsideSegment(first, start, 'start'),
    end: offsetInsideSegment(last, end, 'end')
  });
}
