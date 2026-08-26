/** A half-open range in the original JavaScript string, measured in UTF-16 code units. */
export interface SourceSpan {
  readonly start: number;
  readonly end: number;
}

export interface MarkdownNodeBase<Kind extends string> {
  /** Unique inside a document session and stable while the syntax node is reused. */
  readonly id: number;
  readonly kind: Kind;
  /** Exact source range owned by this node. */
  readonly span: SourceSpan;
}

export interface MarkdownDocumentNode extends MarkdownNodeBase<'document'> {
  readonly children: readonly MarkdownBlockNode[];
}

export interface MarkdownParagraphNode extends MarkdownNodeBase<'paragraph'> {
  readonly contentSpan: SourceSpan;
  readonly children: readonly MarkdownInlineNode[];
}

export interface MarkdownHeadingNode extends MarkdownNodeBase<'heading'> {
  readonly depth: 1 | 2 | 3 | 4 | 5 | 6;
  readonly style: 'atx' | 'setext';
  readonly markerSpans: readonly SourceSpan[];
  readonly contentSpan: SourceSpan;
  readonly children: readonly MarkdownInlineNode[];
}

export interface MarkdownBlockQuoteNode extends MarkdownNodeBase<'blockQuote'> {
  readonly markerSpans: readonly SourceSpan[];
  readonly children: readonly MarkdownBlockNode[];
}

export type MarkdownCalloutKind = 'note' | 'tip' | 'important' | 'warning' | 'caution';

export interface MarkdownCalloutNode extends MarkdownNodeBase<'callout'> {
  readonly calloutKind: MarkdownCalloutKind;
  readonly markerSpans: readonly SourceSpan[];
  readonly labelSpan: SourceSpan;
  readonly children: readonly MarkdownBlockNode[];
}

export interface MarkdownFrontMatterEntry {
  readonly key: string;
  readonly value: string;
  readonly keySpan: SourceSpan;
  readonly valueSpan: SourceSpan;
}

export interface MarkdownFrontMatterNode extends MarkdownNodeBase<'frontMatter'> {
  readonly raw: string;
  readonly openingMarkerSpan: SourceSpan;
  readonly closingMarkerSpan: SourceSpan | null;
  readonly entries: readonly MarkdownFrontMatterEntry[];
}

export type MarkdownListDelimiter = '.' | ')' | null;
export type MarkdownBulletMarker = '-' | '+' | '*' | null;

export interface MarkdownListNode extends MarkdownNodeBase<'list'> {
  readonly ordered: boolean;
  readonly start: number | null;
  readonly delimiter: MarkdownListDelimiter;
  readonly bullet: MarkdownBulletMarker;
  readonly tight: boolean;
  readonly items: readonly MarkdownListItemNode[];
}

export interface MarkdownTaskMarker {
  readonly checked: boolean;
  readonly span: SourceSpan;
}

export interface MarkdownListItemNode extends MarkdownNodeBase<'listItem'> {
  readonly markerSpan: SourceSpan;
  /** Required continuation indentation in virtual columns; source tabs remain unchanged. */
  readonly contentIndent: number;
  /** Whether blank lines make this individual item loose. */
  readonly spread: boolean;
  readonly task: MarkdownTaskMarker | null;
  readonly children: readonly MarkdownBlockNode[];
}

export interface MarkdownFence {
  readonly character: '`' | '~';
  readonly length: number;
  readonly indentation: number;
  readonly openingSpan: SourceSpan;
  readonly closingSpan: SourceSpan | null;
}

export interface MarkdownCodeBlockNode extends MarkdownNodeBase<'codeBlock'> {
  readonly style: 'fenced' | 'indented';
  readonly value: string;
  readonly contentSpan: SourceSpan;
  readonly info: string | null;
  readonly infoSpan: SourceSpan | null;
  readonly language: string | null;
  readonly fence: MarkdownFence | null;
}

export interface MarkdownMathBlockNode extends MarkdownNodeBase<'mathBlock'> {
  readonly value: string;
  readonly contentSpan: SourceSpan;
  readonly openingMarkerSpan: SourceSpan;
  readonly closingMarkerSpan: SourceSpan | null;
}

