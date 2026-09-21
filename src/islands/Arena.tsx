import { computed, signal, type Signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { applyMove, newGame, type GameState, type Move } from '../lib/game';
import { proposeMove } from '../lib/model';
import { firstLegalMove } from '../lib/opponent';
import {
  MAX_PLIES,
  gamesNeeded,
  openingBook,
  scoreFor,
  summarize,
  type ArenaGame,
} from '../lib/arena';
import {
  STAGES,
  findStage,
  modelUrl,
  stageBlock,
  selectableStages,
  type Stage,
} from '../lib/registry';
import { megabytes, progressPercent, type ProgressMessage } from '../lib/worker-protocol';
import { UciTokenizer } from '../lib/chess-lm';
import { createDecoder, type Decoder } from '../workers/decoder-client';
import { MODEL_LICENSE } from '../lib/registry';
import { uciMove } from '../lib/puzzles';

/** Both sides play the canonical sampling of the table (`greedy.yaml`): near-deterministic. */
const ARENA_SAMPLING = { temperature: 0.05, topK: 1, maskIllegal: true };
const HEADER_ELO = 1800;
const GAME_OPTIONS = [10, 20, 40] as const;

type SideStatus = 'consent' | 'loading' | 'ready' | 'error';
type Side = 'a' | 'b';

interface Props {
  game: Signal<GameState>;
  /** Mock mode: both sides are the first-legal-move opponent and nothing is downloaded. */
  mock: boolean;
  /** Stage ids the query asked for; the second defaults to the next one in the registry. */
  initialA: string;
  initialB: string | null;
}

/** The arena's own state; module-level so a re-render never loses a running match. */
const stageA = signal<string>(STAGES[1]?.id ?? STAGES[0].id);
const stageB = signal<string>(STAGES[2]?.id ?? STAGES[0].id);
const statusA = signal<SideStatus>('consent');
const statusB = signal<SideStatus>('consent');
const progressA = signal<ProgressMessage | null>(null);
const progressB = signal<ProgressMessage | null>(null);
const planned = signal<number>(GAME_OPTIONS[0]);
const running = signal(false);
const games = signal<ArenaGame[]>([]);
const error = signal<string | null>(null);
/** Which side is to move in the game on the board, for the status line. */
const mover = signal<Side | null>(null);
const summary = computed(() => summarize(games.value, 7));

const tokenizer = new UciTokenizer();
let decoderA: Decoder | null = null;
let decoderB: Decoder | null = null;
/** Bumped by every stop or unmount so a loop still awaiting a move gives up. */
let generation = 0;

function stageOf(side: Side): Stage {
  const id = side === 'a' ? stageA.value : stageB.value;
  return findStage(id) ?? STAGES[0];
}

function reset(): void {
  generation += 1;
  running.value = false;
  games.value = [];
  mover.value = null;
  error.value = null;
}

async function disposeAll(): Promise<void> {
  const a = decoderA;
  const b = decoderB;
  decoderA = null;
  decoderB = null;
  statusA.value = 'consent';
  statusB.value = 'consent';
  progressA.value = null;
  progressB.value = null;
  await Promise.all([a?.dispose(), b?.dispose()]);
}

async function loadSide(side: Side): Promise<void> {
  const entry = stageOf(side);
  const status = side === 'a' ? statusA : statusB;
  const progress = side === 'a' ? progressA : progressB;
  status.value = 'loading';
  progress.value = null;
  try {
    const decoder = createDecoder();
    if (side === 'a') decoderA = decoder;
    else decoderB = decoder;
    await decoder.init(
      {
        stage: entry.id,
        url: modelUrl(entry),
        sizeBytes: Math.round(entry.sizeMb * 1_000_000),
        block: stageBlock(entry),
        vocab: tokenizer.size,
      },
      (update) => (progress.value = update),
    );
    status.value = 'ready';
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
    status.value = 'error';
  }
}

/** Downloads the two stages one after the other: the ORT build creates sessions in series. */
async function loadBoth(): Promise<void> {
  error.value = null;
  await loadSide('a');
  if (statusA.value === 'ready') await loadSide('b');
}

async function pick(side: Side, state: GameState, mock: boolean): Promise<Move | null> {
  if (mock) return firstLegalMove.pick(state.fen);
  const decoder = side === 'a' ? decoderA : decoderB;
  if (!decoder) return null;
  const proposal = await proposeMove(decoder, {
    state,
    whiteElo: HEADER_ELO,
    blackElo: HEADER_ELO,
    options: ARENA_SAMPLING,
    tokenizer,
  });
  return proposal.move;
}

function fromOpening(opening: string[]): GameState {
  let state = newGame();
  for (const uci of opening) {
    const next = applyMove(state, uciMove(uci));
    if (!next) throw new Error(`opening move ${uci} is not legal`);
    state = next;
  }
  return state;
}

/** Plays the schedule until it is done or `stop` is pressed, one game at a time on the board. */
async function play(game: Signal<GameState>, mock: boolean): Promise<void> {
  if (running.value) return;
  running.value = true;
  error.value = null;
  const mine = ++generation;
  const book = openingBook(Math.ceil(planned.value / 2), 7);
  try {
    while (running.value && generation === mine && games.value.length < planned.value) {
      const index = games.value.length;
      const opening = book[Math.floor(index / 2)];
      const aWhite = index % 2 === 0;
      let state = fromOpening(opening);
      game.value = state;
      let cut = false;
      while (!state.over) {
        if (state.history.length >= MAX_PLIES) {
          cut = true;
          break;
        }
        const side: Side = (state.turn === 'w') === aWhite ? 'a' : 'b';
        mover.value = side;
        const move = await pick(side, state, mock);
        if (generation !== mine) return;
        if (!move) throw new Error(`${stageOf(side).label} no ha propuesto jugada`);
        const next = applyMove(state, move);
        if (!next) throw new Error(`${stageOf(side).label} ha propuesto una jugada ilegal`);
        state = next;
        game.value = state;
      }
      games.value = [
        ...games.value,
        {
          index,
          opening,
          aWhite,
          score: cut ? 0.5 : scoreFor(state.result, aWhite),
          plies: state.history.length,
          cut,
        },
      ];
    }
  } catch (cause) {
    if (generation === mine) error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (generation === mine) {
      running.value = false;
      mover.value = null;
    }
  }
}

function stop(): void {
  generation += 1;
  running.value = false;
  mover.value = null;
}

function formatElo(value: number | null): string {
  if (value === null) return '—';
  const rounded = Math.round(value);
  return `${rounded > 0 ? '+' : ''}${rounded}`;
}

function SideBlock({
  side,
  stage,
  status,
  progress,
  disabled,
  onChange,
}: {
  side: Side;
  stage: Signal<string>;
  status: Signal<SideStatus>;
  progress: Signal<ProgressMessage | null>;
  disabled: boolean;
  onChange: (id: string) => void;
}) {
  const entry = findStage(stage.value) ?? STAGES[0];
  const download = progress.value;
  return (
    <label class="model__field">
      <span class="caption">
        Modelo {side.toUpperCase()}
        {status.value === 'ready' ? (
          <span class="badge" data-testid={`arena-ready-${side}`}>
            listo
          </span>
        ) : null}
      </span>
      <select
        class="select"
        data-testid={`arena-stage-${side}`}
        value={stage.value}
        disabled={disabled}
        onChange={(event) => onChange((event.currentTarget as HTMLSelectElement).value)}
      >
        {selectableStages(stage.value)
          .filter((option) => option.kind !== 'mock' || entry.kind === 'mock')
          .map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
              {option.sizeMb > 0 ? ` · ${option.sizeMb} MB` : ''}
            </option>
          ))}
      </select>
      {status.value === 'loading' ? (
        <span class="caption">
          {download
            ? `${megabytes(download.loaded)} / ${megabytes(download.total)} MB · ${progressPercent(download)} %`
            : 'Preparando la descarga…'}
        </span>
      ) : null}
    </label>
  );
}

