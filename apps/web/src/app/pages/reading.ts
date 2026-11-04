/** How far a person has read one revision of a use case, one scenario at a time. */
export interface Reading {
  /** The scenario on screen, from 0. */
  at: number;
  /** The furthest they have been. They can go back to anything up to here. */
  furthest: number;
}

export const startReading = (): Reading => ({ at: 0, furthest: 0 });

/** Each revision is read from the start, so its key holds the revision. */
export const readingKey = (id: string, revision: number): string => `${id}/${String(revision)}`;

export const hasPrevious = ({ at }: Reading): boolean => at > 0;

export const hasNext = ({ at }: Reading, total: number): boolean => at < total - 1;

/** Moves one step at a time forwards, and back to anywhere already read. */
export function canReach({ furthest }: Reading, index: number, total: number): boolean {
  return index >= 0 && index < total && index <= furthest + 1;
}

export function moveTo(reading: Reading, index: number, total: number): Reading {
  if (!canReach(reading, index, total)) return reading;
  return { at: index, furthest: Math.max(index, reading.furthest) };
}

/** A person can approve once they have reached the last scenario. */
export const canApprove = ({ furthest }: Reading, total: number): boolean =>
  furthest >= total - 1;
