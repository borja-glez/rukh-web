import { describe, expect, it } from 'vitest';
import { parseQuery } from '../src/lib/query';

describe('parseQuery', () => {
  it('?mock=1 forces mock', () => {
    expect(parseQuery('?mock=1')).toEqual({ mock: true, stage: 'mock', color: 'w' });
  });

  it('without query is mock in P0 (the only stage is the mock)', () => {
    expect(parseQuery('')).toEqual({ mock: true, stage: 'mock', color: 'w' });
  });

  it('unknown stage falls back to mock', () => {
    expect(parseQuery('?stage=small-int8')).toEqual({ mock: true, stage: 'mock', color: 'w' });
  });

  it('reads the colour', () => {
    expect(parseQuery('?color=b').color).toBe('b');
    expect(parseQuery('?color=x').color).toBe('w');
  });
});
