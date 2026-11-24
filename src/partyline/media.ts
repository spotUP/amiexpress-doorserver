/**
 * Partyline hub engine: shared files, picture upload and voice, ported from
 * LIVECHAT's /files, /upload, /voice, /mic, /deafen and /undeafen.
 *
 * The call roster lives in the chat store (src/chat/voice.ts, the same calls the
 * web chat's voice rooms use), so a PL caller and a web caller see one call. The
 * audio itself rides the in-process voice hub (livechat-voice.ts) as `M` frames
 * to the caller's board, exactly as the LIVECHAT engine does.
 */
import { deleteFile, listFiles } from '../chat/files';
import { listRooms } from '../chat/store';
import { joinVoice, leaveVoice, setVoiceState, voiceMembers } from '../chat/voice';
import { filesAndDrawing } from './livechat-files';
import { joinVoiceHub, type VoiceSession } from './livechat-voice';
import type { HubScreen } from './ui/screen';

/** The store drops a call member silent for VOICE_STALE_MS (90 s); beat well inside it. */
const HEARTBEAT_MS = 30_000;
const VOICE_USAGE = ['Usage: /voice join <channel>   join a voice channel', '       /voice leave            leave the call', '       /voice mute | unmute    microphone', '       /voice video on | off   camera'];
const FILES_USAGE = 'Usage: /files [list | delete <number> | get <number>]';

type Mic = { deviceId: string; label: string };
const AUDIO_DATA = /^audio:data~?\0/;

export class HubMedia {
  /** The room id of the caller's call, '' when not in one. */
  call = '';
  muted = false;
  video = false;
  deaf = false;
  private beat: ReturnType<typeof setInterval> | undefined;
  private hub: VoiceSession | null = null;
  private mics: Mic[] = [];
  private mic = '';
  private listed: { id: string; name: string }[] = [];
  private made: ReturnType<typeof filesAndDrawing> | null = null;

  /** HubScreen makes this in a field initializer, before its own fields exist: touch `s` only later. */
  constructor(private readonly s: HubScreen) {}

  private get files(): ReturnType<typeof filesAndDrawing> {
    const s = this.s, h = s.info.hello;
    this.made ??= filesAndDrawing({
      store: (w, fn) => s.tryRun(w, fn) as ReturnType<typeof fn>,
      reply: (ev, d) => { if (ev === 'room:error') s.systemLine(String(d.error ?? '')); },
      str: (d, ...keys) => String(keys.map((k) => d[k]).find((v) => typeof v === 'string') ?? ''),
      short: (u) => u,
      room: () => (s.roomId ? { id: s.roomId, name: s.model.room } : null),
      filesDir: s.filesDir,
      uploadMode: h.upload,
      conn: h.conn,
      ...(s.info.ctrl ? { ctrl: s.info.ctrl } : {}),
    });
    return this.made;
  }

  /** The /files, /upload, /voice, /mic, /deafen and /undeafen commands. */
  command(cmd: string, rest: string): void {
    const [sub = '', arg = ''] = rest.split(/\s+(.*)/s).map((x) => x.trim());
    switch (cmd) {
      case 'upload': this.files.handlers['file:upload']!({}); return;
      case 'files': this.filesTyped(sub.toLowerCase(), arg); return;
      case 'voice': this.voiceTyped(sub.toLowerCase(), arg); return;
      case 'mic': this.micTyped(rest); return;
      case 'deafen': this.deaf = true; this.s.systemLine('Deafened - cannot hear others'); return;
      case 'undeafen': this.deaf = false; this.s.systemLine('Undeafened - can hear others'); return;
    }
  }

  /** A `U` frame: the board's answer to `T upload`. */
  uploadResult(payload: Buffer): void { this.files.onUploadResult(payload.toString('latin1')); }

  /** An `M` frame from the caller's board (audio, device lists). */
  media(payload: Buffer): void { this.hub?.onMedia(payload); }

