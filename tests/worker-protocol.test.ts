import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  asResponse,
  megabytes,
  MODEL_CACHE,
  ORT_BASE,
  ORT_VERSION,
  progressPercent,
  type WorkerResponse,
} from '../src/lib/worker-protocol';

describe('worker protocol', () => {
  it('serves the ORT runtime from the installed version', () => {
    const installed = JSON.parse(
      readFileSync(
        new URL('../node_modules/onnxruntime-web/package.json', import.meta.url),
        'utf8',
      ),
    ).version;
    expect(ORT_VERSION).toBe(installed);
    expect(ORT_BASE).toBe(`/ort/${installed}/`);
  });

  it('versions the model cache', () => {
    expect(MODEL_CACHE).toMatch(/^rukh-models-v\d+$/);
  });

  it('narrows known responses', () => {
    const ready: WorkerResponse = {
      type: 'ready',
      id: 3,
      backend: 'webgpu',
      loadMs: 12,
      block: 200,
      vocab: 2030,
    };
    expect(asResponse(ready)).toBe(ready);
    expect(asResponse({ type: 'progress', id: 1, loaded: 2, total: 4 })).not.toBeNull();
    expect(asResponse({ type: 'error', id: 1, message: 'boom' })).not.toBeNull();
  });

  it('rejects anything else', () => {
    expect(asResponse(null)).toBeNull();
    expect(asResponse('ready')).toBeNull();
    expect(asResponse({ type: 'ready' })).toBeNull();
    expect(asResponse({ type: 'unknown', id: 1 })).toBeNull();
    expect(asResponse({ id: 1 })).toBeNull();
  });

  it('reports progress as a bounded percentage', () => {
    expect(progressPercent({ loaded: 0, total: 0 })).toBe(0);
    expect(progressPercent({ loaded: 5, total: 10 })).toBe(50);
    expect(progressPercent({ loaded: 30, total: 10 })).toBe(100);
  });

  it('shows sizes in MB with one decimal', () => {
    expect(megabytes(0)).toBe(0);
    expect(megabytes(1_250_000)).toBe(1.3);
    expect(megabytes(40_000_000)).toBe(40);
  });
});
