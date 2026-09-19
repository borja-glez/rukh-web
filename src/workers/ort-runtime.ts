// What the two model workers (`decoder.worker.ts`, `encoder.worker.ts`) share: the ONNX Runtime
// setup, the serialisation rules ORT imposes, the backend choice with its fallback reason and the
// download wired to the Cache API.
//
// There are two workers on purpose — the evaluation bar must not wait for the move, nor the move
// for the bar — but everything below is about ORT, not about what the model answers, and one copy
// of it is one place to fix. Vite bundles each worker on its own, so this module is compiled into
// both worker chunks; they still never share a session, a queue or a thread.
import * as ort from 'onnxruntime-web/webgpu';
import { downloadModel } from '../lib/download';
import { MODEL_CACHE, ORT_BASE, type Backend } from '../lib/worker-protocol';

/**
 * Points ORT at the self-hosted runtime and pins it to one thread. Called once per worker, at
 * module scope, because `ort.env` is global to the worker's realm.
 *
 * One thread, always: WASM is only the fallback (WebGPU is the fast path), and asking for more
 * threads under cross-origin isolation makes ORT reach for the threaded/proxy artefacts that
 * `scripts/copy-assets.mjs` deliberately does not publish. Keeping it at one means the runtime
 * needs exactly the two files we do publish, isolated or not. No proxy worker either: it would be
 * a third artefact and this code already runs off the main thread, which is all the proxy buys.
 */
export function configureOrt(): void {
  ort.env.wasm.wasmPaths = ORT_BASE;
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.logLevel = 'error';
}

/**
 * A single promise chain: no two sessions are ever created at the same time and no two `run`
 * calls ever overlap (the JSEP/asyncify build cannot re-enter an async call). The download goes
 * through it too, so two `init` messages in flight cannot fetch twice and race to install their
 * session.
 */
export function createSerial(): <T>(work: () => Promise<T>) => Promise<T> {
  let chain: Promise<unknown> = Promise.resolve();
  return <T>(work: () => Promise<T>): Promise<T> => {
    const next = chain.then(work, work);
    chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
}

export function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** `downloadModel` wired to a worker's globals, reporting progress as the body streams in. */
export function fetchModel(
  url: string,
  sizeBytes: number,
  onProgress: (loaded: number, total: number) => void,
): Promise<Uint8Array> {
  return downloadModel(url, sizeBytes, {
    fetch: globalThis.fetch.bind(globalThis),
    caches: typeof caches === 'undefined' ? undefined : caches,
    cacheName: MODEL_CACHE,
    onProgress,
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

export interface CreatedSession {
  session: ort.InferenceSession;
  backend: Backend;
  /** Why WebGPU was not used, when it was not; the panel shows it under the badge. */
  reason: string | null;
}

/**
 * WebGPU whenever `requestAdapter()` hands out an adapter; WASM only when it does not, or when
 * creating the session on WebGPU throws. Both fallbacks carry the reason, so a slow game (or a
 * slow bar) on WASM is never a mystery.
 */
export async function createSession(bytes: Uint8Array): Promise<CreatedSession> {
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

/** One `(1, T)` int64 tensor under the name the session gives its only input. */
export function inputFeeds(
  session: ort.InferenceSession,
  ids: readonly number[],
): Record<string, ort.Tensor> {
  const data = BigInt64Array.from(ids, (id) => BigInt(id));
  return { [session.inputNames[0]]: new ort.Tensor('int64', data, [1, ids.length]) };
}
