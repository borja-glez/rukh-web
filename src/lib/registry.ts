export type StageKind = 'mock';

export interface Stage {
  id: string;
  label: string;
  sizeMb: number;
  kind: StageKind;
}

/** Model stages available in the demo. P0 only ships the mock opponent. */
export const STAGES: Stage[] = [
  { id: 'mock', label: 'Primera jugada legal', sizeMb: 0, kind: 'mock' },
];

export function findStage(id: string): Stage | undefined {
  return STAGES.find((stage) => stage.id === id);
}
