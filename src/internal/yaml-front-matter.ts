import type {
  MarkdownDiagnostic,
  MarkdownFrontMatterMapping,
  MarkdownFrontMatterMappingEntry,
  MarkdownFrontMatterScalar,
  MarkdownFrontMatterSequence,
  MarkdownFrontMatterValue,
  SourceSpan
} from '../model.js';
import { scanSourceLines } from './source-reader.js';

interface YamlLine {
  readonly start: number;
  readonly contentEnd: number;
  readonly end: number;
  readonly indent: number;
  readonly contentStart: number;
  readonly blank: boolean;
}

interface ParsedValue {
  readonly value: MarkdownFrontMatterValue;
  readonly next: number;
}

interface MappingLineOverride {
  readonly index: number;
  readonly contentStart: number;
  readonly indent: number;
}

interface BlockScalarHeader {
  readonly style: 'literal' | 'folded';
  readonly chomping: '' | '+' | '-';
  readonly explicitIndent?: number;
}

function span(start: number, end: number): SourceSpan {
  return { start, end };
}

function scalar(
  sourceSpan: SourceSpan,
  style: MarkdownFrontMatterScalar['style'],
  value: MarkdownFrontMatterScalar['value']
): MarkdownFrontMatterScalar {
  return { kind: 'scalar', span: sourceSpan, style, value };
}

/** Parse the deliberately non-executing YAML subset exposed by front matter. */
export function parseSafeYamlFrontMatter(
  source: string,
  start: number,
  end: number
): { readonly value: MarkdownFrontMatterValue | null; readonly diagnostics: readonly MarkdownDiagnostic[] } {
  const parser = new SafeYamlParser(source, start, end);
  return parser.parse();
}

class SafeYamlParser {
  private readonly lines: readonly YamlLine[];
  private readonly diagnostics: MarkdownDiagnostic[] = [];
  private workRemaining: number;
  private workLimitReported = false;

  constructor(
    private readonly source: string,
    start: number,
    end: number
  ) {
    const fragment = source.slice(start, end);
    this.workRemaining = Math.max(1_024, fragment.length * 16);
    this.lines = scanSourceLines(fragment).map((line) => {
      const absoluteStart = start + line.start;
      const absoluteContentEnd = start + line.contentEnd;
      let contentStart = absoluteStart;
      let indent = 0;
      while (contentStart < absoluteContentEnd) {
        const character = source[contentStart];
        if (character === ' ') {
          contentStart += 1;
          indent += 1;
        } else if (character === '\t') {
          this.report('Tabs are not permitted for YAML indentation.', span(contentStart, contentStart + 1));
          contentStart += 1;
          indent += 4 - indent % 4;
        } else break;
      }
      const content = source.slice(contentStart, absoluteContentEnd);
      return {
        start: absoluteStart,
        contentEnd: absoluteContentEnd,
        end: start + line.end,
        indent,
        contentStart,
        blank: content.trim().length === 0 || content.trimStart().startsWith('#')
      };
    });
  }

  parse(): { readonly value: MarkdownFrontMatterValue | null; readonly diagnostics: readonly MarkdownDiagnostic[] } {
    const first = this.significant(0);
    if (first >= this.lines.length) return { value: null, diagnostics: this.diagnostics };
    const firstLine = this.lines[first];
    if (firstLine === undefined) return { value: null, diagnostics: this.diagnostics };
    if (firstLine.indent !== 0) {
      this.report('The root YAML value must not be indented.', span(firstLine.start, firstLine.contentStart));
    }
    const parsed = this.parseBlock(first, firstLine.indent, 0);
    const remaining = this.significant(parsed.next);
    if (remaining < this.lines.length) {
      const line = this.lines[remaining];
      if (line !== undefined) this.report('Unexpected YAML content after the root value.', span(line.contentStart, line.contentEnd));
    }
    return { value: parsed.value, diagnostics: this.diagnostics };
  }

