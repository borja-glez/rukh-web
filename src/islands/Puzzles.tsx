import { signal, type Signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { applyMove, newGame, type GameState, type Move } from '../lib/game';
import {
  BANDS,
  expectedMoves,
  loadPuzzleSet,
  progressByBand,
  puzzleStart,
  rate,
  uciMove,
  type Band,
  type Puzzle,
  type PuzzleAttempt,
  type PuzzleSet,
} from '../lib/puzzles';
import { MODEL_LICENSE } from '../lib/registry';
import type { ModelStatus } from './App';

/** The move chooser of the play screen, with the header the puzzle's own game carried. */
export type PuzzleMover = (
  state: GameState,
  header: { whiteElo: number; blackElo: number },
) => Promise<Move | null>;

interface Props {
  game: Signal<GameState>;
  status: Signal<ModelStatus>;
  stageLabel: string;
  sizeMb: number;
  /** Runs the consent step's download (the play screen's `load`). */
  onLoad: () => void;
  pick: PuzzleMover;
}

const HEADER_ELO = 1800;

const set = signal<PuzzleSet | null>(null);
const band = signal<Band>(BANDS[0]);
const attempts = signal<PuzzleAttempt[]>([]);
const running = signal(false);
const current = signal<Puzzle | null>(null);
/** The last miss: what the model played against what the line expected. */
const miss = signal<{ proposed: string; expected: string } | null>(null);
const error = signal<string | null>(null);
let generation = 0;

function reset(): void {
  generation += 1;
  running.value = false;
  attempts.value = [];
  current.value = null;
  miss.value = null;
  error.value = null;
}

async function ensureSet(): Promise<PuzzleSet> {
  if (set.value) return set.value;
  const loaded = await loadPuzzleSet();
  set.value = loaded;
  return loaded;
}

/** Attempts one puzzle the way the harness does; the board follows every move. */
async function attempt(
  puzzle: Puzzle,
  chosen: Band,
  game: Signal<GameState>,
  pick: PuzzleMover,
  mine: number,
): Promise<PuzzleAttempt | null> {
  let state = puzzleStart(puzzle);
  if (!state) return null;
  game.value = state;
  const expected = expectedMoves(puzzle);
  const header = {
    whiteElo: puzzle.whiteElo ?? HEADER_ELO,
    blackElo: puzzle.blackElo ?? HEADER_ELO,
  };
  let correct = 0;
  let proposed: string | null = null;
  let missed: string | null = null;
  for (let index = 0; index < puzzle.moves.length; index += 1) {
    const uci = puzzle.moves[index];
    if (index % 2 === 1) {
      const move = await pick(state, header);
      if (generation !== mine) return null;
      const played = move ? `${move.from}${move.to}${move.promotion ?? ''}` : null;
      if (played !== uci) {
        proposed = played ?? '—';
        missed = uci;
        break;
      }
      correct += 1;
    }
    const next = applyMove(state, uciMove(uci));
    if (!next) break;
    state = next;
    game.value = state;
  }
  return {
    id: puzzle.id,
    band: chosen,
    rating: puzzle.rating,
    solved: correct === expected.length && expected.length > 0,
    correct,
    total: expected.length,
    proposed,
    expected: missed,
  };
}

async function run(game: Signal<GameState>, pick: PuzzleMover): Promise<void> {
  if (running.value) return;
  running.value = true;
  error.value = null;
  const mine = ++generation;
  try {
    const loaded = await ensureSet();
    const chosen = band.value;
    const done = new Set(attempts.value.map((a) => a.id));
    for (const puzzle of loaded.bands[chosen] ?? []) {
      if (!running.value || generation !== mine) return;
      if (done.has(puzzle.id)) continue;
      current.value = puzzle;
      miss.value = null;
      const result = await attempt(puzzle, chosen, game, pick, mine);
      if (generation !== mine) return;
      if (!result) continue;
      attempts.value = [...attempts.value, result];
      if (!result.solved && result.proposed && result.expected) {
        miss.value = { proposed: result.proposed, expected: result.expected };
      }
    }
  } catch (cause) {
    if (generation === mine) error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (generation === mine) running.value = false;
  }
}

function stop(): void {
  generation += 1;
  running.value = false;
}

/**
 * The table's puzzle column, live: fifty puzzles per band, the real game as the prompt, the
 * whole line as the criterion. The rate on screen is what `rukh eval` reports for the same
 * stage, up to the sampler (the harness plays the argmax; the demo plays temperature 0.05 with
 * top-k 1, which is the same move almost always).
 */
export default function Puzzles({ game, status, stageLabel, sizeMb, onLoad, pick }: Props) {
  useEffect(() => {
    reset();
    game.value = newGame();
    void ensureSet().catch((cause) => (error.value = String(cause)));
    return () => {
      reset();
    };
  }, [game]);

  const phase = status.value;
  const canRun = phase === 'ready' || phase === 'mock';
  const progress = progressByBand(attempts.value);
  const total = attempts.value.length;
  const solved = attempts.value.filter((a) => a.solved).length;
  const remaining =
    (set.value?.bands[band.value]?.length ?? 0) -
    progress.find((p) => p.band === band.value)!.attempted;

  return (
    <section class="model puzzles" aria-labelledby="puzzles-title" data-testid="puzzles">
      <h2 id="puzzles-title" class="label">
        Puzles · {stageLabel}
      </h2>
      <label class="model__field">
        <span class="caption">Tramo de dificultad</span>
        <select
          class="select"
          data-testid="puzzles-band"
          value={band.value}
          disabled={running.value}
          onChange={(event) =>
            (band.value = (event.currentTarget as HTMLSelectElement).value as Band)
          }
        >
          {BANDS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>

      {phase === 'consent' ? (
        <div class="consent" data-testid="puzzles-consent">
          <p class="consent__text">
            {/* A model read from disk is already here: saying it downloads would be a lie, and
                this text exists precisely to be believed before bytes are spent. */}
            {sizeMb > 0 ? (
              <>
                <strong>{stageLabel}</strong> se descarga desde Hugging Face: {sizeMb} MB, licencia{' '}
                {MODEL_LICENSE}.{' '}
              </>
            ) : (
              <>
                <strong>{stageLabel}</strong> ya está en tu navegador: no se descarga nada.{' '}
              </>
            )}
            Los puzles son cincuenta por tramo, del mismo conjunto de prueba que mide la tabla del
            curso.
          </p>
          <button
            type="button"
            class="btn btn--primary"
            data-testid="puzzles-load"
            onClick={onLoad}
          >
            {sizeMb > 0 ? 'Descargar' : 'Empezar'}
          </button>
        </div>
      ) : null}
      {phase === 'loading' ? <progress class="bar" aria-hidden="true" /> : null}
      {phase === 'error' ? (
        <p class="model__error caption" role="alert">
          No se ha podido cargar el modelo
        </p>
      ) : null}

      <div class="model__row">
        {running.value ? (
          <button type="button" class="btn" data-testid="puzzles-stop" onClick={stop}>
            Parar
          </button>
        ) : (
          <button
            type="button"
            class="btn btn--primary"
            data-testid="puzzles-start"
            disabled={!canRun || !set.value || remaining <= 0}
            onClick={() => void run(game, pick)}
          >
            {total === 0 ? 'Resolver el tramo' : 'Continuar'}
          </button>
        )}
        <button
          type="button"
          class="btn"
          data-testid="puzzles-reset"
          disabled={running.value || total === 0}
          onClick={() => {
            attempts.value = [];
            miss.value = null;
            current.value = null;
            game.value = newGame();
          }}
        >
          Reiniciar
        </button>
      </div>

      <p class="model__status caption" data-testid="puzzles-status" aria-live="polite">
        {running.value && current.value
          ? `Puzle ${current.value.id} · ${current.value.rating} · ${total + 1} de ${set.value?.bands[band.value]?.length ?? '?'}`
          : total === 0
            ? 'Sin intentos'
            : `${solved} de ${total} resueltos · ${rate(solved, total)}`}
      </p>
      {miss.value ? (
        <p class="caption puzzles__miss" data-testid="puzzles-miss">
          Falló: propuso <span class="mono">{miss.value.proposed}</span>, la línea seguía con{' '}
          <span class="mono">{miss.value.expected}</span>
        </p>
      ) : null}
      {error.value ? (
        <p class="model__error caption" role="alert" data-testid="puzzles-error">
          {error.value}
        </p>
      ) : null}

      <table class="puzzles__table" data-testid="puzzles-progress">
        <thead>
          <tr>
            <th scope="col" class="caption">
              Tramo
            </th>
            <th scope="col" class="caption">
              Intentados
            </th>
            <th scope="col" class="caption">
              Resueltos
            </th>
          </tr>
        </thead>
        <tbody>
          {progress.map((row) => (
            <tr key={row.band} data-band={row.band}>
              <td class="mono">{row.band}</td>
              <td class="mono" data-testid={`puzzles-attempted-${row.band}`}>
                {row.attempted}
              </td>
              <td class="mono" data-testid={`puzzles-rate-${row.band}`}>
                {rate(row.solved, row.attempted)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p class="caption arena__note">
        El criterio es el de la tabla: la línea entera, con la partida real como contexto. Un puzle
        a medias no cuenta.
      </p>
    </section>
  );
}
