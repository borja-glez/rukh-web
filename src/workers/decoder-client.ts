// Main-thread side of the decoder worker. The `new Worker(new URL(...), { type: 'module' })`
// literal lives here, at the call site, because that is the only shape Vite recognises to emit
// the worker as its own chunk (`tests/worker-chunk.test.ts` guards it). The request/answer
// plumbing is in `rpc.ts`, shared with the encoder's client.
import type { Backend, InitRequest, ProgressMessage, ReadyMessage } from '../lib/worker-protocol';
import { createRpc, type WorkerLike } from './rpc';

export interface LoadReport {
  backend: Backend;
  /** Why WebGPU was not used, when it was not. */
  fallbackReason?: string;
  loadMs: number;
  /** Context window the session was accepted under; `buildPrompt` crops the prompt to it. */
  block: number;
  /** Width of the logits the model answers with, already checked against the tokenizer. */
  vocab: number;
}

/** What `init` needs to know about a stage; the worker's `id` is added by `send`. */
export type LoadRequest = Omit<InitRequest, 'type' | 'id'>;

export interface LogitsReport {
  data: Float32Array;
  inferMs: number;
}

export interface Decoder {
  /** Downloads (or reads from the cache) the model, creates the session and checks its contract. */
  init(request: LoadRequest, onProgress?: (progress: ProgressMessage) => void): Promise<LoadReport>;
  /** Logits of the last step for a prompt already cropped to the context window. */
  logits(ids: number[]): Promise<LogitsReport>;
  /** Releases the session and terminates the worker; the handle is unusable afterwards. */
  dispose(): Promise<void>;
}

const DEAD = 'el worker del modelo ya se ha cerrado';

/** The real worker; replaced by a fake in the tests. */
function spawn(): WorkerLike {
  return new Worker(new URL('./decoder.worker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as WorkerLike;
}

export function createDecoder(worker: WorkerLike = spawn()): Decoder {
  const rpc = createRpc(worker, 'el worker del modelo ha fallado');

  return {
    async init(request, onProgress) {
      const ready = await rpc.send<ReadyMessage>({ type: 'init', ...request }, onProgress);
      return {
        backend: ready.backend,
        fallbackReason: ready.fallbackReason,
        loadMs: ready.loadMs,
        block: ready.block,
        vocab: ready.vocab,
      };
    },
    async logits(ids) {
      const answer = await rpc.send<{ data: Float32Array; inferMs: number }>({
        type: 'logits',
        ids,
      });
      return { data: answer.data, inferMs: answer.inferMs };
    },
    async dispose() {
      if (rpc.closed) return;
      try {
        await rpc.send<unknown>({ type: 'dispose' });
      } catch {
        /* the worker may already be gone; terminating below is enough */
      }
      rpc.close(DEAD);
    },
  };
}