  private parseBlock(index: number, indent: number, depth: number): ParsedValue {
    const line = this.lines[index];
    if (line === undefined) return { value: scalar(span(0, 0), 'plain', null), next: index };
    if (depth > 256) {
      this.report('YAML value nesting exceeds 256 levels.', span(line.contentStart, line.contentEnd));
      return { value: scalar(span(line.contentStart, line.contentEnd), 'plain', this.source.slice(line.contentStart, line.contentEnd)), next: index + 1 };
    }
    const inlineEnd = this.scalarEnd(line.contentStart, line.contentEnd);
    if (this.source[line.contentStart] === '[' || this.source[line.contentStart] === '{') {
      return { value: this.parseInlineValue(line.contentStart, inlineEnd, depth), next: index + 1 };
    }
    if (this.isSequenceLine(line, indent)) return this.parseSequence(index, indent, depth);
    if (this.blockScalarHeader(line.contentStart, inlineEnd) !== null) {
      return this.parseBlockScalar(index, indent, line.contentStart, inlineEnd);
    }
    if (this.mappingColon(line.contentStart, inlineEnd) >= 0) return this.parseMapping(index, indent, depth);
    return { value: this.parseInlineValue(line.contentStart, inlineEnd, depth), next: index + 1 };
  }

  private parseMapping(index: number, indent: number, depth: number, firstOverride?: MappingLineOverride): ParsedValue {
    const entries: MarkdownFrontMatterMappingEntry[] = [];
    const keys = new Set<string>();
    let cursor = index;
    let firstSpanStart: number | undefined;
    let lastSpanEnd: number | undefined;
    while (cursor < this.lines.length) {
      const significant = this.significant(cursor);
      if (significant >= this.lines.length) {
        cursor = significant;
        break;
      }
      const physical = this.lines[significant];
      if (physical === undefined) break;
      const override = firstOverride?.index === significant ? firstOverride : undefined;
      const lineIndent = override?.indent ?? physical.indent;
      const contentStart = override?.contentStart ?? physical.contentStart;
      if (lineIndent < indent || (lineIndent === indent && this.isSequenceLine(physical, indent))) break;
      if (lineIndent > indent) {
        this.report('Unexpected YAML indentation.', span(physical.start, physical.contentStart));
        cursor = significant + 1;
        continue;
      }
      const colon = this.mappingColon(contentStart, physical.contentEnd);
      if (colon < 0) {
        this.report('A YAML mapping entry requires a key followed by a colon.', span(contentStart, physical.contentEnd));
        cursor = significant + 1;
        continue;
      }
      const keyEnd = this.trimEnd(contentStart, colon);
      const key = this.decodeKey(contentStart, keyEnd);
      if (key.length === 0) this.report('A YAML mapping key cannot be empty.', span(contentStart, colon));
      else if (keys.has(key)) this.report('YAML mapping keys must be unique.', span(contentStart, keyEnd));
      else keys.add(key);
      let valueStart = colon + 1;
      while (valueStart < physical.contentEnd && (this.source[valueStart] === ' ' || this.source[valueStart] === '\t')) valueStart += 1;
      const inlineEnd = this.scalarEnd(valueStart, physical.contentEnd);
      let parsedValue: MarkdownFrontMatterValue;
      let next = significant + 1;
      if (inlineEnd === valueStart) {
        const childIndex = this.significant(next);
        const child = this.lines[childIndex];
        if (child !== undefined && child.indent > indent) {
          const nested = this.parseBlock(childIndex, child.indent, depth + 1);
          parsedValue = nested.value;
          next = nested.next;
        } else {
          parsedValue = scalar(span(valueStart, valueStart), 'plain', null);
        }
      } else if (this.blockScalarHeader(valueStart, inlineEnd) !== null) {
        const block = this.parseBlockScalar(significant, indent, valueStart, inlineEnd);
        parsedValue = block.value;
        next = block.next;
      } else {
        parsedValue = this.parseInlineValue(valueStart, inlineEnd, depth + 1);
      }
      const entry: MarkdownFrontMatterMappingEntry = {
        key,
        keySpan: span(contentStart, keyEnd),
        valueSpan: parsedValue.span,
        value: parsedValue
      };
      entries.push(entry);
      firstSpanStart ??= contentStart;
      lastSpanEnd = Math.max(physical.contentEnd, parsedValue.span.end);
      cursor = next;
      firstOverride = undefined;
    }
    const point = this.lines[index]?.contentStart ?? 0;
    const value: MarkdownFrontMatterMapping = {
      kind: 'mapping',
      span: span(firstSpanStart ?? point, lastSpanEnd ?? point),
      entries
    };
    return { value, next: cursor };
  }

