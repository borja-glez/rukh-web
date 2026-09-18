import { Chess } from 'chess.js';
import type { Move } from './game';

export interface Opponent {
  id: string;
  label: string;
  pick(fen: string): Promise<Move>;
}

/** Mock opponent: the first legal move in chess.js `moves({ verbose: true })` order. */
export const firstLegalMove: Opponent = {
  id: 'mock',
  label: 'Primera jugada legal',
  async pick(fen) {
    const chess = new Chess(fen);
    const [move] = chess.moves({ verbose: true });
    if (!move) throw new Error('No legal moves in this position');
    return {
      from: move.from,
      to: move.to,
      promotion: move.promotion as Move['promotion'],
    };
  },
};
