import { computed, effect, signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import {
  applyMove,
  canUndo,
  fromFen,
  newGame,
  toPgn,
  undoPair,
  type Color,
  type GameState,
  type Move,
} from '../lib/game';
import {
  CONTEXT,
  DEFAULT_SAMPLE,
  proposeMove,
  type Proposal,
  type TopEntry,
  type Timings,
} from '../lib/model';
import { firstLegalMove, type Opponent } from '../lib/opponent';
import { parseQuery, MODES, type Mode } from '../lib/query';
import type { ModelContract } from '../lib/contract';
import {
  adapterUrl,
  encoderBlock,
  findAdapter,
  findEncoderStage,
  findStage,
  modelUrl,
  stageBlock,
  ENCODER_STAGES,
  NO_ADAPTER,
  STAGES,
  type Stage,
} from '../lib/registry';
import { MODEL_CACHE, type Backend, type ProgressMessage } from '../lib/worker-protocol';
import { isCached } from '../lib/download';
import { fenToTokens, UciTokenizer } from '../lib/chess-lm';
import { createDecoder, type Decoder } from '../workers/decoder-client';
import { createEncoder, type Encoder } from '../workers/encoder-client';
import Arena from './Arena';
import Board from './Board';
import EvalBar, { supersedes, type Evaluation } from './EvalBar';
import Puzzles from './Puzzles';
import ModelPanel from './ModelPanel';
import More from './More';
import MoveList from './MoveList';

const HUMAN_LABEL = 'Humano';
/** How many moves the latency waterfall keeps. */
const WATERFALL_LENGTH = 10;

/** Model lifecycle: nothing is downloaded before the user consents in the `consent` step. */
export type ModelStatus = 'mock' | 'consent' | 'loading' | 'ready' | 'error';

/**
 * The encoder's own lifecycle. It is a second model with a second consent: having accepted the
 * 40 MB of the decoder says nothing about accepting the 30 MB of the evaluation bar, so the bar
 * asks for itself and stays at `consent` until it is told otherwise.
 */
export type EncoderStatus = 'consent' | 'loading' | 'ready' | 'error';

/** Outcome of "Borrar modelos descargados": what `caches.delete` answered, or why it could not. */
export interface ClearCacheResult {
  deleted: boolean;
  error?: string;
}

/** Game state lives in module-level signals so the three zones share one source of truth. */
const game = signal<GameState>(newGame());
const human = signal<Color>('w');
const stage = signal<string>(STAGES[0].id);
/** What the screen is doing; the arena and the puzzles lock the board (nobody moves by hand). */
const mode = signal<Mode>('play');
const locked = computed(() => mode.value !== 'play');
/** The arena's second stage when the query named one (`?vs=`). */
const arenaB = signal<string | null>(null);
const MODE_LABELS: Record<Mode, string> = { play: 'Jugar', arena: 'Arena', puzzles: 'Puzles' };
/** True while the opponent is thinking. */
const thinking = signal(false);
/** True while the board animates a turn: colour changes wait for it. */
const turning = signal(false);
const busy = computed(() => thinking.value || turning.value);

const status = signal<ModelStatus>('mock');
const progress = signal<ProgressMessage | null>(null);
const backend = signal<Backend | null>(null);
/** Why WebGPU was not used, when it was not; shown under the backend badge. */
const fallbackReason = signal<string | null>(null);
const loadMs = signal(0);
const error = signal<string | null>(null);
/** What the loaded file was checked against, or null while nothing is loaded. */
const contract = signal<ModelContract | null>(null);
/** Context window the loaded session reported; `CONTEXT` until one has. */
const context = signal(CONTEXT);

/** The tokenizer the prompt is built with; its size is the contract the worker checks. */
const tokenizer = new UciTokenizer();

/** Sampling controls; they live in the drawer, not on the main screen. */
const temperature = signal(DEFAULT_SAMPLE.temperature);
const topK = signal<number>(DEFAULT_SAMPLE.topK ?? 20);
const maskIllegal = signal(true);
const showArrows = signal(false);
const elo = signal(1800);

/**
 * The style adapter loaded into the live session, and whether one is on its way.
 *
 * `NO_ADAPTER` is not "the feature is off": the graph still takes its two factors and is fed
 * zeros, which is the base model exactly. So switching styles never rebuilds the session and
 * never re-downloads the model — it uploads 1.6 MB and the next move comes out different.
 */
const adapter = signal<string>(NO_ADAPTER);
const adapterBusy = signal(false);

/** The evaluation bar: its own stage, its own consent, its own worker. */
const encoderStage = signal<string>(ENCODER_STAGES[0].id);
const encoderStatus = signal<EncoderStatus>('consent');
const encoderProgress = signal<ProgressMessage | null>(null);
const encoderBackend = signal<Backend | null>(null);
const encoderError = signal<string | null>(null);
const evaluation = signal<Evaluation | null>(null);
/**
 * Bumped every time the game on the board is replaced (new game, undo, colour or stage change).
 * An evaluation that was asked for under an older generation belongs to a game that no longer
 * exists, so it is dropped: the bar deliberately survives the opponent's replies (see
 * `supersedes`), which means the position it belongs to is usually *not* the one on the board and
 * a `fen` comparison can no longer tell "stale" from "the move the player is being told about".
 */
let generation = 0;

/** Forgets the current evaluation and refuses every answer already in flight. */
function dropEvaluation(): void {
  generation += 1;
  evaluation.value = null;
}

const top5 = signal<TopEntry[]>([]);
const waterfall = signal<Timings[]>([]);
/** Raw token of the last illegal proposal (unmasked mode); shown in the move list. */
const illegal = signal<string | null>(null);

let decoder: Decoder | null = null;
let encoder: Encoder | null = null;

function currentStage(): Stage {
  return findStage(stage.value) ?? STAGES[0];
}

function currentEncoderStage(): Stage {
  return findEncoderStage(encoderStage.value) ?? ENCODER_STAGES[0];
}

function opponentToMove(state: GameState): boolean {
  return !state.over && state.turn !== human.value;
}

function record(proposal: Proposal) {
  top5.value = proposal.top5;
  waterfall.value = [...waterfall.value, proposal.timings].slice(-WATERFALL_LENGTH);
}

/**
 * The mock opponent, or the decoder once its session is ready. `header` overrides the Elo the
 * prompt is written with: the puzzles carry their players' own ratings, as the harness does.
 */
async function pickMove(
  state: GameState,
  header?: { whiteElo: number; blackElo: number },
): Promise<Move | null> {
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
  const whiteElo = header?.whiteElo ?? elo.value;
  const blackElo = header?.blackElo ?? elo.value;
  const proposal = await proposeMove(source, {
    state,
    whiteElo,
    blackElo,
    options,
    tokenizer,
    context: context.value,
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
    whiteElo,
    blackElo,
    options: { ...options, maskIllegal: true },
    tokenizer,
    context: context.value,
  });
  record(rescue);
  return rescue.move;
}

async function settle() {
  // The arena and the puzzles drive the board themselves; the play loop stays out of it.
  if (mode.value !== 'play') return;
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
  // The bar belongs to a position that no longer exists; the effect below refills it.
  dropEvaluation();
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
  dropEvaluation();
  // As black, undo leaves the opponent to move: let it reply.
  void settle();
}

/**
 * Are this stage's bytes already on the machine? Used to skip a consent step that would be
 * asking about a download that will not happen.
 *
 * The consent step buys the reader a choice about spending tens of megabytes of their
 * connection. After a reload the bytes are in the Cache API and that cost is zero, so the
 * question is noise: they would accept "75 MB", watch the bar finish instantly, and learn
 * nothing. Where the Cache API cannot answer -- private window, blocked site data -- this says
 * no and the page asks, which is the safe direction.
 */
async function alreadyOnDisk(entry: Stage): Promise<boolean> {
  if (entry.kind === 'mock' || !entry.repo) return false;
  return isCached(modelUrl(entry), { caches: globalThis.caches, cacheName: MODEL_CACHE });
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
      {
        stage: entry.id,
        url: modelUrl(entry),
        sizeBytes: Math.round(entry.sizeMb * 1_000_000),
        block: stageBlock(entry),
        vocab: tokenizer.size,
      },
      (update) => (progress.value = update),
    );
    backend.value = ready.backend;
    fallbackReason.value = ready.fallbackReason ?? null;
    loadMs.value = ready.loadMs;
    context.value = ready.block;
    contract.value = { block: ready.block, vocab: ready.vocab, adapter: null };
    status.value = 'ready';
    void settle();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
    status.value = 'error';
  }
}

