/** Controllable clock: real time in prod, fake time in tests. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

export function isoDayStart(ms: number): string {
  const d = new Date(ms);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

export function isoDayEnd(ms: number): string {
  const d = new Date(ms);
  d.setUTCHours(23, 59, 59, 999);
  return d.toISOString();
}

export function secondsUntil(msFuture: number, clock: Clock = systemClock): number {
  return Math.max(0, Math.floor((msFuture - clock.now()) / 1000));
}
