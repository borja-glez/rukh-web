import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import { INITIAL_FEN } from '../src/lib/game';
import { firstLegalMove } from '../src/lib/opponent';

describe('firstLegalMove', () => {
  it('plays a2a3 from the initial position', async () => {
    const move = await firstLegalMove.pick(INITIAL_FEN);
    expect(`${move.from}${move.to}`).toBe('a2a3');
    expect(move.promotion).toBeUndefined();
  });

  it('follows chess.js move order after 1.e4', async () => {
    const chess = new Chess();
    chess.move('e4');
    const [expected] = chess.moves({ verbose: true });
    const move = await firstLegalMove.pick(chess.fen());
    expect(move.from).toBe(expected.from);
    expect(move.to).toBe(expected.to);
    expect(move.promotion).toBeUndefined();
  });
});
