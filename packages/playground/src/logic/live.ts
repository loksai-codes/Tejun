// Turns real elapsed time into a number of simulated scans, so the
// simulator runs at real speed (or slower) whatever the frame rate.

export const MAX_FRAME_MS = 250; // after a pause in the browser tab, don't jump ahead

export class LiveClock {
  private carryMs = 0;

  /** How many scans to run for `elapsedMs` of real time at `speed`. */
  scansFor(elapsedMs: number, speed: number, scanMs: number): number {
    this.carryMs += Math.min(Math.max(elapsedMs, 0), MAX_FRAME_MS) * speed;
    const scans = Math.floor(this.carryMs / scanMs);
    this.carryMs -= scans * scanMs;
    return scans;
  }

  reset(): void {
    this.carryMs = 0;
  }
}
