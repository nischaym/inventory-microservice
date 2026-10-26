import type { Clock } from '../../src/app/ports.js';

/** A Clock tests can set and move. */
export class FixedClock implements Clock {
  constructor(private today: string) {}

  todayUtc(): string {
    return this.today;
  }

  setToday(today: string): void {
    this.today = today;
  }
}
