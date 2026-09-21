/**
 * Arena: two stages play each other in the browser, and the difference is read off the games.
 *
 * The arithmetic is `rukh.eval.match` (M5) ported line for line: every opening is played twice
 * with the colours swapped, the score is A's points over both games, the Elo difference is
 * `400·log10(p / (1 - p))` and its interval comes from a bootstrap over the games. A match
 * measures a **difference** and nothing else: there is no third party here whose mood has to be
 * averaged (D-110), and the number is not a strength.
 *
 * Everything here is pure, so `tests/arena.test.ts` can pin the numbers against the Python
 * implementation without a model in sight.
 */
import { Chess } from 'chess.js';

/** How many plies the random openings have; six, as `rukh eval match` does by default. */
export const OPENING_PLIES = 6;
/** A game that reaches this many plies without a result counts as a draw, and is marked cut. */
export const MAX_PLIES = 300;

/** A small, seeded PRNG so a run with the same seed plays the same openings. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random legal opening of `plies` moves in UCI; retried when it ends the game early. */
export function randomOpening(random: () => number, plies = OPENING_PLIES): string[] {
  for (;;) {
    const chess = new Chess();
    const moves: string[] = [];
    for (let i = 0; i < plies; i += 1) {
      const legal = chess.moves({ verbose: true });
      if (legal.length === 0) break;
      const pick = legal[Math.floor(random() * legal.length)];
      chess.move(pick);
      moves.push(`${pick.from}${pick.to}${pick.promotion ?? ''}`);
    }
    if (moves.length === plies && !chess.isGameOver()) return moves;
  }
}

/** `pairs` openings, each to be played twice with the colours swapped. */
export function openingBook(pairs: number, seed: number, plies = OPENING_PLIES): string[][] {
  const random = mulberry32(seed);
  return Array.from({ length: pairs }, () => randomOpening(random, plies));
}

export interface ArenaGame {
  /** Index in the schedule: game `2k` has A as White on opening `k`, game `2k+1` swaps. */
  index: number;
  opening: string[];
  aWhite: boolean;
  /** A's points: 1, 0.5 or 0. */
  score: number;
  plies: number;
  /** True when the game hit `MAX_PLIES` and was scored as a draw. */
  cut: boolean;
}

export interface ArenaSummary {
  games: number;
  /** A's points over all games, as a fraction. */
  score: number;
  wins: number;
  draws: number;
  losses: number;
  cut: number;
  /** A minus B in Elo, from the score; null until a game has been played. */
  elo: number | null;
  /** 95 % bootstrap interval of `elo`; null with fewer than two games. */
  low: number | null;
  high: number | null;
  /** True when the interval does not contain zero. */
  separated: boolean;
}

/** Elo difference that explains a score, clipped away from 0 and 1 as the harness does. */
export function eloDifference(score: number): number {
  const p = Math.min(Math.max(score, 0.001), 0.999);
  return 400 * Math.log10(p / (1 - p));
}

/**
 * Percentile bootstrap of the Elo difference over the games (`samples` resamples, seeded).
 * The same estimator as `rukh.eval.match.bootstrap_interval`: resample games with replacement,
 * recompute the score, convert.
 */
export function bootstrapElo(
  scores: readonly number[],
  samples = 500,
  seed = 0,
): { low: number; high: number } | null {
  if (scores.length < 2) return null;
  const random = mulberry32(seed);
  const draws: number[] = [];
  for (let s = 0; s < samples; s += 1) {
    let total = 0;
    for (let i = 0; i < scores.length; i += 1) {
      total += scores[Math.floor(random() * scores.length)];
    }
    draws.push(eloDifference(total / scores.length));
  }
  draws.sort((a, b) => a - b);
  const at = (q: number) => draws[Math.min(draws.length - 1, Math.floor(q * draws.length))];
  return { low: at(0.025), high: at(0.975) };
}

export function summarize(games: readonly ArenaGame[], seed = 0): ArenaSummary {
  const scores = games.map((game) => game.score);
  const points = scores.reduce((sum, value) => sum + value, 0);
  const score = games.length > 0 ? points / games.length : 0;
  const interval = bootstrapElo(scores, 500, seed);
  return {
    games: games.length,
    score,
    wins: scores.filter((value) => value === 1).length,
    draws: scores.filter((value) => value === 0.5).length,
    losses: scores.filter((value) => value === 0).length,
    cut: games.filter((game) => game.cut).length,
    elo: games.length > 0 ? eloDifference(score) : null,
    low: interval?.low ?? null,
    high: interval?.high ?? null,
    separated: interval !== null && (interval.low > 0 || interval.high < 0),
  };
}

/** The result of a finished game from A's point of view, given who had White. */
export function scoreFor(result: string | null, aWhite: boolean): number {
  if (result === '1-0') return aWhite ? 1 : 0;
  if (result === '0-1') return aWhite ? 0 : 1;
  return 0.5;
}

/** How many games the match needs to call an edge of `elo` points at 95 % (`labs/m5`). */
export function gamesNeeded(elo: number): number {
  const p = 1 / (1 + 10 ** (-Math.abs(elo) / 400));
  const z = 1.959963985;
  return Math.ceil((z * z * p * (1 - p)) / (p - 0.5) ** 2);
}
