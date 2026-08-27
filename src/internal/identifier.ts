/** CommonMark label normalization with Unicode-compatible case folding. */
export function normalizeMarkdownIdentifier(value: string): string {
  return value
    .replace(/[\t\n\r ]+/gu, ' ')
    .replace(/^ | $/gu, '')
    .toLowerCase()
    .toUpperCase()
    .toLowerCase();
}
