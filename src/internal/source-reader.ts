import type { SourceSpan } from '../model.js';

export interface SourceLine {
  readonly start: number;
  readonly contentEnd: number;
  readonly end: number;
}

/** A line after enclosing block markers have been removed virtually. */
export interface LineView {
  readonly line: SourceLine;
  readonly contentStart: number;
  /** Original virtual column at `contentStart`, before container subtraction. */
  readonly virtualColumn: number;
  /** Expanded indentation cells that remain before `contentStart`. */
  readonly virtualSpaces?: number;
  /** A container-less continuation that may extend a paragraph but cannot open blocks. */
  readonly lazy?: boolean;
}

export interface InlineSegment {
  readonly logicalStart: number;
  readonly logicalEnd: number;
  readonly sourceStart: number;
  readonly sourceEnd: number;
}

export class InlineSource {
  readonly text: string;
  private readonly segments: readonly InlineSegment[];

  constructor(source: string, views: readonly LineView[], removeEscapedPipes = false) {
    let text = '';
    const segments: InlineSegment[] = [];
    for (let index = 0; index < views.length; index += 1) {
      const view = views[index];
      if (view === undefined) continue;
      const prefix = ' '.repeat(view.virtualSpaces ?? 0);
      if (prefix.length > 0) {
        const logicalStart = text.length;
        text += prefix;
        segments.push({
          logicalStart,
          logicalEnd: text.length,
          sourceStart: view.contentStart,
          sourceEnd: view.contentStart
        });
      }
      let chunkStart = view.contentStart;
      for (let offset = view.contentStart; offset < view.line.contentEnd; offset += 1) {
        if (!removeEscapedPipes || source[offset] !== '\\' || source[offset + 1] !== '|') continue;
        if (offset > chunkStart) {
          const logicalStart = text.length;
          text += source.slice(chunkStart, offset);
          segments.push({ logicalStart, logicalEnd: text.length, sourceStart: chunkStart, sourceEnd: offset });
        }
        chunkStart = offset + 1;
      }
      if (chunkStart < view.line.contentEnd) {
        const logicalStart = text.length;
        text += source.slice(chunkStart, view.line.contentEnd);
        segments.push({
          logicalStart,
          logicalEnd: text.length,
          sourceStart: chunkStart,
          sourceEnd: view.line.contentEnd
        });
      }
      const next = views[index + 1];
      if (next !== undefined) {
        const logicalStart = text.length;
        text += '\n';
        segments.push({
          logicalStart,
          logicalEnd: text.length,
          sourceStart: view.line.contentEnd,
          sourceEnd: view.line.end
        });
      }
    }
    this.text = text;
    this.segments = segments;
  }

  span(start: number, end: number): SourceSpan {
    if (start < 0 || end < start || end > this.text.length) {
      throw new RangeError('Inline range is outside its source.');
    }
    if (start === end) {
      const point = this.startOffset(start);
      return { start: point, end: point };
    }
    return { start: this.startOffset(start), end: this.endOffset(end) };
  }

  private startOffset(index: number): number {
    for (const segment of this.segments) {
      if (index >= segment.logicalStart && index < segment.logicalEnd) {
        if (segment.logicalEnd - segment.logicalStart === segment.sourceEnd - segment.sourceStart) {
          return segment.sourceStart + index - segment.logicalStart;
        }
        return segment.sourceStart;
      }
      if (index === segment.logicalStart) return segment.sourceStart;
    }
    return this.segments.at(-1)?.sourceEnd ?? 0;
  }

  private endOffset(index: number): number {
    for (let cursor = this.segments.length - 1; cursor >= 0; cursor -= 1) {
      const segment = this.segments[cursor];
      if (segment === undefined) continue;
      if (index > segment.logicalStart && index <= segment.logicalEnd) {
        if (segment.logicalEnd - segment.logicalStart === segment.sourceEnd - segment.sourceStart) {
          return segment.sourceStart + index - segment.logicalStart;
        }
        return segment.sourceEnd;
      }
    }
    return this.segments[0]?.sourceStart ?? 0;
  }
}

export function scanSourceLines(source: string): readonly SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    if (code !== 0x0a && code !== 0x0d) continue;
    const contentEnd = index;
    if (code === 0x0d && source.charCodeAt(index + 1) === 0x0a) index += 1;
    lines.push({ start, contentEnd, end: index + 1 });
    start = index + 1;
  }
  if (start < source.length || source.length === 0) {
    lines.push({ start, contentEnd: source.length, end: source.length });
  }
  return lines;
}

export function rootLineViews(lines: readonly SourceLine[]): readonly LineView[] {
  return lines.map((line) => ({ line, contentStart: line.start, virtualColumn: 0, virtualSpaces: 0 }));
}

export function advanceVirtualColumn(column: number, code: number): number {
  return code === 0x09 ? column + (4 - column % 4) : column + 1;
}

export function consumeIndent(
  source: string,
  view: LineView,
  maximumColumns: number
): { readonly offset: number; readonly columns: number } {
  let offset = view.contentStart;
  let sourceColumn = view.virtualColumn;
  let columns = view.virtualSpaces ?? 0;
  if (columns > maximumColumns) return { offset, columns: maximumColumns };
  while (offset < view.line.contentEnd) {
    const code = source.charCodeAt(offset);
    if (code !== 0x20 && code !== 0x09) break;
    const next = advanceVirtualColumn(sourceColumn, code);
    const width = next - sourceColumn;
    if (columns + width > maximumColumns) break;
    columns += width;
    sourceColumn = next;
    offset += 1;
  }
  return { offset, columns };
}

export function sourceColumnAt(source: string, lineStart: number, offset: number): number {
  let column = 0;
  for (let cursor = lineStart; cursor < offset; cursor += 1) {
    column = advanceVirtualColumn(column, source.charCodeAt(cursor));
  }
  return column;
}

export function isBlankView(source: string, view: LineView): boolean {
  for (let offset = view.contentStart; offset < view.line.contentEnd; offset += 1) {
    const code = source.charCodeAt(offset);
    if (code !== 0x20 && code !== 0x09) return false;
  }
  return true;
}
