/**
 * Partyline voice/video: the hub's copy of the board's voice-channel.handler.ts and
 * audio-video.handler.ts fan-out, across boards. The LC door in each caller's child talks
 * to this the way it talks to the board; the caller's browser reaches it through `M` frames.
 *
 * `M` payload: event name | 0x00 | body (JSON, or raw bytes for audio:data / video:cells).
 * A body over one frame goes as several frames; all but the last name the event with a
 * trailing `~`. Design: amiexpress-web thoughts/shared/research/2026-11-15-partyline-voice-design.md
 */
import { PLP_MAX_PAYLOAD } from '../../contract/partyline-types';
import { exchangeDoorAudio } from '../chat/voice';
import { RELAY_MAX_BYTES } from '../chat/voice-relay';

type Payload = Record<string, unknown>;

/** Events whose body is raw bytes, not JSON. */
const BINARY = new Set(['audio:data', 'audio:ulaw', 'video:cells']);

/** One event as one or more `M` payloads. */
export function encodeMedia(ev: string, body: Buffer | Payload): Buffer[] {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body), 'utf8');
  const room = PLP_MAX_PAYLOAD - ev.length - 2;
  const out: Buffer[] = [];
  for (let at = 0; at < bytes.length || out.length === 0; at += room) {
    const last = at + room >= bytes.length;
    out.push(Buffer.concat([Buffer.from(`${ev}${last ? '' : '~'}\0`, 'latin1'), bytes.subarray(at, at + room)]));
  }
  return out;
}

/** Joins split `M` payloads; returns the event once its last piece is in. */
export class MediaDecoder {
  private parts = new Map<string, Buffer[]>();
  push(payload: Buffer): { ev: string; body: Buffer } | null {
    const nul = payload.indexOf(0);
    if (nul <= 0) return null;
    const name = payload.toString('latin1', 0, nul);
    const ev = name.endsWith('~') ? name.slice(0, -1) : name;
    const list = this.parts.get(ev) ?? [];
    list.push(payload.subarray(nul + 1));
    if (name.endsWith('~')) { this.parts.set(ev, list); return null; }
    this.parts.delete(ev);
    return { ev, body: Buffer.concat(list) };
  }
}

export interface VoiceSink {
  /** The id the door knows this caller by (the host's short()/full user). */
  userId: string;
  username: string;
  /** The caller's chat room: LC's fallback when no voice channel is joined. */
  room(): string | null;
  /** An event to this caller's LC door. */
  event(ev: string, data: Payload): void;
  /** One `M` payload to this caller's board (dropped when the caller has media=0). */
  media(payload: Buffer): void;
}

interface Member { sink: VoiceSink; channel: string | null; isMuted: boolean; hasVideo: boolean }

/** Every Partyline caller on this hub; one registry per hub process. */
const members = new Set<Member>();

const where = (m: Member): string | null => m.channel ?? m.sink.room();
const peers = (m: Member, self: boolean): Member[] => {
  const c = where(m);
  return c ? [...members].filter((o) => (self || o !== m) && where(o) === c) : [];
};
const send = (to: VoiceSink, ev: string, body: Buffer | Payload): void => { for (const p of encodeMedia(ev, body)) to.media(p); };
const view = (m: Member): Payload => ({ userId: m.sink.userId, username: m.sink.username, isMuted: m.isMuted, hasVideo: m.hasVideo, hasScreenShare: false });

/** Door -> browser commands: in LC a door emit goes server->client, so here it goes to the board. */
const TO_BROWSER = /^(audio:(start-streaming|stop-streaming|mute|select-device|play|set-enabled|set-volume)|video:(start-stream|stop-stream))$/;

export interface VoiceSession {
  /** A door emit. Returns false when it is not a voice event; `ack` gets the join reply. */
  onDoorEmit(ev: string, data: Payload, ack?: (r: unknown) => void): boolean;
  /** One `M` payload from the caller's board. */
  onMedia(payload: Buffer): void;
  close(): void;
}

export function joinVoiceHub(sink: VoiceSink): VoiceSession {
  const me: Member = { sink, channel: null, isMuted: false, hasVideo: false };
  members.add(me);
  const dec = new MediaDecoder();

  const leave = (): string | null => {
    const was = me.channel;
    if (was) for (const o of peers(me, false)) o.sink.event('voice:left', { userId: sink.userId, channelId: was });
    me.channel = null;
    return was;
  };

  return {
    onDoorEmit(ev, data, ack) {
      switch (ev) {
        case 'voice:join-channel': {
          leave();
          const channelId = String(data.channelId || data.channelName || 'default-voice');
          me.channel = channelId;
          for (const o of peers(me, false)) o.sink.event('voice:joined', { ...view(me), channelId });
          ack?.({ success: true, channelId, participants: peers(me, true).map(view) });
          return true;
        }
        case 'voice:leave-channel':
          ack?.({ success: leave() !== null });
          return true;
        case 'voice:mute':
          me.isMuted = !!data.isMuted;
          for (const o of peers(me, false)) o.sink.event('voice:mute', { userId: sink.userId, isMuted: me.isMuted });
          return true;
        case 'voice:video-toggle':
          me.hasVideo = !!data.hasVideo;
          for (const o of peers(me, false)) o.sink.event('voice:video-toggle', { userId: sink.userId, hasVideo: me.hasVideo });
          return true;
        default:
          if (!TO_BROWSER.test(ev)) return false;
          send(sink, ev, data);
          return true;
      }
    },

    onMedia(payload) {
      const got = dec.push(payload);
      if (!got) return;
      const { ev, body } = got;
      if (ev === 'audio:data') {
        // No echo to the sender (audio-video.handler.ts: hearing yourself late).
        for (const o of peers(me, false)) send(o.sink, 'audio:data', Buffer.concat([Buffer.from(`${sink.userId}\0`, 'utf8'), body]));
        return;
      }
      if (ev === 'audio:ulaw') {
        // Bridge to the chat/v1 voice relay (Amiga, /chat browsers): the browser sends 8 kHz
        // mu-law every 500 ms next to its opus audio:data, and gets the room's relay mix back.
        const c = where(me);
        const mix = c && body.length <= RELAY_MAX_BYTES ? exchangeDoorAudio(c, sink.userId, body, me.isMuted) : null;
        if (mix && mix.length > 0) send(sink, 'audio:ulaw', mix);
        return;
      }
      if (ev === 'video:cells') {
        // Others AND the sender: the door draws its own tile from the echo.
        const frame = { userId: sink.userId, username: sink.username, packet: body };
        for (const o of peers(me, true)) o.sink.event('video:cells', frame);
        return;
      }
      let data: Payload;
      try { data = BINARY.has(ev) ? {} : (JSON.parse(body.toString('utf8')) as Payload); } catch { return; }
      if (ev === 'voice:speaking') {
        for (const o of peers(me, true)) o.sink.event('audio-speaking-status', { userId: sink.userId, username: sink.username, isSpeaking: !!data.isSpeaking, audioLevel: data.audioLevel });
        return;
      }
      // audio:levels, audio:device(s), video:started/error...: browser -> its own door, as on the board.
      sink.event(ev, data);
    },

    close() { leave(); members.delete(me); },
  };
}

/** Tests only. */
export function resetVoiceHub(): void { members.clear(); }
