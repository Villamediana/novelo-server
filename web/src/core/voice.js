// Speaking on the computer: the microphone heard here, made 16 kHz mono, cut in pieces of up to ~55 s at
// the quiet moments, each piece sent as WAV to the Novelo's server, which writes what was said — the
// same as the phone's "Novelo" ears (mind/Engines.kt: Hearing.byServer, HEAR_ASK). Nothing of it is kept:
// the words go into the box, she reads them and sends them herself.
import { b64 } from './crypto.js';

export const RATE = 16_000;
export const PIECE_S = 55;
export const MAX_S = 10 * 60;

/** What the server's model is asked (the phone's own words). */
export const HEAR_ASK = 'Transcribe exactly what is said in this recording, in the language it is spoken '
  + '(Portuguese, Spanish or English; they may come mixed). Write only the transcription: no comments, '
  + 'no translation, no quotes. If nothing is said, answer only with a dash (-).';
export const NOTHING_SAID = '-';

/** The microphone, recording: [onLevel](0–1, how loud now) while it goes; [stop]() → the samples at 16 kHz. */
export class Recorder {
  async start(onLevel = () => {}) {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    // The context at the device's own rate (some browsers can't take a microphone into another one): made 16 kHz below.
    this.ctx = new AudioContext();
    this.rate = this.ctx.sampleRate;
    this.chunks = [];
    this.length = 0;
    const source = this.ctx.createMediaStreamSource(this.stream);
    // A ScriptProcessor (old, but everywhere and with no module to load — the page loads no script but its own).
    this.node = this.ctx.createScriptProcessor(4096, 1, 1);
    this.node.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      if (this.length / this.rate >= MAX_S) return;
      this.chunks.push(new Float32Array(input));
      this.length += input.length;
      let sum = 0;
      for (let i = 0; i < input.length; i += 4) sum += input[i] * input[i];
      onLevel(Math.min(1, Math.sqrt(sum / (input.length / 4)) * 6));
    };
    source.connect(this.node);
    this.node.connect(this.ctx.destination);
    this.started = performance.now();
  }

  get seconds() {
    return this.rate ? this.length / this.rate : 0;
  }

  /** Stops (the microphone let go at once) → the whole recording at 16 kHz. */
  async stop() {
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    await this.ctx?.close().catch(() => {});
    const all = new Float32Array(this.length);
    let at = 0;
    for (const c of this.chunks) {
      all.set(c, at);
      at += c.length;
    }
    this.chunks = [];
    return resample(all, this.rate, RATE);
  }
}

/** [samples] at [from] Hz → [to] Hz (each new sample the mean of the ones it covers: speech needs no more). */
export function resample(samples, from, to) {
  if (from === to) return samples;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(samples.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const a = Math.floor(i * ratio);
    const b = Math.max(a + 1, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = a; j < b && j < samples.length; j++) sum += samples[j];
    out[i] = sum / (b - a);
  }
  return out;
}

const rms = (s, a, b) => {
  let sum = 0;
  for (let i = a; i < b; i++) sum += s[i] * s[i];
  return Math.sqrt(sum / Math.max(1, b - a));
};

/** Nothing said (only the room). */
export function isSilent(samples) {
  return !samples.length || rms(samples, 0, samples.length) < 0.004;
}

/** Pieces of up to [max] s, each cut at the quietest moment of its last 8 s (not in the middle of a word). */
export function pieces(samples, rate = RATE, max = PIECE_S) {
  const out = [];
  const size = max * rate;
  let start = 0;
  while (samples.length - start > size) {
    const end = start + size;
    const look = 8 * rate;
    const win = Math.floor(rate / 10);
    let best = end;
    let quiet = Infinity;
    for (let at = end - look; at + win <= end; at += win) {
      const v = rms(samples, at, at + win);
      if (v < quiet) {
        quiet = v;
        best = at + Math.floor(win / 2);
      }
    }
    out.push(samples.subarray(start, best));
    start = best;
  }
  out.push(samples.subarray(start));
  return out.filter((p) => p.length > rate / 4);
}

/** 16-bit PCM WAV of [samples]. */
export function wav(samples, rate = RATE) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const text = (at, s) => { for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i)); };
  text(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); text(8, 'WAVE');
  text(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  text(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 0x7fff, true);
  return new Uint8Array(buf);
}

/** The request for one piece, as the phone sends it. */
export function hearBody(wavBytes) {
  return {
    messages: [
      { role: 'system', content: HEAR_ASK },
      { role: 'user', content: [{ type: 'input_audio', input_audio: { data: b64.enc(wavBytes), format: 'wav' } }] },
    ],
  };
}

/** What the model wrote, cleaned ("" when nothing was said). */
export function heard(text) {
  const t = String(text ?? '').trim().replace(/^["“”]+|["“”]+$/g, '').trim();
  return t === NOTHING_SAID ? '' : t;
}

/** The recording → the words: each piece heard in order ([ask](body) → {text}), [onPiece](i, n) as they go. */
export async function transcribe(samples, ask, onPiece = () => {}) {
  const list = pieces(samples).filter((p) => !isSilent(p));
  const words = [];
  for (let i = 0; i < list.length; i++) {
    onPiece(i, list.length);
    const r = await ask(hearBody(wav(list[i])));
    const w = heard(r.text);
    if (w) words.push(w);
  }
  return words.join(' ');
}
