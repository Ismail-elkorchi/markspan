import type { MarkdownNode, SourceSpan } from './model.js';
import { walkMarkdown } from './analysis.js';

export type MarkdownSyntaxTokenKind =
  | 'headingMarker'
  | 'quoteMarker'
  | 'listMarker'
  | 'taskMarker'
  | 'codeFence'
  | 'codeInfo'
  | 'codeContent'
  | 'thematicBreak'
  | 'html'
  | 'tableDelimiter'
  | 'definitionLabel'
  | 'definitionDestination'
  | 'definitionTitle'
  | 'footnoteLabel'
  | 'emphasisMarker'
  | 'strongMarker'
  | 'strikethroughMarker'
  | 'codeSpanMarker'
  | 'codeSpanContent'
  | 'linkDestination'
  | 'linkLabel'
  | 'imageDestination'
  | 'imageLabel'
  | 'escapeMarker'
  | 'characterReference'
  | 'hardBreakMarker';

export interface MarkdownSyntaxToken {
  readonly kind: MarkdownSyntaxTokenKind;
  readonly span: SourceSpan;
  readonly nodeId: number;
}

function token(kind: MarkdownSyntaxTokenKind, span: SourceSpan, nodeId: number): MarkdownSyntaxToken {
  return Object.freeze({ kind, span, nodeId });
}

/**
 * Project source syntax ranges from the semantic tree. Tokens are intended for
 * editor styling and may overlap when one construct refers to another source
 * location, such as a reference link and its definition.
 */
export function collectMarkdownSyntaxTokens(root: MarkdownNode): readonly MarkdownSyntaxToken[] {
  const tokens: MarkdownSyntaxToken[] = [];
  for (const { node } of walkMarkdown(root)) {
    switch (node.kind) {
      case 'heading':
        for (const marker of node.markerSpans) tokens.push(token('headingMarker', marker, node.id));
        break;
      case 'blockQuote':
        for (const marker of node.markerSpans) tokens.push(token('quoteMarker', marker, node.id));
        break;
      case 'listItem':
        tokens.push(token('listMarker', node.markerSpan, node.id));
        if (node.task !== null) tokens.push(token('taskMarker', node.task.span, node.id));
        break;
      case 'codeBlock':
        tokens.push(token('codeContent', node.contentSpan, node.id));
        if (node.fence !== null) {
          tokens.push(token('codeFence', node.fence.openingSpan, node.id));
          if (node.fence.closingSpan !== null) tokens.push(token('codeFence', node.fence.closingSpan, node.id));
          if (node.infoSpan !== null) tokens.push(token('codeInfo', node.infoSpan, node.id));
        }
        break;
      case 'thematicBreak':
        tokens.push(token('thematicBreak', node.markerSpan, node.id));
        break;
      case 'htmlBlock':
      case 'htmlInline':
        tokens.push(token('html', node.span, node.id));
        break;
      case 'table':
        tokens.push(token('tableDelimiter', node.delimiterSpan, node.id));
        break;
      case 'linkDefinition':
        tokens.push(token('definitionLabel', node.labelSpan, node.id));
        tokens.push(token('definitionDestination', node.destinationSpan, node.id));
        if (node.titleSpan !== null) tokens.push(token('definitionTitle', node.titleSpan, node.id));
        break;
      case 'footnoteDefinition':
      case 'footnoteReference':
        tokens.push(token('footnoteLabel', node.labelSpan, node.id));
        break;
      case 'emphasis':
        tokens.push(token('emphasisMarker', node.openingMarkerSpan, node.id));
        tokens.push(token('emphasisMarker', node.closingMarkerSpan, node.id));
        break;
      case 'strong':
        tokens.push(token('strongMarker', node.openingMarkerSpan, node.id));
        tokens.push(token('strongMarker', node.closingMarkerSpan, node.id));
        break;
      case 'strikethrough':
        tokens.push(token('strikethroughMarker', node.openingMarkerSpan, node.id));
        tokens.push(token('strikethroughMarker', node.closingMarkerSpan, node.id));
        break;
      case 'codeSpan':
        tokens.push(token('codeSpanMarker', node.openingMarkerSpan, node.id));
        tokens.push(token('codeSpanMarker', node.closingMarkerSpan, node.id));
        tokens.push(token('codeSpanContent', node.contentSpan, node.id));
        break;
      case 'link':
        if (node.destinationSpan !== null) tokens.push(token('linkDestination', node.destinationSpan, node.id));
        if (node.labelSpan !== null) tokens.push(token('linkLabel', node.labelSpan, node.id));
        break;
      case 'image':
        if (node.destinationSpan !== null) tokens.push(token('imageDestination', node.destinationSpan, node.id));
        if (node.labelSpan !== null) tokens.push(token('imageLabel', node.labelSpan, node.id));
        break;
      case 'escape':
        tokens.push(token('escapeMarker', node.markerSpan, node.id));
        break;
      case 'characterReference':
        tokens.push(token('characterReference', node.span, node.id));
        break;
      case 'hardBreak':
        tokens.push(token('hardBreakMarker', node.markerSpan, node.id));
        break;
      case 'document':
      case 'paragraph':
      case 'list':
      case 'tableRow':
      case 'tableCell':
      case 'text':
      case 'softBreak':
        break;
    }
  }
  tokens.sort((left, right) => (
    left.span.start - right.span.start
    || left.span.end - right.span.end
    || left.kind.localeCompare(right.kind)
  ));
  return Object.freeze(tokens);
}
