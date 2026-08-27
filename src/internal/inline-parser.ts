import type {
  MarkdownLinkForm,
  SourceSpan
} from '../model.js';
import type { MarkdownDialect, MarkdownSyntaxExtension } from '../options.js';
import type { BudgetController } from './budget.js';
import { decodeMarkdownString, isEscapable, parseCharacterReference } from './decode.js';
import { normalizeMarkdownIdentifier } from './identifier.js';
import type { InlineSource } from './source-reader.js';

export interface InlineDefinitionTarget {
  readonly label: string;
  readonly normalizedLabel: string;
  readonly destination: string;
  readonly title: string | null;
  readonly span: SourceSpan;
}

export interface InlineFootnoteTarget {
  readonly label: string;
  readonly normalizedLabel: string;
  readonly span: SourceSpan;
}

interface RawInlineBase<Kind extends string> {
  readonly kind: Kind;
  readonly span: SourceSpan;
}

export interface RawText extends RawInlineBase<'text'> { readonly value: string }
export interface RawEscape extends RawInlineBase<'escape'> { readonly value: string; readonly markerSpan: SourceSpan }
export interface RawCharacterReference extends RawInlineBase<'characterReference'> { readonly value: string; readonly reference: string }
export interface RawContainer extends RawInlineBase<'emphasis' | 'strong' | 'strikethrough'> {
  readonly openingMarkerSpan: SourceSpan;
  readonly closingMarkerSpan: SourceSpan;
  readonly children: readonly RawInlineNode[];
}
export interface RawCodeSpan extends RawInlineBase<'codeSpan'> {
  readonly value: string;
  readonly contentSpan: SourceSpan;
  readonly openingMarkerSpan: SourceSpan;
  readonly closingMarkerSpan: SourceSpan;
}
export interface RawMathInline extends RawInlineBase<'mathInline'> {
  readonly value: string;
  readonly contentSpan: SourceSpan;
  readonly openingMarkerSpan: SourceSpan;
  readonly closingMarkerSpan: SourceSpan;
}
export interface RawLink extends RawInlineBase<'link'> {
  readonly form: MarkdownLinkForm;
  readonly destination: string;
  readonly destinationSpan: SourceSpan | null;
  readonly title: string | null;
  readonly titleSpan: SourceSpan | null;
  readonly label: string | null;
  readonly labelSpan: SourceSpan | null;
  readonly definitionSpan: SourceSpan | null;
  readonly children: readonly RawInlineNode[];
}
export interface RawImage extends RawInlineBase<'image'> {
  readonly form: Exclude<MarkdownLinkForm, 'autolink' | 'gfmAutolink'>;
  readonly destination: string;
  readonly destinationSpan: SourceSpan | null;
  readonly title: string | null;
  readonly titleSpan: SourceSpan | null;
  readonly label: string | null;
  readonly labelSpan: SourceSpan | null;
  readonly definitionSpan: SourceSpan | null;
  readonly children: readonly RawInlineNode[];
}
export interface RawSoftBreak extends RawInlineBase<'softBreak'> {}
export interface RawHardBreak extends RawInlineBase<'hardBreak'> { readonly markerSpan: SourceSpan; readonly marker: 'spaces' | 'backslash' }
export interface RawHtmlInline extends RawInlineBase<'htmlInline'> { readonly value: string }
export interface RawFootnoteReference extends RawInlineBase<'footnoteReference'> {
  readonly label: string;
  readonly normalizedLabel: string;
  readonly labelSpan: SourceSpan;
  readonly definitionSpan: SourceSpan;
}

export type RawInlineNode =
  | RawText
  | RawEscape
  | RawCharacterReference
  | RawContainer
  | RawCodeSpan
  | RawMathInline
  | RawLink
  | RawImage
  | RawSoftBreak
  | RawHardBreak
  | RawHtmlInline
  | RawFootnoteReference;

interface Special {
  readonly start: number;
  readonly end: number;
  readonly node: RawInlineNode;
}

interface Delimiter {
  readonly sequence: number;
  readonly marker: '*' | '_' | '~';
  readonly canOpen: boolean;
  readonly canClose: boolean;
  start: number;
  end: number;
  remaining: number;
  version: number;
  active: boolean;
}

interface DelimiterEntry {
  readonly delimiter: Delimiter;
  readonly bucket: number;
  readonly version: number;
}

