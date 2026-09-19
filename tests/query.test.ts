import { describe, expect, it } from 'vitest';
import { parseQuery } from '../src/lib/query';

describe('parseQuery', () => {
  it('?mock=1 forces mock', () => {
    expect(parseQuery('?mock=1', 'small-fp16', 'encoder-fp16')).toEqual({
      mock: true,
      stage: 'mock',
      encoder: 'encoder-fp16',
      color: 'w',
    });
    expect(parseQuery('?mock=1&stage=small-int8', 'small-fp16').stage).toBe('mock');
  });

  it('without query takes the device default and is not mock', () => {
    expect(parseQuery('', 'small-int8', 'encoder-int8')).toEqual({
      mock: false,
      stage: 'small-int8',
      encoder: 'encoder-int8',
      color: 'w',
    });
  });

  it('reads a real stage', () => {
    expect(parseQuery('?stage=tiny-int8', 'small-fp16', 'encoder-fp16')).toEqual({
      mock: false,
      stage: 'tiny-int8',
      encoder: 'encoder-fp16',
      color: 'w',
    });
  });

  it('reaches the toy model only through ?stage=test', () => {
    expect(parseQuery('?stage=test', 'small-fp16').stage).toBe('test');
  });

  it('an unknown stage falls back to the default', () => {
    expect(parseQuery('?stage=nope', 'small-int8').stage).toBe('small-int8');
    expect(parseQuery('?stage=nope', 'mock', 'encoder-fp16')).toEqual({
      mock: true,
      stage: 'mock',
      encoder: 'encoder-fp16',
      color: 'w',
    });
  });

  it('reads the encoder independently of the model that plays', () => {
    // The bar is a second model with a second consent: `?mock=1` says nothing about it.
    expect(parseQuery('?encoder=encoder-int8', 'small-fp16').encoder).toBe('encoder-int8');
    expect(parseQuery('?mock=1&encoder=test', 'small-fp16')).toMatchObject({
      mock: true,
      stage: 'mock',
      encoder: 'test',
    });
    // An unknown (or a decoder) id falls back to the device default.
    expect(parseQuery('?encoder=nope', 'small-fp16', 'encoder-int8').encoder).toBe('encoder-int8');
    expect(parseQuery('?encoder=small-fp16', 'small-fp16', 'encoder-fp16').encoder).toBe(
      'encoder-fp16',
    );
  });

  it('reads the colour', () => {
    expect(parseQuery('?color=b', 'mock').color).toBe('b');
    expect(parseQuery('?color=x', 'mock').color).toBe('w');
  });
});
