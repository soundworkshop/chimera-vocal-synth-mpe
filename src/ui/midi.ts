/**
 * Web MIDI keyboards: note on/off (with velocity) from every connected input, including ones
 * plugged in later. The voice hears one note per pitch: a pitch held on several keyboards or
 * channels sounds until the last of them lets go. All-notes-off and unplugging release what
 * that input (channel) was holding.
 *
 * MPE: each channel also carries its own pitch bend and pressure. Every change to a held note's
 * pitch bend, pressure or the set of held notes is reported to `expression` with all the notes
 * held right now, so the caller can pick one (high-note priority) and play its pitch and breath
 * continuously. The bend range is 48 semitones (the MPE default) unless the sender sets it with
 * RPN 0 (pitch bend sensitivity) on that channel.
 */
export type MidiStatus = "off" | "connecting" | "on" | "unsupported" | "denied";

/** a note held on one channel, with that channel's expression */
export interface MpeVoice {
  note: number;
  velocity: number;
  /** pitch bend in semitones */
  bend: number;
  /** 0..1, or null when nothing has sent pressure for this note yet */
  pressure: number | null;
  /** order of pressing (larger = later) */
  serial: number;
}

export interface MidiHandlers {
  noteOn: (note: number, velocity: number) => void;
  noteOff: (note: number) => void;
  /** names of the connected inputs (on every change) */
  inputs: (names: string[]) => void;
  /** every held note with its channel's bend and pressure (on every change) */
  expression?: (voices: MpeVoice[], sendsPressure: boolean) => void;
}

export const midiSupported = (): boolean => typeof navigator !== "undefined" && typeof navigator.requestMIDIAccess === "function";

const MPE_BEND_RANGE = 48;

let handlers: MidiHandlers | null = null;
let access: MIDIAccess | null = null;
let pending: Promise<void> | null = null;
/** bumped by disconnect: a connection still waiting for permission then gives up */
let generation = 0;
/** who holds each pitch, as "input id \0 channel" */
const owners = new Map<number, Set<string>>();
const SEP = "\u0000";

/** per input channel: the note it holds (MPE: one per channel), its bend and pressure */
interface Channel {
  note: number | null;
  velocity: number;
  /** -1..1 of the bend range */
  bend: number;
  range: number;
  pressure: number | null;
  serial: number;
  /** RPN being addressed (CC 101, CC 100), for the bend range */
  rpn: [number, number];
}
const channels = new Map<string, Channel>();
let serial = 0;
/** some input has sent pressure (channel or poly aftertouch) since connecting */
let sendsPressure = false;

function channel(owner: string): Channel {
  let c = channels.get(owner);
  if (!c) channels.set(owner, (c = { note: null, velocity: 0, bend: 0, range: MPE_BEND_RANGE, pressure: null, serial: 0, rpn: [127, 127] }));
  return c;
}

function emit(): void {
  if (!handlers?.expression) return;
  const voices: MpeVoice[] = [];
  for (const c of channels.values())
    if (c.note !== null) voices.push({ note: c.note, velocity: c.velocity, bend: c.bend * c.range, pressure: c.pressure, serial: c.serial });
  handlers.expression(voices, sendsPressure);
}

function press(owner: string, note: number, velocity: number): void {
  let set = owners.get(note);
  if (!set) owners.set(note, (set = new Set()));
  const first = set.size === 0;
  set.add(owner);
  if (first) handlers?.noteOn(note, velocity);
}

function lift(owner: string, note: number): void {
  const set = owners.get(note);
  if (!set || !set.delete(owner)) return;
  if (set.size > 0) return;
  owners.delete(note);
  handlers?.noteOff(note);
}

/** Release every note whose owner matches. */
function liftWhere(match: (owner: string) => boolean): void {
  for (const [note, set] of [...owners]) for (const o of [...set]) if (match(o)) lift(o, note);
  for (const [o, c] of channels) if (match(o)) (c.note = null), (c.pressure = null);
}

function onMessage(owner: string, d: Uint8Array): void {
  const kind = d[0] & 0xf0;
  const c = channel(owner);
  if (kind === 0x90 && d.length > 2 && d[2] > 0) {
    // a new note on this channel: its pressure starts over (the sender follows with its own)
    c.note = d[1];
    c.velocity = d[2];
    c.pressure = null;
    c.serial = ++serial;
    press(owner, d[1], d[2]);
  } else if (kind === 0x80 || kind === 0x90) {
    if (c.note === d[1]) (c.note = null), (c.pressure = null);
    lift(owner, d[1]);
  } else if (kind === 0xe0 && d.length > 2) {
    c.bend = (((d[2] << 7) | d[1]) - 8192) / 8192;
  } else if (kind === 0xd0) {
    sendsPressure = true;
    c.pressure = d[1] / 127;
  } else if (kind === 0xa0 && d.length > 2) {
    sendsPressure = true;
    if (c.note === d[1]) c.pressure = d[2] / 127;
  } else if (kind === 0xb0 && d.length > 2) {
    const [cc, v] = [d[1], d[2]];
    if (cc === 123 || cc === 120) liftWhere((o) => o === owner); // all notes / sound off
    else if (cc === 101) c.rpn[0] = v;
    else if (cc === 100) c.rpn[1] = v;
    else if (cc === 6 && c.rpn[0] === 0 && c.rpn[1] === 0 && v > 0) c.range = v; // pitch bend sensitivity
    else return;
  } else return;
  emit();
}

function attach(a: MIDIAccess): void {
  const names: string[] = [];
  const live = new Set<string>();
  a.inputs.forEach((input) => {
    if (input.state === "disconnected") return;
    live.add(input.id);
    names.push(input.name || "MIDI keyboard");
    input.onmidimessage = (e: MIDIMessageEvent) => {
      const d = e.data;
      if (!d || d.length < 2) return;
      onMessage(input.id + SEP + (d[0] & 0x0f), d);
    };
  });
  // unplugged inputs release what they held
  liftWhere((o) => !live.has(o.slice(0, o.indexOf(SEP))));
  emit();
  handlers?.inputs(names);
}

/** Ask for MIDI access and listen (one request at a time; resolves when connected). */
export function connectMidi(h: MidiHandlers): Promise<void> {
  handlers = h;
  if (access) return Promise.resolve();
  if (pending) return pending;
  const gen = generation;
  const p = navigator.requestMIDIAccess({ sysex: false }).then(
    (a) => {
      if (gen !== generation) return; // disconnected while the browser was asking
      access = a;
      a.onstatechange = () => attach(a);
      attach(a);
    },
  );
  pending = p;
  const clear = () => {
    if (pending === p) pending = null;
  };
  p.then(clear, clear);
  return p;
}

export function disconnectMidi(): void {
  generation++;
  pending = null;
  if (access) {
    access.inputs.forEach((input) => (input.onmidimessage = null));
    access.onstatechange = null;
    access = null;
  }
  liftWhere(() => true);
  emit();
  channels.clear();
  sendsPressure = false;
}
