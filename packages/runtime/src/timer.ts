// IEC 61131-3 TON (on-delay timer), following the reference behaviour used by
// matiec/OpenPLC. Time comes from the caller (the simulated clock), which is
// constant during one scan, like the PLC's cycle time.
//
//   rising IN:  start timing, Q = FALSE, ET = 0
//   IN = FALSE: reset, Q = FALSE, ET = 0
//   while IN:   ET = now - start; Q = TRUE once ET reaches PT (ET then stays at PT)

export class Ton {
  /** Output: TRUE once IN has been TRUE for PT. */
  q = false;
  /** Elapsed time in ms. */
  et = 0;
  private pt = 0;
  private prevIn = false;
  private running = false;
  private start = 0;

  /** Call the timer, as `t(IN := in, PT := pt)`. Omit `ptMs` to keep the previous PT. */
  call(nowMs: number, input: boolean, ptMs?: number): void {
    if (ptMs !== undefined) this.pt = ptMs;
    if (!this.running && !this.prevIn && input) {
      this.running = true;
      this.q = false;
      this.start = nowMs;
    } else if (!input) {
      this.et = 0;
      this.q = false;
      this.running = false;
    } else if (this.running) {
      if (this.start + this.pt <= nowMs) {
        this.q = true;
        this.et = this.pt;
      } else {
        this.et = nowMs - this.start;
      }
    }
    this.prevIn = input;
  }
}
