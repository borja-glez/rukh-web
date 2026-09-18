import { Chess, type Square } from 'chess.js';

export type Color = 'w' | 'b';
export type Promotion = 'q' | 'r' | 'b' | 'n';

export interface Move {
  from: string;
  to: string;
  promotion?: Promotion;
}

/**
 * Immutable snapshot of a game. `history` is the SAN move list played from `start`, the FEN
 * the game began at (the initial position unless the state was built with `fromFen`).
 */
export interface GameState {
  start: string;
  fen: string;
  history: string[];
  turn: Color;
  over: boolean;
  result: string | null;
}

export const INITIAL_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function fromHistory(start: string, history: string[]): Chess {
  const chess = new Chess(start);
  for (const san of history) chess.move(san);
  return chess;
}

function fromState(state: GameState): Chess {
  return fromHistory(state.start, state.history);
}

function resultOf(chess: Chess): string | null {
  if (chess.isCheckmate()) return chess.turn() === 'w' ? '0-1' : '1-0';
  if (chess.isDraw()) return '1/2-1/2';
  return null;
}

function snapshot(chess: Chess, start: string): GameState {
  return {
    start,
    fen: chess.fen(),
    history: chess.history(),
    turn: chess.turn(),
    over: chess.isGameOver(),
    result: resultOf(chess),
  };
}

export function newGame(): GameState {
  return snapshot(new Chess(), INITIAL_FEN);
}

/** Builds a state from an arbitrary FEN (no history). Used by tests and future share links. */
export function fromFen(fen: string): GameState {
  const chess = new Chess(fen);
  return snapshot(chess, chess.fen());
}

/** Destination squares of every legal move from `from` (deduplicated across promotions). */
export function legalTargets(state: GameState, from: string): string[] {
  const chess = fromState(state);
  const moves = chess.moves({ square: from as Square, verbose: true });
  return [...new Set(moves.map((move) => move.to))];
}

/** True when moving `from` to `to` is a legal pawn move that reaches the last rank. */
export function needsPromotion(state: GameState, from: string, to: string): boolean {
  const chess = fromState(state);
  const moves = chess.moves({ square: from as Square, verbose: true });
  return moves.some((move) => move.to === to && move.promotion !== undefined);
}

/** Applies a move and returns the new state, or `null` when the move is illegal. */
export function applyMove(state: GameState, move: Move): GameState | null {
  const chess = fromState(state);
  try {
    chess.move({ from: move.from, to: move.to, promotion: move.promotion });
  } catch {
    return null;
  }
  return snapshot(chess, state.start);
}

/** True when the human has at least one ply of their own in `history` that undo can remove. */
export function canUndo(state: GameState, human: Color): boolean {
  return state.history.length >= (human === 'b' ? 2 : 1);
}

/**
 * Undoes moves until it is the human's turn again with at least one human move removed:
 * two plies when it is already the human's turn, one when the opponent is to move.
 * Returns `state` unchanged when the human has not moved yet (as black, the opponent's
 * opening ply stays on the board).
 */
export function undoPair(state: GameState, human: Color): GameState {
  if (!canUndo(state, human)) return state;
  const plies = state.turn === human ? 2 : 1;
  const history = state.history.slice(0, Math.max(0, state.history.length - plies));
  return snapshot(fromHistory(state.start, history), state.start);
}

const DEFAULT_HEADERS: Record<string, string> = {
  Event: 'Rukh demo',
  Site: 'https://rukh.borjaglez.com',
};

function today(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}.${pad(now.getMonth() + 1)}.${pad(now.getDate())}`;
}

/** PGN export with the demo headers merged with `headers` (caller wins). */
export function toPgn(state: GameState, headers: Record<string, string>): string {
  const chess = fromState(state);
  const merged: Record<string, string> = {
    ...DEFAULT_HEADERS,
    Date: today(),
    ...headers,
    Result: headers.Result ?? state.result ?? '*',
  };
  for (const [key, value] of Object.entries(merged)) chess.setHeader(key, value);
  return chess.pgn();
}
