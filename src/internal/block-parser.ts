import type {
  MarkdownBulletMarker,
  MarkdownCalloutKind,
  MarkdownDiagnostic,
  MarkdownHtmlBlockType,
  MarkdownListDelimiter,
  MarkdownTableAlignment,
  SourceSpan
} from '../model.js';
import type { MarkdownDialect, MarkdownSyntaxExtension } from '../options.js';
import { decodeMarkdownString } from './decode.js';
import type { InlineDefinitionTarget, InlineFootnoteTarget } from './inline-parser.js';
import {
  InlineSource,
  consumeIndent,
  isBlankView,
  sourceColumnAt,
  type LineView,
  type SourceLine
} from './source-reader.js';

interface RawBlockBase<Kind extends string> {
  readonly kind: Kind;
  readonly span: SourceSpan;
}

export interface RawParagraph extends RawBlockBase<'paragraph'> {
  readonly input: InlineSource;
  readonly contentSpan: SourceSpan;
}

export interface RawHeading extends RawBlockBase<'heading'> {
  readonly depth: 1 | 2 | 3 | 4 | 5 | 6;
  readonly style: 'atx' | 'setext';
  readonly markerSpans: readonly SourceSpan[];
  readonly contentSpan: SourceSpan;
  readonly input: InlineSource;
}

export interface RawBlockQuote extends RawBlockBase<'blockQuote'> {
  readonly markerSpans: readonly SourceSpan[];
  readonly children: readonly RawBlock[];
}

export interface RawCallout extends RawBlockBase<'callout'> {
  readonly calloutKind: MarkdownCalloutKind;
  readonly markerSpans: readonly SourceSpan[];
  readonly labelSpan: SourceSpan;
  readonly children: readonly RawBlock[];
}

export interface RawFrontMatter extends RawBlockBase<'frontMatter'> {
  readonly raw: string;
  readonly openingMarkerSpan: SourceSpan;
  readonly closingMarkerSpan: SourceSpan | null;
  readonly entries: readonly {
    readonly key: string;
    readonly value: string;
    readonly keySpan: SourceSpan;
    readonly valueSpan: SourceSpan;
  }[];
}

export interface RawListItem extends RawBlockBase<'listItem'> {
  readonly markerSpan: SourceSpan;
  readonly contentIndent: number;
  readonly spread: boolean;
  readonly task: { readonly checked: boolean; readonly span: SourceSpan } | null;
  readonly children: readonly RawBlock[];
}

export interface RawList extends RawBlockBase<'list'> {
  readonly ordered: boolean;
  readonly start: number | null;
  readonly delimiter: MarkdownListDelimiter;
  readonly bullet: MarkdownBulletMarker;
  readonly tight: boolean;
  readonly items: readonly RawListItem[];
}

export interface RawCodeBlock extends RawBlockBase<'codeBlock'> {
  readonly style: 'fenced' | 'indented';
  readonly value: string;
  readonly contentSpan: SourceSpan;
  readonly info: string | null;
  readonly infoSpan: SourceSpan | null;
  readonly language: string | null;
  readonly fence: {
    readonly character: '`' | '~';
    readonly length: number;
    readonly indentation: number;
    readonly openingSpan: SourceSpan;
    readonly closingSpan: SourceSpan | null;
  } | null;
}

export interface RawMathBlock extends RawBlockBase<'mathBlock'> {
  readonly value: string;
  readonly contentSpan: SourceSpan;
  readonly openingMarkerSpan: SourceSpan;
  readonly closingMarkerSpan: SourceSpan | null;
}

export interface RawThematicBreak extends RawBlockBase<'thematicBreak'> {
  readonly marker: '*' | '-' | '_';
  readonly markerSpan: SourceSpan;
}

export interface RawHtmlBlock extends RawBlockBase<'htmlBlock'> {
  readonly value: string;
  readonly htmlBlockType: MarkdownHtmlBlockType;
}

export interface RawLinkDefinition extends RawBlockBase<'linkDefinition'>, InlineDefinitionTarget {
  readonly kind: 'linkDefinition';
  readonly labelSpan: SourceSpan;
  readonly destinationSpan: SourceSpan;
  readonly titleSpan: SourceSpan | null;
  active: boolean;
}

export interface RawFootnoteDefinition extends RawBlockBase<'footnoteDefinition'>, InlineFootnoteTarget {
  readonly kind: 'footnoteDefinition';
  readonly labelSpan: SourceSpan;
  active: boolean;
  readonly children: readonly RawBlock[];
}

export interface RawTableCell {
  readonly span: SourceSpan;
  readonly contentSpan: SourceSpan;
  readonly input: InlineSource;
}

export interface RawTableRow {
  readonly span: SourceSpan;
  readonly cells: readonly RawTableCell[];
}

export interface RawTable extends RawBlockBase<'table'> {
  readonly align: readonly MarkdownTableAlignment[];
  readonly delimiterSpan: SourceSpan;
  readonly header: RawTableRow;
  readonly rows: readonly RawTableRow[];
}

export type RawBlock =
  | RawParagraph
  | RawHeading
  | RawBlockQuote
  | RawCallout
  | RawFrontMatter
  | RawList
  | RawCodeBlock
  | RawMathBlock
  | RawThematicBreak
  | RawHtmlBlock
  | RawLinkDefinition
  | RawFootnoteDefinition
  | RawTable;

export interface BlockParseResult {
  readonly blocks: readonly RawBlock[];
  readonly definitions: ReadonlyMap<string, InlineDefinitionTarget>;
  readonly footnotes: ReadonlyMap<string, InlineFootnoteTarget>;
  readonly diagnostics: readonly MarkdownDiagnostic[];
}

export interface BlockParseSeed {
  readonly definitions?: ReadonlyMap<string, InlineDefinitionTarget>;
  readonly footnotes?: ReadonlyMap<string, InlineFootnoteTarget>;
}

interface ListMarker {
  readonly ordered: boolean;
  readonly start: number | null;
  readonly delimiter: MarkdownListDelimiter;
  readonly bullet: MarkdownBulletMarker;
  readonly markerStart: number;
  readonly markerEnd: number;
  readonly indentation: number;
  readonly contentStart: number;
  readonly contentIndent: number;
  readonly contentVirtualSpaces: number;
}

interface FenceOpening {
  readonly marker: '`' | '~';
  readonly markerStart: number;
  readonly markerEnd: number;
  readonly length: number;
  readonly indentation: number;
  readonly contentIndentation: number;
  readonly infoStart: number;
  readonly infoEnd: number;
}

interface DefinitionMatch {
  readonly endLine: number;
  readonly span: SourceSpan;
  readonly label: string;
  readonly normalizedLabel: string;
  readonly labelSpan: SourceSpan;
  readonly destination: string;
  readonly destinationSpan: SourceSpan;
  readonly title: string | null;
  readonly titleSpan: SourceSpan | null;
}

