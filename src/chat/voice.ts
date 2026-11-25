/**
 * Voice and video calls in voice rooms: who is in a room's call, their microphone and
 * camera state, and the WebRTC offer/answer/ICE relay between them.
 *
 * The roster model and its rules copy src/partyline/livechat-voice.ts (LIVECHAT's
 * voice:join-channel / voice:leave-channel / voice:mute / voice:video-toggle): joining one
 * call leaves the one you were in, every change fans out to the others in the call.
 * LIVECHAT streams audio through its server; here media goes browser to browser and the
 * hub only relays the signals. The roster lives in memory, like LIVECHAT's: a hub restart
 * empties every call and the browsers rejoin on their next heartbeat.
 */
import type Database from 'better-sqlite3';
import { SurfaceError } from '../achievements/errors';
import { emitEvent } from './events';
import { getRoom } from './permissions';
import type { RoomRec } from './permissions';
import type { ChatCtx } from './sessions';
import { requireMemberOf, str } from './store';
import type { Body } from './store';
import { AudioRelay } from './voice-relay';

interface CallMember { isMuted: boolean; hasVideo: boolean; at: number }

/** room id -> user -> state. */
const calls = new Map<string, Map<string, CallMember>>();

/** A member who sent no join, state or signal for this long has left (closed tab, lost network). */
export const VOICE_STALE_MS = 90_000;
const SIGNAL_KINDS = new Set(['offer', 'answer', 'ice']);
/** An SDP offer with video is a few KB; anything far larger is not a signal. */
const SIGNAL_MAX = 32_768;

export interface VoiceView { user: string; isMuted: boolean; hasVideo: boolean }

const flags = (m: CallMember): string => `${m.isMuted ? 1 : 0}${m.hasVideo ? 1 : 0}`;

function voiceRoom(db: Database.Database, ctx: ChatCtx, id: string): RoomRec {
  const room = getRoom(db, id);
  requireMemberOf(db, room.id, ctx);
  if (room.kind !== 'voice') throw new SurfaceError('forbidden', 403, 'only a voice room has a call');
  return room;
}

function drop(db: Database.Database, roomId: string, user: string): boolean {
  const call = calls.get(roomId);
  if (!call?.delete(user)) return false;
  if (call.size === 0) { calls.delete(roomId); relays.delete(roomId); }
  emitEvent(db, { type: 'voice', roomId, user, ref: 'left', text: '00' });
  return true;
}

/** Drop members gone quiet past VOICE_STALE_MS, each with a `left` event. */
function sweep(db: Database.Database, roomId: string, now: number): void {
  for (const [user, m] of calls.get(roomId) ?? []) if (now - m.at > VOICE_STALE_MS) drop(db, roomId, user);
}

const view = (roomId: string): VoiceView[] =>
  [...(calls.get(roomId) ?? [])].map(([user, m]) => ({ user, isMuted: m.isMuted, hasVideo: m.hasVideo }));

/** GET /rooms/:id/voice */
export function voiceMembers(db: Database.Database, ctx: ChatCtx, id: string): { members: VoiceView[] } {
  const room = voiceRoom(db, ctx, id);
  sweep(db, room.id, Date.now());
  return { members: view(room.id) };
}

/** POST /rooms/:id/voice/join: leaves any other call first, as LIVECHAT's join does. */
export function joinVoice(db: Database.Database, ctx: ChatCtx, id: string, b: Body): { members: VoiceView[] } {
  const room = voiceRoom(db, ctx, id);
  const now = Date.now();
  for (const [other, call] of calls) if (other !== room.id && call.has(ctx.user)) drop(db, other, ctx.user);
  sweep(db, room.id, now);
  const call = calls.get(room.id) ?? new Map<string, CallMember>();
  calls.set(room.id, call);
  const m: CallMember = { isMuted: b.isMuted === true, hasVideo: b.hasVideo === true, at: now };
  call.set(ctx.user, m);
  emitEvent(db, { type: 'voice', roomId: room.id, user: ctx.user, ref: 'joined', text: flags(m) });
  return { members: view(room.id) };
}

/** POST /rooms/:id/voice/leave */
export function leaveVoice(db: Database.Database, ctx: ChatCtx, id: string): { left: boolean } {
  const room = getRoom(db, id);
  return { left: drop(db, room.id, ctx.user) };
}

