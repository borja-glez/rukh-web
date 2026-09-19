import type { Signal } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';
import type { Color, GameState } from '../lib/game';
import {
  findEncoderStage,
  findStage,
  totalSizeMb,
  ENCODER_STAGES,
  MODEL_LICENSE,
  selectableStages,
  STAGES,
} from '../lib/registry';
import {
  megabytes,
  progressPercent,
  type Backend,
  type ProgressMessage,
} from '../lib/worker-protocol';
import type { ClearCacheResult, EncoderStatus, ModelStatus } from './App';

interface Props {
  game: Signal<GameState>;
  human: Signal<Color>;
  stage: Signal<string>;
  busy: Signal<boolean>;
  status: Signal<ModelStatus>;
  progress: Signal<ProgressMessage | null>;
  backend: Signal<Backend | null>;
  /** Why the session is on WASM instead of WebGPU, when it is. */
  fallbackReason: Signal<string | null>;
  error: Signal<string | null>;
  elo: Signal<number>;
  onStage: (id: string) => void;
  onColor: (color: Color) => void;
  onPlay: () => void;
  onClearCache: () => Promise<ClearCacheResult>;
  /** The evaluation bar's model: a second download, asked for separately. */
  encoderStage: Signal<string>;
  encoderStatus: Signal<EncoderStatus>;
  encoderProgress: Signal<ProgressMessage | null>;
  encoderBackend: Signal<Backend | null>;
  encoderError: Signal<string | null>;
  onEncoder: () => void;
}

/** What the "Borrar modelos descargados" button says, once it has been pressed. */
type CacheState = 'idle' | 'deleted' | 'empty' | 'failed';

const CACHE_LABEL: Record<CacheState, string> = {
  idle: 'Borrar modelos descargados',
  deleted: 'Modelos borrados',
  empty: 'No había nada guardado',
  failed: 'No se han podido borrar',
};

/** How long the button keeps its answer before offering itself again. */
const CACHE_RESET_MS = 4000;

/** Elo targets offered once the conditioned checkpoints land (M4). */
const ELO_TARGETS = Array.from({ length: 13 }, (_, i) => 1200 + i * 100);

const BACKEND_LABEL: Record<Backend, string> = { webgpu: 'WebGPU', wasm: 'WASM' };

function statusText(game: GameState, human: Color, busy: boolean): string {
  if (game.over) {
    if (game.result === '1/2-1/2') return 'Tablas';
    const humanWon = (game.result === '1-0') === (human === 'w');
    return humanWon ? 'Jaque mate · has ganado' : 'Jaque mate · ha ganado el modelo';
  }
  if (busy) return 'El modelo piensa…';
  return game.turn === human ? 'Te toca mover' : 'Turno del modelo';
}

/** `navigator.connection.saveData`, when the browser exposes it. */
function saveData(): boolean {
  if (typeof navigator === 'undefined') return false;
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return connection?.saveData === true;
}

