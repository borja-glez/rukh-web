import { readFileSync } from 'node:fs';
import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import {
  BANDS,
  expectedMoves,
  loadPuzzleSet,
  progressByBand,
  puzzleStart,
  rate,
  uciMove,
  type Puzzle,
  type PuzzleSet,
} from '../src/lib/puzzles';
import { historyUci } from '../src/lib/model';

const SET = JSON.parse(readFileSync('public/puzzles.json', 'utf8')) as PuzzleSet;

describe('public/puzzles.json', () => {
  it('is the exporter’s schema, fifty per band, every one with a real game behind it', () => {
    expect(SET.schema).toBe('rukh-puzzles/1');
    expect(Object.keys(SET.bands).sort()).toEqual([...BANDS].sort());
    for (const band of BANDS) {
      const puzzles = SET.bands[band];
      expect(puzzles).toHaveLength(SET.perBand);
      for (const puzzle of puzzles) {
        expect(puzzle.prefix.length).toBeGreaterThan(0);
        expect(puzzle.moves.length).toBeGreaterThanOrEqual(2);
        expect(puzzle.moves.length % 2).toBe(0);
      }
    }
  });

  it('replays every prefix onto the puzzle’s own position', () => {
    for (const band of BANDS) {
      for (const puzzle of SET.bands[band]) {
        const start = puzzleStart(puzzle);
        expect(start, puzzle.id).not.toBeNull();
        // The prompt the model sees is the real game: the UCI history is the prefix.
        expect(historyUci(start!)).toEqual(puzzle.prefix);
        // And the whole line is legal from there.
        const chess = new Chess(start!.fen);
        for (const uci of puzzle.moves) chess.move(uciMove(uci));
      }
    }
  });
});

describe('the puzzle helpers', () => {
  const puzzle: Puzzle = {
    id: 'x',
    fen: 'r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 3 3',
    moves: ['g8f6', 'h5f7'],
    rating: 1100,
    prefix: ['e2e4', 'e7e5', 'f1c4', 'b8c6', 'd1h5'],
    whiteElo: 1500,
    blackElo: 1450,
  };

  it('asks the model for the odd moves of the line only', () => {
    expect(expectedMoves(puzzle)).toEqual(['h5f7']);
    expect(uciMove('e7e8q')).toEqual({ from: 'e7', to: 'e8', promotion: 'q' });
    expect(uciMove('g1f3').promotion).toBeUndefined();
  });

  it('refuses a puzzle whose prefix does not reach its position', () => {
    expect(puzzleStart(puzzle)).not.toBeNull();
    expect(puzzleStart({ ...puzzle, prefix: ['e2e4', 'e7e5'] })).toBeNull();
    expect(puzzleStart({ ...puzzle, prefix: ['e2e5'] })).toBeNull();
  });

  it('reports progress per band and formats a rate with a comma', () => {
    const attempts = [
      { id: 'a', band: '1000-1500' as const, rating: 1, solved: true, correct: 1, total: 1 },
      { id: 'b', band: '1000-1500' as const, rating: 1, solved: false, correct: 0, total: 1 },
      { id: 'c', band: '2000+' as const, rating: 1, solved: true, correct: 2, total: 2 },
    ].map((a) => ({ ...a, proposed: null, expected: null }));
    expect(progressByBand(attempts)).toEqual([
      { band: '1000-1500', attempted: 2, solved: 1 },
      { band: '1500-2000', attempted: 0, solved: 0 },
      { band: '2000+', attempted: 1, solved: 1 },
    ]);
    expect(rate(1, 2)).toBe('50,0 %');
    expect(rate(0, 0)).toBe('—');
  });

  it('loads the set through fetch and rejects another schema', async () => {
    const ok = { ok: true, status: 200, statusText: 'OK', json: async () => SET } as Response;
    await expect(loadPuzzleSet('/x', async () => ok)).resolves.toBe(SET);
    const wrong = { ...ok, json: async () => ({ ...SET, schema: 'other' }) } as Response;
    await expect(loadPuzzleSet('/x', async () => wrong)).rejects.toThrow('unknown schema');
    const missing = { ok: false, status: 404, statusText: 'Not Found' } as Response;
    await expect(loadPuzzleSet('/x', async () => missing)).rejects.toThrow('404');
  });
});
