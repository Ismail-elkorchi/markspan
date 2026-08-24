import type {
  MarkdownBlockNode,
  MarkdownDiagnostic,
  MarkdownDocumentNode,
  MarkdownFootnoteDefinition,
  MarkdownInlineNode,
  MarkdownNode,
  MarkdownReferenceDefinition,
  MarkdownTableCellNode,
  MarkdownTableRowNode,
  SourceSpan
} from '../model.js';
import type { MarkdownDialect } from '../options.js';
import type { BudgetController } from './budget.js';
import {
  parseBlocks,
  type BlockParseResult,
  type RawBlock,
  type RawListItem,
  type RawTableCell,
  type RawTableRow
} from './block-parser.js';
import { parseInline, type RawInlineNode } from './inline-parser.js';
import { rootLineViews, scanSourceLines } from './source-reader.js';

export interface ConvertedMarkdown {
  readonly tree: MarkdownDocumentNode;
  readonly definitions: readonly MarkdownReferenceDefinition[];
  readonly footnotes: readonly MarkdownFootnoteDefinition[];
  readonly diagnostics: readonly MarkdownDiagnostic[];
}

export interface ConvertOptions {
  readonly dialect: MarkdownDialect;
  readonly sourceOffset: number;
  readonly documentLength: number;
  readonly budget: BudgetController;
  nextId(): number;
}

function freezeSpan(value: SourceSpan, offset: number): SourceSpan {
  return Object.freeze({ start: value.start + offset, end: value.end + offset });
}

class Emitter {
  private readonly definitions: MarkdownReferenceDefinition[] = [];
  private readonly footnotes: MarkdownFootnoteDefinition[] = [];

  constructor(
    private readonly parsed: BlockParseResult,
    private readonly options: ConvertOptions
  ) {}

  emit(): ConvertedMarkdown {
    const children = this.parsed.blocks.map((block) => this.block(block, 1));
    const tree: MarkdownDocumentNode = Object.freeze({
      id: this.allocate(0),
      kind: 'document',
      span: Object.freeze({ start: 0, end: this.options.documentLength }),
      children: Object.freeze(children)
    });
    return Object.freeze({
      tree,
      definitions: Object.freeze(this.definitions),
      footnotes: Object.freeze(this.footnotes),
      diagnostics: Object.freeze(this.parsed.diagnostics.map((diagnostic) => Object.freeze({
        ...diagnostic,
        span: this.absolute(diagnostic.span)
      })))
    });
  }

  private allocate(depth: number): number {
    this.options.budget.node(depth);
    return this.options.nextId();
  }

  private absolute(value: SourceSpan): SourceSpan {
    return freezeSpan(value, this.options.sourceOffset);
  }

  private inlineNodes(input: Parameters<typeof parseInline>[0], depth: number): readonly MarkdownInlineNode[] {
    const raw = parseInline(input, {
      dialect: this.options.dialect,
      definitions: this.parsed.definitions,
      footnotes: this.parsed.footnotes,
      budget: this.options.budget,
      baseDepth: depth
    });
    return Object.freeze(raw.map((node) => this.inline(node, depth)));
  }

