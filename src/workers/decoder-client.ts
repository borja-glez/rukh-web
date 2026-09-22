// Main-thread side of the decoder worker. The `new Worker(new URL(...), { type: 'module' })`
// literal lives here, at the call site, because that is the only shape Vite recognises to emit
// the worker as its own chunk (`tests/worker-chunk.test.ts` guards it). The request/answer
// plumbing is in `rpc.ts`, shared with the encoder's client.
import type {
  AdapterMessage,
  Backend,
  InitRequest,
  ProgressMessage,
  ReadyMessage,
} from '../lib/worker-protocol';
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
  /** Floats a style adapter for this file has; 0 when the graph takes none. */
  adapterFloats: number;
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
  /**
   * Loads a style adapter into the live session, or clears it with `url: null`.
   *
   * Only stages whose graph takes the factors as inputs accept this; the others answer with an
   * error rather than quietly playing without the style the player asked for.
   */
  adapter(
    request: { adapter: string; url: string | null; sizeBytes: number },
    onProgress?: (progress: ProgressMessage) => void,
  ): Promise<AdapterMessage>;
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
      /* A local model travels as its buffer; transferring hands it over instead of cloning it. */
      const transfer = request.bytes ? [request.bytes.buffer] : undefined;
      const ready = await rpc.send<ReadyMessage>(
        { type: 'init', ...request },
        onProgress,
        transfer,
      );
      return {
        backend: ready.backend,
        fallbackReason: ready.fallbackReason,
        loadMs: ready.loadMs,
        block: ready.block,
        vocab: ready.vocab,
        adapterFloats: ready.adapterFloats ?? 0,
      };
    },
    adapter(request, onProgress) {
      return rpc.send<AdapterMessage>({ type: 'adapter', ...request }, onProgress);
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
