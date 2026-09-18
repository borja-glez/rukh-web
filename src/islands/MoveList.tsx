import type { Signal } from '@preact/signals';
import type { GameState } from '../lib/game';

interface Props {
  game: Signal<GameState>;
  busy: Signal<boolean>;
  onUndo: () => void;
  onNewGame: () => void;
  onExport: () => string;
}

function pairs(history: string[]): Array<[string, string | undefined]> {
  const rows: Array<[string, string | undefined]> = [];
  for (let i = 0; i < history.length; i += 2) rows.push([history[i], history[i + 1]]);
  return rows;
}

function describeLast(history: string[]): string {
  if (history.length === 0) return 'Sin jugadas';
  const ply = history.length;
  const number = Math.ceil(ply / 2);
  const prefix = ply % 2 === 1 ? `${number}.` : `${number}…`;
  return `Última jugada: ${prefix} ${history[ply - 1]}`;
}

function fileName(): string {
  return `rukh-${new Date().toISOString().slice(0, 10)}.pgn`;
}

async function download(pgn: string) {
  const blob = new Blob([pgn], { type: 'application/x-chess-pgn' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName();
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  try {
    await navigator.clipboard?.writeText(pgn);
  } catch {
    /* clipboard unavailable (permissions, insecure context): the download already happened */
  }
}

export default function MoveList({ game, busy, onUndo, onNewGame, onExport }: Props) {
  const { history } = game.value;
  const rows = pairs(history);
  const current = history.length - 1;

  return (
    <section class="moves" aria-labelledby="moves-title">
      <h2 id="moves-title" class="label">
        Jugadas
      </h2>
      <ol class="moves__list" data-testid="move-list" aria-label="Lista de jugadas">
        {rows.length === 0 ? (
          <li class="moves__empty caption">Sin jugadas</li>
        ) : (
          rows.map(([white, black], index) => (
            <li class="moves__row" key={index}>
              <span class="moves__num">{index + 1}.</span>
              <span
                class={`moves__ply${index * 2 === current ? ' is-current' : ''}`}
                data-ply={index * 2 + 1}
                aria-current={index * 2 === current ? 'step' : undefined}
              >
                {white}
              </span>
              {black ? (
                <span
                  class={`moves__ply${index * 2 + 1 === current ? ' is-current' : ''}`}
                  data-ply={index * 2 + 2}
                  aria-current={index * 2 + 1 === current ? 'step' : undefined}
                >
                  {black}
                </span>
              ) : (
                <span />
              )}
            </li>
          ))
        )}
      </ol>
      <p class="visually-hidden" aria-live="polite" data-testid="last-move">
        {describeLast(history)}
      </p>
      <div class="moves__actions">
        <button
          type="button"
          class="btn"
          onClick={onUndo}
          disabled={busy.value || history.length === 0}
        >
          Deshacer
        </button>
        <button type="button" class="btn" onClick={onNewGame}>
          Nueva partida
        </button>
        <button
          type="button"
          class="btn btn--wide"
          onClick={() => void download(onExport())}
          disabled={history.length === 0}
        >
          Exportar PGN
        </button>
      </div>
    </section>
  );
}