export interface MarkdownThematicBreakNode extends MarkdownNodeBase<'thematicBreak'> {
  readonly marker: '*' | '-' | '_';
  readonly markerSpan: SourceSpan;
}

export type MarkdownHtmlBlockType = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface MarkdownHtmlBlockNode extends MarkdownNodeBase<'htmlBlock'> {
  readonly value: string;
  readonly htmlBlockType: MarkdownHtmlBlockType;
}

export interface MarkdownLinkDefinitionNode extends MarkdownNodeBase<'linkDefinition'> {
  readonly label: string;
  readonly normalizedLabel: string;
  readonly labelSpan: SourceSpan;
  readonly destination: string;
  readonly destinationSpan: SourceSpan;
  readonly title: string | null;
  readonly titleSpan: SourceSpan | null;
  /** False for duplicate definitions ignored by reference resolution. */
  readonly active: boolean;
}

export interface MarkdownFootnoteDefinitionNode extends MarkdownNodeBase<'footnoteDefinition'> {
  readonly label: string;
  readonly normalizedLabel: string;
  readonly labelSpan: SourceSpan;
  /** False for duplicate definitions ignored by footnote resolution. */
  readonly active: boolean;
  readonly children: readonly MarkdownBlockNode[];
}

export type MarkdownTableAlignment = 'left' | 'center' | 'right' | null;

export interface MarkdownTableNode extends MarkdownNodeBase<'table'> {
  readonly align: readonly MarkdownTableAlignment[];
  readonly delimiterSpan: SourceSpan;
  readonly header: MarkdownTableRowNode;
  readonly rows: readonly MarkdownTableRowNode[];
}

export interface MarkdownTableRowNode extends MarkdownNodeBase<'tableRow'> {
  readonly cells: readonly MarkdownTableCellNode[];
}

export interface MarkdownTableCellNode extends MarkdownNodeBase<'tableCell'> {
  readonly column: number;
  readonly contentSpan: SourceSpan;
  readonly children: readonly MarkdownInlineNode[];
}

export interface MarkdownTextNode extends MarkdownNodeBase<'text'> {
  readonly value: string;
}

export interface MarkdownEscapeNode extends MarkdownNodeBase<'escape'> {
  readonly value: string;
  readonly markerSpan: SourceSpan;
}

export interface MarkdownCharacterReferenceNode extends MarkdownNodeBase<'characterReference'> {
  readonly value: string;
  readonly reference: string;
}

export interface MarkdownEmphasisNode extends MarkdownNodeBase<'emphasis'> {
  readonly openingMarkerSpan: SourceSpan;
  readonly closingMarkerSpan: SourceSpan;
  readonly children: readonly MarkdownInlineNode[];
}

export interface MarkdownStrongNode extends MarkdownNodeBase<'strong'> {
  readonly openingMarkerSpan: SourceSpan;
  readonly closingMarkerSpan: SourceSpan;
  readonly children: readonly MarkdownInlineNode[];
}

export interface MarkdownStrikethroughNode extends MarkdownNodeBase<'strikethrough'> {
  readonly openingMarkerSpan: SourceSpan;
  readonly closingMarkerSpan: SourceSpan;
  readonly children: readonly MarkdownInlineNode[];
}

export interface MarkdownCodeSpanNode extends MarkdownNodeBase<'codeSpan'> {
  readonly value: string;
  readonly contentSpan: SourceSpan;
  readonly openingMarkerSpan: SourceSpan;
  readonly closingMarkerSpan: SourceSpan;
}

export interface MarkdownMathInlineNode extends MarkdownNodeBase<'mathInline'> {
  readonly value: string;
  readonly contentSpan: SourceSpan;
  readonly openingMarkerSpan: SourceSpan;
  readonly closingMarkerSpan: SourceSpan;
}

export type MarkdownLinkForm =
  | 'inline'
  | 'fullReference'
  | 'collapsedReference'
  | 'shortcutReference'
  | 'autolink'
  | 'gfmAutolink';