/**
 * Two stages, one board, and the number a match can honestly give: A minus B in Elo with its
 * interval, over both colours of every opening. What it cannot give is a strength: there is no
 * third party here, which is exactly why the interval is so much narrower than the ladder's for
 * the same games (M5).
 */
export default function Arena({ game, mock, initialA, initialB }: Props) {
  useEffect(() => {
    reset();
    if (mock) {
      stageA.value = STAGES[0].id;
      stageB.value = STAGES[0].id;
      statusA.value = 'ready';
      statusB.value = 'ready';
    } else {
      stageA.value = findStage(initialA)?.id ?? stageA.value;
      const other = initialB ?? STAGES.find((s) => s.kind !== 'mock' && s.id !== stageA.value)?.id;
      stageB.value = other ?? stageB.value;
    }
    game.value = newGame();
    return () => {
      reset();
      void disposeAll();
    };
  }, [mock, initialA, initialB, game]);

  const ready = statusA.value === 'ready' && statusB.value === 'ready';
  const loading = statusA.value === 'loading' || statusB.value === 'loading';
  const result = summary.value;
  const a = stageOf('a');
  const b = stageOf('b');
  const changeStage = (side: Side) => (id: string) => {
    stop();
    void disposeAll();
    games.value = [];
    if (side === 'a') stageA.value = id;
    else stageB.value = id;
    if (mock) {
      statusA.value = 'ready';
      statusB.value = 'ready';
    }
  };

  return (
    <section class="model arena" aria-labelledby="arena-title" data-testid="arena">
      <h2 id="arena-title" class="label">
        Arena · modelo contra modelo
      </h2>
      <SideBlock
        side="a"
        stage={stageA}
        status={statusA}
        progress={progressA}
        disabled={loading || running.value}
        onChange={changeStage('a')}
      />
      <SideBlock
        side="b"
        stage={stageB}
        status={statusB}
        progress={progressB}
        disabled={loading || running.value}
        onChange={changeStage('b')}
      />
      <label class="model__field">
        <span class="caption">Partidas</span>
        <select
          class="select"
          data-testid="arena-games-select"
          value={String(planned.value)}
          disabled={running.value}
          onChange={(event) => {
            planned.value = Number((event.currentTarget as HTMLSelectElement).value);
            games.value = games.value.slice(0, planned.value);
          }}
        >
          {GAME_OPTIONS.map((count) => (
            <option key={count} value={String(count)}>
              {count} · detecta unos {Math.round(eloDetectable(count))} Elo
            </option>
          ))}
        </select>
      </label>

      {!ready && !loading && !mock ? (
        <div class="consent" data-testid="arena-consent">
          <p class="consent__text">
            <strong>{a.label}</strong> ({a.sizeMb} MB) y <strong>{b.label}</strong> ({b.sizeMb} MB)
            se descargan desde Hugging Face, licencia {MODEL_LICENSE}, y se guardan en el navegador.
            Son dos modelos en memoria a la vez: en un móvil, elige las versiones int8.
          </p>
          <button
            type="button"
            class="btn btn--primary"
            data-testid="arena-download"
            onClick={() => void loadBoth()}
          >
            Descargar los dos
          </button>
        </div>
      ) : null}

      {loading ? <progress class="bar" aria-hidden="true" data-testid="arena-loading" /> : null}

      {error.value ? (
        <p class="model__error caption" role="alert" data-testid="arena-error">
          {error.value}
        </p>
      ) : null}

      <div class="model__row">
        {running.value ? (
          <button type="button" class="btn" data-testid="arena-stop" onClick={stop}>
            Parar
          </button>
        ) : (
          <button
            type="button"
            class="btn btn--primary"
            data-testid="arena-start"
            disabled={!ready || games.value.length >= planned.value}
            onClick={() => void play(game, mock)}
          >
            {games.value.length === 0 ? 'Empezar' : 'Continuar'}
          </button>
        )}
        <button
          type="button"
          class="btn"
          data-testid="arena-reset"
          disabled={running.value || games.value.length === 0}
          onClick={() => {
            games.value = [];
            game.value = newGame();
          }}
        >
          Reiniciar
        </button>
      </div>

      <p class="model__status caption" data-testid="arena-status" aria-live="polite">
        {running.value
          ? `Partida ${games.value.length + 1} de ${planned.value} · mueve ${mover.value === 'a' ? a.label : b.label}`
          : games.value.length === 0
            ? 'Sin partidas'
            : `${games.value.length} de ${planned.value} partidas`}
      </p>

      <dl class="arena__summary" data-testid="arena-summary">
        <div>
          <dt class="caption">A − B</dt>
          <dd class="mono" data-testid="arena-elo">
            {formatElo(result.elo)}
            {result.low !== null && result.high !== null
              ? ` (IC ${formatElo(result.low)} a ${formatElo(result.high)})`
              : ''}
          </dd>
        </div>
        <div>
          <dt class="caption">Puntos de A</dt>
          <dd class="mono" data-testid="arena-score">
            {result.games > 0
              ? `${result.wins}+${result.draws}=${result.losses} · ${result.score.toFixed(3)}`
              : '—'}
          </dd>
        </div>
      </dl>
      <p class="caption arena__note" data-testid="arena-verdict">
        {result.games === 0
          ? `${planned.value} partidas separan del cero una diferencia de unos ${Math.round(eloDetectable(planned.value))} Elo. Cada apertura se juega con los dos colores.`
          : result.low === null
            ? 'Una partida no dice nada; sigue.'
            : result.separated
              ? 'El intervalo no toca el cero: la diferencia es medible con estas partidas.'
              : 'El intervalo incluye el cero: con estas partidas no se puede distinguir a los dos.'}
        {result.cut > 0
          ? ` ${result.cut} partida(s) cortadas a ${MAX_PLIES} plies cuentan como tablas.`
          : ''}
      </p>
    </section>
  );
}

/** The Elo edge `games` games can separate from zero at 95 % (the inverse of `gamesNeeded`). */
function eloDetectable(games: number): number {
  let low = 1;
  let high = 400;
  while (high - low > 1) {
    const mid = (low + high) / 2;
    if (gamesNeeded(mid) <= games) high = mid;
    else low = mid;
  }
  return high;
}
