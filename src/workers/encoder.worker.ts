// Dedicated worker for the position encoder: it downloads the fine-tuned encoder, keeps it in the
// Cache API and answers `evaluate` with the two numbers the bar draws — the value from White's
// point of view and the probability that the last move threw the game away.
//
// It is a worker of its own, never the decoder's, and that is the whole point: ORT creates
// sessions one at a time and cannot re-enter `run`, so sharing a worker would mean the evaluation
// waits for the model's move and the model's move waits for the evaluation. Two workers, two
// queues, two sessions; the browser schedules them.
//
// The contract is checked before anything is drawn (`readEncoderContract`) and again on every
// answer: two outputs called `value` and `blunder`, one number each, inside the range their heads
// can produce. `rukh.export.export_encoder_onnx` puts the sigmoid inside the graph
// (`rukh_blunder=probability`), so what comes out of `blunder` is already a probability and the
// page compares it against 0.5 without applying anything of its own.
import type * as ort from 'onnxruntime-web/webgpu';
import {
  BLUNDER_RANGE,
  RUN_SOURCE,
  VALUE_RANGE,
  assertInRange,
  assertScalarOutput,
  readEncoderContract,
  type EncoderContract,
} from '../lib/contract';
import type { EncoderRequest, WorkerResponse } from '../lib/worker-protocol';
import { configureOrt, createSerial, createSession, fetchModel, inputFeeds } from './ort-runtime';

/** The worker global, typed with just what this file uses (avoids pulling in the webworker lib). */
interface WorkerScope {
  postMessage(message: WorkerResponse): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

const ctx = self as unknown as WorkerScope;

configureOrt();

let session: ort.InferenceSession | null = null;
/** What the live session was accepted under; null while there is no session. */
let contract: EncoderContract | null = null;

/** This worker's own chain: sessions created in series and `run` calls never overlapping. */
const serial = createSerial();

function reply(message: WorkerResponse): void {
  ctx.postMessage(message);
}

async function init(request: Extract<EncoderRequest, { type: 'encoder-init' }>): Promise<void> {
  const started = performance.now();
  const ready = await serial(async () => {
    await session?.release();
    session = null;
    contract = null;
    const bytes = await fetchModel(request.url, request.sizeBytes, (loaded, total) =>
      reply({ type: 'progress', id: request.id, loaded, total }),
    );
    const created = await createSession(bytes);
    const checked = readEncoderContract(created.session, request.block);
    session = created.session;
    contract = checked;
    return { backend: created.backend, reason: created.reason, contract: checked };
  });
  reply({
    type: 'encoder-ready',
    id: request.id,
    backend: ready.backend,
    fallbackReason: ready.reason ?? undefined,
    loadMs: Math.round(performance.now() - started),
    block: ready.contract.block,
    outputs: [ready.contract.outputs[0], ready.contract.outputs[1]],
  });
}

/** The single number one head answered for this position, checked on the way out. */
function scalar(output: ort.InferenceSession.OnnxValueMapType, name: string): number {
  const tensor = output[name];
  if (!tensor) throw new Error(`el encoder no ha devuelto la salida ${name}`);
  const raw = tensor.data;
  if (!(raw instanceof Float32Array)) {
    throw new Error(`la salida ${name} del encoder no es float32 (${tensor.type})`);
  }
  // The declared shape is `[batch]` and often symbolic, so the real width is only knowable here.
  assertScalarOutput(raw.length, name, RUN_SOURCE);
  return raw[0];
}

async function evaluate(request: Extract<EncoderRequest, { type: 'evaluate' }>): Promise<void> {
  const answer = await serial(async () => {
    const current = session;
    const live = contract;
    if (!current || !live) throw new Error('el encoder todavía no está cargado');
    if (request.ids.length !== live.block) {
      throw new Error(
        `la posición trae ${request.ids.length} tokens y el encoder espera ${live.block}`,
      );
    }
    const feeds = inputFeeds(current, request.ids);
    const started = performance.now();
    const output = await current.run(feeds);
    const inferMs = performance.now() - started;
    const value = scalar(output, live.outputs[0]);
    const blunder = scalar(output, live.outputs[1]);
    assertInRange(value, live.outputs[0], VALUE_RANGE);
    assertInRange(blunder, live.outputs[1], BLUNDER_RANGE);
    return { value, blunder, inferMs };
  });
  reply({
    type: 'evaluation',
    id: request.id,
    value: answer.value,
    blunder: answer.blunder,
    inferMs: answer.inferMs,
  });
}

async function dispose(request: Extract<EncoderRequest, { type: 'dispose' }>): Promise<void> {
  await serial(async () => {
    await session?.release();
    session = null;
    contract = null;
  });
  reply({ type: 'disposed', id: request.id });
}

ctx.addEventListener('message', (event: MessageEvent) => {
  const request = event.data as EncoderRequest;
  const run = async () => {
    switch (request.type) {
      case 'encoder-init':
        return init(request);
      case 'evaluate':
        return evaluate(request);
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
