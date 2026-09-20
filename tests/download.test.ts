import { describe, expect, it, vi } from 'vitest';
import { downloadModel, isCached, type DownloadDeps } from '../src/lib/download';

const CACHE = 'rukh-models-test';
const URL = 'https://example.invalid/model.onnx';

/** A cache whose every call is appended to `log`, so the order of events can be asserted. */
function fakeCaches(log: string[], stored?: Response) {
  const put = vi.fn(async () => {
    log.push('cache.put');
  });
  const cache = {
    match: async () => stored,
    put,
  };
  return { caches: { open: async () => cache } as unknown as CacheStorage, put };
}

/**
 * A response whose body is driven by hand: `feed` pushes one chunk, `finish` closes the stream.
 * Nothing is enqueued until the test says so, which is the only way to prove that progress is
 * reported *while* the body arrives rather than after it.
 */
function drip(headers: Record<string, string> = {}) {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    response: new Response(body, { status: 200, headers }),
    feed: (size: number) => controller.enqueue(new Uint8Array(size).fill(7)),
    finish: () => controller.close(),
  };
}

describe('downloading the weights', () => {
  it('reports progress while the body streams, and caches only at the end', async () => {
    const log: string[] = [];
    const { caches, put } = fakeCaches(log);
    const stream = drip({ 'content-length': '30' });
    const deps: DownloadDeps = {
      fetch: (async () => stream.response) as unknown as typeof globalThis.fetch,
      caches,
      cacheName: CACHE,
      onProgress: (loaded, total) => log.push(`progress ${loaded}/${total}`),
    };

    const pending = downloadModel(URL, 30, deps).then((bytes) => {
      log.push('done');
      return bytes;
    });

    // First chunk only: the download cannot possibly be finished, and yet the bar has moved.
    stream.feed(10);
    await vi.waitFor(() => expect(log).toContain('progress 10/30'));
    expect(log).not.toContain('cache.put');
    expect(log).not.toContain('done');

    stream.feed(20);
    await vi.waitFor(() => expect(log).toContain('progress 30/30'));
    stream.finish();

    const bytes = await pending;
    expect(bytes.byteLength).toBe(30);
    expect(bytes.every((byte) => byte === 7)).toBe(true);
    // Order: every progress message, then the cache write, then the resolution.
    expect(log.indexOf('progress 10/30')).toBeLessThan(log.indexOf('cache.put'));
    expect(log.indexOf('cache.put')).toBeLessThan(log.indexOf('done'));
    expect(log.filter((entry) => entry.startsWith('progress')).length).toBeGreaterThan(1);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('falls back to the registry size when there is no content-length', async () => {
    const log: string[] = [];
    const stream = drip();
    const deps: DownloadDeps = {
      fetch: (async () => stream.response) as unknown as typeof globalThis.fetch,
      cacheName: CACHE,
      onProgress: (loaded, total) => log.push(`${loaded}/${total}`),
    };
    const pending = downloadModel(URL, 1000, deps);
    stream.feed(400);
    await vi.waitFor(() => expect(log).toContain('400/1000'));
    stream.finish();
    await pending;
    // The last message always squares the totals, whatever the estimate was.
    expect(log.at(-1)).toBe('400/400');
  });

  it('never reports more than 100 % when the estimate was too small', async () => {
    const log: number[] = [];
    const stream = drip();
    const deps: DownloadDeps = {
      fetch: (async () => stream.response) as unknown as typeof globalThis.fetch,
      cacheName: CACHE,
      onProgress: (loaded, total) => log.push(loaded / total),
    };
    const pending = downloadModel(URL, 10, deps);
    stream.feed(50);
    await vi.waitFor(() => expect(log.length).toBeGreaterThan(0));
    stream.finish();
    await pending;
    expect(Math.max(...log)).toBeLessThanOrEqual(1);
  });

  it('serves a cached entry without touching the network', async () => {
    const log: string[] = [];
    const stored = new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    const { caches, put } = fakeCaches(log, stored);
    const fetch = vi.fn();
    const bytes = await downloadModel(URL, 3, {
      fetch: fetch as unknown as typeof globalThis.fetch,
      caches,
      cacheName: CACHE,
      onProgress: (loaded, total) => log.push(`progress ${loaded}/${total}`),
    });
    expect(fetch).not.toHaveBeenCalled();
    // Nothing is written back: it came from there.
    expect(put).not.toHaveBeenCalled();
    expect([...bytes]).toEqual([1, 2, 3]);
  });

  it('turns a failed response into a Spanish error', async () => {
    const fetch = async () => new Response('nope', { status: 404 });
    await expect(
      downloadModel(URL, 1, {
        fetch: fetch as unknown as typeof globalThis.fetch,
        cacheName: CACHE,
        onProgress: () => undefined,
      }),
    ).rejects.toThrow(/no se pudo descargar el modelo \(404\)/);
  });

  it('works without the Cache API at all', async () => {
    const seen: number[] = [];
    const stream = drip();
    const pending = downloadModel(URL, 4, {
      fetch: (async () => stream.response) as unknown as typeof globalThis.fetch,
      cacheName: CACHE,
      onProgress: (loaded) => seen.push(loaded),
    });
    stream.feed(4);
    stream.finish();
    expect((await pending).byteLength).toBe(4);
    expect(seen.at(-1)).toBe(4);
  });
});

describe('isCached', () => {
  it('answers true only when the bytes are really there', async () => {
    const store = new Map<string, Response>([['https://hub/model.onnx', new Response('x')]]);
    const caches = {
      open: async () => ({ match: async (url: string) => store.get(url) }),
    } as unknown as CacheStorage;

    expect(await isCached('https://hub/model.onnx', { caches, cacheName: 'c' })).toBe(true);
    expect(await isCached('https://hub/other.onnx', { caches, cacheName: 'c' })).toBe(false);
  });

  it('answers false rather than throwing where the Cache API is unavailable or blocked', async () => {
    // A private window, blocked site data, or an old browser. "We cannot promise it is there"
    // has to fall back to asking, never to assuming.
    expect(await isCached('https://hub/m.onnx', { caches: undefined, cacheName: 'c' })).toBe(false);

    const hostile = {
      open: async () => {
        throw new Error('site data blocked');
      },
    } as unknown as CacheStorage;
    expect(await isCached('https://hub/m.onnx', { caches: hostile, cacheName: 'c' })).toBe(false);
  });
});
