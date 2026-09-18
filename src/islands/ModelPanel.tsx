import type { Signal } from '@preact/signals';
import type { Color, GameState } from '../lib/game';
import { STAGES } from '../lib/registry';

interface Props {
  game: Signal<GameState>;
  human: Signal<Color>;
  stage: Signal<string>;
  busy: Signal<boolean>;
  onStage: (id: string) => void;
  onColor: (color: Color) => void;
  onNewGame: () => void;
}

function statusText(game: GameState, human: Color, busy: boolean): string {
  if (game.over) {
    if (game.result === '1/2-1/2') return 'Tablas';
    const humanWon = (game.result === '1-0') === (human === 'w');
    return humanWon ? 'Jaque mate · has ganado' : 'Jaque mate · ha ganado el modelo';
  }
  if (busy) return 'El modelo piensa…';
  return game.turn === human ? 'Te toca mover' : 'Turno del modelo';
}

export default function ModelPanel({
  game,
  human,
  stage,
  busy,
  onStage,
  onColor,
  onNewGame,
}: Props) {
  const state = game.value;
  const color = human.value;

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
          onChange={(event) => onStage((event.currentTarget as HTMLSelectElement).value)}
        >
          {STAGES.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
              {entry.sizeMb > 0 ? ` · ${entry.sizeMb} MB` : ''}
            </option>
          ))}
        </select>
      </label>
      <p class="model__status caption">Sin modelo · primera jugada legal</p>
      <p class="model__turn" data-testid="status">
        {statusText(state, color, busy.value)}
      </p>
      <div class="model__row" role="group" aria-label="Color">
        <button type="button" class="btn" aria-pressed={color === 'w'} onClick={() => onColor('w')}>
          Blancas
        </button>
        <button type="button" class="btn" aria-pressed={color === 'b'} onClick={() => onColor('b')}>
          Negras
        </button>
      </div>
      <button type="button" class="btn btn--primary model__new" onClick={onNewGame}>
        Nueva partida
      </button>
    </section>
  );
}
