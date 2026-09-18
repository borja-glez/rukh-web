import type { Color } from './game';
import { defaultStageId, detectConditions, findStage } from './registry';

export interface Query {
  mock: boolean;
  stage: string;
  color: Color;
}

/**
 * Parses the page query string. `mock` is forced by `?mock=1` and is also true when the
 * requested stage is unknown or is itself the mock, so the E2E suite never downloads anything.
 * Without `?stage=` the default comes from the device (`small-int8` on mobile or with data
 * saver on, `small-fp16` otherwise) and nothing is fetched until the user consents.
 * `?color=b` makes the human play black.
 */
export function parseQuery(search: string, fallback = defaultStageId(detectConditions())): Query {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const requested = params.get('stage') ?? fallback;
  const stage = findStage(requested) ?? findStage(fallback);
  const mock = params.get('mock') === '1' || stage === undefined || stage.kind === 'mock';
  return {
    mock,
    stage: mock ? 'mock' : (stage?.id ?? fallback),
    color: params.get('color') === 'b' ? 'b' : 'w',
  };
}
