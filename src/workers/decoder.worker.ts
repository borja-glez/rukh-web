// Dedicated worker that owns the ONNX Runtime session: it downloads the model (streaming the
// progress back), keeps it in the Cache API and answers `logits` requests with the last step's
// logits. The main thread never touches ORT, so a 28 MB WASM runtime and a 40 MB model never
// block the board.
//
// Two serialisation rules come from ORT itself and are not negotiable: sessions are created one
// at a time and `run` calls never overlap (the JSEP/asyncify build cannot re-enter an async
// call). Both go through `serial`, a single promise chain — the download included, so two `init`
// messages in flight cannot end up fetching twice and racing to install their session.
//
// The file is never trusted: `readContract` checks the declared output width against the
// tokenizer's vocabulary as soon as the session exists, and `assertVocab` checks the real width
// of every answer. See `src/lib/contract.ts` for why.
import * as ort from 'onnxruntime-web/webgpu';
import { RUN_SOURCE, assertVocab, readContract, type ModelContract } from '../lib/contract';
import { downloadModel } from '../lib/download';
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
/** Block and vocabulary the live session was accepted under; null while there is no session. */
let contract: ModelContract | null = null;

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

/** `downloadModel` wired to this worker's globals, reporting progress back to the main thread. */
function fetchModel(id: number, url: string, sizeBytes: number): Promise<Uint8Array> {
  return downloadModel(url, sizeBytes, {
    fetch: globalThis.fetch.bind(globalThis),
    caches: typeof caches === 'undefined' ? undefined : caches,
    cacheName: MODEL_CACHE,
    onProgress: (loaded, total) => reply({ type: 'progress', id, loaded, total }),
  });
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

/**
 * Downloads the weights and hands them to ORT. The buffer is a local of this frame on purpose:
 * when it returns, the only copy of the model still alive is the one inside the session, instead
 * of 80 MB sitting next to it for as long as the worker lives.
 */
async function loadSession(request: Extract<WorkerRequest, { type: 'init' }>) {
  const bytes = await fetchModel(request.id, request.url, request.sizeBytes);
  return createSession(bytes);
}

async function init(request: Extract<WorkerRequest, { type: 'init' }>): Promise<void> {
  const started = performance.now();
  // The download runs inside the chain too: outside it, a second `init` would start its own fetch
  // while the first was still tearing the old session down, and both would race to install one.
  const ready = await serial(async () => {
    await session?.release();
    session = null;
    contract = null;
    const created = await loadSession(request);
    const checked = readContract(created.session, request.vocab, request.block);
    session = created.session;
    contract = checked;
    return { backend: created.backend, reason: created.reason, contract: checked };
  });
  reply({
    type: 'ready',
    id: request.id,
    backend: ready.backend,
    fallbackReason: ready.reason ?? undefined,
    loadMs: Math.round(performance.now() - started),
    block: ready.contract.block,
    vocab: ready.contract.vocab,
  });
}

async function logits(request: Extract<WorkerRequest, { type: 'logits' }>): Promise<void> {
  const data = await serial(async () => {
    const current = session;
    const live = contract;
    if (!current || !live) throw new Error('el modelo todavía no está cargado');
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
    // The declared shape is often symbolic, so the real width is only knowable here. A model
    // whose logits are not the tokenizer's vocabulary would map every id to a different move.
    assertVocab(raw.length, live.vocab, RUN_SOURCE);
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
    contract = null;
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
