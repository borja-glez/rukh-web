// Parity with `rukh/src/rukh/models/squares.py`, the encoder's input scheme. The fixture under
// src/lib/chess-lm/fixtures/ is generated from that module itself (its vocabulary, its hash and
// the ids it answers for 44 positions), so a drift between the two files fails here instead of
// showing a quietly wrong evaluation bar in the browser.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildSquareVocab,
  castlingStrings,
  clockBucket,
  fenToTokens,
  tokensToStrings,
  CLS_ID,
  EMPTY_ID,
  SQUARE_TOKENS,
  SQUARE_VOCAB,
  SQUARE_VOCAB_SIZE,
} from '../src/lib/chess-lm/squares';

interface SquaresFixture {
  source: string;
  tokens: number;
  vocab: string[];
  vocab_hash: string;
  cases: { fen: string; ids: number[] }[];
}

function readFixture(): SquaresFixture {
  const path = resolve(import.meta.dirname, '../src/lib/chess-lm/fixtures/squares.json');
  if (!existsSync(path)) throw new Error(`fixture missing: ${path}`);
  return JSON.parse(readFileSync(path, 'utf8')) as SquaresFixture;
}

const fixture = readFixture();

describe('the squares scheme', () => {
  it('has the 69 fixed positions and the 47-token vocabulary', () => {
    expect(SQUARE_TOKENS).toBe(69);
    expect(SQUARE_TOKENS).toBe(fixture.tokens);
    expect(SQUARE_VOCAB_SIZE).toBe(47);
    expect(SQUARE_VOCAB).toEqual(buildSquareVocab());
  });

  it('builds the vocabulary Python built, token for token', () => {
    expect(SQUARE_VOCAB).toEqual(fixture.vocab);
  });

  it('answers the identity Python pins the scheme with', () => {
    // `squares.vocab_hash()`: sha256 of the vocabulary as a compact JSON list, which is exactly
    // what `JSON.stringify` writes. A change to the enumeration invalidates every encoder trained
    // with it, so the hash is asserted here and not merely carried in the fixture.
    const hash = createHash('sha256').update(JSON.stringify(SQUARE_VOCAB), 'ascii').digest('hex');
    expect(hash).toBe(fixture.vocab_hash);
  });

  it('lists the 16 castling combinations in the Python order', () => {
    const rights = castlingStrings();
    expect(rights).toHaveLength(16);
    expect(rights.slice(0, 5)).toEqual(['-', 'K', 'Q', 'KQ', 'k']);
    expect(rights[15]).toBe('KQkq');
  });

  it('buckets the halfmove clock at 6, 25 and 50', () => {
    expect([0, 5].map(clockBucket)).toEqual([0, 0]);
    expect([6, 24].map(clockBucket)).toEqual([1, 1]);
    expect([25, 49].map(clockBucket)).toEqual([2, 2]);
    expect([50, 137].map(clockBucket)).toEqual([3, 3]);
    expect(() => clockBucket(-1)).toThrow(/negative/);
  });

  it('reproduces every id Python answered, for all 44 fixture positions', () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(30);
    for (const [index, entry] of fixture.cases.entries()) {
      expect(fenToTokens(entry.fen), `${index}: ${entry.fen}`).toEqual(entry.ids);
    }
  });

  it('answers exactly 69 ids inside the vocabulary for every fixture position', () => {
    for (const entry of fixture.cases) {
      const ids = fenToTokens(entry.fen);
      expect(ids).toHaveLength(SQUARE_TOKENS);
      expect(ids.every((id) => Number.isInteger(id) && id >= 0 && id < SQUARE_VOCAB_SIZE)).toBe(
        true,
      );
      expect(ids[0]).toBe(CLS_ID);
    }
  });

  it('lays the start position out file-major with <cls> first', () => {
    const names = tokensToStrings(fenToTokens(fixture.cases[0].fen));
    expect(names[0]).toBe('<cls>');
    // a1 is a white rook, a2 a white pawn, a3..a6 empty, a7 a black pawn, a8 a black rook.
    expect(names.slice(1, 9)).toEqual([
      'R',
      'P',
      '<empty>',
      '<empty>',
      '<empty>',
      '<empty>',
      'p',
      'r',
    ]);
    // e1 is the white king: the fifth file, first rank.
    expect(names[1 + 4 * 8]).toBe('K');
    expect(names.slice(65)).toEqual(['turn:w', 'castle:KQkq', 'ep:none', 'clock:0']);
  });

  it('normalises a castling field written out of order', () => {
    const fen = 'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w ';
    expect(fenToTokens(`${fen}qkQK - 0 1`)).toEqual(fenToTokens(`${fen}KQkq - 0 1`));
  });

  it('accepts a four-field FEN and reads it as clock:0', () => {
    const four = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -';
    expect(fenToTokens(four)).toEqual(fenToTokens(`${four} 0 1`));
    expect(tokensToStrings(fenToTokens(four))[68]).toBe('clock:0');
  });

  it('reads the en-passant file and forgets the rank', () => {
    const names = tokensToStrings(
      fenToTokens('rnbqkbnr/ppp1pppp/8/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 3'),
    );
    expect(names[67]).toBe('ep:d');
  });

  it('refuses a FEN it would have to repair', () => {
    expect(() => fenToTokens('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP w KQkq -')).toThrow(/8 ranks/);
    expect(() => fenToTokens('8/8/8/8/8/8/8/8 x - - 0 1')).toThrow(/side to move/);
    expect(() => fenToTokens('8/8/8/8/8/8/8/8 w - z9 0 1')).toThrow(/en-passant/);
    expect(() => fenToTokens('8/8/8/8/8/8/8/8 w D - 0 1')).toThrow(/castling/);
    expect(() => fenToTokens('9/8/8/8/8/8/8/8 w - - 0 1')).toThrow(/files/);
    expect(() => fenToTokens('rnbqkbnr w KQkq')).toThrow(/at least 4 fields/);
    expect(() => fenToTokens('8/8/8/8/8/8/8/8 w - -')).not.toThrow();
  });

  it('fills the empty squares with <empty>', () => {
    const ids = fenToTokens('8/8/8/8/8/8/8/8 w - - 0 1');
    expect(ids.slice(1, 65).every((id) => id === EMPTY_ID)).toBe(true);
  });
});
