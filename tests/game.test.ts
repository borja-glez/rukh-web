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