interface Match {
  readonly marker: '*' | '_' | '~';
  readonly openingStart: number;
  readonly openingEnd: number;
  readonly closingStart: number;
  readonly closingEnd: number;
}

interface Resource {
  readonly end: number;
  readonly destination: string;
  readonly destinationStart: number;
  readonly destinationEnd: number;
  readonly title: string | null;
  readonly titleStart: number | null;
  readonly titleEnd: number | null;
}

interface LinkResolution {
  readonly end: number;
  readonly form: Exclude<MarkdownLinkForm, 'autolink' | 'gfmAutolink'>;
  readonly destination: string;
  readonly destinationStart: number | null;
  readonly destinationEnd: number | null;
  readonly title: string | null;
  readonly titleStart: number | null;
  readonly titleEnd: number | null;
  readonly label: string | null;
  readonly labelStart: number;
  readonly labelEnd: number;
  readonly definitionSpan: SourceSpan | null;
}

export interface InlineParseOptions {
  readonly dialect: MarkdownDialect;
  readonly extensions: ReadonlySet<MarkdownSyntaxExtension>;
  readonly definitions: ReadonlyMap<string, InlineDefinitionTarget>;
  readonly footnotes: ReadonlyMap<string, InlineFootnoteTarget>;
  readonly budget: BudgetController;
  readonly baseDepth: number;
}

const whitespacePattern = /^\s$/u;
const punctuationPattern = /^(?:\p{P}|\p{S})$/u;

function isWhitespace(character: string | undefined): boolean {
  return character === undefined || whitespacePattern.test(character);
}

function isPunctuation(character: string | undefined): boolean {
  return character !== undefined && punctuationPattern.test(character);
}

function delimiterCapabilities(value: string, start: number, end: number, marker: '*' | '_' | '~'): {
  readonly canOpen: boolean;
  readonly canClose: boolean;
} {
  const before = start === 0 ? undefined : value[start - 1];
  const after = end >= value.length ? undefined : value[end];
  const beforeWhitespace = isWhitespace(before);
  const afterWhitespace = isWhitespace(after);
  const beforePunctuation = isPunctuation(before);
  const afterPunctuation = isPunctuation(after);
  const leftFlanking = !afterWhitespace && (!afterPunctuation || beforeWhitespace || beforePunctuation);
  const rightFlanking = !beforeWhitespace && (!beforePunctuation || afterWhitespace || afterPunctuation);
  if (marker === '_') {
    return {
      canOpen: leftFlanking && (!rightFlanking || beforePunctuation),
      canClose: rightFlanking && (!leftFlanking || afterPunctuation)
    };
  }
  return { canOpen: leftFlanking, canClose: rightFlanking };
}

function countRun(value: string, start: number, marker: string): number {
  let end = start;
  while (value[end] === marker) end += 1;
  return end - start;
}

function inlineMathEnd(value: string, start: number, end: number): number | null {
  if (value[start] !== '$'
    || value[start + 1] === '$'
    || isWhitespace(value[start + 1])) return null;
  for (let cursor = start + 1; cursor < end; cursor += 1) {
    const character = value[cursor];
    if (character === '\n' || character === '\r') return null;
    if (character === '\\') {
      cursor += 1;
      continue;
    }
    if (character !== '$' || value[cursor + 1] === '$' || isWhitespace(value[cursor - 1])) continue;
    return cursor;
  }
  return null;
}

function backtickClosers(value: string, start: number, end: number): ReadonlyMap<number, number> {
  const runs: Array<{ readonly start: number; readonly length: number }> = [];
  for (let cursor = start; cursor < end;) {
    if (value[cursor] !== '`') {
      cursor += 1;
      continue;
    }
    const length = countRun(value, cursor, '`');
    runs.push({ start: cursor, length });
    cursor += length;
  }
  const nextByLength = new Map<number, number>();
  const result = new Map<number, number>();
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index];
    if (run === undefined) continue;
    const next = nextByLength.get(run.length);
    if (next !== undefined) result.set(run.start, next);
    nextByLength.set(run.length, run.start);
  }
  return result;
}

