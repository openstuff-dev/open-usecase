import { describe, expect, it } from 'vitest';
import {
  canApprove,
  canReach,
  hasNext,
  hasPrevious,
  moveTo,
  readingKey,
  startReading,
} from '../src/app/pages/reading';

describe('reading a use case', () => {
  it('UC-9/S1 starts at the first scenario, and goes to the next and the previous one', () => {
    let reading = startReading();
    expect(reading.at).toBe(0);
    expect(hasPrevious(reading)).toBe(false);
    expect(hasNext(reading, 3)).toBe(true);

    reading = moveTo(reading, 1, 3);
    expect(reading.at).toBe(1);
    expect(hasPrevious(reading)).toBe(true);

    reading = moveTo(reading, 0, 3);
    expect(reading.at).toBe(0);
  });

  it('UC-9/S1 can jump back to what was read, but not ahead past the next one', () => {
    const reading = moveTo(moveTo(startReading(), 1, 4), 0, 4);
    expect(canReach(reading, 1, 4)).toBe(true);
    expect(canReach(reading, 2, 4)).toBe(true);
    expect(canReach(reading, 3, 4)).toBe(false);
    expect(moveTo(reading, 3, 4)).toEqual(reading);
  });

  it('UC-9/S2 approving waits until the last scenario, and stays possible after going back', () => {
    let reading = startReading();
    expect(canApprove(reading, 3)).toBe(false);
    reading = moveTo(reading, 1, 3);
    expect(canApprove(reading, 3)).toBe(false);
    reading = moveTo(reading, 2, 3);
    expect(hasNext(reading, 3)).toBe(false);
    expect(canApprove(reading, 3)).toBe(true);
    expect(canApprove(moveTo(reading, 0, 3), 3)).toBe(true);
  });

  it('UC-9/S2 a use case with one scenario can be approved straight away', () => {
    expect(canApprove(startReading(), 1)).toBe(true);
  });

  it('UC-9/S3 a new revision has its own reading, so it starts over', () => {
    expect(readingKey('a', 1)).not.toBe(readingKey('a', 2));
  });
});
