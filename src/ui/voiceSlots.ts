import type { MpeVoice } from "./midi.ts";

/**
 * Which held MPE notes the voices play: one note per voice, kept on its voice for as long as it
 * is held (no swapping when bends cross, so neither voice jumps). A new note takes a free voice;
 * with none free it takes the voice playing the lowest note, if it is higher (high-note
 * priority). A voice let go picks up the highest note left waiting. With one voice this is plain
 * high-note priority.
 *
 * `slots` holds each voice's channel id (or null) and is updated in place. Returns the note each
 * voice plays now.
 */
export function assignSlots(slots: (string | null)[], voices: MpeVoice[]): (MpeVoice | null)[] {
  const byId = new Map(voices.map((v) => [v.id, v]));
  for (let i = 0; i < slots.length; i++) if (slots[i] !== null && !byId.has(slots[i]!)) slots[i] = null;
  const waiting = voices.filter((v) => !slots.includes(v.id)).sort((a, b) => b.note - a.note || b.serial - a.serial);
  for (const v of waiting) {
    const free = slots.indexOf(null);
    if (free >= 0) {
      slots[free] = v.id;
      continue;
    }
    let low = -1;
    for (let i = 0; i < slots.length; i++) {
      const cur = byId.get(slots[i]!)!;
      if (low < 0 || cur.note < byId.get(slots[low]!)!.note) low = i;
    }
    if (low >= 0 && v.note > byId.get(slots[low]!)!.note) slots[low] = v.id;
  }
  return slots.map((id) => (id === null ? null : byId.get(id)!));
}
