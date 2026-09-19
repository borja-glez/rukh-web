// Downloading the model bytes, with the progress bar actually moving while they arrive.
//
// The obvious version — `await cache.put(url, response.clone())` before reading the body — does
// not work: `put` only resolves once the clone's body has been consumed, and a cloned body is fed
// by the same underlying stream, so the browser buffers the whole file (twice: the clone and the
// copy the cache keeps) before the first progress message is ever sent. On an 80 MB fp16 export
// that is a minute of a bar sitting at zero. So the body is streamed first and the cache entry is
// written from the bytes afterwards, which also means a download that fails half-way leaves
// nothing behind.
//
// Everything the browser provides is injected, so the whole thing is testable without a browser.

/** What `downloadModel` needs from its environment. */
export interface DownloadDeps {
  fetch: typeof globalThis.fetch;
  /** `caches`, or undefined where the Cache API is not available (the model is just refetched). */
  caches?: CacheStorage;
  /** Name of the Cache API bucket the weights are stored in. */
  cacheName: string;
  /** Called after every chunk; `total` is the best estimate available at that moment. */
  onProgress: (loaded: number, total: number) => void;
}

/** Joins the chunks a stream produced into one buffer. */
function concat(chunks: readonly Uint8Array[], length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * The model bytes, from the Cache API when they are already there and from the network otherwise,
 * reporting progress as the body streams in. `sizeBytes` is the registry's estimate and is only
 * used when the response has no usable `content-length` (a Hub redirect to a CDN sometimes omits
 * it); a `loaded` that overshoots it wins, so the bar never reports more than 100 %.
 */
export async function downloadModel(
  url: string,
  sizeBytes: number,
  deps: DownloadDeps,
): Promise<Uint8Array> {
  const cache = await deps.caches?.open(deps.cacheName).catch(() => null);
  const cached = await cache?.match(url).catch(() => undefined);
  const response = cached ?? (await deps.fetch(url, { mode: 'cors', credentials: 'omit' }));
  if (!response.ok) {
    throw new Error(`no se pudo descargar el modelo (${response.status})`);
  }

  const declared = Number(response.headers.get('content-length') ?? '0');
  const total = declared > 0 ? declared : sizeBytes;

  const body = response.body;
  if (!body) {
    // No stream (an old browser, or a fake in a test): one shot, one progress message.
    const buffer = new Uint8Array(await response.arrayBuffer());
    deps.onProgress(buffer.byteLength, buffer.byteLength);
    return buffer;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    deps.onProgress(loaded, Math.max(total, loaded));
  }
  const bytes = concat(chunks, loaded);
  // The chunks are now a second copy of the whole model: drop them before anyone awaits again.
  chunks.length = 0;
  deps.onProgress(loaded, loaded);

  // Only now, with the whole file in hand and the bar at 100 %, is the cache written.
  if (!cached && cache) {
    // `bytes.buffer` is the freshly allocated buffer `concat` made, so handing it over is a
    // move, not a copy; `Response` reads it synchronously here.
    await cache
      .put(
        url,
        new Response(bytes.buffer as ArrayBuffer, {
          headers: {
            'content-type': 'application/octet-stream',
            'content-length': String(bytes.byteLength),
          },
        }),
      )
      .catch(() => undefined);
  }
  return bytes;
}
