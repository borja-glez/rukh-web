import type { Color } from './game';
import {
  defaultEncoderId,
  defaultStageId,
  detectConditions,
  findEncoderStage,
  findStage,
} from './registry';

export interface Query {
  mock: boolean;
  stage: string;
  /** Encoder stage the evaluation bar would load; nothing is fetched until its own consent. */
  encoder: string;
  color: Color;
}

/**
 * Parses the page query string. `mock` is forced by `?mock=1` and is also true when the
 * requested stage is unknown or is itself the mock, so the E2E suite never downloads anything.
 * Without `?stage=` the default comes from the device (`small-int8` on mobile or with data
 * saver on, `small-fp16` otherwise) and nothing is fetched until the user consents.
 * `?color=b` makes the human play black.
 *
 * `?encoder=` picks the evaluation bar's model the same way (`encoder-int8` on mobile or with
 * data saver on). It is independent of `mock`: the bar is a second model with a second consent,
 * and evaluating a position has nothing to do with who is choosing the moves.
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
  return {
    mock,
    stage: mock ? 'mock' : (stage?.id ?? fallback),
    encoder: encoder?.id ?? encoderFallback,
    color: params.get('color') === 'b' ? 'b' : 'w',
  };
}