  private block(raw: RawBlock, depth: number): MarkdownBlockNode {
    const id = this.allocate(depth);
    const span = this.absolute(raw.span);
    switch (raw.kind) {
      case 'paragraph':
        return Object.freeze({
          id,
          kind: 'paragraph',
          span,
          contentSpan: this.absolute(raw.contentSpan),
          children: this.inlineNodes(raw.input, depth + 1)
        });
      case 'heading':
        return Object.freeze({
          id,
          kind: 'heading',
          span,
          depth: raw.depth,
          style: raw.style,
          markerSpans: Object.freeze(raw.markerSpans.map((marker) => this.absolute(marker))),
          contentSpan: this.absolute(raw.contentSpan),
          children: this.inlineNodes(raw.input, depth + 1)
        });
      case 'blockQuote':
        return Object.freeze({
          id,
          kind: 'blockQuote',
          span,
          markerSpans: Object.freeze(raw.markerSpans.map((marker) => this.absolute(marker))),
          children: Object.freeze(raw.children.map((child) => this.block(child, depth + 1)))
        });
      case 'list':
        return Object.freeze({
          id,
          kind: 'list',
          span,
          ordered: raw.ordered,
          start: raw.start,
          delimiter: raw.delimiter,
          bullet: raw.bullet,
          tight: raw.tight,
          items: Object.freeze(raw.items.map((item) => this.listItem(item, depth + 1)))
        });
      case 'codeBlock':
        return Object.freeze({
          id,
          kind: 'codeBlock',
          span,
          style: raw.style,
          value: raw.value,
          contentSpan: this.absolute(raw.contentSpan),
          info: raw.info,
          infoSpan: raw.infoSpan === null ? null : this.absolute(raw.infoSpan),
          language: raw.language,
          fence: raw.fence === null ? null : Object.freeze({
            character: raw.fence.character,
            length: raw.fence.length,
            indentation: raw.fence.indentation,
            openingSpan: this.absolute(raw.fence.openingSpan),
            closingSpan: raw.fence.closingSpan === null ? null : this.absolute(raw.fence.closingSpan)
          })
        });
      case 'thematicBreak':
        return Object.freeze({
          id,
          kind: 'thematicBreak',
          span,
          marker: raw.marker,
          markerSpan: this.absolute(raw.markerSpan)
        });
      case 'htmlBlock':
        return Object.freeze({ id, kind: 'htmlBlock', span, value: raw.value, htmlBlockType: raw.htmlBlockType });
      case 'linkDefinition': {
        const result = Object.freeze({
          id,
          kind: 'linkDefinition' as const,
          span,
          label: raw.label,
          normalizedLabel: raw.normalizedLabel,
          labelSpan: this.absolute(raw.labelSpan),
          destination: raw.destination,
          destinationSpan: this.absolute(raw.destinationSpan),
          title: raw.title,
          titleSpan: raw.titleSpan === null ? null : this.absolute(raw.titleSpan),
          active: raw.active
        });
        if (raw.active) {
          this.definitions.push(Object.freeze({
            label: result.label,
            normalizedLabel: result.normalizedLabel,
            destination: result.destination,
            title: result.title,
            span: result.span,
            nodeId: result.id
          }));
        }
        return result;
      }
      case 'footnoteDefinition': {
        const result = Object.freeze({
          id,
          kind: 'footnoteDefinition' as const,
          span,
          label: raw.label,
          normalizedLabel: raw.normalizedLabel,
          labelSpan: this.absolute(raw.labelSpan),
          active: raw.active,
          children: Object.freeze(raw.children.map((child) => this.block(child, depth + 1)))
        });
        if (raw.active) {
          this.footnotes.push(Object.freeze({
            label: result.label,
            normalizedLabel: result.normalizedLabel,
            span: result.span,
            nodeId: result.id
          }));
        }
        return result;
      }
      case 'table':
        return Object.freeze({
          id,
          kind: 'table',
          span,
          align: Object.freeze([...raw.align]),
          delimiterSpan: this.absolute(raw.delimiterSpan),
          header: this.tableRow(raw.header, depth + 1),
          rows: Object.freeze(raw.rows.map((row) => this.tableRow(row, depth + 1)))
        });
    }
  }

  private listItem(raw: RawListItem, depth: number): Extract<MarkdownNode, { kind: 'listItem' }> {
    return Object.freeze({
      id: this.allocate(depth),
      kind: 'listItem',
      span: this.absolute(raw.span),
      markerSpan: this.absolute(raw.markerSpan),
      contentIndent: raw.contentIndent,
      spread: raw.spread,
      task: raw.task === null ? null : Object.freeze({ checked: raw.task.checked, span: this.absolute(raw.task.span) }),
      children: Object.freeze(raw.children.map((child) => this.block(child, depth + 1)))
    });
  }

  private tableRow(raw: RawTableRow, depth: number): MarkdownTableRowNode {
    return Object.freeze({
      id: this.allocate(depth),
      kind: 'tableRow',
      span: this.absolute(raw.span),
      cells: Object.freeze(raw.cells.map((cell, column) => this.tableCell(cell, column, depth + 1)))
    });
  }

