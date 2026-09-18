import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import {
  applyMove,
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
const busy = signal(false);

function opponentFor(): Opponent {
  // P0: every stage is the mock opponent.
  return firstLegalMove;
}

async function settle() {
  const current = game.value;
  if (current.over || current.turn === human.value || busy.value) return;
  busy.value = true;
  try {
    const move = await opponentFor().pick(current.fen);
    // The position may have been reset while the opponent was thinking.
    if (game.value.fen !== current.fen) return;
    const next = applyMove(current, move);
    if (next) game.value = next;
  } finally {
    busy.value = false;
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
  if (color === human.value) return;
  human.value = color;
  startNewGame();
}

function undo() {
  if (busy.value) return;
  game.value = undoPair(game.value, human.value);
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
      <Board game={game} human={human} onMove={playHuman} />
      <aside class="panel" data-testid="panel" aria-label="Modelo y jugadas">
        <ModelPanel
          game={game}
          human={human}
          stage={stage}
          busy={busy}
          onStage={(id) => (stage.value = id)}
          onColor={chooseColor}
          onNewGame={startNewGame}
        />
        <MoveList
          game={game}
          busy={busy}
          onUndo={undo}
          onNewGame={startNewGame}
          onExport={exportPgn}
        />
      </aside>
    </>
  );
}
