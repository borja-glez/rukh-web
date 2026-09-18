/* Minimal typings for the cm-chessboard ESM sources used by the demo. */

declare module 'cm-chessboard/src/Chessboard.js' {
  export const COLOR: { white: 'w'; black: 'b' };
  export const INPUT_EVENT_TYPE: {
    moveInputStarted: 'moveInputStarted';
    movingOverSquare: 'movingOverSquare';
    validateMoveInput: 'validateMoveInput';
    moveInputCanceled: 'moveInputCanceled';
    moveInputFinished: 'moveInputFinished';
  };
  export const FEN: { start: string; empty: string };

  export interface MoveInputEvent {
    type: keyof typeof INPUT_EVENT_TYPE;
    chessboard: Chessboard;
    squareFrom: string;
    squareTo?: string | null;
    piece?: string;
    reason?: string;
    animate?: boolean;
  }

  export interface ExtensionEntry {
    class: new (chessboard: Chessboard, props?: Record<string, unknown>) => unknown;
    props?: Record<string, unknown>;
  }

  export interface ChessboardProps {
    position?: string;
    orientation?: 'w' | 'b';
    responsive?: boolean;
    assetsUrl?: string;
    assetsCache?: boolean;
    style?: {
      cssClass?: string;
      showCoordinates?: boolean;
      borderType?: 'none' | 'thin' | 'frame';
      aspectRatio?: number;
      pieces?: { file?: string; tileSize?: number };
      animationDuration?: number;
    };
    extensions?: ExtensionEntry[];
  }

  export interface MarkerType {
    class: string;
    slice: string;
    position?: string;
  }

  export interface ArrowType {
    class: string;
  }

  export interface PromotionDialogResult {
    type: 'pieceSelected' | 'canceled';
    square?: string;
    piece?: string;
  }

  export class Chessboard {
    constructor(context: HTMLElement, props?: ChessboardProps);
    setPosition(fen: string, animated?: boolean): Promise<void>;
    movePiece(from: string, to: string, animated?: boolean): Promise<void>;
    setOrientation(color: 'w' | 'b', animated?: boolean): Promise<void> | undefined;
    getOrientation(): 'w' | 'b';
    getPosition(): string;
    getPiece(square: string): string | undefined;
    enableMoveInput(handler: (event: MoveInputEvent) => boolean | void, color?: 'w' | 'b'): void;
    disableMoveInput(): void;
    isMoveInputEnabled(): boolean;
    destroy(): void;
    // Provided by the Markers extension.
    addMarker(type: MarkerType, square: string): void;
    removeMarkers(type?: MarkerType, square?: string): void;
    // Provided by the PromotionDialog extension.
    showPromotionDialog(
      square: string,
      color: 'w' | 'b',
      callback: (result: PromotionDialogResult) => void,
    ): void;
    isPromotionDialogShown(): boolean;
    // Provided by the Arrows extension.
    addArrow(type: ArrowType, from: string, to: string): void;
    removeArrows(type?: ArrowType, from?: string, to?: string): void;
  }
}

declare module 'cm-chessboard/src/extensions/markers/Markers.js' {
  import type { MarkerType } from 'cm-chessboard/src/Chessboard.js';
  export const MARKER_TYPE: {
    frame: MarkerType;
    framePrimary: MarkerType;
    frameDanger: MarkerType;
    circle: MarkerType;
    circlePrimary: MarkerType;
    circleDanger: MarkerType;
    circleDangerFilled: MarkerType;
    square: MarkerType;
    dot: MarkerType;
    bevel: MarkerType;
  };
  export class Markers {}
}

declare module 'cm-chessboard/src/extensions/promotion-dialog/PromotionDialog.js' {
  export const PROMOTION_DIALOG_RESULT_TYPE: {
    pieceSelected: 'pieceSelected';
    canceled: 'canceled';
  };
  export class PromotionDialog {}
}

declare module 'cm-chessboard/src/extensions/accessibility/Accessibility.js' {
  export class Accessibility {}
}

declare module 'cm-chessboard/src/extensions/arrows/Arrows.js' {
  import type { ArrowType } from 'cm-chessboard/src/Chessboard.js';
  export const ARROW_TYPE: {
    default: ArrowType;
    success: ArrowType;
    secondary: ArrowType;
    warning: ArrowType;
    info: ArrowType;
    danger: ArrowType;
  };
  export class Arrows {}
}
