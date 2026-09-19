// Dedicated worker that owns the ONNX Runtime session: it downloads the model (streaming the
// progress back), keeps it in the Cache API and answers `logits` requests with the last step's
// logits. The main thread never touches ORT, so a 28 MB WASM runtime and a 40 MB model never
// block the board.
//
// The ORT setup, the serialisation rules it imposes (sessions created one at a time, `run` calls
// never overlapping) and the WebGPU/WASM choice live in `ort-runtime.ts`, shared with the
// encoder's worker; what stays here is what this model answers.
//
// The file is never trusted: `readContract` checks the declared output width against the
// tokenizer's vocabulary as soon as the session exists, and `assertVocab` checks the real width
// of every answer. See `src/lib/contract.ts` for why.
import type * as ort from 'onnxruntime-web/webgpu';
import { RUN_SOURCE, assertVocab, readContract, type ModelContract } from '../lib/contract';
import type { DecoderRequest, WorkerResponse } from '../lib/worker-protocol';
import { configureOrt, createSerial, createSession, fetchModel, inputFeeds } from './ort-runtime';

/** The worker global, typed with just what this file uses (avoids pulling in the webworker lib). */
interface WorkerScope {
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

const ctx = self as unknown as WorkerScope;

// Self-hosted runtime: `public/ort/<version>/` is filled by `scripts/copy-assets.mjs` so the
// page never reaches a CDN (the CSP would not allow it either).
configureOrt();

let session: ort.InferenceSession | null = null;
/** Block and vocabulary the live session was accepted under; null while there is no session. */
let contract: ModelContract | null = null;

/** The single chain every ORT call is queued on: no two sessions or runs are ever in flight. */
const serial = createSerial();

function reply(message: WorkerResponse, transfer?: Transferable[]): void {
  ctx.postMessage(message, transfer);
}

/**
 * Downloads the weights and hands them to ORT. The buffer is a local of this frame on purpose:
 * when it returns, the only copy of the model still alive is the one inside the session, instead
 * of 80 MB sitting next to it for as long as the worker lives.
 */
async function loadSession(request: Extract<DecoderRequest, { type: 'init' }>) {
  const bytes = await fetchModel(request.url, request.sizeBytes, (loaded, total) =>
    reply({ type: 'progress', id: request.id, loaded, total }),
  );
  return createSession(bytes);
}

async function init(request: Extract<DecoderRequest, { type: 'init' }>): Promise<void> {
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

async function logits(request: Extract<DecoderRequest, { type: 'logits' }>): Promise<void> {
  const data = await serial(async () => {
    const current = session;
    const live = contract;
    if (!current || !live) throw new Error('el modelo todavía no está cargado');
    const feeds = inputFeeds(current, request.ids);
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

async function dispose(request: Extract<DecoderRequest, { type: 'dispose' }>): Promise<void> {
  await serial(async () => {
    await session?.release();
    session = null;
    contract = null;
  });
  reply({ type: 'disposed', id: request.id });
}

ctx.addEventListener('message', (event: MessageEvent) => {
  const request = event.data as DecoderRequest;
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
