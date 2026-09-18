// Dedicated worker that owns the ONNX Runtime session: it downloads the model (streaming the
// progress back), keeps it in the Cache API and answers `logits` requests with the last step's
// logits. The main thread never touches ORT, so a 28 MB WASM runtime and a 40 MB model never
// block the board.
//
// Two serialisation rules come from ORT itself and are not negotiable: sessions are created one
// at a time and `run` calls never overlap (the JSEP/asyncify build cannot re-enter an async
// call). Both go through `serial`, a single promise chain.
import * as ort from 'onnxruntime-web/webgpu';
import {
  MODEL_CACHE,
  ORT_BASE,
  type Backend,
  type WorkerRequest,
  type WorkerResponse,
} from '../lib/worker-protocol';

/** The worker global, typed with just what this file uses (avoids pulling in the webworker lib). */
interface WorkerScope {
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

const ctx = self as unknown as WorkerScope;

// Self-hosted runtime: `public/ort/<version>/` is filled by `scripts/copy-assets.mjs` so the
// page never reaches a CDN (the CSP would not allow it either).
ort.env.wasm.wasmPaths = ORT_BASE;
// One thread, always. WASM is only the fallback here (WebGPU is the fast path and this decoder
// is 40 MB), and asking for more threads under cross-origin isolation makes ORT reach for the
// threaded/proxy artefacts that `scripts/copy-assets.mjs` deliberately does not publish. Keeping
// it at one means the runtime needs exactly the two files we do publish, isolated or not.
ort.env.wasm.numThreads = 1;
// No proxy worker either: it would be a third artefact (`ort-wasm-proxy-worker`) and this code
// already runs off the main thread, which is the only thing the proxy buys.
ort.env.wasm.proxy = false;
ort.env.logLevel = 'error';

let session: ort.InferenceSession | null = null;
let backend: Backend | null = null;
/** Why WebGPU was not used, when it was not; surfaced in the panel under the backend badge. */
let fallbackReason: string | null = null;

/** The single chain every ORT call is queued on: no two sessions or runs are ever in flight. */
let chain: Promise<unknown> = Promise.resolve();

function serial<T>(work: () => Promise<T>): Promise<T> {
  const next = chain.then(work, work);
  chain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

function reply(message: WorkerResponse, transfer?: Transferable[]): void {
  ctx.postMessage(message, transfer);
}

/**
 * The model bytes, from the Cache API when they are already there and from the network
 * otherwise, reporting progress as the body streams in. `total` falls back to the registry size
 * when the response has no usable `content-length` (a Hub redirect to a CDN sometimes omits it).
 */
async function fetchModel(id: number, url: string, sizeBytes: number): Promise<Uint8Array> {
  const cache = await caches.open(MODEL_CACHE).catch(() => null);
  const cached = await cache?.match(url).catch(() => undefined);
  const response = cached ?? (await fetch(url, { mode: 'cors', credentials: 'omit' }));
  if (!response.ok) {
    throw new Error(`no se pudo descargar el modelo (${response.status})`);
  }

  const declared = Number(response.headers.get('content-length') ?? '0');
  const total = declared > 0 ? declared : sizeBytes;

  // Keep a pristine clone for the cache: the body can only be read once.
  if (!cached && cache) {
    await cache.put(url, response.clone()).catch(() => undefined);
  }

  const body = response.body;
  if (!body) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    reply({ type: 'progress', id, loaded: buffer.byteLength, total: buffer.byteLength });
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
    reply({ type: 'progress', id, loaded, total: Math.max(total, loaded) });
  }

  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  reply({ type: 'progress', id, loaded, total: loaded });
  return bytes;
}

/** The WebGPU adapter, or the reason there is none. Never throws. */
async function webgpuAdapter(): Promise<{ adapter: unknown } | { reason: string }> {
  const gpu = (globalThis as { navigator?: { gpu?: { requestAdapter(): Promise<unknown> } } })
    .navigator?.gpu;
  if (!gpu) return { reason: 'este navegador no expone WebGPU' };
  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) return { reason: 'WebGPU no ha ofrecido ningún adaptador' };
    return { adapter };
  } catch (cause) {
    return { reason: `WebGPU ha fallado al pedir el adaptador: ${describe(cause)}` };
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * WebGPU whenever `requestAdapter()` hands out an adapter; WASM only when it does not, or when
 * creating the session on WebGPU throws. Both fallbacks carry the reason, which the panel shows
 * under the badge so a slow game on WASM is never a mystery.
 */
async function createSession(
  bytes: Uint8Array,
): Promise<{ session: ort.InferenceSession; backend: Backend; reason: string | null }> {
  const options: ort.InferenceSession.SessionOptions = {
    graphOptimizationLevel: 'all',
    executionMode: 'sequential',
  };
  const probe = await webgpuAdapter();
  let reason = 'reason' in probe ? probe.reason : null;
  if (!reason) {
    try {
      const created = await ort.InferenceSession.create(bytes, {
        ...options,
        executionProviders: ['webgpu'],
      });
      return { session: created, backend: 'webgpu', reason: null };
    } catch (cause) {
      // An adapter that cannot compile the graph is a normal outcome, not a bug: say so and
      // carry on with WASM.
      reason = `WebGPU no ha podido crear la sesión: ${describe(cause)}`;
    }
  }
  const created = await ort.InferenceSession.create(bytes, {
    ...options,
    executionProviders: ['wasm'],
  });
  return { session: created, backend: 'wasm', reason };
}

async function init(request: Extract<WorkerRequest, { type: 'init' }>): Promise<void> {
  const started = performance.now();
  const bytes = await fetchModel(request.id, request.url, request.sizeBytes);
  await serial(async () => {
    session?.release();
    session = null;
    const created = await createSession(bytes);
    session = created.session;
    backend = created.backend;
    fallbackReason = created.reason;
  });
  reply({
    type: 'ready',
    id: request.id,
    backend: backend ?? 'wasm',
    fallbackReason: fallbackReason ?? undefined,
    loadMs: Math.round(performance.now() - started),
  });
}

async function logits(request: Extract<WorkerRequest, { type: 'logits' }>): Promise<void> {
  const data = await serial(async () => {
    const current = session;
    if (!current) throw new Error('el modelo todavía no está cargado');
    const ids = BigInt64Array.from(request.ids, (id) => BigInt(id));
    const feeds: Record<string, ort.Tensor> = {
      [current.inputNames[0]]: new ort.Tensor('int64', ids, [1, request.ids.length]),
    };
    const started = performance.now();
    const output = await current.run(feeds);
    const inferMs = performance.now() - started;
    const tensor = output[current.outputNames[0]];
    const raw = tensor.data;
    if (!(raw instanceof Float32Array)) {
      throw new Error(`la salida del modelo no es float32 (${tensor.type})`);
    }
    // Copy out of the ORT arena: the tensor's buffer may be reused by the next run.
    return { values: raw.slice(), inferMs };
  });
  reply({ type: 'logits', id: request.id, data: data.values, inferMs: data.inferMs }, [
    data.values.buffer,
  ]);
}

async function dispose(request: Extract<WorkerRequest, { type: 'dispose' }>): Promise<void> {
  await serial(async () => {
    await session?.release();
    session = null;
    backend = null;
    fallbackReason = null;
  });
  reply({ type: 'disposed', id: request.id });
}

ctx.addEventListener('message', (event: MessageEvent) => {
  const request = event.data as WorkerRequest;
  const run = async () => {
    switch (request.type) {
      case 'init':
        return init(request);
      case 'logits':
        return logits(request);
      case 'dispose':
        return dispose(request);
      default:
        return undefined;
    }
  };
  void run().catch((error: unknown) => {
    reply({
      type: 'error',
      id: request.id,
      message: error instanceof Error ? error.message : String(error),
    });
  });
});
