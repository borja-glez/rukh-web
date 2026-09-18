import { describe, expect, it } from 'vitest';
import { INITIAL_FEN } from '../src/lib/game';
import { firstLegalMove } from '../src/lib/opponent';

describe('firstLegalMove', () => {
  it('plays a2a3 from the initial position', async () => {
    const move = await firstLegalMove.pick(INITIAL_FEN);
    expect(`${move.from}${move.to}`).toBe('a2a3');
    expect(move.promotion).toBeUndefined();
  });

  it('is deterministic', async () => {
    const fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
    const first = await firstLegalMove.pick(fen);
    const second = await firstLegalMove.pick(fen);
    expect(first).toEqual(second);
  });
});
