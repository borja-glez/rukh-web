// The rule that decides which evaluation the bar draws, and the two pure functions that turn a
// number into something readable. `supersedes` is the interesting one: it is what keeps the bar on
// the player's own move instead of following the board, and getting it wrong is invisible in the
// browser (the bar still moves, it just always talks about the opponent).
import { describe, expect, it } from 'vitest';
import {
  advantage,
  formatValue,
  supersedes,
  whiteShare,
  BLUNDER_THRESHOLD,
  type Evaluation,
} from '../src/islands/EvalBar';

function at(ply: number, byHuman: boolean, value = 0): Evaluation {
  return { value, blunder: 0, move: ply > 0 ? 'e4' : null, ply, byHuman };
}

describe('which evaluation the bar draws', () => {
  it('draws the first answer there is', () => {
    expect(supersedes(at(0, false), null)).toBe(true);
    expect(supersedes(at(7, true), null)).toBe(true);
  });

  it("keeps the player's move up while the opponent replies to it", () => {
    // 1.e4 (ply 1, the human's) is on the bar; the reply lands milliseconds later and loses.
    expect(supersedes(at(2, false), at(1, true))).toBe(false);
    // ...until the player moves again, which is what the bar is for.
    expect(supersedes(at(3, true), at(1, true))).toBe(true);
  });

  it('lets the opponent have the bar while the player has not moved', () => {
    // Playing black: the opening position, then the opponent's first move.
    expect(supersedes(at(1, false), at(0, false))).toBe(true);
    // And the human's answer to it takes it straight back.
    expect(supersedes(at(2, true), at(1, false))).toBe(true);
  });

  it('never goes backwards in the same game', () => {
    expect(supersedes(at(1, true), at(3, true))).toBe(false);
    expect(supersedes(at(0, false), at(2, false))).toBe(false);
    // The same position answered twice is not going backwards.
    expect(supersedes(at(3, true, 0.5), at(3, true, 0.1))).toBe(true);
  });
});

describe('how the bar reads', () => {
  it('always prints the sign, and never a negative zero', () => {
    expect(formatValue(0.4242)).toBe('+0.42');
    expect(formatValue(-0.4242)).toBe('-0.42');
    expect(formatValue(-0.001)).toBe('0.00');
    expect(formatValue(0)).toBe('0.00');
  });

  it('says who is ahead in words, because the colours alone do not', () => {
    expect(advantage(0.4)).toBe('ventaja de las blancas');
    expect(advantage(-0.4)).toBe('ventaja de las negras');
    expect(advantage(0.01)).toBe('igualada');
  });

  it("turns tanh's range into White's share of the track", () => {
    expect(whiteShare(-1)).toBe('0%');
    expect(whiteShare(0)).toBe('50%');
    expect(whiteShare(1)).toBe('100%');
    // Out of range is clamped rather than drawn outside the track.
    expect(whiteShare(9)).toBe('100%');
  });

  it('alerts on a probability, not on a logit', () => {
    expect(BLUNDER_THRESHOLD).toBeGreaterThan(0);
    expect(BLUNDER_THRESHOLD).toBeLessThan(1);
  });

  it('sits where the published head can actually reach it', () => {
    // The blunder head is not calibrated: a blunder is 3.7 % of the labelled rows, so its
    // probabilities sit low and the published encoder never reaches the factory 0.5. Pinning the
    // threshold there made this alert unreachable, which is a bug the types cannot catch -- the
    // demo just never warned. 0.31 is the highest the published head was seen to answer.
    expect(BLUNDER_THRESHOLD).toBeLessThan(0.31);
  });
});