/**
 * Downloads the encoder and creates its session. Only ever called from the bar's own consent
 * step, which is separate from the decoder's on purpose (see `EncoderStatus`).
 */
async function loadEncoder() {
  const entry = currentEncoderStage();
  encoderStatus.value = 'loading';
  encoderError.value = null;
  encoderProgress.value = null;
  try {
    encoder ??= createEncoder();
    const ready = await encoder.init(
      {
        stage: entry.id,
        url: modelUrl(entry),
        sizeBytes: Math.round(entry.sizeMb * 1_000_000),
        block: encoderBlock(entry),
      },
      (update) => (encoderProgress.value = update),
    );
    encoderBackend.value = ready.backend;
    encoderStatus.value = 'ready';
  } catch (cause) {
    encoderError.value = cause instanceof Error ? cause.message : String(cause);
    encoderStatus.value = 'error';
  }
}

/**
 * Turns the bar off again: releases the ORT session, terminates the worker and goes back to the
 * consent step. Without this the encoder is load-once for the life of the page — a second worker,
 * a second session and 30 MB of weights that a player who only wanted to look at the bar once has
 * no way of giving back. The weights stay in the Cache API (that is what "Borrar modelos
 * descargados" is for), so turning it on again costs no download.
 */
async function stopEncoder() {
  const live = encoder;
  encoder = null;
  encoderStatus.value = 'consent';
  encoderProgress.value = null;
  encoderBackend.value = null;
  encoderError.value = null;
  dropEvaluation();
  await live?.dispose();
}

