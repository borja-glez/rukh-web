import { computed, effect, type Signal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import { legalTargets, needsPromotion, type Color, type GameState, type Move } from '../lib/game';

interface Props {
  game: Signal<GameState>;
  human: Signal<Color>;
  /** Applies the human move; returns false when it is rejected. */
  onMove: (move: Move) => boolean;
}

/**
 * cm-chessboard wrapper. The library is loaded on the client only (it touches the DOM at
 * import time), the sprites are served from /pieces and /extensions (copied by
 * scripts/copy-assets.mjs) and the theme lives in src/styles/board.css.
 */
export default function Board({ game, human, onMove }: Props) {
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
      ] = await Promise.all([
        import('cm-chessboard/src/Chessboard.js'),
        import('cm-chessboard/src/extensions/markers/Markers.js'),
        import('cm-chessboard/src/extensions/promotion-dialog/PromotionDialog.js'),
        import('cm-chessboard/src/extensions/accessibility/Accessibility.js'),
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
            if (state.over || state.turn !== human.value) return false;
            const targets = legalTargets(state, event.squareFrom);
            if (targets.length === 0) return false;
            clearTargets();
            for (const square of targets) board.addMarker(MARKER_TYPE.dot, square);
            return true;
          }
          case INPUT_EVENT_TYPE.validateMoveInput: {
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

      // Input is toggled only when the game ends or the human changes colour: `computed`
      // keeps the effect from re-running (and interrupting cm-chessboard) on every move.
      const over = computed(() => game.value.over);
      let orientation = human.value;
      const stopInput = effect(() => {
        const finished = over.value;
        const color = human.value;
        if (board.isMoveInputEnabled()) board.disableMoveInput();
        clearTargets();
        if (color !== orientation) {
          orientation = color;
          void board.setOrientation(color === 'w' ? COLOR.white : COLOR.black, false);
        }
        if (!finished) board.enableMoveInput(handler, color === 'w' ? COLOR.white : COLOR.black);
      });

      dispose = () => {
        stopPosition();
        stopInput();
        board.destroy();
      };
    })();

    return () => {
      disposed = true;
      dispose?.();
    };
  }, [game, human, onMove]);

  return (
    <div class="board" data-testid="board" data-busy="true">
      <div class="board__surface" ref={container} />
    </div>
  );
}
