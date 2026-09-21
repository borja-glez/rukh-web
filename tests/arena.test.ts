import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import {
  bootstrapElo,
  eloDifference,
  gamesNeeded,
  mulberry32,
  openingBook,
  randomOpening,
  scoreFor,
  summarize,
  type ArenaGame,
} from '../src/lib/arena';

function game(index: number, score: number, cut = false): ArenaGame {
  return { index, opening: [], aWhite: index % 2 === 0, score, plies: 40, cut };
}

describe('the arena arithmetic (rukh.eval.match, ported)', () => {
  it('turns a score into an Elo difference the way the harness does', () => {
    expect(eloDifference(0.5)).toBe(0);
    // 50 Elo is a 0.5715 score; the harness's figure for the games such an edge needs is 185.
    expect(eloDifference(0.5715)).toBeCloseTo(50, 0);
    expect(gamesNeeded(50)).toBe(185);
    // The clip keeps a whitewash finite, at the same bound as Python (p = 0.999).
    expect(eloDifference(1)).toBeCloseTo(400 * Math.log10(0.999 / 0.001), 6);
  });

  it('bootstraps an interval that contains the point estimate and shrinks with games', () => {
    const balanced = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 1 : 0));
    const forty = bootstrapElo(balanced, 500, 1)!;
    expect(forty.low).toBeLessThan(0);
    expect(forty.high).toBeGreaterThan(0);
    const four = bootstrapElo(balanced.slice(0, 4), 500, 1)!;
    expect(four.high - four.low).toBeGreaterThan(forty.high - forty.low);
    expect(bootstrapElo([1], 500, 1)).toBeNull();
    // Seeded: the same games give the same interval.
    expect(bootstrapElo(balanced, 500, 7)).toEqual(bootstrapElo(balanced, 500, 7));
  });

  it('summarises a match with counts, the difference and whether zero is inside', () => {
    const even = summarize([game(0, 1), game(1, 0), game(2, 0.5), game(3, 0.5)]);
    expect(even).toMatchObject({ games: 4, wins: 1, draws: 2, losses: 1, score: 0.5, elo: 0 });
    expect(even.separated).toBe(false);
    const rout = summarize(Array.from({ length: 30 }, (_, i) => game(i, 1)));
    expect(rout.elo).toBeGreaterThan(400);
    expect(rout.separated).toBe(true);
    expect(summarize([]).elo).toBeNull();
    expect(summarize([game(0, 0.5, true)]).cut).toBe(1);
  });

  it('scores a result from A’s side whoever had White', () => {
    expect(scoreFor('1-0', true)).toBe(1);
    expect(scoreFor('1-0', false)).toBe(0);
    expect(scoreFor('0-1', false)).toBe(1);
    expect(scoreFor('1/2-1/2', true)).toBe(0.5);
    expect(scoreFor(null, true)).toBe(0.5);
  });

  it('draws seeded legal openings that leave the game open', () => {
    const book = openingBook(3, 42);
    expect(book).toHaveLength(3);
    for (const opening of book) {
      expect(opening).toHaveLength(6);
      const chess = new Chess();
      for (const uci of opening) chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4) });
      expect(chess.isGameOver()).toBe(false);
    }
    expect(openingBook(3, 42)).toEqual(book);
    expect(openingBook(3, 43)).not.toEqual(book);
    expect(randomOpening(mulberry32(1), 2)).toHaveLength(2);
  });
});