  private parseSequence(index: number, indent: number, depth: number): ParsedValue {
    const items: MarkdownFrontMatterValue[] = [];
    let cursor = index;
    let firstStart: number | undefined;
    let lastEnd: number | undefined;
    while (cursor < this.lines.length) {
      const significant = this.significant(cursor);
      const line = this.lines[significant];
      if (line === undefined || line.indent !== indent || !this.isSequenceLine(line, indent)) break;
      const marker = line.contentStart;
      let valueStart = marker + 1;
      while (valueStart < line.contentEnd && (this.source[valueStart] === ' ' || this.source[valueStart] === '\t')) valueStart += 1;
      const inlineEnd = this.scalarEnd(valueStart, line.contentEnd);
      let value: MarkdownFrontMatterValue;
      let next = significant + 1;
      if (inlineEnd === valueStart) {
        const childIndex = this.significant(next);
        const child = this.lines[childIndex];
        if (child !== undefined && child.indent > indent) {
          const nested = this.parseBlock(childIndex, child.indent, depth + 1);
          value = nested.value;
          next = nested.next;
        } else value = scalar(span(valueStart, valueStart), 'plain', null);
      } else if (this.source[valueStart] === '[' || this.source[valueStart] === '{') {
        value = this.parseInlineValue(valueStart, inlineEnd, depth + 1);
      } else if (this.mappingColon(valueStart, inlineEnd) >= 0) {
        const nested = this.parseMapping(significant, valueStart - line.start, depth + 1, {
          index: significant,
          contentStart: valueStart,
          indent: valueStart - line.start
        });
        value = nested.value;
        next = nested.next;
      } else if (this.blockScalarHeader(valueStart, inlineEnd) !== null) {
        const block = this.parseBlockScalar(significant, indent, valueStart, inlineEnd);
        value = block.value;
        next = block.next;
      } else value = this.parseInlineValue(valueStart, inlineEnd, depth + 1);
      items.push(value);
      firstStart ??= marker;
      lastEnd = Math.max(line.contentEnd, value.span.end);
      cursor = next;
    }
    const point = this.lines[index]?.contentStart ?? 0;
    const value: MarkdownFrontMatterSequence = {
      kind: 'sequence',
      span: span(firstStart ?? point, lastEnd ?? point),
      items
    };
    return { value, next: cursor };
  }

