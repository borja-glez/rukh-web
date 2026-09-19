// Main-thread side of the encoder worker, built exactly like the decoder's: the `new Worker(new
// URL(...), { type: 'module' })` literal at the call site so Vite emits it as its own chunk, and
// the shared `rpc.ts` for the request/answer plumbing.
//
// It is a second worker, never the decoder's: the bar must be able to evaluate while the model
// thinks. `evaluate` is still serialised *inside* the worker (ORT cannot re-enter `run`), and the
// caller drops stale answers by comparing the position it asked about with the one on the board.
import type {
  Backend,
  EncoderInitRequest,
  EncoderReadyMessage,
  EvaluationMessage,
  ProgressMessage,
} from '../lib/worker-protocol';
import { createRpc, type WorkerLike } from './rpc';

export interface EncoderReport {
  backend: Backend;
  /** Why WebGPU was not used, when it was not. */
  fallbackReason?: string;
  loadMs: number;
  /** Tokens the session was accepted for (`squares`: 69). */
  block: number;
  /** The two outputs the contract check found: the value head and the blunder head. */
  outputs: [string, string];
}

/** What `init` needs to know about an encoder stage; the worker's `id` is added by `send`. */
export type EncoderLoadRequest = Omit<EncoderInitRequest, 'type' | 'id'>;

export interface Evaluation {
  /** The position's evaluation from White's point of view, in [-1, 1]. */
  value: number;
  /** Probability that the move that led here threw the game away; already a probability. */
  blunder: number;
  inferMs: number;
}

export interface Encoder {
  /** Downloads (or reads from the cache) the encoder, creates the session and checks its contract. */
  init(
    request: EncoderLoadRequest,
    onProgress?: (progress: ProgressMessage) => void,
  ): Promise<EncoderReport>;
  /** The two heads' answers for one position, already tokenized with `fenToTokens`. */
  evaluate(ids: number[]): Promise<Evaluation>;
  /** Releases the session and terminates the worker; the handle is unusable afterwards. */
  dispose(): Promise<void>;
}

const DEAD = 'el worker del encoder ya se ha cerrado';

/** The real worker; replaced by a fake in the tests. */
function spawn(): WorkerLike {
  return new Worker(new URL('./encoder.worker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as WorkerLike;
}

export function createEncoder(worker: WorkerLike = spawn()): Encoder {
  const rpc = createRpc(worker, 'el worker del encoder ha fallado');

  return {
    async init(request, onProgress) {
      const ready = await rpc.send<EncoderReadyMessage>(
        { type: 'encoder-init', ...request },
        onProgress,
      );
      return {
        backend: ready.backend,
        fallbackReason: ready.fallbackReason,
        loadMs: ready.loadMs,
        block: ready.block,
        outputs: ready.outputs,
      };
    },
    async evaluate(ids) {
      const answer = await rpc.send<EvaluationMessage>({ type: 'evaluate', ids });
      return { value: answer.value, blunder: answer.blunder, inferMs: answer.inferMs };
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
