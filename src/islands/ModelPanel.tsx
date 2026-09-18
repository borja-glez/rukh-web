import type { Signal } from '@preact/signals';
import { useState } from 'preact/hooks';
import type { Color, GameState } from '../lib/game';
import { findStage, MODEL_LICENSE, selectableStages, STAGES } from '../lib/registry';
import {
  megabytes,
  progressPercent,
  type Backend,
  type ProgressMessage,
} from '../lib/worker-protocol';
import type { ModelStatus } from './App';

interface Props {
  game: Signal<GameState>;
  human: Signal<Color>;
  stage: Signal<string>;
  busy: Signal<boolean>;
  status: Signal<ModelStatus>;
  progress: Signal<ProgressMessage | null>;
  backend: Signal<Backend | null>;
  error: Signal<string | null>;
  elo: Signal<number>;
  onStage: (id: string) => void;
  onColor: (color: Color) => void;
  onPlay: () => void;
  onClearCache: () => Promise<boolean>;
}

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
  error,
  elo,
  onStage,
  onColor,
  onPlay,
  onClearCache,
}: Props) {
  const state = game.value;
  const color = human.value;
  const locked = busy.value;
  const current = findStage(stage.value) ?? STAGES[0];
  const phase = status.value;
  const download = progress.value;
  const [cleared, setCleared] = useState(false);

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
          <progress
            class="bar"
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
        <p class="model__status caption">
          <span class="badge" data-testid="backend">
            {BACKEND_LABEL[backend.value]}
          </span>{' '}
          {current.label}
        </p>
      ) : null}

      {phase === 'error' ? (
        <p class="model__error caption" role="alert" data-testid="model-error">
          {error.value ?? 'No se ha podido cargar el modelo'}
        </p>
      ) : null}

      <p class="model__turn" data-testid="status">
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
        onClick={() => void onClearCache().then(() => setCleared(true))}
      >
        {cleared ? 'Modelos borrados' : 'Borrar modelos descargados'}
      </button>
    </section>
  );
}
