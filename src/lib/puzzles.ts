/**
 * Live puzzles: the harness's puzzle criterion (`rukh.eval.puzzles`), in the browser.
 *
 * A puzzle is attempted the way the table measured it (D-053): the model is prompted with the
 * **real game** that led to the position, with the players' own ratings in the header, and it
 * has to find the **whole** line, not the first move. `moves[0]` is the opponent's move that
 * sets the puzzle (Lichess's convention), then the sides alternate; the model answers the odd
 * indices and the opponent's replies are played from the solution.
 *
 * `public/puzzles.json` is written by `labs/m6/puzzles_export.py` in the ML repository from the
 * `test` split of `chorcat/rukh-puzzles-split`, fifty per band, seeded.
 */
import { Chess } from 'chess.js';
import { INITIAL_FEN, type GameState, type Move } from './game';

export interface Puzzle {
  id: string;
  fen: string;
  moves: string[];
  rating: number;
  prefix: string[];
  whiteElo: number | null;
  blackElo: number | null;
}

export interface PuzzleSet {
  schema: string;
  source: string;
  seed: number;
  perBand: number;
  generated: string;
  bands: Record<string, Puzzle[]>;
}

export const BANDS = ['1000-1500', '1500-2000', '2000+'] as const;
export type Band = (typeof BANDS)[number];

export const PUZZLES_URL = '/puzzles.json';

export async function loadPuzzleSet(
  url = PUZZLES_URL,
  fetcher: typeof fetch = fetch,
): Promise<PuzzleSet> {
  const response = await fetcher(url);
  if (!response.ok) throw new Error(`puzzles: ${response.status} ${response.statusText}`);
  const data = (await response.json()) as PuzzleSet;
  if (data.schema !== 'rukh-puzzles/1') throw new Error(`puzzles: unknown schema ${data.schema}`);
  return data;
}

/** UCI `e7e8q` as a `Move`. */
export function uciMove(uci: string): Move {
  return {
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    promotion: (uci.slice(4, 5) || undefined) as Move['promotion'],
  };
}

/**
 * The game state the puzzle starts from: the real game replayed from the initial position, so
 * the prompt carries the prefix, and the board is the puzzle's FEN. Replaying the prefix must
 * land on that FEN (the first four fields); when it does not, the puzzle is malformed and is
 * skipped rather than attempted from a position the model never reached.
 */
export function puzzleStart(puzzle: Puzzle): GameState | null {
  const chess = new Chess();
  try {
    for (const uci of puzzle.prefix) chess.move(uciMove(uci));
  } catch {
    return null;
  }
  const reached = chess.fen().split(' ').slice(0, 4).join(' ');
  const expected = puzzle.fen.split(' ').slice(0, 4).join(' ');
  if (reached !== expected) return null;
  return {
    start: INITIAL_FEN,
    fen: chess.fen(),
    history: chess.history(),
    turn: chess.turn(),
    over: chess.isGameOver(),
    result: null,
  };
}

/** The moves the model has to find: the odd indices of the line. */
export function expectedMoves(puzzle: Puzzle): string[] {
  return puzzle.moves.filter((_, index) => index % 2 === 1);
}

export interface PuzzleAttempt {
  id: string;
  band: Band;
  rating: number;
  solved: boolean;
  /** Model moves that matched before the first miss. */
  correct: number;
  total: number;
  /** What the model proposed at the first miss (UCI), and what the line expected. */
  proposed: string | null;
  expected: string | null;
}

export interface BandProgress {
  band: Band;
  attempted: number;
  solved: number;
}

export function progressByBand(attempts: readonly PuzzleAttempt[]): BandProgress[] {
  return BANDS.map((band) => {
    const own = attempts.filter((attempt) => attempt.band === band);
    return { band, attempted: own.length, solved: own.filter((a) => a.solved).length };
  });
}

/** `12,3 %`-style rate, or an em dash before anything was attempted. */
export function rate(solved: number, attempted: number): string {
  if (attempted === 0) return '—';
  return `${((100 * solved) / attempted).toFixed(1).replace('.', ',')} %`;
}
