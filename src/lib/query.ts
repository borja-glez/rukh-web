import type { Color } from './game';
import { findStage, STAGES } from './registry';

export interface Query {
  mock: boolean;
  stage: string;
  color: Color;
}

/**
 * Parses the page query string. `mock` is forced by `?mock=1` and is also true when the
 * requested stage is unknown or is itself a mock; in P0 every stage is a mock, so `mock`
 * is always true. `?color=b` makes the human play black.
 */
export function parseQuery(search: string): Query {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const requested = params.get('stage') ?? STAGES[0].id;
  const stage = findStage(requested);
  const mock = params.get('mock') === '1' || stage === undefined || stage.kind === 'mock';
  return {
    mock,
    stage: stage?.id ?? STAGES[0].id,
    color: params.get('color') === 'b' ? 'b' : 'w',
  };
}
