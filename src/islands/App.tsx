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
import { firstLegalMove, type Opponent } from '../lib/opponent';
import { parseQuery } from '../lib/query';
import { STAGES } from '../lib/registry';
import Board from './Board';
import ModelPanel from './ModelPanel';
import MoveList from './MoveList';

const HUMAN_LABEL = 'Humano';

/** Game state lives in module-level signals so the three zones share one source of truth. */
const game = signal<GameState>(newGame());
const human = signal<Color>('w');
const stage = signal<string>(STAGES[0].id);
/** True while the opponent is thinking. */
const thinking = signal(false);
/** True while the board animates a turn: colour changes wait for it. */
const turning = signal(false);
const busy = computed(() => thinking.value || turning.value);

function opponentFor(): Opponent {
  // P0: every stage is the mock opponent.
  return firstLegalMove;
}

function opponentToMove(state: GameState): boolean {
  return !state.over && state.turn !== human.value;
}

async function settle() {
  const current = game.value;
  if (!opponentToMove(current) || thinking.value) return;
  thinking.value = true;
  try {
    const move = await opponentFor().pick(current.fen);
    // The position may have been reset (new game, colour change, undo) while the opponent
    // was thinking: drop the stale reply; the `finally` below re-schedules if needed.
    if (game.value.fen !== current.fen) return;
    const next = applyMove(current, move);
    if (next) game.value = next;
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
  // As black, undo leaves the opponent to move: let it reply.
  void settle();
}

function stageLabel(): string {
  return STAGES.find((entry) => entry.id === stage.value)?.label ?? STAGES[0].label;
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
    if (query.color !== human.value) {
      human.value = query.color;
    }
    void settle();
  }, []);

  return (
    <>
      <Board game={game} human={human} turning={turning} onMove={playHuman} />
      <aside class="panel" data-testid="panel" aria-label="Modelo y jugadas">
        <ModelPanel
          game={game}
          human={human}
          stage={stage}
          busy={busy}
          onStage={(id) => (stage.value = id)}
          onColor={chooseColor}
        />
        <MoveList
          game={game}
          human={human}
          busy={busy}
          onUndo={undo}
          onNewGame={startNewGame}
          onExport={exportPgn}
        />
      </aside>
    </>
  );
}
