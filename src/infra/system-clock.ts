import type { Clock } from '../app/ports.js';
import { toUtcCalendarDate } from '../domain/days.js';

export const systemClock: Clock = {
  todayUtc: () => toUtcCalendarDate(new Date()),
};