/** PUT /rooms/:id/voice: microphone/camera change, and the heartbeat that keeps the caller in the call. */
export function setVoiceState(db: Database.Database, ctx: ChatCtx, id: string, b: Body): { ok: true } {
  const room = voiceRoom(db, ctx, id);
  const m = calls.get(room.id)?.get(ctx.user);
  if (!m) throw new SurfaceError('not_found', 404, 'you are not in this call');
  m.at = Date.now();
  const before = flags(m);
  if (typeof b.isMuted === 'boolean') m.isMuted = b.isMuted;
  if (typeof b.hasVideo === 'boolean') m.hasVideo = b.hasVideo;
  if (flags(m) !== before) emitEvent(db, { type: 'voice', roomId: room.id, user: ctx.user, ref: 'state', text: flags(m) });
  sweep(db, room.id, m.at);
  return { ok: true };
}

/** POST /rooms/:id/voice/signal: one WebRTC offer, answer or ICE candidate to one other member of the call. */
export function relaySignal(db: Database.Database, ctx: ChatCtx, id: string, b: Body): { ok: true } {
  const room = voiceRoom(db, ctx, id);
  const call = calls.get(room.id);
  const me = call?.get(ctx.user);
  if (!me) throw new SurfaceError('not_found', 404, 'you are not in this call');
  me.at = Date.now();
  const to = str(b, 'to', 200);
  if (!call?.has(to) || to === ctx.user) throw new SurfaceError('not_found', 404, 'that user is not in this call');
  const kind = str(b, 'kind', 10);
  if (!SIGNAL_KINDS.has(kind)) throw new SurfaceError('bad_request', 400, 'kind is offer, answer or ice');
  const data = str(b, 'data', SIGNAL_MAX);
  // base64: the events.txt escaper turns '|' into '!' and newlines into spaces, which would corrupt SDP.
  emitEvent(db, { type: 'voice_signal', label: room.id, user: ctx.user, ref: kind, text: Buffer.from(data, 'utf8').toString('base64'), dmA: ctx.user, dmB: to });
  return { ok: true };
}

/** room id -> the call's audio relay for callers without WebRTC (voice-relay.ts). */
const relays = new Map<string, AudioRelay>();

/**
 * PUT /rooms/:id/voice/audio: post the caller's mu-law microphone bytes, get back the mix of
 * what the others sent since the caller's last exchange. Counts as the call heartbeat.
 * A muted caller's bytes are dropped here, whatever the client sends.
 */
export function exchangeAudio(db: Database.Database, ctx: ChatCtx, id: string, ulaw: Buffer, mesh: boolean): Buffer {
  const room = voiceRoom(db, ctx, id);
  const call = calls.get(room.id);
  const me = call?.get(ctx.user);
  if (!call || !me) throw new SurfaceError('not_found', 404, 'you are not in this call');
  me.at = Date.now();
  const relay = relays.get(room.id) ?? new AudioRelay();
  relays.set(room.id, relay);
  return relay.exchange(ctx.user, ulaw, { mesh, muted: me.isMuted, inCall: inCallOrDoor(call), now: me.at });
}

/** Relay key of a Partyline door caller: never collides with a chat/v1 call member. */
export const doorRelayKey = (userId: string): string => `door:${userId}`;
/** Door callers are not in the call roster; the relay's 5 s idle rule prunes them instead. */
const inCallOrDoor = (call: Map<string, CallMember>) => (u: string): boolean => call.has(u) || u.startsWith('door:');

/**
 * A Partyline door caller's mic (8 kHz mu-law, from livechat-voice.ts) into the relay of the
 * chat/v1 voice room it sits in; returns the mix for it, or null when that room has no call
 * (nobody on the relay side to hear or be heard). Door callers hear each other over LIVECHAT's
 * own audio:data, so they share the relay group `door` and are never relayed to each other.
 */
export function exchangeDoorAudio(roomId: string, userId: string, ulaw: Buffer, muted: boolean): Buffer | null {
  const call = calls.get(roomId);
  if (!call) return null;
  const relay = relays.get(roomId) ?? new AudioRelay();
  relays.set(roomId, relay);
  return relay.exchange(doorRelayKey(userId), ulaw, { mesh: 'door', muted, inCall: inCallOrDoor(call), now: Date.now() });
}

/** Tests only. */
export function _resetVoiceForTests(): void { calls.clear(); relays.clear(); }