export default function ModelPanel({
  game,
  human,
  stage,
  busy,
  status,
  progress,
  backend,
  fallbackReason,
  error,
  elo,
  onStage,
  onColor,
  onPlay,
  onClearCache,
  encoderStage,
  encoderStatus,
  encoderProgress,
  encoderBackend,
  encoderError,
  onEncoder,
}: Props) {
  const state = game.value;
  const color = human.value;
  const locked = busy.value;
  const current = findStage(stage.value) ?? STAGES[0];
  const phase = status.value;
  const download = progress.value;
  const encoder = findEncoderStage(encoderStage.value) ?? ENCODER_STAGES[0];
  const encoderPhase = encoderStatus.value;
  const encoderDownload = encoderProgress.value;
  const [cache, setCache] = useState<CacheState>('idle');

  // The answer is temporary: without this the button would keep claiming "Modelos borrados"
  // forever, which is a lie as soon as the next model is downloaded.
  useEffect(() => {
    if (cache === 'idle') return undefined;
    const timer = setTimeout(() => setCache('idle'), CACHE_RESET_MS);
    return () => clearTimeout(timer);
  }, [cache]);

  return (
    <section class="model" aria-labelledby="model-title">
      <h2 id="model-title" class="label">
        Modelo
      </h2>
      <label class="model__field">
        <span class="caption">Etapa</span>
        <select
          class="select"
          value={stage.value}
          disabled={phase === 'loading'}
          onChange={(event) => onStage((event.currentTarget as HTMLSelectElement).value)}
        >
          {selectableStages(stage.value).map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
              {entry.sizeMb > 0 ? ` · ${entry.sizeMb} MB` : ''}
            </option>
          ))}
        </select>
      </label>
      <label class="model__field">
        <span class="caption">Elo objetivo</span>
        <select
          class="select"
          value={String(elo.value)}
          disabled={!current.eloConditioned}
          title={current.eloConditioned ? undefined : 'Condicionar por Elo llega en M4'}
          onChange={(event) =>
            (elo.value = Number((event.currentTarget as HTMLSelectElement).value))
          }
        >
          {ELO_TARGETS.map((target) => (
            <option key={target} value={String(target)}>
              {target}
            </option>
          ))}
        </select>
        {!current.eloConditioned ? (
          <span class="caption" data-testid="elo-hint">
            Condicionar por Elo llega en M4
          </span>
        ) : null}
      </label>

      {phase === 'mock' ? (
        <p class="model__status caption">Sin modelo · primera jugada legal</p>
      ) : null}

      {phase === 'consent' ? (
        <div class="consent" data-testid="consent">
          <p class="consent__text">
            <strong>{current.label}</strong> se descarga desde Hugging Face: {current.sizeMb} MB,
            licencia {MODEL_LICENSE}. Se guarda en el navegador para la próxima partida.
          </p>
          {saveData() ? (
            <p class="consent__warn caption" data-testid="save-data">
              Tienes el ahorro de datos activado: esta descarga consume {current.sizeMb} MB.
            </p>
          ) : null}
          <button type="button" class="btn btn--primary" data-testid="play" onClick={onPlay}>
            Jugar
          </button>
        </div>
      ) : null}

      {phase === 'loading' ? (
        <div class="model__loading" data-testid="loading">
          {/* The caption below says the same thing in words, so the bar is decorative. */}
          <progress
            class="bar"
            aria-hidden="true"
            value={download?.loaded ?? 0}
            max={Math.max(download?.total ?? 1, 1)}
          />
          <span class="caption" data-testid="progress">
            {download
              ? `${megabytes(download.loaded)} / ${megabytes(download.total)} MB · ${progressPercent(download)} %`
              : 'Preparando la descarga…'}
          </span>
        </div>
      ) : null}

      {phase === 'ready' && backend.value ? (
        <>
          <p class="model__status caption">
            <span class="badge" data-testid="backend">
              {BACKEND_LABEL[backend.value]}
            </span>{' '}
            {current.label}
          </p>
          {fallbackReason.value ? (
            <p class="model__status caption" data-testid="backend-note">
              En WASM: {fallbackReason.value}
            </p>
          ) : null}
        </>
      ) : null}

      {phase === 'error' ? (
        <p class="model__error caption" role="alert" data-testid="model-error">
          {error.value ?? 'No se ha podido cargar el modelo'}
        </p>
      ) : null}

      {/* The evaluation bar is a second model with a second consent: accepting the decoder says
          nothing about accepting these extra MB, so it asks for itself. */}
      <section class="encoder" aria-labelledby="encoder-title">
        <h3 id="encoder-title" class="label">
          Barra de evaluación
        </h3>
        {encoderPhase === 'consent' ? (
          <div class="consent" data-testid="encoder-consent">
            <p class="consent__text">
              Opcional: <strong>{encoder.label}</strong> se descarga aparte desde Hugging Face:{' '}
              {encoder.sizeMb} MB, licencia {MODEL_LICENSE}. Dibuja el valor de la posición y avisa
              de posibles errores.
            </p>
            {saveData() ? (
              <p class="consent__warn caption" data-testid="encoder-save-data">
                Tienes el ahorro de datos activado: esta segunda descarga consume {encoder.sizeMb}{' '}
                MB más.
              </p>
            ) : null}
            <button type="button" class="btn" data-testid="encoder-play" onClick={onEncoder}>
              Activar la barra
            </button>
          </div>
        ) : null}

        {encoderPhase === 'loading' ? (
          <div class="model__loading" data-testid="encoder-loading">
            {/* The caption below says the same thing in words, so the bar is decorative. */}
            <progress
              class="bar"
              aria-hidden="true"
              value={encoderDownload?.loaded ?? 0}
              max={Math.max(encoderDownload?.total ?? 1, 1)}
            />
            <span class="caption" data-testid="encoder-progress">
              {encoderDownload
                ? `${megabytes(encoderDownload.loaded)} / ${megabytes(encoderDownload.total)} MB · ${progressPercent(encoderDownload)} %`
                : 'Preparando la descarga…'}
            </span>
          </div>
        ) : null}

        {encoderPhase === 'ready' && encoderBackend.value ? (
          <>
            <p class="model__status caption" data-testid="encoder-ready">
              <span class="badge" data-testid="encoder-backend">
                {BACKEND_LABEL[encoderBackend.value]}
              </span>{' '}
              {encoder.label}
            </p>
            {phase === 'ready' ? (
              <p class="model__status caption" data-testid="total-size">
                Descargado en total: {totalSizeMb(current, encoder)} MB (modelo {current.sizeMb} MB
                + barra {encoder.sizeMb} MB).
              </p>
            ) : null}
          </>
        ) : null}

        {encoderPhase === 'error' ? (
          <p class="model__error caption" role="alert" data-testid="encoder-error">
            {encoderError.value ?? 'No se ha podido cargar el encoder'}
          </p>
        ) : null}
      </section>

      <p class="model__turn" data-testid="status" data-thinking={busy.value ? 'true' : 'false'}>
        {statusText(state, color, busy.value)}
      </p>
      <div class="model__row" role="group" aria-label="Color">
        <button
          type="button"
          class="btn"
          aria-pressed={color === 'w'}
          disabled={locked}
          onClick={() => onColor('w')}
        >
          Blancas
        </button>
        <button
          type="button"
          class="btn"
          aria-pressed={color === 'b'}
          disabled={locked}
          onClick={() => onColor('b')}
        >
          Negras
        </button>
      </div>
      <button
        type="button"
        class="btn"
        data-testid="clear-cache"
        data-cache={cache}
        onClick={() =>
          void onClearCache().then((result) =>
            setCache(result.error ? 'failed' : result.deleted ? 'deleted' : 'empty'),
          )
        }
      >
        {CACHE_LABEL[cache]}
      </button>
    </section>
  );
}
