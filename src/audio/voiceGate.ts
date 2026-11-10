/**
 * Which mic frames are the performer's voice, so the mouth holds the last vowel they said instead
 * of following what comes after it. A frame counts only if it is
 *  - above the Gate knob (absolute),
 *  - well above the room's noise floor (tracked: falls at once, rises slowly), so a fan, hum or
 *    the earbud mic's own hiss above the gate is ignored, and
 *  - near the level of what is being said now (a peak that decays), so the fading end of a word
 *    and the breath after it, whose formants mean nothing, are ignored.
 */
export class VoiceGate {
  floor = Infinity;
  peak = -Infinity;
  /** dB above the noise floor a voice frame needs */
  static FLOOR_MARGIN = 12;
  /** dB below the current peak a frame may be and still count */
  static PEAK_WINDOW = 15;
  /** how fast the peak falls back (dB/s), so a quieter next word still gets through */
  static PEAK_DECAY = 12;

  update(db: number, dt: number, gate: number): boolean {
    if (!(db > -200)) return false;
    // noise floor: follow drops at once; rise slowly (faster while nothing is being said, so a
    // noise that starts later is learnt in a few seconds, while a long held vowel isn't)
    const prevFloor = this.floor;
    if (db < this.floor) this.floor = db;
    const ok = db > gate && db > prevFloor + VoiceGate.FLOOR_MARGIN && db > this.peak - VoiceGate.PEAK_WINDOW;
    if (db >= prevFloor) this.floor = Math.min(db, (this.floor === Infinity ? db : this.floor) + (ok ? 1.5 : 6) * dt);
    if (db > this.peak) this.peak = db;
    else this.peak -= VoiceGate.PEAK_DECAY * dt;
    return ok;
  }

  reset(): void {
    this.floor = Infinity;
    this.peak = -Infinity;
  }
}
