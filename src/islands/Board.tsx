import { computed, effect, type Signal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import { legalTargets, needsPromotion, type Color, type GameState, type Move } from '../lib/game';
import type { TopEntry } from '../lib/model';

interface Props {
  game: Signal<GameState>;
  human: Signal<Color>;
  /**
   * True while the model is thinking (or the board is turning): the human cannot move. It is
   * published as `data-thinking` on the board, separately from `data-busy`, because they mean
   * different things — `data-busy` is a 150 ms piece animation, `data-thinking` can be seconds
   * of inference. Waiting only for `data-busy` looks idle while the model is still deciding,
   * which silently swallowed the next click.
   */
  thinking: Signal<boolean>;
  /** Set while the board animates an orientation change. */
  turning: Signal<boolean>;
  /** The five moves the network proposed last, drawn as arrows when `arrows` is on. */
  top5: Signal<TopEntry[]>;
  /** Drawer toggle for the top-5 arrows; off by default. */
  arrows: Signal<boolean>;
  /** Applies the human move; returns false when it is rejected. */
  onMove: (move: Move) => boolean;
  /**
   * True in the modes where nobody moves by hand (the arena, the puzzles): input is refused
   * without looking at whose turn it is, and the board says so with `data-locked`.
   */
  locked?: Signal<boolean>;
}

/**
 * Arrow class by probability: five buckets, opacity rising with the probability (the theme
 * lives in `src/styles/board.css`, so nothing needs an inline style).
 */
function arrowType(prob: number): { class: string } {
  const bucket = Math.min(5, Math.max(1, Math.ceil(prob * 5)));
  return { class: `arrow-rukh arrow-rukh-${bucket}` };
}

const ARROW_MOVE = /^([a-h][1-8])([a-h][1-8])/;

/**
 * cm-chessboard wrapper. The library is loaded on the client only (it touches the DOM at
 * import time), the sprites are served from /pieces and /extensions (copied by
 * scripts/copy-assets.mjs) and the theme lives in src/styles/board.css.
 */
export default function Board({
  game,
  human,
  thinking,
  turning,
  top5,
  arrows,
  onMove,
  locked,
}: Props) {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    let disposed = false;
    let dispose: (() => void) | undefined;

    (async () => {
      const [
        { Chessboard, COLOR, INPUT_EVENT_TYPE },
        { Markers, MARKER_TYPE },
        { PromotionDialog },
        { Accessibility },
        { Arrows },
      ] = await Promise.all([
        import('cm-chessboard/src/Chessboard.js'),
        import('cm-chessboard/src/extensions/markers/Markers.js'),
        import('cm-chessboard/src/extensions/promotion-dialog/PromotionDialog.js'),
        import('cm-chessboard/src/extensions/accessibility/Accessibility.js'),
        import('cm-chessboard/src/extensions/arrows/Arrows.js'),
      ]);
      if (disposed) return;

      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const board = new Chessboard(element, {
        position: game.value.fen,
        orientation: human.value === 'w' ? COLOR.white : COLOR.black,
        assetsUrl: '/',
        style: {
          cssClass: 'rukh',
          showCoordinates: true,
          borderType: 'none',
          pieces: { file: 'pieces/standard.svg' },
          animationDuration: reduced ? 0 : 150,
        },
        extensions: [
          { class: Markers, props: { autoMarkers: MARKER_TYPE.frame } },
          { class: PromotionDialog },
          { class: Arrows },
          {
            class: Accessibility,
            props: {
              brailleNotationInAlt: true,
              movePieceForm: false,
              boardAsTable: false,
              piecesAsList: false,
              visuallyHidden: true,
            },
          },
        ],
      });

      const clearTargets = () => board.removeMarkers(MARKER_TYPE.dot);

      const handler = (event: Parameters<Parameters<typeof board.enableMoveInput>[0]>[0]) => {
        const state = game.value;
        switch (event.type) {
          case INPUT_EVENT_TYPE.moveInputStarted: {
            if (locked?.value || thinking.value || state.over || state.turn !== human.value) {
              return false;
            }
            const targets = legalTargets(state, event.squareFrom);
            if (targets.length === 0) return false;
            clearTargets();
            for (const square of targets) board.addMarker(MARKER_TYPE.dot, square);
            return true;
          }
          case INPUT_EVENT_TYPE.validateMoveInput: {
            if (locked?.value || thinking.value) return false;
            const from = event.squareFrom;
            const to = event.squareTo ?? '';
            if (needsPromotion(state, from, to)) {
              const color = state.turn === 'w' ? COLOR.white : COLOR.black;
              board.showPromotionDialog(to, color, (result) => {
                clearTargets();
                const piece = result.piece?.charAt(1) as Move['promotion'] | undefined;
                if (result.type === 'pieceSelected' && piece) {
                  if (!onMove({ from, to, promotion: piece }))
                    void board.setPosition(game.value.fen, false);
                } else {
                  void board.setPosition(game.value.fen, false);
                }
              });
              return true;
            }
            return onMove({ from, to });
          }
          case INPUT_EVENT_TYPE.moveInputCanceled:
          case INPUT_EVENT_TYPE.moveInputFinished:
            clearTargets();
            return true;
          default:
            return true;
        }
      };

      // Keep the board in sync with the game: opponent replies, undo, new game and
      // side effects of the human move (castling rook, en passant capture, promotion).
      // `data-busy` is true while position animations are pending: cm-chessboard ignores new
      // input until the previous move animation has finished, and the E2E tests wait for it.
      let pending = 0;
      const setBusy = (delta: number) => {
        pending += delta;
        element.parentElement?.setAttribute('data-busy', String(pending > 0));
      };

      // Deferred a microtask: when the human moves, cm-chessboard moves the piece itself right
      // after the validate callback, and setPosition then only animates the remaining diff.
      const stopPosition = effect(() => {
        const fen = game.value.fen;
        setBusy(1);
        queueMicrotask(() => {
          if (disposed) return;
          board.setPosition(fen, true).finally(() => setTimeout(() => setBusy(-1), 0));
        });
      });

      // Accessible name for the board image (the Accessibility extension keeps the braille
      // notation in `alt`; `aria-label` is what assistive tech reads for role="img").
      element.querySelector('svg.cm-chessboard')?.setAttribute('aria-label', 'Tablero de ajedrez');

      // cm-chessboard rejects a second setOrientation while one is queued: chain them and,
      // once a turn finishes, re-apply the latest colour if it changed meanwhile.
      const orientationOf = (color: Color) => (color === 'w' ? COLOR.white : COLOR.black);
      let turn: Promise<void> = Promise.resolve();
      const orient = () => {
        turn = turn.then(async () => {
          if (disposed) return;
          const wanted = orientationOf(human.value);
          if (board.getOrientation() === wanted) return;
          turning.value = true;
          try {
            await board.setOrientation(wanted, false);
          } finally {
            if (disposed || board.getOrientation() === orientationOf(human.value)) {
              turning.value = false;
            } else {
              orient();
            }
          }
        });
      };

      // Input is toggled only when the game ends or the human changes colour: `computed`
      // keeps the effect from re-running (and interrupting cm-chessboard) on every move.
      const over = computed(() => game.value.over);
      const stopInput = effect(() => {
        const finished = over.value;
        const color = human.value;
        if (board.isMoveInputEnabled()) board.disableMoveInput();
        clearTargets();
        orient();
        if (!finished) board.enableMoveInput(handler, orientationOf(color));
      });

      // Top-5 arrows: redrawn whenever the proposals or the toggle change, cleared otherwise.
      const stopArrows = effect(() => {
        const entries = arrows.value ? top5.value : [];
        board.removeArrows();
        for (const entry of entries) {
          const parsed = ARROW_MOVE.exec(entry.uci);
          if (!parsed) continue;
          board.addArrow(arrowType(entry.prob), parsed[1], parsed[2]);
        }
      });

      dispose = () => {
        stopArrows();
        stopPosition();
        stopInput();
        turning.value = false;
        board.destroy();
      };
    })();

    return () => {
      disposed = true;
      dispose?.();
    };
  }, [game, human, thinking, turning, top5, arrows, onMove, locked]);

  return (
    <div
      class="board"
      data-testid="board"
      data-busy="true"
      data-thinking={thinking.value ? 'true' : 'false'}
      data-locked={locked?.value ? 'true' : 'false'}
    >
      <div class="board__surface" ref={container} />
    </div>
  );
}
