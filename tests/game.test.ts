import { describe, expect, it } from 'vitest';
import {
  applyMove,
  fromFen,
  INITIAL_FEN,
  legalTargets,
  needsPromotion,
  newGame,
  toPgn,
  undoPair,
} from '../src/lib/game';

describe('game', () => {
  it('starts from the initial position', () => {
    const state = newGame();
    expect(state.fen).toBe(INITIAL_FEN);
    expect(state.history).toEqual([]);
    expect(state.turn).toBe('w');
    expect(state.over).toBe(false);
    expect(state.result).toBeNull();
  });

  it('lists legal targets', () => {
    expect(legalTargets(newGame(), 'e2').sort()).toEqual(['e3', 'e4']);
    expect(legalTargets(newGame(), 'e1')).toEqual([]);
  });

  it('returns null for an illegal move', () => {
    expect(applyMove(newGame(), { from: 'e2', to: 'e5' })).toBeNull();
    expect(applyMove(newGame(), { from: 'e7', to: 'e5' })).toBeNull();
  });

  it('applies a legal move', () => {
    const state = applyMove(newGame(), { from: 'e2', to: 'e4' });
    expect(state?.history).toEqual(['e4']);
    expect(state?.turn).toBe('b');
  });

  it('detects promotion', () => {
    const state = fromFen('8/P7/8/8/8/8/8/k6K w - - 0 1');
    expect(needsPromotion(state, 'a7', 'a8')).toBe(true);
    expect(needsPromotion(newGame(), 'e2', 'e4')).toBe(false);
    const promoted = applyMove(state, { from: 'a7', to: 'a8', promotion: 'q' });
    expect(promoted?.history).toEqual(['a8=Q+']);
  });

  it('undoPair after 1.e4 e5 leaves an empty history', () => {
    let state = newGame();
    state = applyMove(state, { from: 'e2', to: 'e4' })!;
    state = applyMove(state, { from: 'e7', to: 'e5' })!;
    const undone = undoPair(state, 'w');
    expect(undone.history).toEqual([]);
    expect(undone.fen).toBe(INITIAL_FEN);
  });

  it('undoPair removes one ply when the opponent is to move', () => {
    const state = applyMove(newGame(), { from: 'e2', to: 'e4' })!;
    expect(undoPair(state, 'w').history).toEqual([]);
    expect(undoPair(newGame(), 'w').history).toEqual([]);
  });

  it('undoPair as black keeps the opponent opening ply when the human has not moved', () => {
    const state = applyMove(newGame(), { from: 'a2', to: 'a3' })!;
    const undone = undoPair(state, 'b');
    expect(undone).toBe(state);
    expect(undone.history).toEqual(['a3']);
  });

  it('undoPair as black removes one pair after the human has replied', () => {
    let state = newGame();
    state = applyMove(state, { from: 'a2', to: 'a3' })!;
    state = applyMove(state, { from: 'e7', to: 'e5' })!;
    state = applyMove(state, { from: 'a3', to: 'a4' })!;
    expect(undoPair(state, 'b').history).toEqual(['a3']);
  });

  it('keeps applying moves to a state built from a custom FEN', () => {
    const start = 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1';
    const first = applyMove(fromFen(start), { from: 'e1', to: 'g1' });
    expect(first?.history).toEqual(['O-O']);
    const second = applyMove(first!, { from: 'e8', to: 'c8' });
    expect(second?.history).toEqual(['O-O', 'O-O-O']);
    expect(second?.turn).toBe('w');
    expect(undoPair(second!, 'w').history).toEqual([]);
    expect(undoPair(second!, 'w').fen).toBe(start);
  });

  it("detects fool's mate", () => {
    let state = newGame();
    for (const [from, to] of [
      ['f2', 'f3'],
      ['e7', 'e5'],
      ['g2', 'g4'],
      ['d8', 'h4'],
    ]) {
      state = applyMove(state, { from, to })!;
    }
    expect(state.history).toEqual(['f3', 'e5', 'g4', 'Qh4#']);
    expect(state.over).toBe(true);
    expect(state.result).toBe('0-1');
  });

  it('exports PGN with headers', () => {
    let state = newGame();
    state = applyMove(state, { from: 'e2', to: 'e4' })!;
    state = applyMove(state, { from: 'e7', to: 'e5' })!;
    const pgn = toPgn(state, { White: 'Humano', Black: 'Primera jugada legal' });
    expect(pgn).toContain('[Event "Rukh demo"]');
    expect(pgn).toContain('[Site "https://rukh.borjaglez.com"]');
    expect(pgn).toMatch(/\[Date "\d{4}\.\d{2}\.\d{2}"\]/);
    expect(pgn).toContain('[White "Humano"]');
    expect(pgn).toContain('[Result "*"]');
    expect(pgn).toContain('1. e4 e5');
  });

  it('reports game over', () => {
    const state = fromFen('7k/6Q1/6K1/8/8/8/8/8 b - - 0 1');
    expect(state.over).toBe(true);
    expect(state.result).toBe('1-0');
  });
});
