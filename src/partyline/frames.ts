/**
 * PLP/1 frame codec: type (1 byte) | length (u16 BE) | payload (<= 4096 bytes).
 * Big-endian buffer methods only: the 68K client reads the header natively.
 */
import { PLP_HEADER_BYTES, PLP_MAX_PAYLOAD } from '../../contract/partyline-types';
import type { PlpFrame } from '../../contract/partyline-types';

export class FrameError extends Error {}

export function encodeFrame(type: string, payload: Buffer | string = Buffer.alloc(0)): Buffer {
  if (type.length !== 1 || type.charCodeAt(0) > 0x7f) throw new FrameError(`frame type must be one ASCII character, got "${type}"`);
  const body = typeof payload === 'string' ? Buffer.from(payload, 'latin1') : payload;
  if (body.length > PLP_MAX_PAYLOAD) throw new FrameError(`payload of ${body.length} bytes exceeds ${PLP_MAX_PAYLOAD}`);
  const out = Buffer.alloc(PLP_HEADER_BYTES + body.length);
  out.writeUInt8(type.charCodeAt(0), 0);
  out.writeUInt16BE(body.length, 1);
  body.copy(out, PLP_HEADER_BYTES);
  return out;
}

/** Bytes in, whole frames out; a frame split across chunks waits for its tail. */
export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);

  /** Throws FrameError on an oversize length; the caller closes the connection. */
  push(chunk: Buffer): PlpFrame[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const frames: PlpFrame[] = [];
    while (this.buf.length >= PLP_HEADER_BYTES) {
      const len = this.buf.readUInt16BE(1);
      if (len > PLP_MAX_PAYLOAD) throw new FrameError(`frame length ${len} exceeds ${PLP_MAX_PAYLOAD}`);
      if (this.buf.length < PLP_HEADER_BYTES + len) break;
      frames.push({
        type: String.fromCharCode(this.buf.readUInt8(0)),
        payload: Buffer.from(this.buf.subarray(PLP_HEADER_BYTES, PLP_HEADER_BYTES + len)),
      });
      this.buf = this.buf.subarray(PLP_HEADER_BYTES + len);
    }
    return frames;
  }
}

/** `D`/`G` payload: sequence (u32 BE) then the bytes. */
export function seqPayload(seq: number, bytes: Buffer): Buffer {
  const out = Buffer.alloc(4 + bytes.length);
  out.writeUInt32BE(seq >>> 0, 0);
  bytes.copy(out, 4);
  return out;
}

/** `C` payload: the acked sequence (u32 BE); null when short. */
export function readAck(payload: Buffer): number | null {
  return payload.length >= 4 ? payload.readUInt32BE(0) : null;
}

/** `key=value` lines (LF or CRLF) to a map; lines without `=` are skipped. */
export function parseKv(payload: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of payload.toString('latin1').split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq > 0) out.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  return out;
}

export function kvPayload(rec: Record<string, string | number>): Buffer {
  return Buffer.from(Object.entries(rec).map(([k, v]) => `${k}=${v}`).join('\n'), 'latin1');
}