function bracketPairs(
  value: string,
  start: number,
  end: number,
  codeClosers: ReadonlyMap<number, number>
): ReadonlyMap<number, number> {
  const stack: number[] = [];
  const result = new Map<number, number>();
  for (let cursor = start; cursor < end;) {
    const character = value[cursor];
    if (character === '\\' && cursor + 1 < end) {
      cursor += 2;
      continue;
    }
    if (character === '`') {
      const closing = codeClosers.get(cursor);
      const length = countRun(value, cursor, '`');
      cursor = closing === undefined ? cursor + length : closing + length;
      continue;
    }
    if (character === '<') {
      const automatic = autolink(value, cursor, end);
      const htmlEnd = automatic?.end ?? htmlInlineEnd(value, cursor, end);
      if (htmlEnd !== null && htmlEnd !== undefined) {
        cursor = htmlEnd;
        continue;
      }
    }
    if (character === '[') stack.push(cursor);
    else if (character === ']') {
      const opening = stack.pop();
      if (opening !== undefined) result.set(opening, cursor);
    }
    cursor += 1;
  }
  return result;
}

function htmlInlineEnd(value: string, start: number, end: number): number | null {
  const tail = value.slice(start, end);
  const patterns = [
    /^<!---?>/u,
    /^<!--[\s\S]*?-->/u,
    /^<\?[\s\S]*?\?>/u,
    /^<!\[CDATA\[[\s\S]*?\]\]>/u,
    /^<![A-Z][\s\S]*?>/u,
    /^<\/[A-Za-z][A-Za-z0-9-]*\s*>/u,
    /^<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>/u
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(tail);
    if (match?.[0] !== undefined) return start + match[0].length;
  }
  return null;
}

function trimLiteralAutolink(value: string): string {
  let result = value;
  for (;;) {
    const previous = result;
    while (/[?!.,:*_~]$/u.test(result)) result = result.slice(0, -1);
    while (result.endsWith(')')) {
      let balance = 0;
      for (const character of result) {
        if (character === '(') balance += 1;
        else if (character === ')') balance -= 1;
      }
      if (balance >= 0) break;
      result = result.slice(0, -1);
    }
    if (result === previous) break;
  }
  return result;
}