/**
 * Evaluates a position the board settled on. The worker serialises its own runs, so a burst of
 * moves only queues; what is decided here is *which* answer the bar ends up drawing, and that is
 * not simply the newest one — `supersedes` explains why the player's own move wins over the reply
 * that follows it milliseconds later.
 *
 * A failed `evaluate` is a failed **run**, not a failed session: the bar is emptied (a frozen
 * number about a position nobody is looking at any more is worse than no number) and the reason
 * is shown in the panel, but the session stays `ready`, so the next position simply tries again.
 */
async function evaluatePosition(state: GameState) {
  const source = encoder;
  if (!source || encoderStatus.value !== 'ready') return;
  const asked = generation;
  const fen = state.fen;
  const ply = state.history.length;
  const move = ply > 0 ? state.history[ply - 1] : null;
  // The side that has just moved is the one that is *not* to move now.
  const byHuman = ply > 0 && state.turn !== human.value;
  try {
    const answer = await source.evaluate(fenToTokens(fen));
    if (asked !== generation) return;
    const next: Evaluation = { value: answer.value, blunder: answer.blunder, move, ply, byHuman };
    if (!supersedes(next, evaluation.value)) return;
    encoderError.value = null;
    evaluation.value = next;
  } catch (cause) {
    if (asked !== generation) return;
    encoderError.value = cause instanceof Error ? cause.message : String(cause);
    evaluation.value = null;
  }
}

/**
 * Loads a style adapter into the live session, or clears it.
 *
 * The signal is set to what actually took, not to what was clicked: a failed download has to
 * leave the selector showing the style the model is really playing with, or the page would be
 * claiming a style the weights know nothing about.
 */
async function chooseAdapter(id: string): Promise<void> {
  if (id === adapter.value || adapterBusy.value) return;
  const entry = findAdapter(id);
  if (!decoder || status.value !== 'ready') return;
  adapterBusy.value = true;
  error.value = null;
  const previous = adapter.value;
  try {
    await decoder.adapter(
      {
        adapter: entry?.id ?? '',
        url: entry ? adapterUrl(entry) : null,
        sizeBytes: entry?.sizeBytes ?? 0,
      },
      (update) => (progress.value = update),
    );
    adapter.value = entry ? entry.id : NO_ADAPTER;
  } catch (cause) {
    adapter.value = previous;
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    adapterBusy.value = false;
    progress.value = null;
  }
}