  private parseBlockScalar(
    headerIndex: number,
    parentIndent: number,
    headerStart: number,
    headerEnd: number
  ): ParsedValue {
    const header = this.source.slice(headerStart, headerEnd);
    const decodedHeader = this.blockScalarHeader(headerStart, headerEnd);
    if (decodedHeader === null) {
      this.report('A YAML block scalar header is malformed.', span(headerStart, headerEnd));
      return { value: scalar(span(headerStart, headerEnd), 'plain', header), next: headerIndex + 1 };
    }
    let cursor = headerIndex + 1;
    let minimumIndent = Number.POSITIVE_INFINITY;
    const body: YamlLine[] = [];
    while (cursor < this.lines.length) {
      const line = this.lines[cursor];
      if (line === undefined) break;
      if (!line.blank && line.indent <= parentIndent) break;
      body.push(line);
      if (!line.blank) minimumIndent = Math.min(minimumIndent, line.indent);
      cursor += 1;
    }
    const contentIndent = decodedHeader.explicitIndent === undefined
      ? (Number.isFinite(minimumIndent) ? minimumIndent : parentIndent + 1)
      : parentIndent + decodedHeader.explicitIndent;
    const chunks = body.map((line) => {
      if (line.blank) return '';
      let offset = line.start;
      let columns = 0;
      while (offset < line.contentEnd && columns < contentIndent) {
        const character = this.source[offset];
        if (character === ' ') {
          columns += 1;
          offset += 1;
        } else if (character === '\t') {
          columns += 4 - columns % 4;
          offset += 1;
        } else break;
      }
      if (columns < contentIndent) {
        this.report(
          'A YAML block scalar line does not satisfy its indentation indicator.',
          span(line.start, line.contentStart)
        );
      }
      return this.source.slice(offset, line.contentEnd);
    });
    let value = decodedHeader.style === 'literal' ? chunks.join('\n') : this.foldLines(chunks);
    if (body.length > 0) value += '\n';
    if (decodedHeader.chomping === '-') value = value.replace(/\n+$/u, '');
    else if (decodedHeader.chomping !== '+' && value.endsWith('\n')) value = value.replace(/\n+$/u, '\n');
    const last = body.at(-1);
    const sourceEnd = last?.contentEnd ?? headerEnd;
    return {
      value: scalar(span(headerStart, sourceEnd), decodedHeader.style, value),
      next: cursor
    };
  }

