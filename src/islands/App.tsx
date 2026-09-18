import { computed, signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import {
  applyMove,
  canUndo,
  newGame,
  toPgn,
  undoPair,
  type Color,
  type GameState,
  type Move,
} from '../lib/game';
import {
  DEFAULT_SAMPLE,
  proposeMove,
  type Proposal,
  type TopEntry,
  type Timings,
} from '../lib/model';
import { firstLegalMove, type Opponent } from '../lib/opponent';
import { parseQuery } from '../lib/query';
import { findStage, modelUrl, STAGES, type Stage } from '../lib/registry';
import { MODEL_CACHE, type Backend, type ProgressMessage } from '../lib/worker-protocol';
import { createDecoder, type Decoder } from '../workers/decoder-client';
import Board from './Board';
import ModelPanel from './ModelPanel';
import More from './More';
import MoveList from './MoveList';

const HUMAN_LABEL = 'Humano';
/** How many moves the latency waterfall keeps. */
const WATERFALL_LENGTH = 10;

/** Model lifecycle: nothing is downloaded before the user consents in the `consent` step. */
export type ModelStatus = 'mock' | 'consent' | 'loading' | 'ready' | 'error';

/** Game state lives in module-level signals so the three zones share one source of truth. */
const game = signal<GameState>(newGame());
const human = signal<Color>('w');
const stage = signal<string>(STAGES[0].id);
/** True while the opponent is thinking. */
const thinking = signal(false);
/** True while the board animates a turn: colour changes wait for it. */
const turning = signal(false);
const busy = computed(() => thinking.value || turning.value);

const status = signal<ModelStatus>('mock');
const progress = signal<ProgressMessage | null>(null);
const backend = signal<Backend | null>(null);
const loadMs = signal(0);
const error = signal<string | null>(null);

/** Sampling controls; they live in the drawer, not on the main screen. */
const temperature = signal(DEFAULT_SAMPLE.temperature);
const topK = signal<number>(DEFAULT_SAMPLE.topK ?? 20);
const maskIllegal = signal(true);
const showArrows = signal(false);
const elo = signal(1800);

const top5 = signal<TopEntry[]>([]);
const waterfall = signal<Timings[]>([]);
/** Raw token of the last illegal proposal (unmasked mode); shown in the move list. */
const illegal = signal<string | null>(null);

let decoder: Decoder | null = null;

function currentStage(): Stage {
  return findStage(stage.value) ?? STAGES[0];
}

function opponentToMove(state: GameState): boolean {
  return !state.over && state.turn !== human.value;
}

function record(proposal: Proposal) {
  top5.value = proposal.top5;
  waterfall.value = [...waterfall.value, proposal.timings].slice(-WATERFALL_LENGTH);
}

/** The mock opponent, or the decoder once its session is ready. */
async function pickMove(state: GameState): Promise<Move | null> {
  if (status.value === 'mock') {
    const opponent: Opponent = firstLegalMove;
    return opponent.pick(state.fen);
  }
  if (!decoder || status.value !== 'ready') return null;
  const source = decoder;
  const options = {
    temperature: temperature.value,
    topK: topK.value,
    maskIllegal: maskIllegal.value,
  };
  const proposal = await proposeMove(source, {
    state,
    whiteElo: elo.value,
    blackElo: elo.value,
    options,
  });
  record(proposal);
  if (proposal.move) {
    illegal.value = null;
    return proposal.move;
  }
  // Unmasked mode: the network proposed something that is not a legal move. It is reported
  // instead of played and the move is drawn again with the mask on, so the game continues
  // (`play_game` in Python does exactly this to keep counting illegal proposals).
  illegal.value = proposal.rawToken || null;
  if (proposal.masked) return null;
  const rescue = await proposeMove(source, {
    state,
    whiteElo: elo.value,
    blackElo: elo.value,
    options: { ...options, maskIllegal: true },
  });
  record(rescue);
  return rescue.move;
}

async function settle() {
  const current = game.value;
  if (!opponentToMove(current) || thinking.value) return;
  if (status.value !== 'mock' && status.value !== 'ready') return;
  thinking.value = true;
  try {
    const move = await pickMove(current);
    // The position may have been reset (new game, colour change, undo) while the opponent
    // was thinking: drop the stale reply; the `finally` below re-schedules if needed.
    if (game.value.fen !== current.fen || !move) return;
    const next = applyMove(current, move);
    if (next) game.value = next;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
    status.value = 'error';
  } finally {
    thinking.value = false;
    // Re-run only when a newer position still waits for the opponent (no loop otherwise).
    if (game.value.fen !== current.fen && opponentToMove(game.value)) void settle();
  }
}

function playHuman(move: Move): boolean {
  const current = game.value;
  if (busy.value || current.over || current.turn !== human.value) return false;
  const next = applyMove(current, move);
  if (!next) return false;
  game.value = next;
  void settle();
  return true;
}

function startNewGame() {
  game.value = newGame();
  top5.value = [];
  illegal.value = null;
  void settle();
}

function chooseColor(color: Color) {
  if (color === human.value || busy.value) return;
  human.value = color;
  startNewGame();
}

function undo() {
  if (busy.value || !canUndo(game.value, human.value)) return;
  game.value = undoPair(game.value, human.value);
  illegal.value = null;
  // As black, undo leaves the opponent to move: let it reply.
  void settle();
}

/** Downloads the stage and creates the session. Only ever called from the consent step. */
async function load() {
  const entry = currentStage();
  if (entry.kind === 'mock') {
    status.value = 'mock';
    void settle();
    return;
  }
  status.value = 'loading';
  error.value = null;
  progress.value = null;
  try {
    decoder ??= createDecoder();
    const ready = await decoder.init(
      entry.id,
      modelUrl(entry),
      Math.round(entry.sizeMb * 1_000_000),
      (update) => (progress.value = update),
    );
    backend.value = ready.backend;
    loadMs.value = ready.loadMs;
    status.value = 'ready';
    void settle();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
    status.value = 'error';
  }
}

function chooseStage(id: string) {
  if (id === stage.value) return;
  stage.value = id;
  top5.value = [];
  waterfall.value = [];
  illegal.value = null;
  backend.value = null;
  progress.value = null;
  error.value = null;
  const entry = currentStage();
  if (entry.kind === 'mock') {
    status.value = 'mock';
    void decoder?.dispose();
    decoder = null;
  } else {
    // A new stage means a new session: back to the consent step, nothing is fetched yet.
    status.value = 'consent';
    void decoder?.dispose();
    decoder = null;
  }
  startNewGame();
}

/** Empties the Cache API bucket so the next "Jugar" downloads the weights again. */
async function clearCache(): Promise<boolean> {
  try {
    return await caches.delete(MODEL_CACHE);
  } catch {
    return false;
  }
}

function stageLabel(): string {
  return currentStage().label;
}

function exportPgn(): string {
  const white = human.value === 'w' ? HUMAN_LABEL : stageLabel();
  const black = human.value === 'b' ? HUMAN_LABEL : stageLabel();
  return toPgn(game.value, { White: white, Black: black });
}

export default function App() {
  useEffect(() => {
    const query = parseQuery(window.location.search);
    stage.value = query.stage;
    status.value = currentStage().kind === 'mock' ? 'mock' : 'consent';
    if (query.color !== human.value) {
      human.value = query.color;
    }
    void settle();
  }, []);

  return (
    <>
      <Board
        game={game}
        human={human}
        turning={turning}
        top5={top5}
        arrows={showArrows}
        onMove={playHuman}
      />
      <aside class="panel" data-testid="panel" aria-label="Modelo y jugadas">
        <ModelPanel
          game={game}
          human={human}
          stage={stage}
          busy={busy}
          status={status}
          progress={progress}
          backend={backend}
          error={error}
          elo={elo}
          onStage={chooseStage}
          onColor={chooseColor}
          onPlay={() => void load()}
          onClearCache={clearCache}
        />
        <MoveList
          game={game}
          human={human}
          busy={busy}
          illegal={illegal}
          onUndo={undo}
          onNewGame={startNewGame}
          onExport={exportPgn}
        />
      </aside>
      <More
        temperature={temperature}
        topK={topK}
        maskIllegal={maskIllegal}
        showArrows={showArrows}
        waterfall={waterfall}
        top5={top5}
        loadMs={loadMs}
        backend={backend}
      />
    </>
  );
}
