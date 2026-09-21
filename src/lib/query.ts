import { Chess } from 'chess.js';
import type { Color } from './game';
import {
  defaultEncoderId,
  defaultStageId,
  detectConditions,
  findEncoderStage,
  findStage,
} from './registry';

/** The three things the screen can do: play the model, watch two stages play, solve puzzles. */
export type Mode = 'play' | 'arena' | 'puzzles';
export const MODES: readonly Mode[] = ['play', 'arena', 'puzzles'];

export interface Query {
  mock: boolean;
  stage: string;
  /** Encoder stage the evaluation bar would load; nothing is fetched until its own consent. */
  encoder: string;
  color: Color;
  mode: Mode;
  /** A position to start from (`?fen=`), when it parses; null otherwise. */
  fen: string | null;
  /** The second stage of the arena (`?vs=`), when it is a known stage. */
  vs: string | null;
}

/**
 * Parses the page query string. `mock` is forced by `?mock=1` and is also true when the
 * requested stage is unknown or is itself the mock, so the E2E suite never downloads anything.
 * Without `?stage=` the default comes from the device (`small-fp16` wherever WebGPU runs,
 * `small-int8` on the WASM fallback or with data saver on) and nothing is fetched until the
 * user consents.
 * `?color=b` makes the human play black.
 *
 * `?encoder=` picks the evaluation bar's model the same way (`encoder-int8` on mobile or with
 * data saver on). It is independent of `mock`: the bar is a second model with a second consent,
 * and evaluating a position has nothing to do with who is choosing the moves.
 *
 * `?mode=arena|puzzles` opens the screen in one of the two other modes; `?fen=` shares a
 * position (validated with chess.js, silently ignored when it is not one); `?vs=` names the
 * arena's second stage.
 */
export function parseQuery(
  search: string,
  fallback = defaultStageId(detectConditions()),
  encoderFallback = defaultEncoderId(detectConditions()),
): Query {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const requested = params.get('stage') ?? fallback;
  const stage = findStage(requested) ?? findStage(fallback);
  const mock = params.get('mock') === '1' || stage === undefined || stage.kind === 'mock';
  const encoder = findEncoderStage(params.get('encoder') ?? encoderFallback);
  const mode = params.get('mode');
  const vs = params.get('vs');
  return {
    mock,
    stage: mock ? 'mock' : (stage?.id ?? fallback),
    encoder: encoder?.id ?? encoderFallback,
    color: params.get('color') === 'b' ? 'b' : 'w',
    mode: mode !== null && (MODES as readonly string[]).includes(mode) ? (mode as Mode) : 'play',
    fen: validFen(params.get('fen')),
    vs: vs !== null && findStage(vs) ? vs : null,
  };
}

/** `fen` when chess.js accepts it as a position, else null. */
export function validFen(fen: string | null): string | null {
  if (!fen) return null;
  try {
    return new Chess(fen).fen();
  } catch {
    return null;
  }
}