  private tableCell(raw: RawTableCell, column: number, depth: number): MarkdownTableCellNode {
    return Object.freeze({
      id: this.allocate(depth),
      kind: 'tableCell',
      span: this.absolute(raw.span),
      column,
      contentSpan: this.absolute(raw.contentSpan),
      children: this.inlineNodes(raw.input, depth + 1)
    });
  }

  private inline(raw: RawInlineNode, depth: number): MarkdownInlineNode {
    const id = this.allocate(depth);
    const span = this.absolute(raw.span);
    switch (raw.kind) {
      case 'text':
        return Object.freeze({ id, kind: 'text', span, value: raw.value });
      case 'escape':
        return Object.freeze({ id, kind: 'escape', span, value: raw.value, markerSpan: this.absolute(raw.markerSpan) });
      case 'characterReference':
        return Object.freeze({ id, kind: 'characterReference', span, value: raw.value, reference: raw.reference });
      case 'emphasis':
      case 'strong':
      case 'strikethrough':
        return Object.freeze({
          id,
          kind: raw.kind,
          span,
          openingMarkerSpan: this.absolute(raw.openingMarkerSpan),
          closingMarkerSpan: this.absolute(raw.closingMarkerSpan),
          children: Object.freeze(raw.children.map((child) => this.inline(child, depth + 1)))
        });
      case 'codeSpan':
        return Object.freeze({
          id,
          kind: 'codeSpan',
          span,
          value: raw.value,
          contentSpan: this.absolute(raw.contentSpan),
          openingMarkerSpan: this.absolute(raw.openingMarkerSpan),
          closingMarkerSpan: this.absolute(raw.closingMarkerSpan)
        });
      case 'link':
        return Object.freeze({
          id,
          kind: 'link',
          span,
          form: raw.form,
          destination: raw.destination,
          destinationSpan: raw.destinationSpan === null ? null : this.absolute(raw.destinationSpan),
          title: raw.title,
          titleSpan: raw.titleSpan === null ? null : this.absolute(raw.titleSpan),
          label: raw.label,
          labelSpan: raw.labelSpan === null ? null : this.absolute(raw.labelSpan),
          definitionSpan: raw.definitionSpan === null ? null : this.absolute(raw.definitionSpan),
          children: Object.freeze(raw.children.map((child) => this.inline(child, depth + 1)))
        });
      case 'image':
        return Object.freeze({
          id,
          kind: 'image',
          span,
          form: raw.form,
          destination: raw.destination,
          destinationSpan: raw.destinationSpan === null ? null : this.absolute(raw.destinationSpan),
          title: raw.title,
          titleSpan: raw.titleSpan === null ? null : this.absolute(raw.titleSpan),
          label: raw.label,
          labelSpan: raw.labelSpan === null ? null : this.absolute(raw.labelSpan),
          definitionSpan: raw.definitionSpan === null ? null : this.absolute(raw.definitionSpan),
          children: Object.freeze(raw.children.map((child) => this.inline(child, depth + 1)))
        });
      case 'softBreak':
        return Object.freeze({ id, kind: 'softBreak', span });
      case 'hardBreak':
        return Object.freeze({ id, kind: 'hardBreak', span, markerSpan: this.absolute(raw.markerSpan), marker: raw.marker });
      case 'htmlInline':
        return Object.freeze({ id, kind: 'htmlInline', span, value: raw.value });
      case 'footnoteReference':
        return Object.freeze({
          id,
          kind: 'footnoteReference',
          span,
          label: raw.label,
          normalizedLabel: raw.normalizedLabel,
          labelSpan: this.absolute(raw.labelSpan),
          definitionSpan: this.absolute(raw.definitionSpan)
        });
    }
  }
}

export function convertMarkdown(source: string, options: ConvertOptions): ConvertedMarkdown {
  const lines = scanSourceLines(source);
  const parsed = parseBlocks(source, rootLineViews(lines), options.dialect);
  return new Emitter(parsed, options).emit();
}

