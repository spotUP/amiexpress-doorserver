/**
 * Voice-room audio relay for clients with no WebRTC stack (the Amiga Partyline client).
 *
 * Wire format: G.711 mu-law, 8000 Hz, mono, one byte per sample (64 kbit/s). Chosen for
 * the 68K: decode is one 256-byte table lookup per sample, encode one lookup in a 16 KB
 * table, so a 68020 spends about 2% of its time on the codec (see the Amiga client's
 * pl_ulaw.c). Browsers send the same stream next to their WebRTC mesh (`mesh` callers).
 *
 * Each exchange posts the caller's microphone bytes and takes back everything the others
 * sent since the caller's last exchange, mixed into one stream. Mesh callers already hear
 * each other over WebRTC, so audio never goes from one mesh caller to another.
 */

const BIAS = 0x84;
const CLIP = 32635;

/** G.711 mu-law encode of one 16-bit sample. */
export function ulawEncode(sample: number): number {
  let s = sample;
  const sign = s < 0 ? 0x80 : 0;
  if (sign) s = -s;
  if (s > CLIP) s = CLIP;
  s += BIAS;
  let exp = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exp > 0; mask >>= 1) exp--;
  return ~(sign | (exp << 4) | ((s >> (exp + 3)) & 0x0f)) & 0xff;
}

/** G.711 mu-law decode of one byte to a 16-bit sample. */
export function ulawDecode(byte: number): number {
  const u = ~byte & 0xff;
  const s = ((((u & 0x0f) << 3) + BIAS) << ((u >> 4) & 7)) - BIAS;
  return u & 0x80 ? -s : s;
}

const DECODE = Int16Array.from({ length: 256 }, (_, i) => ulawDecode(i));

/** One second of audio: the most a caller may post at once and the most queued per sender. */
export const RELAY_MAX_BYTES = 8000;
/** A caller who has not exchanged for this long stops being sent audio. */
export const RELAY_IDLE_MS = 5000;

interface Listener { mesh: boolean; at: number; queued: Map<string, Int16Array> }

/** One call's relay: listener -> sender -> samples waiting for that listener. */
export class AudioRelay {
  private listeners = new Map<string, Listener>();

  /** Post `ulaw` from `user` (empty or `muted` = no microphone audio) and return their mix. */
  exchange(user: string, ulaw: Buffer, opts: { mesh: boolean; muted: boolean; inCall: (u: string) => boolean; now: number }): Buffer {
    for (const [u, l] of this.listeners) if (u !== user && (!opts.inCall(u) || opts.now - l.at > RELAY_IDLE_MS)) this.listeners.delete(u);
    const me = this.listeners.get(user) ?? { mesh: opts.mesh, at: opts.now, queued: new Map<string, Int16Array>() };
    me.mesh = opts.mesh;
    me.at = opts.now;
    this.listeners.set(user, me);

    const n = Math.min(ulaw.length, RELAY_MAX_BYTES);
    if (n > 0 && !opts.muted) {
      const pcm = new Int16Array(n);
      for (let i = 0; i < n; i++) pcm[i] = DECODE[ulaw[i]];
      for (const [u, l] of this.listeners) {
        if (u === user || (l.mesh && me.mesh)) continue;
        const had = l.queued.get(user);
        const joined = had ? concat(had, pcm) : pcm;
        // A listener that stopped draining keeps only the newest second, never a growing backlog.
        l.queued.set(user, joined.length > RELAY_MAX_BYTES ? joined.subarray(joined.length - RELAY_MAX_BYTES) : joined);
      }
    }
    return this.drain(me);
  }

  /** Sum every sender's queue sample by sample (aligned at the start), clip, encode, clear. */
  private drain(me: Listener): Buffer {
    let len = 0;
    for (const q of me.queued.values()) len = Math.max(len, q.length);
    const out = Buffer.alloc(len);
    for (let i = 0; i < len; i++) {
      let sum = 0;
      for (const q of me.queued.values()) if (i < q.length) sum += q[i];
      out[i] = ulawEncode(sum > 32767 ? 32767 : sum < -32768 ? -32768 : sum);
    }
    me.queued.clear();
    return out;
  }

  get size(): number { return this.listeners.size; }
}

function concat(a: Int16Array, b: Int16Array): Int16Array {
  const out = new Int16Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