  /** A store event; true when it was a voice event of the caller's call. */
  event(e: { type: string; room_id: string | null; user: string; ref: string; text: string }): boolean {
    if (e.type !== 'voice' || e.room_id !== this.call || this.s.model.isSelf(e.user)) return false;
    const who = e.user.slice(0, 24);
    if (e.ref === 'joined') this.s.systemLine(`${who} joined the call`);
    else if (e.ref === 'left') this.s.systemLine(`${who} left the call`);
    else if (e.ref === 'state') this.s.systemLine(`${who} ${e.text[0] === '1' ? 'muted' : 'unmuted'} the microphone${e.text[1] === '1' ? ', camera on' : ''}`);
    return true;
  }

  close(): void {
    if (this.call) this.s.tryRun(true, (db, ctx) => leaveVoice(db, ctx, this.call));
    this.stop();
    this.hub?.close();
    this.hub = null;
  }

  private filesTyped(sub: string, arg: string): void {
    const s = this.s;
    if (sub === '' || sub === 'list') {
      if (!s.roomId) { s.systemLine('Join a chat room first.'); return; }
      const rows = s.tryRun(false, (db, ctx) => listFiles(db, ctx, s.roomId, s.filesDir !== null));
      if (!rows) return;
      this.listed = rows.map((r) => ({ id: r.id, name: r.name }));
      if (rows.length === 0) { s.systemLine('No files shared in this room yet. /upload shares a picture.'); return; }
      s.systemLine(`Files in #${s.model.room.slice(0, 40)}:`);
      rows.slice(0, 50).forEach((r, i) => s.systemLine(`  ${i + 1}. ${r.name.slice(0, 50)} (${Math.max(1, Math.round(r.size / 1024))} KB, ${r.kind}) by ${r.label.slice(0, 24)}`));
      s.systemLine('/files delete <number> removes one.');
      return;
    }
    const f = this.listed[(Number.parseInt(arg, 10) || 0) - 1];
    if (sub === 'delete' || sub === 'get') {
      if (!f) { s.systemLine('No such file. /files lists them.'); return; }
      // shortcut: the Partyline protocol has no download frame yet; add one (board relay) to fetch here.
      if (sub === 'get') { s.systemLine('Downloading is not on Partyline yet; use the web chat.'); return; }
      if (s.tryRun(true, (db, ctx) => { deleteFile(db, s.filesDir, ctx, f.id); return true; })) {
        this.listed = this.listed.filter((x) => x !== f);
        s.systemLine(`Deleted ${f.name.slice(0, 50)}`);
      }
      return;
    }
    s.systemLine(FILES_USAGE);
  }

