import { characterEntities } from './entities.js';

const escapable = new Set(Array.from(`!"#$%&'()*+,-./:;<=>?@[\\]^_\`{|}~`));

export interface DecodedReference {
  readonly end: number;
  readonly value: string;
}

function numericCharacter(value: string, radix: number): string {
  const code = Number.parseInt(value, radix);
  const invalid = code < 9
    || code === 11
    || (code > 13 && code < 32)
    || (code > 126 && code < 160)
    || (code > 55_295 && code < 57_344)
    || (code > 64_975 && code < 65_008)
    || (code & 65_535) === 65_535
    || (code & 65_535) === 65_534
    || code > 1_114_111;
  return invalid ? '\ufffd' : String.fromCodePoint(code);
}

export function parseCharacterReference(value: string, start: number): DecodedReference | null {
  if (value.charCodeAt(start) !== 0x26) return null;
  if (value.charCodeAt(start + 1) === 0x23) {
    const hexadecimal = value.charCodeAt(start + 2) === 0x78 || value.charCodeAt(start + 2) === 0x58;
    const digitsStart = start + (hexadecimal ? 3 : 2);
    const maximum = hexadecimal ? 6 : 7;
    let end = digitsStart;
    while (end < value.length && end - digitsStart < maximum) {
      const code = value.charCodeAt(end);
      const digit = code >= 0x30 && code <= 0x39;
      const hexadecimalDigit = hexadecimal && (
        code >= 0x41 && code <= 0x46 || code >= 0x61 && code <= 0x66
      );
      if (!digit && !hexadecimalDigit) break;
      end += 1;
    }
    if (end === digitsStart || value.charCodeAt(end) !== 0x3b) return null;
    return {
      end: end + 1,
      value: numericCharacter(value.slice(digitsStart, end), hexadecimal ? 16 : 10)
    };
  }
  let end = start + 1;
  while (end < value.length && end - start <= 31) {
    const code = value.charCodeAt(end);
    if (!(code >= 0x30 && code <= 0x39 || code >= 0x41 && code <= 0x5a || code >= 0x61 && code <= 0x7a)) break;
    end += 1;
  }
  if (value.charCodeAt(end) !== 0x3b) return null;
  const name = value.slice(start + 1, end);
  const decoded = characterEntities[name as keyof typeof characterEntities];
  return decoded === undefined ? null : { end: end + 1, value: decoded };
}

export function decodeMarkdownString(value: string): string {
  let result = '';
  let cursor = 0;
  let literalStart = 0;
  while (cursor < value.length) {
    const character = value[cursor];
    if (character === '\\' && cursor + 1 < value.length && escapable.has(value[cursor + 1] ?? '')) {
      result += value.slice(literalStart, cursor) + value[cursor + 1];
      cursor += 2;
      literalStart = cursor;
      continue;
    }
    if (character === '&') {
      const reference = parseCharacterReference(value, cursor);
      if (reference !== null) {
        result += value.slice(literalStart, cursor) + reference.value;
        cursor = reference.end;
        literalStart = cursor;
        continue;
      }
    }
    cursor += 1;
  }
  return (result + value.slice(literalStart)).replace(/\0/gu, '\ufffd');
}

export function isEscapable(character: string | undefined): boolean {
  return character !== undefined && escapable.has(character);
}