function chooseStage(id: string) {
  if (id === stage.value) return;
  stage.value = id;
  adapter.value = NO_ADAPTER;
  adapterBusy.value = false;
  top5.value = [];
  waterfall.value = [];
  illegal.value = null;
  backend.value = null;
  fallbackReason.value = null;
  progress.value = null;
  error.value = null;
  context.value = CONTEXT;
  contract.value = null;
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

/**
 * Empties the Cache API bucket so the next "Jugar" downloads the weights again. The panel reports
 * what actually happened, so `deleted: false` (there was nothing stored) and a refusal (private
 * mode, blocked storage) are told apart instead of both looking like success.
 */
async function clearCache(): Promise<ClearCacheResult> {
  try {
    return { deleted: await caches.delete(MODEL_CACHE) };
  } catch (cause) {
    return { deleted: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

function stageLabel(): string {
  return currentStage().label;
}

/** Switches between playing, the arena and the puzzles; the board starts over each time. */
function chooseMode(next: Mode) {
  if (next === mode.value) return;
  mode.value = next;
  dropEvaluation();
  game.value = newGame();
  illegal.value = null;
  if (next === 'play') void settle();
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
    encoderStage.value = query.encoder;
    mode.value = query.mode;
    arenaB.value = query.vs;
    // A shared position (`?fen=`) starts the game there, with no history behind it: the model
    // plays from a shorter prompt than it was trained on, which the model card says out loud.
    if (query.fen && query.mode === 'play') game.value = fromFen(query.fen);
    status.value = currentStage().kind === 'mock' ? 'mock' : 'consent';
    // A reload finds the weights in the Cache API. Asking again would be asking about a
    // download that will not happen, so the model just loads.
    void (async () => {
      const entry = currentStage();
      if (entry.kind !== 'mock' && (await alreadyOnDisk(entry)) && status.value === 'consent') {
        void load();
      }
      const bar = findEncoderStage(encoderStage.value);
      if (bar && (await alreadyOnDisk(bar)) && encoderStatus.value === 'consent') {
        void loadEncoder();
      }
    })();
    if (query.color !== human.value) {
      human.value = query.color;
    }
    void settle();
  }, []);

  // Every position the board settles on is evaluated, and so is the one already on the board
  // when the encoder becomes ready (the effect reads `encoderStatus` too). It is an `effect`
  // rather than a dependency array because `App` does not re-render when `game` changes: it only
  // hands the signal to its children.
  useEffect(
    () =>
      effect(() => {
        const state = game.value;
        if (encoderStatus.value === 'ready') void evaluatePosition(state);
      }),
    [],
  );

  return (
    <>
      {/* The bar's column is reserved as soon as the encoder is ready, never per evaluation:
          `evaluation` is emptied by every new game and every undo, and driving the layout from it
          made the board jump by the width of that column each time. */}
      <div
        class="board-area"
        data-testid="board-area"
        data-eval={encoderStatus.value === 'ready' ? 'on' : 'off'}
      >
        <Board
          game={game}
          human={human}
          thinking={busy}
          turning={turning}
          top5={top5}
          arrows={showArrows}
          onMove={playHuman}
          locked={locked}
        />
        <EvalBar evaluation={evaluation} />
      </div>
      <aside class="panel" data-testid="panel" aria-label="Modelo y jugadas">
        <nav class="modes" aria-label="Modo" data-testid="modes">
          {MODES.map((option) => (
            <button
              key={option}
              type="button"
              class="btn modes__item"
              aria-pressed={mode.value === option}
              data-mode={option}
              onClick={() => chooseMode(option)}
            >
              {MODE_LABELS[option]}
            </button>
          ))}
        </nav>
        {mode.value === 'arena' ? (
          <Arena
            game={game}
            mock={status.value === 'mock'}
            initialA={stage.value}
            initialB={arenaB.value}
          />
        ) : null}
        {mode.value === 'puzzles' ? (
          <Puzzles
            game={game}
            status={status}
            stageLabel={stageLabel()}
            sizeMb={currentStage().sizeMb}
            onLoad={() => void load()}
            pick={(state, header) => pickMove(state, header)}
          />
        ) : null}
        {mode.value === 'play' ? (
          <ModelPanel
            game={game}
            human={human}
            stage={stage}
            busy={busy}
            status={status}
            progress={progress}
            backend={backend}
            fallbackReason={fallbackReason}
            error={error}
            elo={elo}
            adapter={adapter}
            adapterBusy={adapterBusy}
            onStage={chooseStage}
            onAdapter={(id) => void chooseAdapter(id)}
            onColor={chooseColor}
            onPlay={() => void load()}
            onClearCache={clearCache}
            encoderStage={encoderStage}
            encoderStatus={encoderStatus}
            encoderProgress={encoderProgress}
            encoderBackend={encoderBackend}
            encoderError={encoderError}
            onEncoder={() => void loadEncoder()}
            onEncoderOff={() => void stopEncoder()}
          />
        ) : null}
        {mode.value === 'play' ? (
          <MoveList
            game={game}
            human={human}
            busy={busy}
            illegal={illegal}
            onUndo={undo}
            onNewGame={startNewGame}
            onExport={exportPgn}
          />
        ) : null}
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
        contract={contract}
      />
    </>
  );
}