  private roomOf(name: string): string {
    if (name === '') return this.s.roomId;
    const want = name.replace(/^#/, '').toLowerCase();
    return this.s.tryRun(false, (db, ctx) => listRooms(db, ctx).find((r) => r.id === name || r.name.toLowerCase() === want)?.id) ?? '';
  }

  private voiceTyped(sub: string, arg: string): void {
    const s = this.s;
    switch (sub) {
      case '': {
        if (!this.call) s.systemLine('Not in a voice call.');
        else {
          const who = s.tryRun(false, (db, ctx) => voiceMembers(db, ctx, this.call).members) ?? [];
          s.systemLine(`In a call: ${who.map((m) => `${m.user.slice(0, 24)}${m.isMuted ? ' (muted)' : ''}`).join(', ')}${this.deaf ? '  [deafened]' : ''}`);
        }
        for (const l of VOICE_USAGE) s.systemLine(l);
        return;
      }
      case 'join': {
        const id = this.roomOf(arg);
        if (!id) { s.systemLine(arg ? 'No such channel.' : 'Usage: /voice join <channel>'); return; }
        const r = s.tryRun(true, (db, ctx) => joinVoice(db, ctx, id, { isMuted: this.muted, hasVideo: false }));
        if (!r) return;
        this.call = id;
        this.video = false;
        this.audio().onDoorEmit('voice:join-channel', { channelId: id });
        this.audio().onDoorEmit('voice:mute', { isMuted: this.muted });
        if (s.info.media) this.audio().onDoorEmit('audio:start-streaming', {});
        clearInterval(this.beat);
        this.beat = setInterval(() => { if (this.call) s.tryRun(true, (db, ctx) => setVoiceState(db, ctx, this.call, {})); }, HEARTBEAT_MS);
        this.beat.unref?.();
        s.systemLine(`Joined the call (${r.members.length} in call)${s.info.media ? '' : ' - this client carries no audio'}`);
        return;
      }
      case 'leave': {
        if (!this.call) { s.systemLine('Not in a voice call.'); return; }
        s.tryRun(true, (db, ctx) => leaveVoice(db, ctx, this.call));
        this.stop();
        s.systemLine('Left the call');
        return;
      }
      case 'mute': case 'unmute': {
        this.muted = sub === 'mute';
        if (this.call) s.tryRun(true, (db, ctx) => setVoiceState(db, ctx, this.call, { isMuted: this.muted }));
        this.hub?.onDoorEmit('voice:mute', { isMuted: this.muted });
        this.hub?.onDoorEmit('audio:mute', { muted: this.muted });
        s.systemLine(this.muted ? 'Microphone muted' : 'Microphone unmuted');
        return;
      }
      case 'video': {
        if (!this.call) { s.systemLine('Join a voice call first: /voice join <channel>'); return; }
        this.video = arg.toLowerCase() !== 'off';
        s.tryRun(true, (db, ctx) => setVoiceState(db, ctx, this.call, { hasVideo: this.video }));
        this.hub?.onDoorEmit('voice:video-toggle', { hasVideo: this.video });
        this.hub?.onDoorEmit(this.video ? 'video:start-stream' : 'video:stop-stream', {});
        s.systemLine(this.video ? 'Camera on' : 'Camera off');
        return;
      }
      default:
        s.systemLine(`Unknown subcommand: ${sub}`);
        s.systemLine('Usage: /voice [join <channel> | leave]');
    }
  }

  /** LIVECHAT commands/mic.ts renderMicList and its select. */
  private micTyped(rest: string): void {
    const s = this.s, n = Number.parseInt(rest, 10);
    if (rest !== '' && n >= 1 && n <= this.mics.length) {
      this.mic = this.mics[n - 1]!.deviceId;
      this.hub?.onDoorEmit('audio:select-device', { deviceId: this.mic });
      s.systemLine(`Microphone: ${this.mics[n - 1]!.label.slice(0, 60)}`);
      return;
    }
    if (this.mics.length === 0) { s.systemLine('No microphones reported yet - turn voice on first.'); return; }
    s.systemLine('Microphones:');
    this.mics.forEach((m, i) => s.systemLine(`  ${i + 1}. ${m.label.slice(0, 60)}${m.deviceId === this.mic ? ' (in use)' : ''}`));
    s.systemLine('Choose one with /mic <number>');
  }

  /** The in-process audio transport, made on first join and kept for the session. */
  private audio(): VoiceSession {
    if (this.hub) return this.hub;
    const s = this.s;
    this.hub = joinVoiceHub({
      userId: s.info.user,
      username: s.model.handle,
      room: () => this.call || null,
      event: (ev, d) => {
        if (ev === 'audio:devices' && Array.isArray(d.devices)) {
          this.mics = (d.devices as Mic[]).filter((m) => m && typeof m.deviceId === 'string').map((m) => ({ deviceId: m.deviceId, label: String(m.label || m.deviceId) }));
          if (!this.mic && this.mics[0]) this.mic = this.mics[0].deviceId;
        }
      },
      // Deafened: the peers' audio is dropped here, the rest still reaches the board.
      media: (p) => { if (!(this.deaf && AUDIO_DATA.test(p.toString('latin1', 0, 12)))) s.info.media?.(p); },
    });
    return this.hub;
  }

  private stop(): void {
    clearInterval(this.beat);
    this.beat = undefined;
    if (this.hub && this.call) {
      this.hub.onDoorEmit('voice:leave-channel', {});
      this.hub.onDoorEmit('audio:stop-streaming', {});
    }
    this.call = '';
  }
}