const blockTagNames = new Set([
  'address', 'article', 'aside', 'base', 'basefont', 'blockquote', 'body', 'caption',
  'center', 'col', 'colgroup', 'dd', 'details', 'dialog', 'dir', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'frame', 'frameset', 'h1',
  'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hr', 'html', 'iframe', 'legend',
  'li', 'link', 'main', 'menu', 'menuitem', 'nav', 'noframes', 'ol', 'optgroup',
  'option', 'p', 'param', 'search', 'section', 'summary', 'table', 'tbody', 'td',
  'tfoot', 'th', 'thead', 'title', 'tr', 'track', 'ul'
]);

function span(start: number, end: number): SourceSpan {
  return { start, end };
}

function normalizeLabel(value: string): string {
  return value
    .replace(/[\t\n\r ]+/gu, ' ')
    .replace(/^ | $/gu, '')
    .toLowerCase()
    .toUpperCase()
    .toLowerCase();
}

function lineWithEnd(line: SourceLine, end: number): SourceLine {
  return { start: line.start, contentEnd: end, end: line.end };
}

function replaceViewBounds(view: LineView, start: number, end = view.line.contentEnd): LineView {
  return { line: lineWithEnd(view.line, end), contentStart: start, virtualColumn: 0, virtualSpaces: 0 };
}

class BlockParser {
  private readonly definitions: Map<string, InlineDefinitionTarget>;
  private readonly footnotes: Map<string, InlineFootnoteTarget>;
  private readonly diagnostics: MarkdownDiagnostic[] = [];

  constructor(
    private readonly source: string,
    private readonly dialect: MarkdownDialect,
    private readonly extensions: ReadonlySet<MarkdownSyntaxExtension>,
    seed: BlockParseSeed
  ) {
    this.definitions = new Map(seed.definitions);
    this.footnotes = new Map(seed.footnotes);
  }

  parse(views: readonly LineView[]): BlockParseResult {
    const blocks = this.parseBlocks(views);
    return {
      blocks,
      definitions: this.definitions,
      footnotes: this.footnotes,
      diagnostics: this.diagnostics
    };
  }

  private parseBlocks(views: readonly LineView[]): readonly RawBlock[] {
    const blocks: RawBlock[] = [];
    for (let index = 0; index < views.length;) {
      const view = views[index];
      if (view === undefined) break;
      if (isBlankView(this.source, view)) {
        index += 1;
        continue;
      }

      if (index === 0 && this.extensions.has('frontMatter')) {
        const frontMatter = this.frontMatter(views);
        if (frontMatter !== null) {
          blocks.push(frontMatter.block);
          index = frontMatter.endLine;
          continue;
        }
      }

      const quote = this.blockQuote(views, index);
      if (quote !== null) {
        blocks.push(quote.block);
        index = quote.endLine;
        continue;
      }

      const fence = this.fencedCode(views, index);
      if (fence !== null) {
        blocks.push(fence.block);
        index = fence.endLine;
        continue;
      }

      if (this.extensions.has('math')) {
        const math = this.mathBlock(views, index);
        if (math !== null) {
          blocks.push(math.block);
          index = math.endLine;
          continue;
        }
      }

      const heading = this.atxHeading(view);
      if (heading !== null) {
        blocks.push(heading);
        index += 1;
        continue;
      }

      const thematic = this.thematicBreak(view);
      if (thematic !== null) {
        blocks.push(thematic);
        index += 1;
        continue;
      }

      if (this.dialect === 'gfm') {
        const footnote = this.footnoteDefinition(views, index);
        if (footnote !== null) {
          blocks.push(footnote.block);
          index = footnote.endLine;
          continue;
        }
      }

      const definition = this.linkDefinition(views, index);
      if (definition !== null) {
        const block: RawLinkDefinition = {
          kind: 'linkDefinition',
          ...definition,
          active: false
        };
        this.registerDefinition(block);
        blocks.push(block);
        index = definition.endLine;
        continue;
      }

      const list = this.list(views, index);
      if (list !== null) {
        blocks.push(list.block);
        index = list.endLine;
        continue;
      }

      const html = this.htmlBlock(views, index, true);
      if (html !== null) {
        blocks.push(html.block);
        index = html.endLine;
        continue;
      }

      const indented = this.indentedCode(views, index);
      if (indented !== null) {
        blocks.push(indented.block);
        index = indented.endLine;
        continue;
      }

      const paragraph = this.paragraph(views, index);
      blocks.push(paragraph.block);
      index = paragraph.endLine;
    }
    return blocks;
  }

  private indentation(view: LineView, maximum = Number.POSITIVE_INFINITY): { readonly offset: number; readonly columns: number } {
    if (maximum === Number.POSITIVE_INFINITY) {
      let offset = view.contentStart;
      let columns = view.virtualSpaces ?? 0;
      let sourceColumn = view.virtualColumn;
      while (offset < view.line.contentEnd) {
        const character = this.source[offset];
        if (character === ' ') {
          columns += 1;
          sourceColumn += 1;
        } else if (character === '\t') {
          const width = 4 - sourceColumn % 4;
          columns += width;
          sourceColumn += width;
        }
        else break;
        offset += 1;
      }
      return { offset, columns };
    }
    if ((view.virtualSpaces ?? 0) > maximum) {
      return { offset: view.line.contentEnd, columns: view.virtualSpaces ?? 0 };
    }
    return consumeIndent(this.source, view, maximum);
  }

  private blockQuote(views: readonly LineView[], start: number): { readonly block: RawBlockQuote | RawCallout; readonly endLine: number } | null {
    const first = views[start];
    if (first === undefined) return null;
    const firstIndent = this.indentation(first, 3);
    if (this.source[firstIndent.offset] !== '>') return null;
    const children: LineView[] = [];
    const markers: SourceSpan[] = [];
    let index = start;
    let lastContentEnd = first.line.contentEnd;
    let paragraphCanContinue = false;
    while (index < views.length) {
      const view = views[index];
      if (view === undefined) break;
      const indentation = this.indentation(view, 3);
      if (this.source[indentation.offset] === '>') {
        const markerStart = indentation.offset;
        let contentStart = markerStart + 1;
        let virtualSpaces = 0;
        if (this.source[contentStart] === ' ') contentStart += 1;
        else if (this.source[contentStart] === '\t') {
          const markerColumn = sourceColumnAt(this.source, view.line.start, markerStart);
          const width = 4 - (markerColumn + 1) % 4;
          virtualSpaces = Math.max(0, width - 1);
          contentStart += 1;
        }
        markers.push(span(markerStart, markerStart + 1));
        const child = {
          line: view.line,
          contentStart,
          virtualColumn: sourceColumnAt(this.source, view.line.start, contentStart),
          virtualSpaces
        };
        children.push(child);
        lastContentEnd = view.line.contentEnd;
        paragraphCanContinue = this.canStartLazyParagraph(child);
        index += 1;
        continue;
      }
      if (isBlankView(this.source, view)) break;
      if (!paragraphCanContinue || this.startsInterruptingBlock(view, true)) break;
      children.push({ ...view, lazy: true });
      lastContentEnd = view.line.contentEnd;
      index += 1;
    }
    const firstChild = children[0];
    const callout = firstChild === undefined || !this.extensions.has('callouts')
      ? null
      : /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*$/u.exec(
          this.source.slice(firstChild.contentStart, firstChild.line.contentEnd)
        );
    const block = callout === null
      ? {
        kind: 'blockQuote',
        span: span(firstIndent.offset, lastContentEnd),
        markerSpans: markers,
        children: this.parseBlocks(children)
      } as RawBlockQuote
      : {
        kind: 'callout',
        span: span(firstIndent.offset, lastContentEnd),
        calloutKind: (callout[1] ?? '').toLowerCase() as MarkdownCalloutKind,
        markerSpans: markers,
        labelSpan: span(
          (firstChild as LineView).contentStart,
          (firstChild as LineView).line.contentEnd
        ),
        children: this.parseBlocks(children.slice(1))
      } as RawCallout;
    return {
      block,
      endLine: index
    };
  }