export interface MarkdownLinkNode extends MarkdownNodeBase<'link'> {
  readonly form: MarkdownLinkForm;
  readonly destination: string;
  readonly destinationSpan: SourceSpan | null;
  readonly title: string | null;
  readonly titleSpan: SourceSpan | null;
  readonly label: string | null;
  readonly labelSpan: SourceSpan | null;
  readonly definitionSpan: SourceSpan | null;
  readonly children: readonly MarkdownInlineNode[];
}

export interface MarkdownImageNode extends MarkdownNodeBase<'image'> {
  readonly form: Exclude<MarkdownLinkForm, 'autolink' | 'gfmAutolink'>;
  readonly destination: string;
  readonly destinationSpan: SourceSpan | null;
  readonly title: string | null;
  readonly titleSpan: SourceSpan | null;
  readonly label: string | null;
  readonly labelSpan: SourceSpan | null;
  readonly definitionSpan: SourceSpan | null;
  readonly children: readonly MarkdownInlineNode[];
}

export interface MarkdownSoftBreakNode extends MarkdownNodeBase<'softBreak'> {}

export interface MarkdownHardBreakNode extends MarkdownNodeBase<'hardBreak'> {
  readonly markerSpan: SourceSpan;
  readonly marker: 'spaces' | 'backslash';
}

export interface MarkdownHtmlInlineNode extends MarkdownNodeBase<'htmlInline'> {
  readonly value: string;
}

export interface MarkdownFootnoteReferenceNode extends MarkdownNodeBase<'footnoteReference'> {
  readonly label: string;
  readonly normalizedLabel: string;
  readonly labelSpan: SourceSpan;
  readonly definitionSpan: SourceSpan;
}

export type MarkdownBlockNode =
  | MarkdownParagraphNode
  | MarkdownHeadingNode
  | MarkdownBlockQuoteNode
  | MarkdownCalloutNode
  | MarkdownFrontMatterNode
  | MarkdownListNode
  | MarkdownCodeBlockNode
  | MarkdownMathBlockNode
  | MarkdownThematicBreakNode
  | MarkdownHtmlBlockNode
  | MarkdownLinkDefinitionNode
  | MarkdownFootnoteDefinitionNode
  | MarkdownTableNode;

export type MarkdownInlineNode =
  | MarkdownTextNode
  | MarkdownEscapeNode
  | MarkdownCharacterReferenceNode
  | MarkdownEmphasisNode
  | MarkdownStrongNode
  | MarkdownStrikethroughNode
  | MarkdownCodeSpanNode
  | MarkdownMathInlineNode
  | MarkdownLinkNode
  | MarkdownImageNode
  | MarkdownSoftBreakNode
  | MarkdownHardBreakNode
  | MarkdownHtmlInlineNode
  | MarkdownFootnoteReferenceNode;

export type MarkdownNode =
  | MarkdownDocumentNode
  | MarkdownBlockNode
  | MarkdownListItemNode
  | MarkdownTableRowNode
  | MarkdownTableCellNode
  | MarkdownInlineNode;

export type MarkdownNodeKind = MarkdownNode['kind'];

export type MarkdownNodeOfKind<Kind extends MarkdownNodeKind> = Extract<MarkdownNode, { readonly kind: Kind }>;

export interface MarkdownReferenceDefinition {
  readonly label: string;
  readonly normalizedLabel: string;
  readonly destination: string;
  readonly title: string | null;
  readonly span: SourceSpan;
  readonly nodeId: number;
}

export interface MarkdownFootnoteDefinition {
  readonly label: string;
  readonly normalizedLabel: string;
  readonly span: SourceSpan;
  readonly nodeId: number;
}

export type MarkdownDiagnosticSeverity = 'info' | 'warning' | 'error';

export interface MarkdownDiagnostic {
  readonly code:
    | 'duplicate-reference-definition'
    | 'duplicate-footnote-definition'
    | 'invalid-front-matter'
    | 'unclosed-front-matter'
    | 'unclosed-math';
  readonly severity: MarkdownDiagnosticSeverity;
  readonly message: string;
  readonly span: SourceSpan;
}