  private parseScalar(start: number, end: number): MarkdownFrontMatterScalar {
    const raw = this.source.slice(start, end);
    if (raw.startsWith('|') || raw.startsWith('>')) {
      this.report('A YAML block scalar header is malformed.', span(start, end));
    }
    if (raw.startsWith("'")) {
      if (!raw.endsWith("'") || raw.length < 2) {
        this.report('A single-quoted YAML scalar is not closed.', span(start, end));
        return scalar(span(start, end), 'singleQuoted', raw.slice(1));
      }
      return scalar(span(start, end), 'singleQuoted', raw.slice(1, -1).replace(/''/gu, "'"));
    }
    if (raw.startsWith('"')) return scalar(span(start, end), 'doubleQuoted', this.decodeDoubleQuoted(raw, start, end));
    this.reportUnsupportedConstructs(raw, start);
    if (/^(?:null|Null|NULL|~)$/u.test(raw)) return scalar(span(start, end), 'plain', null);
    if (/^(?:true|True|TRUE)$/u.test(raw)) return scalar(span(start, end), 'plain', true);
    if (/^(?:false|False|FALSE)$/u.test(raw)) return scalar(span(start, end), 'plain', false);
    if (/^[-+]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][-+]?\d+)?$/u.test(raw)) {
      const number = Number(raw);
      if (Number.isFinite(number)) return scalar(span(start, end), 'plain', number);
    }
    return scalar(span(start, end), 'plain', raw);
  }

  private parseInlineValue(start: number, end: number, depth: number): MarkdownFrontMatterValue {
    if (this.workRemaining <= 0) return scalar(span(start, end), 'plain', this.source.slice(start, end));
    if (depth > 256) {
      this.report('YAML value nesting exceeds 256 levels.', span(start, end));
      return scalar(span(start, end), 'plain', this.source.slice(start, end));
    }
    if (this.source[start] === '[') return this.parseFlowSequence(start, end, depth);
    if (this.source[start] === '{') return this.parseFlowMapping(start, end, depth);
    return this.parseScalar(start, end);
  }

  private parseFlowSequence(start: number, end: number, depth: number): MarkdownFrontMatterSequence {
    if (this.source[end - 1] !== ']') {
      this.report('A flow YAML sequence is not closed.', span(start, end));
      return { kind: 'sequence', span: span(start, end), items: [] };
    }
    const items: MarkdownFrontMatterValue[] = [];
    for (const range of this.flowRanges(start + 1, end - 1)) {
      const itemStart = this.trimStart(range.start, range.end);
      const itemEnd = this.trimEnd(itemStart, range.end);
      if (itemStart === itemEnd) {
        if (range.start !== range.end) this.report('A flow YAML sequence item is empty.', span(range.start, range.end));
        continue;
      }
      items.push(this.parseInlineValue(itemStart, itemEnd, depth + 1));
    }
    return { kind: 'sequence', span: span(start, end), items };
  }

  private parseFlowMapping(start: number, end: number, depth: number): MarkdownFrontMatterMapping {
    if (this.source[end - 1] !== '}') {
      this.report('A flow YAML mapping is not closed.', span(start, end));
      return { kind: 'mapping', span: span(start, end), entries: [] };
    }
    const entries: MarkdownFrontMatterMappingEntry[] = [];
    const keys = new Set<string>();
    for (const range of this.flowRanges(start + 1, end - 1)) {
      const entryStart = this.trimStart(range.start, range.end);
      const entryEnd = this.trimEnd(entryStart, range.end);
      if (entryStart === entryEnd) continue;
      const colon = this.flowMappingColon(entryStart, entryEnd);
      if (colon < 0) {
        this.report('A flow YAML mapping entry requires a key followed by a colon.', span(entryStart, entryEnd));
        continue;
      }
      const keyEnd = this.trimEnd(entryStart, colon);
      const valueStart = this.trimStart(colon + 1, entryEnd);
      const key = this.decodeKey(entryStart, keyEnd);
      if (key.length === 0) this.report('A YAML mapping key cannot be empty.', span(entryStart, colon));
      else if (keys.has(key)) this.report('YAML mapping keys must be unique.', span(entryStart, keyEnd));
      else keys.add(key);
      const value = valueStart === entryEnd
        ? scalar(span(valueStart, valueStart), 'plain', null)
        : this.parseInlineValue(valueStart, entryEnd, depth + 1);
      entries.push({
        key,
        keySpan: span(entryStart, keyEnd),
        valueSpan: value.span,
        value
      });
    }
    return { kind: 'mapping', span: span(start, end), entries };
  }

  private flowRanges(start: number, end: number): readonly SourceSpan[] {
    if (start === end) return [];
    const ranges: SourceSpan[] = [];
    let rangeStart = start;
    let squareDepth = 0;
    let mappingDepth = 0;
    let quote: "'" | '"' | undefined;
    for (let offset = start; offset < end; offset += 1) {
      if (!this.consumeWork(offset)) {
        ranges.push(span(rangeStart, end));
        return ranges;
      }
      const character = this.source[offset];
      if (quote === "'" && character === "'" && this.source[offset + 1] === "'") {
        offset += 1;
        continue;
      }
      if (quote === '"' && character === '\\') {
        offset += 1;
        continue;
      }
      if (character === "'" || character === '"') {
        quote = quote === character ? undefined : quote ?? character;
        continue;
      }
      if (quote !== undefined) continue;
      if (character === '[') squareDepth += 1;
      else if (character === ']') squareDepth -= 1;
      else if (character === '{') mappingDepth += 1;
      else if (character === '}') mappingDepth -= 1;
      else if (character === ',' && squareDepth === 0 && mappingDepth === 0) {
        ranges.push(span(rangeStart, offset));
        rangeStart = offset + 1;
      }
      if (squareDepth < 0 || mappingDepth < 0) {
        this.report('A flow YAML collection contains an unmatched closing delimiter.', span(offset, offset + 1));
        squareDepth = Math.max(0, squareDepth);
        mappingDepth = Math.max(0, mappingDepth);
      }
    }
    if (quote !== undefined) this.report('A quoted YAML scalar is not closed.', span(rangeStart, end));
    if (squareDepth !== 0 || mappingDepth !== 0) this.report('A nested flow YAML collection is not closed.', span(rangeStart, end));
    ranges.push(span(rangeStart, end));
    return ranges;
  }

  private flowMappingColon(start: number, end: number): number {
    const ranges = this.flowRanges(start, end);
    if (ranges.length !== 1) return -1;
    let squareDepth = 0;
    let mappingDepth = 0;
    let quote: "'" | '"' | undefined;
    for (let offset = start; offset < end; offset += 1) {
      if (!this.consumeWork(offset)) return -1;
      const character = this.source[offset];
      if (quote === "'" && character === "'" && this.source[offset + 1] === "'") {
        offset += 1;
        continue;
      }
      if (quote === '"' && character === '\\') {
        offset += 1;
        continue;
      }
      if (character === "'" || character === '"') quote = quote === character ? undefined : quote ?? character;
      else if (quote === undefined) {
        if (character === '[') squareDepth += 1;
        else if (character === ']') squareDepth -= 1;
        else if (character === '{') mappingDepth += 1;
        else if (character === '}') mappingDepth -= 1;
        else if (character === ':' && squareDepth === 0 && mappingDepth === 0) return offset;
      }
    }
    return -1;
  }

  private reportUnsupportedConstructs(raw: string, sourceStart: number): void {
    let quote: "'" | '"' | undefined;
    for (let index = 0; index < raw.length; index += 1) {
      const character = raw[index];
      if (quote === "'" && character === "'" && raw[index + 1] === "'") {
        index += 1;
        continue;
      }
      if (quote === '"' && character === '\\') {
        index += 1;
        continue;
      }
      if (character === "'" || character === '"') {
        quote = quote === character ? undefined : quote ?? character;
        continue;
      }
      const boundary = index === 0 || /[\s,[{]/u.test(raw[index - 1] ?? '');
      if (quote !== undefined || !boundary || (character !== '!' && character !== '&' && character !== '*')) continue;
      let tokenEnd = index + 1;
      while (tokenEnd < raw.length && !/[\s,\]{}]/u.test(raw[tokenEnd] ?? '')) tokenEnd += 1;
      const construct = character === '!' ? 'tags' : character === '&' ? 'anchors' : 'aliases';
      this.report(
        `YAML ${construct} are not supported in front matter.`,
        span(sourceStart + index, sourceStart + tokenEnd)
      );
      index = tokenEnd - 1;
    }
  }

  private decodeDoubleQuoted(raw: string, start: number, end: number): string {
    if (!raw.endsWith('"') || raw.length < 2) {
      this.report('A double-quoted YAML scalar is not closed.', span(start, end));
      return raw.slice(1);
    }
    let value = '';
    for (let index = 1; index < raw.length - 1; index += 1) {
      const character = raw[index];
      if (character !== '\\') {
        value += character ?? '';
        continue;
      }
      const escaped = raw[index + 1];
      if (escaped === undefined) break;
      const simple: Readonly<Record<string, string>> = {
        '0': '\0', a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b',
        ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: '\u0085', _: '\u00a0', L: '\u2028', P: '\u2029'
      };
      const decoded = simple[escaped];
      if (decoded !== undefined) {
        value += decoded;
        index += 1;
        continue;
      }
      const width = escaped === 'x' ? 2 : escaped === 'u' ? 4 : escaped === 'U' ? 8 : 0;
      const digits = width === 0 ? '' : raw.slice(index + 2, index + 2 + width);
      if (width > 0 && new RegExp(`^[0-9A-Fa-f]{${String(width)}}$`, 'u').test(digits)) {
        const codePoint = Number.parseInt(digits, 16);
        if (codePoint <= 0x10ffff && (codePoint < 0xd800 || codePoint > 0xdfff)) {
          value += String.fromCodePoint(codePoint);
        } else {
          this.report(
            'A double-quoted YAML escape is not a Unicode scalar value.',
            span(start + index, start + index + 2 + width)
          );
        }
        index += 1 + width;
        continue;
      }
      this.report('A double-quoted YAML scalar contains an invalid escape.', span(start + index, start + index + 2));
      value += escaped;
      index += 1;
    }
    return value;
  }

  private decodeKey(start: number, end: number): string {
    const raw = this.source.slice(start, end);
    if (raw.startsWith("'") || raw.startsWith('"')) {
      const parsed = this.parseScalar(start, end);
      return typeof parsed.value === 'string' ? parsed.value : String(parsed.value ?? '');
    }
    this.reportUnsupportedConstructs(raw, start);
    return raw;
  }

  private blockScalarHeader(start: number, end: number): BlockScalarHeader | null {
    const value = this.source.slice(start, end);
    const match = /^([|>])(?:(?:([+-])([1-9]?))|(?:([1-9])([+-]?)))?$/u.exec(value);
    if (match === null) return null;
    const indentation = match[3] || match[4];
    const chomping = (match[2] || match[5] || '') as BlockScalarHeader['chomping'];
    return {
      style: match[1] === '>' ? 'folded' : 'literal',
      chomping,
      ...(indentation === undefined || indentation === '' ? {} : { explicitIndent: Number(indentation) })
    };
  }

  private mappingColon(start: number, end: number): number {
    let quote: "'" | '"' | undefined;
    for (let offset = start; offset < end; offset += 1) {
      const character = this.source[offset];
      if (quote === "'" && character === "'" && this.source[offset + 1] === "'") {
        offset += 1;
        continue;
      }
      if (quote === '"' && character === '\\') {
        offset += 1;
        continue;
      }
      if (character === "'" || character === '"') {
        quote = quote === character ? undefined : quote ?? character;
        continue;
      }
      if (quote === undefined && character === '#' && (
        offset === start || this.source[offset - 1] === ' ' || this.source[offset - 1] === '\t'
      )) return -1;
      if (quote === undefined && character === ':' && (
        offset + 1 === end || this.source[offset + 1] === ' ' || this.source[offset + 1] === '\t'
      )) return offset;
    }
    return -1;
  }

  private scalarEnd(start: number, end: number): number {
    let quote: "'" | '"' | undefined;
    let result = end;
    for (let offset = start; offset < end; offset += 1) {
      const character = this.source[offset];
      if (quote === "'" && character === "'" && this.source[offset + 1] === "'") {
        offset += 1;
        continue;
      }
      if (quote === '"' && character === '\\') {
        offset += 1;
        continue;
      }
      if (character === "'" || character === '"') quote = quote === character ? undefined : quote ?? character;
      else if (quote === undefined && character === '#' && (offset === start || /[ \t]/u.test(this.source[offset - 1] ?? ''))) {
        result = offset;
        break;
      }
    }
    return this.trimEnd(start, result);
  }

  private trimEnd(start: number, end: number): number {
    let result = end;
    while (result > start && (this.source[result - 1] === ' ' || this.source[result - 1] === '\t')) result -= 1;
    return result;
  }

  private trimStart(start: number, end: number): number {
    let result = start;
    while (result < end && (this.source[result] === ' ' || this.source[result] === '\t')) result += 1;
    return result;
  }

  private isSequenceLine(line: YamlLine, indent: number): boolean {
    return line.indent === indent
      && this.source[line.contentStart] === '-'
      && (line.contentStart + 1 === line.contentEnd || /[ \t]/u.test(this.source[line.contentStart + 1] ?? ''));
  }

  private significant(index: number): number {
    let result = index;
    while (this.lines[result]?.blank === true) result += 1;
    return result;
  }

  private foldLines(lines: readonly string[]): string {
    let value = '';
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? '';
      const next = lines[index + 1];
      value += line;
      if (next !== undefined) value += line.length > 0 && next.length > 0 ? ' ' : '\n';
    }
    return value;
  }

  private report(message: string, sourceSpan: SourceSpan): void {
    this.diagnostics.push({
      code: 'invalid-front-matter',
      severity: 'error',
      message,
      span: sourceSpan
    });
  }

  private consumeWork(offset: number): boolean {
    if (this.workRemaining > 0) {
      this.workRemaining -= 1;
      return true;
    }
    if (!this.workLimitReported) {
      this.workLimitReported = true;
      this.report('YAML parsing work exceeds the bounded limit.', span(offset, Math.min(this.source.length, offset + 1)));
    }
    return false;
  }
}