  private frontMatter(views: readonly LineView[]): { readonly block: RawFrontMatter; readonly endLine: number } | null {
    const opening = views[0];
    if (opening === undefined
      || opening.line.start !== 0
      || opening.contentStart !== 0
      || this.source.slice(0, opening.line.contentEnd) !== '---') return null;
    let closingIndex = -1;
    for (let index = 1; index < views.length; index += 1) {
      const view = views[index];
      if (view !== undefined
        && view.contentStart === view.line.start
        && this.source.slice(view.contentStart, view.line.contentEnd) === '---') {
        closingIndex = index;
        break;
      }
    }
    const contentViews = views.slice(1, closingIndex < 0 ? views.length : closingIndex);
    const entries: RawFrontMatter['entries'][number][] = [];
    for (const view of contentViews) {
      const line = this.source.slice(view.contentStart, view.line.contentEnd);
      if (/^[ \t]*(?:#.*)?$/u.test(line)) continue;
      const match = /^([A-Za-z_][A-Za-z0-9_.-]*)[ \t]*:[ \t]*(.*?)[ \t]*$/u.exec(line);
      if (match === null || match[1] === undefined || match[2] === undefined) {
        this.diagnostics.push({
          code: 'invalid-front-matter',
          severity: 'error',
          message: 'Front matter entries must use a plain key followed by a colon and a value.',
          span: span(view.contentStart, view.line.contentEnd)
        });
        continue;
      }
      const keyStart = view.contentStart + (match.index ?? 0);
      const colon = line.indexOf(':', match[1].length);
      let valueStart = view.contentStart + colon + 1;
      while (valueStart < view.line.contentEnd && /[ \t]/u.test(this.source[valueStart] ?? '')) valueStart += 1;
      let valueEnd = view.line.contentEnd;
      while (valueEnd > valueStart && /[ \t]/u.test(this.source[valueEnd - 1] ?? '')) valueEnd -= 1;
      if (this.source[valueStart] === '!') {
        this.diagnostics.push({
          code: 'invalid-front-matter',
          severity: 'error',
          message: 'YAML tags are not supported in front matter.',
          span: span(valueStart, valueEnd)
        });
      }
      entries.push({
        key: match[1],
        value: this.source.slice(valueStart, valueEnd),
        keySpan: span(keyStart, keyStart + match[1].length),
        valueSpan: span(valueStart, valueEnd)
      });
    }
    const closing = closingIndex < 0 ? null : views[closingIndex];
    if (closing === null || closing === undefined) {
      this.diagnostics.push({
        code: 'unclosed-front-matter',
        severity: 'error',
        message: 'Front matter must end with a closing --- delimiter.',
        span: span(0, opening.line.contentEnd)
      });
    }
    const contentStart = opening.line.end;
    const contentEnd = closing?.line.start ?? this.source.length;
    return {
      block: {
        kind: 'frontMatter',
        span: span(0, closing?.line.contentEnd ?? this.source.length),
        raw: this.source.slice(contentStart, contentEnd),
        openingMarkerSpan: span(0, opening.line.contentEnd),
        closingMarkerSpan: closing === undefined || closing === null
          ? null
          : span(closing.contentStart, closing.line.contentEnd),
        entries
      },
      endLine: closingIndex < 0 ? views.length : closingIndex + 1
    };
  }

  private mathBlock(views: readonly LineView[], start: number): { readonly block: RawMathBlock; readonly endLine: number } | null {
    const opening = views[start];
    if (opening === undefined) return null;
    const indentation = this.indentation(opening, 3);
    if (this.source.slice(indentation.offset, opening.line.contentEnd) !== '$$') return null;
    let closingIndex = -1;
    for (let index = start + 1; index < views.length; index += 1) {
      const view = views[index];
      if (view === undefined) break;
      const closeIndentation = this.indentation(view, 3);
      if (this.source.slice(closeIndentation.offset, view.line.contentEnd) === '$$') {
        closingIndex = index;
        break;
      }
    }
    const closing = closingIndex < 0 ? undefined : views[closingIndex];
    if (closing === undefined) {
      this.diagnostics.push({
        code: 'unclosed-math',
        severity: 'error',
        message: 'Block math must end with a closing $$ delimiter.',
        span: span(indentation.offset, opening.line.contentEnd)
      });
    }
    const contentStart = opening.line.end;
    const contentEnd = closing?.line.start ?? this.source.length;
    return {
      block: {
        kind: 'mathBlock',
        span: span(indentation.offset, closing?.line.contentEnd ?? this.source.length),
        value: this.source.slice(contentStart, contentEnd),
        contentSpan: span(contentStart, contentEnd),
        openingMarkerSpan: span(indentation.offset, opening.line.contentEnd),
        closingMarkerSpan: closing === undefined
          ? null
          : span(this.indentation(closing, 3).offset, closing.line.contentEnd)
      },
      endLine: closingIndex < 0 ? views.length : closingIndex + 1
    };
  }

  private fenceOpening(view: LineView): FenceOpening | null {
    const indentation = this.indentation(view, 3);
    const marker = this.source[indentation.offset];
    if (marker !== '`' && marker !== '~') return null;
    const length = this.run(indentation.offset, view.line.contentEnd, marker);
    if (length < 3) return null;
    const markerEnd = indentation.offset + length;
    if (marker === '`' && this.source.slice(markerEnd, view.line.contentEnd).includes('`')) return null;
    let infoStart = markerEnd;
    while (infoStart < view.line.contentEnd && (this.source[infoStart] === ' ' || this.source[infoStart] === '\t')) infoStart += 1;
    let infoEnd = view.line.contentEnd;
    while (infoEnd > infoStart && (this.source[infoEnd - 1] === ' ' || this.source[infoEnd - 1] === '\t')) infoEnd -= 1;
    return {
      marker,
      markerStart: indentation.offset,
      markerEnd,
      length,
      indentation: sourceColumnAt(this.source, view.line.start, indentation.offset),
      contentIndentation: indentation.columns,
      infoStart,
      infoEnd
    };
  }

  private fencedCode(views: readonly LineView[], start: number): { readonly block: RawCodeBlock; readonly endLine: number } | null {
    const openingView = views[start];
    if (openingView === undefined) return null;
    const opening = this.fenceOpening(openingView);
    if (opening === null) return null;
    const content: Array<{ readonly view: LineView; readonly start: number }> = [];
    let closingSpan: SourceSpan | null = null;
    let index = start + 1;
    let blockEnd = opening.markerEnd;
    while (index < views.length) {
      const view = views[index];
      if (view === undefined) break;
      const indentation = this.indentation(view, 3);
      if (this.source[indentation.offset] === opening.marker) {
        const length = this.run(indentation.offset, view.line.contentEnd, opening.marker);
        const rest = this.source.slice(indentation.offset + length, view.line.contentEnd);
        if (length >= opening.length && /^[ \t]*$/u.test(rest)) {
          closingSpan = span(indentation.offset, indentation.offset + length);
          blockEnd = indentation.offset + length;
          index += 1;
          break;
        }
      }
      const stripped = consumeIndent(this.source, view, opening.contentIndentation);
      content.push({ view, start: stripped.offset });
      blockEnd = view.line.contentEnd;
      index += 1;
    }
    const values = content.map(({ view, start: contentStart }) => (
      ' '.repeat(view.virtualSpaces ?? 0) + this.source.slice(contentStart, view.line.contentEnd)
    ));
    const first = content[0];
    const last = content.at(-1);
    const contentSpan = first === undefined || last === undefined
      ? span(openingView.line.contentEnd, openingView.line.contentEnd)
      : span(first.start, last.view.line.contentEnd);
    const rawInfo = this.source.slice(opening.infoStart, opening.infoEnd);
    const info = rawInfo.length === 0 ? null : decodeMarkdownString(rawInfo);
    const language = info?.split(/[ \t\n]+/u)[0] || null;
    return {
      block: {
        kind: 'codeBlock',
        span: span(opening.markerStart, blockEnd),
        style: 'fenced',
        value: values.join('\n'),
        contentSpan,
        info,
        infoSpan: info === null ? null : span(opening.infoStart, opening.infoEnd),
        language,
        fence: {
          character: opening.marker,
          length: opening.length,
          indentation: opening.indentation,
          openingSpan: span(opening.markerStart, opening.markerEnd),
          closingSpan
        }
      },
      endLine: index
    };
  }

  private atxHeading(view: LineView): RawHeading | null {
    const indentation = this.indentation(view, 3);
    if (this.source[indentation.offset] !== '#') return null;
    const length = this.run(indentation.offset, view.line.contentEnd, '#');
    if (length > 6) return null;
    const after = indentation.offset + length;
    if (after < view.line.contentEnd && this.source[after] !== ' ' && this.source[after] !== '\t') return null;
    let contentStart = after;
    while (contentStart < view.line.contentEnd && (this.source[contentStart] === ' ' || this.source[contentStart] === '\t')) contentStart += 1;
    let contentEnd = view.line.contentEnd;
    while (contentEnd > contentStart && (this.source[contentEnd - 1] === ' ' || this.source[contentEnd - 1] === '\t')) contentEnd -= 1;
    let closingStart = contentEnd;
    while (closingStart > contentStart && this.source[closingStart - 1] === '#') closingStart -= 1;
    const hasClosing = closingStart < contentEnd
      && (closingStart === contentStart || this.source[closingStart - 1] === ' ' || this.source[closingStart - 1] === '\t');
    if (hasClosing) {
      contentEnd = closingStart;
      while (contentEnd > contentStart && (this.source[contentEnd - 1] === ' ' || this.source[contentEnd - 1] === '\t')) contentEnd -= 1;
    }
    const markers = [span(indentation.offset, after)];
    if (hasClosing) markers.push(span(closingStart, view.line.contentEnd - this.trailingWhitespace(view)));
    const contentView = replaceViewBounds(view, contentStart, contentEnd);
    return {
      kind: 'heading',
      span: span(indentation.offset, view.line.contentEnd),
      depth: length as 1 | 2 | 3 | 4 | 5 | 6,
      style: 'atx',
      markerSpans: markers,
      contentSpan: span(contentStart, contentEnd),
      input: new InlineSource(this.source, [contentView])
    };
  }

  private thematicBreak(view: LineView): RawThematicBreak | null {
    const indentation = this.indentation(view, 3);
    const marker = this.source[indentation.offset];
    if (marker !== '*' && marker !== '-' && marker !== '_') return null;
    let count = 0;
    for (let offset = indentation.offset; offset < view.line.contentEnd; offset += 1) {
      const character = this.source[offset];
      if (character === marker) count += 1;
      else if (character !== ' ' && character !== '\t') return null;
    }
    if (count < 3) return null;
    return {
      kind: 'thematicBreak',
      span: span(indentation.offset, view.line.contentEnd),
      marker,
      markerSpan: span(indentation.offset, view.line.contentEnd)
    };
  }

  private listMarker(view: LineView, interruptParagraph = false): ListMarker | null {
    const indentation = this.indentation(view, 3);
    const markerStart = indentation.offset;
    const first = this.source[markerStart];
    let ordered = false;
    let listStart: number | null = null;
    let delimiter: MarkdownListDelimiter = null;
    let bullet: MarkdownBulletMarker = null;
    let markerEnd = markerStart;
    if (first === '-' || first === '+' || first === '*') {
      bullet = first;
      markerEnd += 1;
    } else {
      let digitsEnd = markerStart;
      while (digitsEnd < view.line.contentEnd && /[0-9]/u.test(this.source[digitsEnd] ?? '') && digitsEnd - markerStart < 9) digitsEnd += 1;
      if (digitsEnd === markerStart || digitsEnd - markerStart > 9) return null;
      const suffix = this.source[digitsEnd];
      if (suffix !== '.' && suffix !== ')') return null;
      listStart = Number.parseInt(this.source.slice(markerStart, digitsEnd), 10);
      if (interruptParagraph && listStart !== 1) return null;
      ordered = true;
      delimiter = suffix;
      markerEnd = digitsEnd + 1;
    }
    const after = this.source[markerEnd];
    if (markerEnd < view.line.contentEnd && after !== ' ' && after !== '\t') return null;
    if (!ordered && this.thematicBreak(view) !== null) return null;
    let contentStart = markerEnd;
    let sourceColumn = sourceColumnAt(this.source, view.line.start, markerEnd);
    let whitespaceColumns = 0;
    while (contentStart < view.line.contentEnd && (this.source[contentStart] === ' ' || this.source[contentStart] === '\t')) {
      const next = this.source[contentStart] === '\t' ? 4 - sourceColumn % 4 : 1;
      if (whitespaceColumns + next > 4) break;
      whitespaceColumns += next;
      sourceColumn += next;
      contentStart += 1;
    }
    const whitespaceContinues = this.source[contentStart] === ' ' || this.source[contentStart] === '\t';
    let contentVirtualSpaces = 0;
    if (whitespaceColumns === 0 || whitespaceColumns > 4 || whitespaceContinues || contentStart === view.line.contentEnd && whitespaceColumns > 1) {
      contentStart = markerEnd;
      if (this.source[contentStart] === ' ') contentStart += 1;
      else if (this.source[contentStart] === '\t') {
        const width = 4 - sourceColumnAt(this.source, view.line.start, contentStart) % 4;
        contentVirtualSpaces = Math.max(0, width - 1);
        contentStart += 1;
      }
      whitespaceColumns = 1;
    }
    const markerWidth = markerEnd - markerStart;
    return {
      ordered,
      start: listStart,
      delimiter,
      bullet,
      markerStart,
      markerEnd,
      indentation: indentation.columns,
      contentStart,
      contentIndent: markerWidth + whitespaceColumns,
      contentVirtualSpaces
    };
  }

  private sameList(left: ListMarker, right: ListMarker): boolean {
    return left.ordered === right.ordered
      && left.delimiter === right.delimiter
      && left.bullet === right.bullet;
  }

  private stripRequiredIndent(view: LineView, columns: number): LineView | null {
    let offset = view.contentStart;
    let consumed = Math.min(view.virtualSpaces ?? 0, columns);
    let virtualSpaces = Math.max(0, (view.virtualSpaces ?? 0) - columns);
    let sourceColumn = view.virtualColumn;
    while (offset < view.line.contentEnd && consumed < columns) {
      const character = this.source[offset];
      let width: number;
      if (character === ' ') width = 1;
      else if (character === '\t') width = 4 - sourceColumn % 4;
      else break;
      const needed = columns - consumed;
      if (width > needed) virtualSpaces += width - needed;
      consumed += width;
      sourceColumn += width;
      offset += 1;
    }
    return consumed < columns ? null : {
      line: view.line,
      contentStart: offset,
      virtualColumn: sourceColumn,
      virtualSpaces
    };
  }

  private list(views: readonly LineView[], start: number): { readonly block: RawList; readonly endLine: number } | null {
    const firstView = views[start];
    if (firstView === undefined) return null;
    const firstMarker = this.listMarker(firstView);
    if (firstMarker === null) return null;
    const items: RawListItem[] = [];
    let index = start;
    let listSpread = false;
    let listEnd = firstView.line.contentEnd;

    while (index < views.length) {
      const itemView = views[index];
      if (itemView === undefined) break;
      const marker = this.listMarker(itemView);
      if (marker === null || !this.sameList(firstMarker, marker)) break;
      const itemLines: LineView[] = [{
        line: itemView.line,
        contentStart: marker.contentStart,
        virtualColumn: sourceColumnAt(this.source, itemView.line.start, marker.contentStart),
        virtualSpaces: marker.contentVirtualSpaces
      }];
      let itemEnd = itemView.line.contentEnd;
      let itemSpread = false;
      const initiallyBlank = isBlankView(this.source, itemLines[0] ?? itemView);
      let sawBlank = false;
      let cursor = index + 1;
      while (cursor < views.length) {
        const continuation = views[cursor];
        if (continuation === undefined) break;
        if (isBlankView(this.source, continuation)) {
          if (initiallyBlank) break;
          itemLines.push({ line: continuation.line, contentStart: continuation.line.contentEnd, virtualColumn: 0 });
          sawBlank = true;
          cursor += 1;
          continue;
        }
        const stripped = this.stripRequiredIndent(continuation, marker.indentation + marker.contentIndent);
        if (stripped !== null) {
          itemLines.push(stripped);
          itemEnd = continuation.line.contentEnd;
          sawBlank = false;
          cursor += 1;
          continue;
        }
        const sibling = this.listMarker(continuation);
        if (sibling !== null) break;
        if (sawBlank || this.startsInterruptingBlock(continuation, true)) break;
        itemLines.push(continuation);
        itemEnd = continuation.line.contentEnd;
        cursor += 1;
      }
      while (itemLines.length > 1 && isBlankView(this.source, itemLines.at(-1) ?? itemView)) itemLines.pop();
      let task: RawListItem['task'] = null;
      if (this.dialect === 'gfm') {
        const firstContent = itemLines[0];
        if (firstContent !== undefined) {
          const taskMatch = /^\[([ xX])\](?=[ \t]|$)/u.exec(this.source.slice(firstContent.contentStart, firstContent.line.contentEnd));
          if (taskMatch !== null) {
            const taskStart = firstContent.contentStart;
            task = { checked: taskMatch[1]?.toLowerCase() === 'x', span: span(taskStart, taskStart + 3) };
            let contentStart = taskStart + 3;
            if (this.source[contentStart] === ' ' || this.source[contentStart] === '\t') contentStart += 1;
            itemLines[0] = { line: firstContent.line, contentStart, virtualColumn: 0 };
          }
        }
      }
      const children = this.parseBlocks(itemLines);
      for (let childIndex = 1; childIndex < children.length; childIndex += 1) {
        const previous = children[childIndex - 1];
        const child = children[childIndex];
        if (previous === undefined || child === undefined) continue;
        if (itemLines.some((line) => isBlankView(this.source, line)
          && line.line.start >= previous.span.end
          && line.line.contentEnd <= child.span.start)) {
          itemSpread = true;
          break;
        }
      }
      const followingMarker = cursor < views.length ? this.listMarker(views[cursor] ?? itemView) : null;
      listSpread ||= itemSpread || sawBlank && followingMarker !== null && this.sameList(firstMarker, followingMarker);
      items.push({
        kind: 'listItem',
        span: span(marker.markerStart, itemEnd),
        markerSpan: span(marker.markerStart, marker.markerEnd),
        contentIndent: marker.contentIndent,
        spread: itemSpread,
        task,
        children
      });
      listEnd = itemEnd;
      index = cursor;
      if (index < views.length && isBlankView(this.source, views[index] ?? itemView)) {
        let next = index;
        while (next < views.length && isBlankView(this.source, views[next] ?? itemView)) next += 1;
        const nextView = views[next];
        const nextMarker = nextView === undefined ? null : this.listMarker(nextView);
        if (nextMarker !== null && this.sameList(firstMarker, nextMarker)) {
          listSpread = true;
          index = next;
        }
      }
    }
    if (items.length === 0) return null;
    return {
      block: {
        kind: 'list',
        span: span(firstMarker.markerStart, listEnd),
        ordered: firstMarker.ordered,
        start: firstMarker.ordered ? firstMarker.start : null,
        delimiter: firstMarker.delimiter,
        bullet: firstMarker.bullet,
        tight: !listSpread,
        items
      },
      endLine: index
    };
  }

  private indentedCode(views: readonly LineView[], start: number): { readonly block: RawCodeBlock; readonly endLine: number } | null {
    const first = views[start];
    if (first === undefined || isBlankView(this.source, first)) return null;
    const firstContent = this.stripRequiredIndent(first, 4);
    if (firstContent === null) return null;
    const lines: LineView[] = [firstContent];
    let index = start + 1;
    while (index < views.length) {
      const view = views[index];
      if (view === undefined) break;
      if (isBlankView(this.source, view)) {
        lines.push(this.stripRequiredIndent(view, 4) ?? {
          line: view.line,
          contentStart: view.line.contentEnd,
          virtualColumn: sourceColumnAt(this.source, view.line.start, view.line.contentEnd),
          virtualSpaces: 0
        });
        index += 1;
        continue;
      }
      const stripped = this.stripRequiredIndent(view, 4);
      if (stripped === null) break;
      lines.push(stripped);
      index += 1;
    }
    while (lines.length > 0 && isBlankView(this.source, lines.at(-1) ?? first)) lines.pop();
    const last = lines.at(-1) ?? firstContent;
    return {
      block: {
        kind: 'codeBlock',
        span: span(first.contentStart, last.line.contentEnd),
        style: 'indented',
        value: lines.map((view) => (
          ' '.repeat(view.virtualSpaces ?? 0) + this.source.slice(view.contentStart, view.line.contentEnd)
        )).join('\n'),
        contentSpan: span(firstContent.contentStart, last.line.contentEnd),
        info: null,
        infoSpan: null,
        language: null,
        fence: null
      },
      endLine: index
    };
  }

  private htmlStart(view: LineView, mayBeTypeSeven: boolean): { readonly type: MarkdownHtmlBlockType; readonly close: RegExp | null } | null {
    const indentation = this.indentation(view, 3);
    const value = this.source.slice(indentation.offset, view.line.contentEnd);
    const rawTag = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?:[ \t\n/>]|$)/u.exec(value)?.[1]?.toLowerCase();
    if (/^<(?:script|pre|style|textarea)(?:[ \t>]|$)/iu.test(value)) {
      const tag = /^<([A-Za-z]+)/u.exec(value)?.[1] ?? '';
      return { type: 1, close: new RegExp(`</${tag}>`, 'iu') };
    }
    if (value.startsWith('<!--')) return { type: 2, close: /-->/u };
    if (value.startsWith('<?')) return { type: 3, close: /\?>/u };
    if (/^<![A-Z]/u.test(value)) return { type: 4, close: />/u };
    if (value.startsWith('<![CDATA[')) return { type: 5, close: /\]\]>/u };
    if (rawTag !== undefined && blockTagNames.has(rawTag)) return { type: 6, close: null };
    const completeOpenTag = /^<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>\s*$/u.test(value);
    const completeClosingTag = /^<\/[A-Za-z][A-Za-z0-9-]*\s*>\s*$/u.test(value);
    if (mayBeTypeSeven && (completeOpenTag || completeClosingTag)) {
      return { type: 7, close: null };
    }
    return null;
  }

  private htmlBlock(views: readonly LineView[], start: number, mayBeTypeSeven: boolean): { readonly block: RawHtmlBlock; readonly endLine: number } | null {
    const first = views[start];
    if (first === undefined) return null;
    const html = this.htmlStart(first, mayBeTypeSeven);
    if (html === null) return null;
    const lines: string[] = [];
    let index = start;
    let lastEnd = first.line.contentEnd;
    while (index < views.length) {
      const view = views[index];
      if (view === undefined) break;
      if (index > start && html.close === null && isBlankView(this.source, view)) break;
      const contentStart = view.contentStart;
      const value = this.source.slice(contentStart, view.line.contentEnd);
      lines.push(value);
      lastEnd = view.line.contentEnd;
      index += 1;
      if (html.close !== null && html.close.test(value)) break;
    }
    return {
      block: {
        kind: 'htmlBlock',
        span: span(first.contentStart, lastEnd),
        value: lines.join('\n'),
        htmlBlockType: html.type
      },
      endLine: index
    };
  }

  private linkDefinition(views: readonly LineView[], start: number): DefinitionMatch | null {
    const first = views[start];
    if (first === undefined) return null;
    const indentation = this.indentation(first, 3);
    if (this.source[indentation.offset] !== '[' || this.source[indentation.offset + 1] === '^') return null;
    const candidateViews: LineView[] = [{ line: first.line, contentStart: indentation.offset, virtualColumn: 0 }];
    for (let index = start + 1; index < views.length; index += 1) {
      const view = views[index];
      if (view === undefined || isBlankView(this.source, view)) break;
      candidateViews.push(view);
    }
    const input = new InlineSource(this.source, candidateViews);
    const value = input.text;
    let cursor = 1;
    const labelStart = cursor;
    while (cursor < value.length && value[cursor] !== ']' && cursor - labelStart <= 999) {
      if (value[cursor] === '\\' && cursor + 1 < value.length) cursor += 2;
      else if (value[cursor] === '[') return null;
      else cursor += 1;
    }
    if (cursor === labelStart || value[cursor] !== ']' || value[cursor + 1] !== ':') return null;
    const labelEnd = cursor;
    cursor += 2;
    while (cursor < value.length && /[ \t\n]/u.test(value[cursor] ?? '')) cursor += 1;
    let destinationStart = cursor;
    let destinationEnd = cursor;
    let destinationSyntaxEnd = cursor;
    if (value[cursor] === '<') {
      destinationStart = ++cursor;
      while (cursor < value.length && value[cursor] !== '>' && value[cursor] !== '\n') {
        if (value[cursor] === '\\' && cursor + 1 < value.length) cursor += 2;
        else if (value[cursor] === '<') return null;
        else cursor += 1;
      }
      if (value[cursor] !== '>') return null;
      destinationEnd = cursor;
      cursor += 1;
      destinationSyntaxEnd = cursor;
    } else {
      destinationStart = cursor;
      let balance = 0;
      while (cursor < value.length) {
        const character = value[cursor];
        if (character === '\\' && cursor + 1 < value.length) {
          cursor += 2;
          continue;
        }
        if (character === '(') {
          balance += 1;
          if (balance > 32) return null;
        } else if (character === ')') {
          if (balance === 0) break;
          balance -= 1;
        } else if (character === undefined || /[ \t\n]/u.test(character)) break;
        cursor += 1;
      }
      if (balance !== 0 || cursor === destinationStart) return null;
      destinationEnd = cursor;
      destinationSyntaxEnd = cursor;
    }
    const whitespaceStart = cursor;
    while (cursor < value.length && /[ \t\n]/u.test(value[cursor] ?? '')) cursor += 1;
    let title: string | null = null;
    let titleSpan: SourceSpan | null = null;
    let definitionEnd = destinationSyntaxEnd;
    if (cursor > whitespaceStart && (value[cursor] === '"' || value[cursor] === "'" || value[cursor] === '(')) {
      const opening = value[cursor];
      const closing = opening === '(' ? ')' : opening;
      const titleStart = cursor + 1;
      cursor += 1;
      while (cursor < value.length && value[cursor] !== closing) {
        if (value[cursor] === '\\' && cursor + 1 < value.length) cursor += 2;
        else cursor += 1;
      }
      if (value[cursor] !== closing) {
        if (!value.slice(whitespaceStart, cursor).includes('\n')) return null;
        cursor = destinationSyntaxEnd;
      } else {
      const titleEnd = cursor;
      let tail = cursor + 1;
      while (tail < value.length && value[tail] !== '\n' && (value[tail] === ' ' || value[tail] === '\t')) tail += 1;
        if (tail < value.length && value[tail] !== '\n') {
          if (!value.slice(whitespaceStart, titleStart - 1).includes('\n')) return null;
          cursor = destinationSyntaxEnd;
        } else {
          title = decodeMarkdownString(value.slice(titleStart, titleEnd));
          titleSpan = input.span(titleStart, titleEnd);
          definitionEnd = cursor + 1;
        }
      }
    } else {
      let tail = destinationSyntaxEnd;
      while (tail < value.length && value[tail] !== '\n' && (value[tail] === ' ' || value[tail] === '\t')) tail += 1;
      if (tail < value.length && value[tail] !== '\n') return null;
    }
    const definitionSpan = input.span(0, definitionEnd);
    let endLine = start + 1;
    while (endLine < views.length && (views[endLine - 1]?.line.contentEnd ?? Number.POSITIVE_INFINITY) < definitionSpan.end) endLine += 1;
    const rawLabel = value.slice(labelStart, labelEnd);
    const normalizedLabel = normalizeLabel(rawLabel);
    if (normalizedLabel.length === 0) return null;
    return {
      endLine,
      span: definitionSpan,
      label: decodeMarkdownString(rawLabel),
      normalizedLabel,
      labelSpan: input.span(labelStart, labelEnd),
      destination: decodeMarkdownString(value.slice(destinationStart, destinationEnd)),
      destinationSpan: input.span(destinationStart, destinationEnd),
      title,
      titleSpan
    };
  }

  private registerDefinition(definition: RawLinkDefinition): void {
    const existing = this.definitions.get(definition.normalizedLabel);
    if (existing === undefined) {
      definition.active = true;
      this.definitions.set(definition.normalizedLabel, definition);
    } else {
      this.diagnostics.push({
        code: 'duplicate-reference-definition',
        severity: 'warning',
        message: `The reference definition “${definition.label}” is shadowed by an earlier definition.`,
        span: definition.span
      });
    }
  }

  private footnoteDefinition(views: readonly LineView[], start: number): { readonly block: RawFootnoteDefinition; readonly endLine: number } | null {
    const view = views[start];
    if (view === undefined) return null;
    const indentation = this.indentation(view, 3);
    const match = /^\[\^([^\]\r\n]+)\]:/u.exec(this.source.slice(indentation.offset, view.line.contentEnd));
    if (match === null || match[1] === undefined) return null;
    const markerLength = match[0].length;
    const labelStart = indentation.offset + 2;
    const labelEnd = labelStart + match[1].length;
    let contentStart = indentation.offset + markerLength;
    while (this.source[contentStart] === ' ' || this.source[contentStart] === '\t') contentStart += 1;
    const childViews: LineView[] = [{ line: view.line, contentStart, virtualColumn: 0 }];
    let index = start + 1;
    let blockEnd = view.line.contentEnd;
    while (index < views.length) {
      const continuation = views[index];
      if (continuation === undefined) break;
      if (isBlankView(this.source, continuation)) {
        childViews.push({ line: continuation.line, contentStart: continuation.line.contentEnd, virtualColumn: 0 });
        index += 1;
        continue;
      }
      const stripped = this.stripRequiredIndent(continuation, 4);
      if (stripped === null) break;
      childViews.push(stripped);
      blockEnd = continuation.line.contentEnd;
      index += 1;
    }
    const rawLabel = match[1];
    const normalized = normalizeLabel(rawLabel);
    const block: RawFootnoteDefinition = {
      kind: 'footnoteDefinition',
      span: span(indentation.offset, blockEnd),
      label: decodeMarkdownString(rawLabel),
      normalizedLabel: normalized,
      labelSpan: span(labelStart, labelEnd),
      active: false,
      children: this.parseBlocks(childViews)
    };
    const existing = this.footnotes.get(normalized);
    if (existing === undefined) {
      block.active = true;
      this.footnotes.set(normalized, block);
    } else {
      this.diagnostics.push({
        code: 'duplicate-footnote-definition',
        severity: 'warning',
        message: `The footnote definition “${block.label}” is shadowed by an earlier definition.`,
        span: block.span
      });
    }
    return { block, endLine: index };
  }

  private tableDelimiter(view: LineView): readonly MarkdownTableAlignment[] | null {
    const cells = this.splitTableCells(view);
    if (cells.length === 0) return null;
    const align: MarkdownTableAlignment[] = [];
    for (const cell of cells) {
      const value = this.source.slice(cell.contentStart, cell.contentEnd).trim();
      if (!/^:?-+:?$/u.test(value)) return null;
      align.push(value.startsWith(':') && value.endsWith(':') ? 'center' : value.startsWith(':') ? 'left' : value.endsWith(':') ? 'right' : null);
    }
    return align;
  }

  private splitTableCells(view: LineView): ReadonlyArray<{ readonly start: number; readonly end: number; readonly contentStart: number; readonly contentEnd: number }> {
    let start = view.contentStart;
    let end = view.line.contentEnd;
    while (start < end && (this.source[start] === ' ' || this.source[start] === '\t')) start += 1;
    while (end > start && (this.source[end - 1] === ' ' || this.source[end - 1] === '\t')) end -= 1;
    const dividers: number[] = [];
    let backticks = 0;
    for (let offset = start; offset < end; offset += 1) {
      const character = this.source[offset];
      if (character === '\\') {
        offset += 1;
        continue;
      }
      if (character === '`') {
        const length = this.run(offset, end, '`');
        backticks = backticks === 0 ? length : backticks === length ? 0 : backticks;
        offset += length - 1;
        continue;
      }
      if (character === '|' && backticks === 0) dividers.push(offset);
    }
    if (dividers.length === 0) return [];
    const leading = dividers[0] === start;
    const trailing = dividers.at(-1) === end - 1;
    const boundaries = [start, ...dividers, end];
    const cells: Array<{ readonly start: number; readonly end: number; readonly contentStart: number; readonly contentEnd: number }> = [];
    for (let index = leading ? 1 : 0; index < boundaries.length - (trailing ? 2 : 1); index += 1) {
      const left = boundaries[index];
      const right = boundaries[index + 1];
      if (left === undefined || right === undefined) continue;
      const cellStart = index === 0 ? left : left;
      const cellEnd = right;
      let contentStart = left + (this.source[left] === '|' ? 1 : 0);
      let contentEnd = right;
      while (contentStart < contentEnd && (this.source[contentStart] === ' ' || this.source[contentStart] === '\t')) contentStart += 1;
      while (contentEnd > contentStart && (this.source[contentEnd - 1] === ' ' || this.source[contentEnd - 1] === '\t')) contentEnd -= 1;
      cells.push({ start: cellStart, end: cellEnd, contentStart, contentEnd });
    }
    return cells;
  }

  private tableRow(view: LineView, columns: number): RawTableRow {
    const split = [...this.splitTableCells(view)];
    while (split.length < columns) {
      split.push({ start: view.line.contentEnd, end: view.line.contentEnd, contentStart: view.line.contentEnd, contentEnd: view.line.contentEnd });
    }
    const cells = split.slice(0, columns).map((cell) => {
      const contentView = replaceViewBounds(view, cell.contentStart, cell.contentEnd);
      return {
        span: span(cell.start, cell.end),
        contentSpan: span(cell.contentStart, cell.contentEnd),
        input: new InlineSource(this.source, [contentView], true)
      };
    });
    return { span: span(view.contentStart, view.line.contentEnd), cells };
  }

  private paragraph(views: readonly LineView[], start: number): { readonly block: RawBlock; readonly endLine: number } {
    const paragraphViews: LineView[] = [];
    let index = start;
    while (index < views.length) {
      const view = views[index];
      if (view === undefined || isBlankView(this.source, view)) break;
      const indentation = this.indentation(view, 3);
      if (index > start) {
        const candidate = { line: view.line, contentStart: indentation.offset, virtualColumn: 0 };
        if (view.lazy !== true && this.setextUnderline(view) !== null) {
          paragraphViews.push(candidate);
          index += 1;
          break;
        }
        if (this.dialect === 'gfm') {
          const alignment = this.tableDelimiter(view);
          const header = paragraphViews.at(-1);
          const headerColumns = header === undefined ? 0 : this.splitTableCells(header).length;
          if (alignment !== null && alignment.length === headerColumns) {
            if (paragraphViews.length > 1) {
              const preceding = paragraphViews.slice(0, -1);
              return { block: this.plainParagraph(preceding), endLine: index - 1 };
            }
            paragraphViews.push(candidate);
            index += 1;
            break;
          }
        }
        if (this.startsInterruptingBlock(view, true)) break;
      }
      const fullIndent = this.indentation(view);
      const semanticIndentation = index > start ? fullIndent : indentation;
      paragraphViews.push({
        line: view.line,
        contentStart: semanticIndentation.offset,
        virtualColumn: sourceColumnAt(this.source, view.line.start, semanticIndentation.offset),
        virtualSpaces: 0,
        ...(view.lazy === true ? { lazy: true as const } : {})
      });
      index += 1;
    }
    const first = paragraphViews[0];
    const last = paragraphViews.at(-1);
    if (first === undefined || last === undefined) throw new Error('Paragraph parser received no content.');

    if (paragraphViews.length >= 2) {
      const underlineView = views[index - 1] ?? last;
      const underline = underlineView.lazy === true ? null : this.setextUnderline(underlineView);
      if (underline !== null) {
        const contentViews = paragraphViews.slice(0, -1);
        const contentTail = contentViews.at(-1);
        if (contentTail !== undefined) {
          let trimmedEnd = contentTail.line.contentEnd;
          while (trimmedEnd > contentTail.contentStart && (this.source[trimmedEnd - 1] === ' ' || this.source[trimmedEnd - 1] === '\t')) trimmedEnd -= 1;
          contentViews[contentViews.length - 1] = replaceViewBounds(contentTail, contentTail.contentStart, trimmedEnd);
        }
        const contentLast = contentViews.at(-1) ?? first;
        return {
          block: {
            kind: 'heading',
            span: span(first.contentStart, underline.end),
            depth: underline.marker === '=' ? 1 : 2,
            style: 'setext',
            markerSpans: [span(underline.start, underline.end)],
            contentSpan: span(first.contentStart, contentLast.line.contentEnd),
            input: new InlineSource(this.source, contentViews)
          },
          endLine: index
        };
      }
    }

    if (this.dialect === 'gfm' && paragraphViews.length >= 2) {
      const align = this.tableDelimiter(paragraphViews[1] ?? first);
      const headerCells = this.splitTableCells(first);
      if (align !== null && headerCells.length === align.length && align.length > 0) {
        const rows: RawTableRow[] = [];
        let tableEnd = paragraphViews[1]?.line.contentEnd ?? last.line.contentEnd;
        let rowIndex = start + 2;
        while (rowIndex < views.length) {
          const rowView = views[rowIndex];
          if (rowView === undefined || isBlankView(this.source, rowView) || this.splitTableCells(rowView).length === 0) break;
          rows.push(this.tableRow(rowView, align.length));
          tableEnd = rowView.line.contentEnd;
          rowIndex += 1;
        }
        return {
          block: {
            kind: 'table',
            span: span(first.contentStart, tableEnd),
            align,
            delimiterSpan: span(paragraphViews[1]?.contentStart ?? first.contentStart, paragraphViews[1]?.line.contentEnd ?? first.line.contentEnd),
            header: this.tableRow(first, align.length),
            rows
          },
          endLine: rowIndex
        };
      }
    }

    return { block: this.plainParagraph(paragraphViews), endLine: index };
  }

  private plainParagraph(views: readonly LineView[]): RawParagraph {
    const first = views[0];
    const last = views.at(-1);
    if (first === undefined || last === undefined) throw new Error('Paragraph requires content.');
    const semanticViews = [...views];
    let semanticEnd = last.line.contentEnd;
    while (semanticEnd > last.contentStart && (this.source[semanticEnd - 1] === ' ' || this.source[semanticEnd - 1] === '\t')) semanticEnd -= 1;
    semanticViews[semanticViews.length - 1] = replaceViewBounds(last, last.contentStart, semanticEnd);
    return {
      kind: 'paragraph',
      span: span(first.contentStart, last.line.contentEnd),
      contentSpan: span(first.contentStart, last.line.contentEnd),
      input: new InlineSource(this.source, semanticViews)
    };
  }

  private setextUnderline(view: LineView): { readonly marker: '=' | '-'; readonly start: number; readonly end: number } | null {
    const indentation = this.indentation(view, 3);
    const marker = this.source[indentation.offset];
    if (marker !== '=' && marker !== '-') return null;
    let end = indentation.offset;
    while (this.source[end] === marker) end += 1;
    if (!/^[ \t]*$/u.test(this.source.slice(end, view.line.contentEnd))) return null;
    return { marker, start: indentation.offset, end };
  }

  private startsInterruptingBlock(view: LineView, paragraphOpen: boolean): boolean {
    if (this.fenceOpening(view) !== null || this.atxHeading(view) !== null || this.thematicBreak(view) !== null) return true;
    const indentation = this.indentation(view, 3);
    if (this.source[indentation.offset] === '>') return true;
    const list = this.listMarker(view, paragraphOpen);
    if (list !== null && (!paragraphOpen || list.contentStart < view.line.contentEnd)) return true;
    if (this.htmlStart(view, !paragraphOpen) !== null) return true;
    if (this.dialect === 'gfm' && /^\[\^[^\]\r\n]+\]:/u.test(this.source.slice(indentation.offset, view.line.contentEnd))) return true;
    return false;
  }

  private canStartLazyParagraph(initial: LineView): boolean {
    let view = initial;
    for (;;) {
      if (isBlankView(this.source, view) || this.stripRequiredIndent(view, 4) !== null) return false;
      const indentation = this.indentation(view, 3);
      if (this.source[indentation.offset] === '>') {
        let contentStart = indentation.offset + 1;
        if (this.source[contentStart] === ' ' || this.source[contentStart] === '\t') contentStart += 1;
        view = { line: view.line, contentStart, virtualColumn: 0 };
        continue;
      }
      const marker = this.listMarker(view);
      if (marker !== null) {
        view = { line: view.line, contentStart: marker.contentStart, virtualColumn: 0 };
        continue;
      }
      return !this.startsInterruptingBlock(view, false);
    }
  }

  private run(start: number, end: number, marker: string): number {
    let cursor = start;
    while (cursor < end && this.source[cursor] === marker) cursor += 1;
    return cursor - start;
  }

  private trailingWhitespace(view: LineView): number {
    let count = 0;
    for (let offset = view.line.contentEnd - 1; offset >= view.contentStart; offset -= 1) {
      const character = this.source[offset];
      if (character !== ' ' && character !== '\t') break;
      count += 1;
    }
    return count;
  }
}

export function parseBlocks(
  source: string,
  views: readonly LineView[],
  dialect: MarkdownDialect,
  extensions: ReadonlySet<MarkdownSyntaxExtension>,
  seed: BlockParseSeed = {}
): BlockParseResult {
  return new BlockParser(source, dialect, extensions, seed).parse(views);
}
