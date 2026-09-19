import type { Signal } from '@preact/signals';

/** What the encoder answered for the position the bar is drawing. */
export interface Evaluation {
  /** `tanh(cp / 400)` from White's point of view, in [-1, 1]. */
  value: number;
  /** Probability that the move that led here threw the game away (already a probability). */
  blunder: number;
  /** SAN of that move, or null in the starting position. The alert has to be able to name it. */
  move: string | null;
  /** Half-moves played to reach the position; how two evaluations are ordered. */
  ply: number;
  /** True when `move` was the player's own, false when it was the opponent's (or there is none). */
  byHuman: boolean;
}

/**
 * Whether `next` should replace `current` on the bar.
 *
 * The rule is deliberately **not** "the newest answer wins". Playing a move hands the turn to the
 * opponent within milliseconds, so the newest answer is always about the opponent's reply, and a
 * bar that always drew the newest one could structurally only ever accuse the opponent: the
 * player would never be told about their own blunder, which is the one thing a learning demo is
 * for. So an evaluation of a position the player created stays up until the player creates a
 * newer one, and a position the *opponent* created only ever replaces another one of its kind —
 * the opening position, or the opponent's first move when the human plays black.
 *
 * Positions from an older game never arrive here: `App` drops them by generation before asking.
 */
export function supersedes(next: Evaluation, current: Evaluation | null): boolean {
  if (!current) return true;
  if (next.ply < current.ply) return false;
  return next.byHuman || !current.byHuman;
}

interface Props {
  /** The last evaluation, or null while the encoder has not answered for this position. */
  evaluation: Signal<Evaluation | null>;
}

/** Above this the encoder is calling the last move a blunder; the head answers a probability. */
export const BLUNDER_THRESHOLD = 0.5;

/** Share of the bar that belongs to White, as a percentage string. */
export function whiteShare(value: number): string {
  const clamped = Math.min(1, Math.max(-1, value));
  return `${Math.round(((clamped + 1) / 2) * 1000) / 10}%`;
}

/** The evaluation as the bar prints it: always signed, so the sign is never only a colour. */
export function formatValue(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  // `-0.00` would claim a side that does not exist.
  const shown = Object.is(rounded, -0) ? 0 : rounded;
  return `${shown > 0 ? '+' : ''}${shown.toFixed(2)}`;
}

/** Who the evaluation favours, in words: the bar must be readable without seeing its colours. */
export function advantage(value: number): string {
  if (Math.abs(value) < 0.05) return 'igualada';
  return value > 0 ? 'ventaja de las blancas' : 'ventaja de las negras';
}

/**
 * The encoder's evaluation bar: vertical beside the board on a desktop, horizontal under the
 * board below 900 px (`src/styles/base.css`; the component draws the same markup either way and
 * the media query decides). Nothing is rendered until the encoder has answered, so the single
 * screen of `docs/05-web-demo.md` is untouched for a player who never turns the bar on.
 *
 * Three rules it follows on purpose:
 *
 *   * the number is printed with its sign and the label says who is ahead, because a bar whose
 *     only cue is which end is filled is unreadable for someone who cannot tell the colours
 *     apart (and for anyone on a screen reader);
 *   * the alert **names the move it refers to**: the blunder head answers about the move that led
 *     to this position, not about the position, and an alert that does not say which move is an
 *     accusation with no defendant. Without a move played there is nothing to name and no alert.
 *     Which move that is follows `supersedes` above: normally the player's own last move;
 *   * the fill is animated with a 140 ms transition, and `prefers-reduced-motion: reduce` turns
 *     every transition off globally in `base.css`.
 *
 * The fill percentage travels in a CSS custom property set as a `style` attribute. The CSP allows
 * style *attributes* (`style-src-attr 'unsafe-inline'`, which cm-chessboard already needs to drag
 * a piece) while `style-src` itself stays hashed, so nothing is relaxed for this bar.
 */
export default function EvalBar({ evaluation }: Props) {
  const current = evaluation.value;
  if (!current) return null;
  const alert = current.blunder > BLUNDER_THRESHOLD && current.move !== null;
  const reading = `${formatValue(current.value)} · ${advantage(current.value)}`;
  const about = current.move ? ` tras ${current.move}` : '';

  return (
    <>
      <section
        class="evalbar"
        data-testid="evalbar"
        data-blunder={alert ? 'true' : 'false'}
        aria-label="Barra de evaluación del encoder"
      >
        <div
          class="evalbar__track"
          role="img"
          aria-label={`Evaluación del encoder: ${reading}${about}`}
          data-testid="eval-track"
        >
          <div class="evalbar__fill" style={{ '--eval-fill': whiteShare(current.value) }} />
        </div>
        <p class="evalbar__value" data-testid="eval-value" data-raw={current.value.toFixed(4)}>
          {formatValue(current.value)}
        </p>
      </section>
      {/* The `role="img"` label above is read once, when the bar is focused or walked: nothing
          re-announces it when the number changes. This is the announcement path for the value —
          the same pattern the move list uses for the last move played. */}
      <p class="visually-hidden" aria-live="polite" data-testid="eval-announce">
        {`Evaluación ${reading}${about}`}
      </p>
      {/* Always in the DOM, empty when there is nothing to say: a live region has to pre-exist
          the text it announces, and one that is created together with its content is routinely
          missed. `.evalbar__alert:empty` collapses the frame so an empty one draws nothing. */}
      <p
        class="evalbar__alert"
        role="status"
        data-testid="blunder-alert"
        data-alert={alert ? 'true' : 'false'}
      >
        {alert ? (
          <>
            <span class="evalbar__alert-tag">Posible error</span> en {current.move} ·{' '}
            {Math.round(current.blunder * 100)} % según el encoder
          </>
        ) : null}
      </p>
    </>
  );
}