function validWwwHost(value: string): boolean {
  const host = value.slice(4).split(/[/?#]/u, 1)[0] ?? '';
  const parts = host.split('.');
  if (parts.length < 2) return false;
  const penultimate = parts.at(-2) ?? '';
  const last = parts.at(-1) ?? '';
  return !penultimate.includes('_') && !last.includes('_') && /^[A-Za-z0-9-]+$/u.test(last);
}

function literalAutolink(value: string, start: number, end: number): {
  readonly end: number;
  readonly destination: string;
  readonly display: string;
} | null {
  const previous = start === 0 ? undefined : value[start - 1];
  if (previous !== undefined && /[A-Za-z0-9_]/u.test(previous)) return null;
  const tail = value.slice(start, end);
  const protocolEmail = /^(?:mailto:[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+|xmpp:[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%/?#-]*)?)/iu.exec(tail)?.[0];
  if (protocolEmail !== undefined) {
    const display = trimLiteralAutolink(protocolEmail);
    return { end: start + display.length, destination: display, display };
  }
  const url = /^(?:https?:\/\/|www\.)[^\s<>"'](?:[^\s<>"']*)/iu.exec(tail)?.[0];
  if (url !== undefined) {
    const display = trimLiteralAutolink(url);
    if (display.toLowerCase().startsWith('www.') && !validWwwHost(display)) return null;
    return {
      end: start + display.length,
      destination: display.toLowerCase().startsWith('www.') ? `http://${display}` : display,
      display
    };
  }
  const email = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+/u.exec(tail)?.[0];
  if (email === undefined) return null;
  return { end: start + email.length, destination: `mailto:${email}`, display: email };
}

function autolink(value: string, start: number, end: number): {
  readonly end: number;
  readonly destination: string;
  readonly display: string;
} | null {
  const closing = value.indexOf('>', start + 1);
  if (closing < 0 || closing >= end) return null;
  const content = value.slice(start + 1, closing);
  if (/^[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*$/u.test(content)) {
    return { end: closing + 1, destination: content.replace(/\0/gu, '\ufffd'), display: content };
  }
  if (/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/u.test(content)) {
    return { end: closing + 1, destination: `mailto:${content}`, display: content };
  }
  return null;
}

function plainText(nodes: readonly RawInlineNode[]): string {
  let result = '';
  const stack = [...nodes].reverse();
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) continue;
    switch (node.kind) {
      case 'text':
      case 'escape':
      case 'characterReference':
      case 'codeSpan':
      case 'mathInline':
        result += node.value;
        break;
      case 'softBreak':
      case 'hardBreak':
        result += '\n';
        break;
      case 'htmlInline':
        result += node.value;
        break;
      case 'emphasis':
      case 'strong':
      case 'strikethrough':
      case 'link':
      case 'image':
        for (let index = node.children.length - 1; index >= 0; index -= 1) {
          const child = node.children[index];
          if (child !== undefined) stack.push(child);
        }
        break;
      case 'footnoteReference':
        result += node.label;
        break;
    }
  }
  return result;
}

class InlineParser {
  private readonly value: string;

  constructor(
    private readonly input: InlineSource,
    private readonly options: InlineParseOptions
  ) {
    this.value = input.text;
  }

  parse(): readonly RawInlineNode[] {
    return this.parseRange(0, this.value.length, true, 0);
  }

  private parseRange(start: number, end: number, allowLinks: boolean, nesting: number): readonly RawInlineNode[] {
    this.options.budget.depth(this.options.baseDepth + nesting);
    const codeClosers = backtickClosers(this.value, start, end);
    const pairs = bracketPairs(this.value, start, end, codeClosers);
    const specials: Special[] = [];
    const delimiters: Delimiter[] = [];
    let sequence = 0;

    for (let cursor = start; cursor < end;) {
      const character = this.value[cursor];
      if (character === '\\') {
        if (this.value[cursor + 1] === '\n') {
          specials.push({
            start: cursor,
            end: cursor + 2,
            node: {
              kind: 'hardBreak',
              span: this.input.span(cursor, cursor + 2),
              markerSpan: this.input.span(cursor, cursor + 1),
              marker: 'backslash'
            }
          });
          cursor += 2;
          continue;
        }
        if (isEscapable(this.value[cursor + 1])) {
          specials.push({
            start: cursor,
            end: cursor + 2,
            node: {
              kind: 'escape',
              span: this.input.span(cursor, cursor + 2),
              value: this.value[cursor + 1] ?? '',
              markerSpan: this.input.span(cursor, cursor + 1)
            }
          });
          cursor += 2;
          continue;
        }
      }

      if (character === '&') {
        const reference = parseCharacterReference(this.value, cursor);
        if (reference !== null && reference.end <= end) {
          specials.push({
            start: cursor,
            end: reference.end,
            node: {
              kind: 'characterReference',
              span: this.input.span(cursor, reference.end),
              value: reference.value,
              reference: this.value.slice(cursor, reference.end)
            }
          });
          cursor = reference.end;
          continue;
        }
      }

      if (character === '`') {
        const length = countRun(this.value, cursor, '`');
        const closing = codeClosers.get(cursor);
        if (closing !== undefined && closing < end) {
          const contentStart = cursor + length;
          const contentEnd = closing;
          let content = this.value.slice(contentStart, contentEnd).replace(/\n/gu, ' ').replace(/\0/gu, '\ufffd');
          if (/^ .* $/u.test(content) && /[^ ]/u.test(content)) content = content.slice(1, -1);
          const tokenEnd = closing + length;
          specials.push({
            start: cursor,
            end: tokenEnd,
            node: {
              kind: 'codeSpan',
              span: this.input.span(cursor, tokenEnd),
              value: content,
              contentSpan: this.input.span(contentStart, contentEnd),
              openingMarkerSpan: this.input.span(cursor, contentStart),
              closingMarkerSpan: this.input.span(closing, tokenEnd)
            }
          });
          cursor = tokenEnd;
          continue;
        }
        cursor += length;
        continue;
      }

      if (character === '$' && this.options.extensions.has('math')) {
        const closing = inlineMathEnd(this.value, cursor, end);
        if (closing !== null) {
          const tokenEnd = closing + 1;
          specials.push({
            start: cursor,
            end: tokenEnd,
            node: {
              kind: 'mathInline',
              span: this.input.span(cursor, tokenEnd),
              value: this.value.slice(cursor + 1, closing),
              contentSpan: this.input.span(cursor + 1, closing),
              openingMarkerSpan: this.input.span(cursor, cursor + 1),
              closingMarkerSpan: this.input.span(closing, tokenEnd)
            }
          });
          cursor = tokenEnd;
          continue;
        }
      }

      const image = character === '!' && this.value[cursor + 1] === '[';
      const labelOpening = image ? cursor + 1 : cursor;
      if ((image || character === '[') && pairs.has(labelOpening)) {
        const closing = pairs.get(labelOpening);
        if (closing !== undefined && closing - labelOpening <= 1_000) {
          if (this.options.dialect === 'gfm' && !image && this.value[labelOpening + 1] === '^') {
            const rawLabel = this.value.slice(labelOpening + 2, closing);
            const normalized = normalizeMarkdownIdentifier(rawLabel);
            const target = this.options.footnotes.get(normalized);
            if (rawLabel.length > 0 && target !== undefined) {
              const tokenEnd = closing + 1;
              specials.push({
                start: cursor,
                end: tokenEnd,
                node: {
                  kind: 'footnoteReference',
                  span: this.input.span(cursor, tokenEnd),
                  label: decodeMarkdownString(rawLabel),
                  normalizedLabel: normalized,
                  labelSpan: this.input.span(labelOpening + 2, closing),
                  definitionSpan: target.span
                }
              });
              cursor = tokenEnd;
              continue;
            }
          }
          if (image || allowLinks) {
            const resolution = this.resolveLink(labelOpening, closing, end);
            const containsLink = !image && resolution !== null
              && this.containsResolvableLink(labelOpening, closing, pairs, end);
            if (resolution !== null && !containsLink) {
              const children = this.parseRange(labelOpening + 1, closing, image, nesting + 1);
              const span = this.input.span(cursor, resolution.end);
              const labelSpan = this.input.span(labelOpening + 1, closing);
              const common = {
                span,
                form: resolution.form,
                destination: resolution.destination,
                destinationSpan: resolution.destinationStart === null || resolution.destinationEnd === null
                  ? null
                  : this.input.span(resolution.destinationStart, resolution.destinationEnd),
                title: resolution.title,
                titleSpan: resolution.titleStart === null || resolution.titleEnd === null
                  ? null
                  : this.input.span(resolution.titleStart, resolution.titleEnd),
                label: resolution.label,
                labelSpan: resolution.form === 'inline'
                  ? labelSpan
                  : this.input.span(resolution.labelStart, resolution.labelEnd),
                definitionSpan: resolution.definitionSpan
              };
              const node: RawInlineNode = image
                ? {
                    kind: 'image',
                    ...common,
                    children: plainText(children).length === 0
                      ? []
                      : [{ kind: 'text', span: labelSpan, value: plainText(children) }]
                  }
                : { kind: 'link', ...common, children };
              specials.push({ start: cursor, end: resolution.end, node });
              cursor = resolution.end;
              continue;
            }
          }
        }
      }

      if (character === '<') {
        const automatic = autolink(this.value, cursor, end);
        if (automatic !== null) {
          const contentStart = cursor + 1;
          const contentEnd = automatic.end - 1;
          const child: RawText = {
            kind: 'text',
            span: this.input.span(contentStart, contentEnd),
            value: automatic.display
          };
          specials.push({
            start: cursor,
            end: automatic.end,
            node: {
              kind: 'link',
              span: this.input.span(cursor, automatic.end),
              form: 'autolink',
              destination: automatic.destination,
              destinationSpan: this.input.span(contentStart, contentEnd),
              title: null,
              titleSpan: null,
              label: null,
              labelSpan: null,
              definitionSpan: null,
              children: [child]
            }
          });
          cursor = automatic.end;
          continue;
        }
        const htmlEnd = htmlInlineEnd(this.value, cursor, end);
        if (htmlEnd !== null) {
          specials.push({
            start: cursor,
            end: htmlEnd,
            node: {
              kind: 'htmlInline',
              span: this.input.span(cursor, htmlEnd),
              value: this.value.slice(cursor, htmlEnd)
            }
          });
          cursor = htmlEnd;
          continue;
        }
      }

      if (this.options.dialect === 'gfm' && allowLinks && (character === 'h' || character === 'H' || character === 'w' || character === 'W' || /[A-Za-z0-9]/u.test(character ?? ''))) {
        const automatic = literalAutolink(this.value, cursor, end);
        if (automatic !== null) {
          const child: RawText = {
            kind: 'text',
            span: this.input.span(cursor, automatic.end),
            value: automatic.display
          };
          specials.push({
            start: cursor,
            end: automatic.end,
            node: {
              kind: 'link',
              span: this.input.span(cursor, automatic.end),
              form: 'gfmAutolink',
              destination: automatic.destination,
              destinationSpan: this.input.span(cursor, automatic.end),
              title: null,
              titleSpan: null,
              label: null,
              labelSpan: null,
              definitionSpan: null,
              children: [child]
            }
          });
          cursor = automatic.end;
          continue;
        }
      }

      if (character === '\n') {
        let whitespaceStart = cursor;
        while (whitespaceStart > start && (this.value[whitespaceStart - 1] === ' ' || this.value[whitespaceStart - 1] === '\t')) {
          whitespaceStart -= 1;
        }
        const trailing = this.value.slice(whitespaceStart, cursor);
        if (/ {2,}$/u.test(trailing)) {
          specials.push({
            start: whitespaceStart,
            end: cursor + 1,
            node: {
              kind: 'hardBreak',
              span: this.input.span(whitespaceStart, cursor + 1),
              markerSpan: this.input.span(cursor - (/ +$/u.exec(trailing)?.[0].length ?? 0), cursor),
              marker: 'spaces'
            }
          });
        } else {
          specials.push({
            start: whitespaceStart,
            end: cursor + 1,
            node: { kind: 'softBreak', span: this.input.span(whitespaceStart, cursor + 1) }
          });
        }
        cursor += 1;
        continue;
      }

      if (character === '*' || character === '_' || character === '~' && this.options.dialect === 'gfm') {
        const marker = character as '*' | '_' | '~';
        const length = countRun(this.value, cursor, marker);
        if (marker === '~' && length > 2) {
          cursor += length;
          continue;
        }
        const capability = delimiterCapabilities(this.value, cursor, cursor + length, marker);
        delimiters.push({
          sequence: sequence++,
          marker,
          canOpen: capability.canOpen,
          canClose: capability.canClose,
          start: cursor,
          end: cursor + length,
          remaining: length,
          version: 0,
          active: true
        });
        cursor += length;
        continue;
      }
      cursor += 1;
    }

    return this.build(start, end, specials, this.resolveDelimiters(delimiters));
  }

  private parseResource(start: number, end: number): Resource | null {
    if (this.value[start] !== '(') return null;
    let cursor = start + 1;
    while (cursor < end && /[ \t\n]/u.test(this.value[cursor] ?? '')) cursor += 1;
    let destinationStart = cursor;
    let destinationEnd = cursor;
    if (this.value[cursor] === '<') {
      destinationStart = ++cursor;
      while (cursor < end && this.value[cursor] !== '>' && this.value[cursor] !== '\n') {
        if (this.value[cursor] === '\\' && cursor + 1 < end) cursor += 2;
        else cursor += 1;
      }
      if (this.value[cursor] !== '>') return null;
      destinationEnd = cursor;
      cursor += 1;
    } else {
      destinationStart = cursor;
      let balance = 0;
      while (cursor < end) {
        const character = this.value[cursor];
        if (character === '\\' && cursor + 1 < end) {
          cursor += 2;
          continue;
        }
        if (character === '(') {
          balance += 1;
          if (balance > 32) return null;
        } else if (character === ')') {
          if (balance === 0) break;
          balance -= 1;
        } else if (character === undefined || /[ \t\n\0]/u.test(character)) break;
        cursor += 1;
      }
      destinationEnd = cursor;
    }
    const whitespaceStart = cursor;
    while (cursor < end && /[ \t\n]/u.test(this.value[cursor] ?? '')) cursor += 1;
    let title: string | null = null;
    let titleStart: number | null = null;
    let titleEnd: number | null = null;
    if (cursor > whitespaceStart && (this.value[cursor] === '"' || this.value[cursor] === "'" || this.value[cursor] === '(')) {
      const opening = this.value[cursor];
      const closing = opening === '(' ? ')' : opening;
      titleStart = cursor + 1;
      cursor += 1;
      while (cursor < end && this.value[cursor] !== closing) {
        if (this.value[cursor] === '\\' && cursor + 1 < end) cursor += 2;
        else cursor += 1;
      }
      if (this.value[cursor] !== closing) return null;
      titleEnd = cursor;
      title = decodeMarkdownString(this.value.slice(titleStart, titleEnd));
      cursor += 1;
      while (cursor < end && /[ \t\n]/u.test(this.value[cursor] ?? '')) cursor += 1;
    }
    if (this.value[cursor] !== ')') return null;
    return {
      end: cursor + 1,
      destination: decodeMarkdownString(this.value.slice(destinationStart, destinationEnd)),
      destinationStart,
      destinationEnd,
      title,
      titleStart,
      titleEnd
    };
  }

  private resolveLink(opening: number, closing: number, end: number): LinkResolution | null {
    const resource = this.parseResource(closing + 1, end);
    if (resource !== null) {
      return {
        ...resource,
        form: 'inline',
        label: null,
        labelStart: opening + 1,
        labelEnd: closing,
        definitionSpan: null
      };
    }

    const labelText = this.value.slice(opening + 1, closing);
    if (this.value[closing + 1] === '[') {
      let referenceEnd = closing + 2;
      while (referenceEnd < end && this.value[referenceEnd] !== ']' && referenceEnd - closing <= 1_001) {
        if (this.value[referenceEnd] === '\\' && referenceEnd + 1 < end) referenceEnd += 2;
        else referenceEnd += 1;
      }
      if (this.value[referenceEnd] === ']') {
        const rawReference = this.value.slice(closing + 2, referenceEnd);
        const collapsed = rawReference.length === 0;
        const lookup = collapsed ? labelText : rawReference;
        const target = this.options.definitions.get(normalizeMarkdownIdentifier(lookup));
        if (target !== undefined) {
          return {
            end: referenceEnd + 1,
            form: collapsed ? 'collapsedReference' : 'fullReference',
            destination: target.destination,
            destinationStart: null,
            destinationEnd: null,
            title: target.title,
            titleStart: null,
            titleEnd: null,
            label: decodeMarkdownString(lookup),
            labelStart: collapsed ? opening + 1 : closing + 2,
            labelEnd: collapsed ? closing : referenceEnd,
            definitionSpan: target.span
          };
        }
        if (!collapsed) return null;
      }
    }
    const target = this.options.definitions.get(normalizeMarkdownIdentifier(labelText));
    if (target === undefined) return null;
    return {
      end: closing + 1,
      form: 'shortcutReference',
      destination: target.destination,
      destinationStart: null,
      destinationEnd: null,
      title: target.title,
      titleStart: null,
      titleEnd: null,
      label: decodeMarkdownString(labelText),
      labelStart: opening + 1,
      labelEnd: closing,
      definitionSpan: target.span
    };
  }

  private containsResolvableLink(
    opening: number,
    closing: number,
    pairs: ReadonlyMap<number, number>,
    end: number
  ): boolean {
    for (let cursor = opening + 1; cursor < closing; cursor += 1) {
      if (this.value[cursor] !== '[' || this.value[cursor - 1] === '!') continue;
      const nestedClosing = pairs.get(cursor);
      if (nestedClosing === undefined || nestedClosing >= closing) continue;
      if (this.resolveLink(cursor, nestedClosing, end) !== null) return true;
    }
    return false;
  }

  private resolveDelimiters(delimiters: readonly Delimiter[]): readonly Match[] {
    const buckets = new Map<string, Array<Array<DelimiterEntry>>>();
    const activeOpeners: Delimiter[] = [];
    const stacks = (marker: string): Array<Array<DelimiterEntry>> => {
      const existing = buckets.get(marker);
      if (existing !== undefined) return existing;
      const created = Array.from({ length: 6 }, () => [] as DelimiterEntry[]);
      buckets.set(marker, created);
      return created;
    };
    const bucketNumber = (delimiter: Delimiter): number => (
      (delimiter.canClose ? 3 : 0) + delimiter.remaining % 3
    );
    const add = (delimiter: Delimiter, newlyActive: boolean): void => {
      const bucket = bucketNumber(delimiter);
      stacks(delimiter.marker)[bucket]?.push({ delimiter, bucket, version: delimiter.version });
      if (newlyActive) activeOpeners.push(delimiter);
    };
    const tail = (entries: DelimiterEntry[]): Delimiter | null => {
      while (entries.length > 0) {
        const entry = entries.at(-1);
        if (entry !== undefined
          && entry.delimiter.active
          && entry.delimiter.version === entry.version
          && bucketNumber(entry.delimiter) === entry.bucket) return entry.delimiter;
        entries.pop();
      }
      return null;
    };
    const matches: Match[] = [];
    for (const delimiter of delimiters) {
      let closeRemaining = delimiter.remaining;
      let closeStart = delimiter.start;
      if (delimiter.canClose) {
        const available = stacks(delimiter.marker);
        while (closeRemaining > 0) {
          let candidate: Delimiter | null = null;
          for (const entries of available) {
            const opener = tail(entries);
            if (opener === null) continue;
            if (delimiter.marker === '~' && opener.remaining !== closeRemaining) continue;
            const blocked = delimiter.marker !== '~'
              && (opener.canClose || delimiter.canOpen)
              && closeRemaining % 3 !== 0
              && (opener.remaining + closeRemaining) % 3 === 0;
            if (blocked) continue;
            if (candidate === null || opener.sequence > candidate.sequence) candidate = opener;
          }
          if (candidate === null) break;
          while ((activeOpeners.at(-1)?.sequence ?? -1) > candidate.sequence) {
            const crossed = activeOpeners.pop();
            if (crossed !== undefined) crossed.active = false;
          }
          const use = delimiter.marker === '~'
            ? closeRemaining
            : candidate.remaining > 1 && closeRemaining > 1 ? 2 : 1;
          matches.push({
            marker: delimiter.marker,
            openingStart: candidate.end - use,
            openingEnd: candidate.end,
            closingStart: closeStart,
            closingEnd: closeStart + use
          });
          candidate.version += 1;
          candidate.end -= use;
          candidate.remaining -= use;
          closeStart += use;
          closeRemaining -= use;
          if (candidate.remaining === 0) {
            candidate.active = false;
            if (activeOpeners.at(-1) === candidate) activeOpeners.pop();
          } else add(candidate, false);
        }
      }
      if (delimiter.canOpen && closeRemaining > 0) {
        delimiter.start = closeStart;
        delimiter.end = closeStart + closeRemaining;
        delimiter.remaining = closeRemaining;
        delimiter.version = 0;
        delimiter.active = true;
        add(delimiter, true);
      }
    }
    return matches;
  }

  private build(
    start: number,
    end: number,
    specials: readonly Special[],
    matches: readonly Match[]
  ): readonly RawInlineNode[] {
    type Event =
      | { readonly position: number; readonly type: 'open'; readonly match: Match }
      | { readonly position: number; readonly type: 'close'; readonly match: Match }
      | { readonly position: number; readonly type: 'special'; readonly special: Special };
    const events: Event[] = [];
    for (const match of matches) {
      events.push({ position: match.openingStart, type: 'open', match });
      events.push({ position: match.closingStart, type: 'close', match });
    }
    for (const special of specials) events.push({ position: special.start, type: 'special', special });
    const priority = { close: 0, special: 1, open: 2 } as const;
    events.sort((left, right) => left.position - right.position || priority[left.type] - priority[right.type]);

    interface Frame {
      readonly match: Match | null;
      readonly children: RawInlineNode[];
    }
    const stack: Frame[] = [{ match: null, children: [] }];
    let cursor = start;
    const append = (node: RawInlineNode): void => {
      const children = stack.at(-1)?.children;
      if (children === undefined) throw new Error('Inline container stack is empty.');
      const previous = children.at(-1);
      if (previous?.kind === 'text' && node.kind === 'text' && previous.span.end === node.span.start) {
        children[children.length - 1] = {
          kind: 'text',
          span: { start: previous.span.start, end: node.span.end },
          value: previous.value + node.value
        };
      } else children.push(node);
    };
    const text = (from: number, to: number): void => {
      if (to <= from) return;
      append({
        kind: 'text',
        span: this.input.span(from, to),
        value: this.value.slice(from, to).replace(/\0/gu, '\ufffd')
      });
    };

    for (const event of events) {
      if (event.position < cursor) continue;
      text(cursor, event.position);
      if (event.type === 'special') {
        append(event.special.node);
        cursor = event.special.end;
      } else if (event.type === 'open') {
        stack.push({ match: event.match, children: [] });
        cursor = event.match.openingEnd;
      } else {
        const frame = stack.pop();
        if (frame?.match !== event.match) throw new Error('Delimiter matches crossed.');
        const match = event.match;
        const kind = match.marker === '~'
          ? 'strikethrough'
          : match.openingEnd - match.openingStart === 2
            ? 'strong'
            : 'emphasis';
        append({
          kind,
          span: this.input.span(match.openingStart, match.closingEnd),
          openingMarkerSpan: this.input.span(match.openingStart, match.openingEnd),
          closingMarkerSpan: this.input.span(match.closingStart, match.closingEnd),
          children: frame.children
        });
        cursor = match.closingEnd;
      }
    }
    text(cursor, end);
    if (stack.length !== 1) throw new Error('Delimiter container remained open.');
    return stack[0]?.children ?? [];
  }
}

export function parseInline(input: InlineSource, options: InlineParseOptions): readonly RawInlineNode[] {
  return new InlineParser(input, options).parse();
}
