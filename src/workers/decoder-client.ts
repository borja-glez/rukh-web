// Main-thread side of the decoder worker. The `new Worker(new URL(...), { type: 'module' })`
// literal lives here, at the call site, because that is the only shape Vite recognises to emit
// the worker as its own chunk (`tests/worker-chunk.test.ts` guards it).
import {
  asResponse,
  type Backend,
  type ProgressMessage,
  type WorkerRequest,
} from '../lib/worker-protocol';

export interface LoadReport {
  backend: Backend;
  /** Why WebGPU was not used, when it was not. */
  fallbackReason?: string;
  loadMs: number;
}

export interface LogitsReport {
  data: Float32Array;
  inferMs: number;
}

export interface Decoder {
  /** Downloads (or reads from the cache) the model and creates the session. */
  init(
    stage: string,
    url: string,
    sizeBytes: number,
    onProgress?: (progress: ProgressMessage) => void,
  ): Promise<LoadReport>;
  /** Logits of the last step for a prompt already cropped to the context window. */
  logits(ids: number[]): Promise<LogitsReport>;
  /** Releases the session and terminates the worker; the handle is unusable afterwards. */
  dispose(): Promise<void>;
}

/** `Omit` over a union collapses it, so the distribution is written out explicitly. */
type Unidentified<T> = T extends WorkerRequest ? Omit<T, 'id'> : never;

interface Pending {
  resolve: (value: never) => void;
  reject: (error: Error) => void;
  onProgress?: (progress: ProgressMessage) => void;
}

export function createDecoder(): Decoder {
  const worker = new Worker(new URL('./decoder.worker.ts', import.meta.url), { type: 'module' });
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let terminated = false;

  const fail = (error: Error) => {
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };

  worker.addEventListener('message', (event: MessageEvent) => {
    const message = asResponse(event.data);
    if (!message) return;
    const entry = pending.get(message.id);
    if (!entry) return;
    if (message.type === 'progress') {
      entry.onProgress?.(message);
      return;
    }
    pending.delete(message.id);
    if (message.type === 'error') {
      entry.reject(new Error(message.message));
      return;
    }
    (entry.resolve as (value: unknown) => void)(message);
  });

  worker.addEventListener('error', (event: ErrorEvent) => {
    fail(new Error(event.message || 'el worker del modelo ha fallado'));
  });

  function send<T>(
    request: Unidentified<WorkerRequest>,
    onProgress?: (progress: ProgressMessage) => void,
  ): Promise<T> {
    if (terminated) return Promise.reject(new Error('el worker del modelo ya se ha cerrado'));
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (value: never) => void, reject, onProgress });
      worker.postMessage({ ...request, id } as WorkerRequest);
    });
  }

  return {
    async init(stage, url, sizeBytes, onProgress) {
      const ready = await send<{ backend: Backend; fallbackReason?: string; loadMs: number }>(
        { type: 'init', stage, url, sizeBytes },
        onProgress,
      );
      return {
        backend: ready.backend,
        fallbackReason: ready.fallbackReason,
        loadMs: ready.loadMs,
      };
    },
    async logits(ids) {
      const answer = await send<{ data: Float32Array; inferMs: number }>({ type: 'logits', ids });
      return { data: answer.data, inferMs: answer.inferMs };
    },
    async dispose() {
      if (terminated) return;
      try {
        await send<unknown>({ type: 'dispose' });
      } catch {
        /* the worker may already be gone; terminating below is enough */
      }
      terminated = true;
      fail(new Error('el worker del modelo se ha cerrado'));
      worker.terminate();
    },
  };
}
