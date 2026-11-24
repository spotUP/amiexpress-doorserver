/**
 * Partyline media commands (src/partyline/media.ts) against LIVECHAT /files, /upload,
 * /voice, /mic, /deafen: a real hub screen on a real chat store and voice roster.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { makeAchievementsFixture } from './achievements/helpers';
import type { AchievementsFixture } from './achievements/helpers';
import { withAchievementsDb } from '../src/achievements/db';
import { loadChatConfig } from '../src/chat/config';
import { createSession, _stopChatSweepersForTests } from '../src/chat/sessions';
import { createRoom } from '../src/chat/store';
import { beginUpload, finishUpload, uploadChunk } from '../src/chat/files';
import { voiceMembers, _resetVoiceForTests } from '../src/chat/voice';
import { encodeMedia, resetVoiceHub } from '../src/partyline/livechat-voice';
import { chatScreen } from '../src/partyline/ui/screen';
import type { HubScreen } from '../src/partyline/ui/screen';
import type { ScreenInfo } from '../src/partyline/session';

describe('Partyline media commands', () => {
  let fx: AchievementsFixture;
  let dir: string;
  const screens: HubScreen[] = [];
  const ctrl: string[] = [];
  const media: Buffer[] = [];
  beforeEach(() => { fx = makeAchievementsFixture(); dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-media-')); ctrl.length = 0; media.length = 0; });
  afterEach(() => {
    for (const s of screens.splice(0)) s.close();
    resetVoiceHub(); _resetVoiceForTests(); _stopChatSweepersForTests(); fx.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const open = (handle: string, over: Partial<ScreenInfo['hello']> = {}, sink = true): HubScreen => {
    const chat = loadChatConfig();
    const sid = withAchievementsDb(fx.ach, (db) => createSession(db, chat, fx.boardId, { handle, sysop: true, client: 'test' }).sid);
    const hello = { cols: 80, rows: 25, upload: 'web', conn: 'web', media: true, ...over } as ScreenInfo['hello'];
    const s = chatScreen(fx.ach, chat, dir)({ sid, user: handle, boardId: fx.boardId, hello, markDirty: () => {}, ...(sink ? { ctrl: (t: string) => ctrl.push(t), media: (p: Buffer) => media.push(p) } : {}) }) as HubScreen;
    screens.push(s);
    return s;
  };
  const type = (s: HubScreen, line: string): void => { s.input(Buffer.from(`${line}\r`, 'latin1')); s.take(); };
  const last = (s: HubScreen): string => s.model.lines[s.model.lines.length - 1]?.text ?? '';
  const texts = (s: HubScreen): string[] => s.model.lines.map((l) => l.text);

  it('/upload asks the board for a transfer and reports a failed one', () => {
    const s = open('bob');
    type(s, '/upload'); expect(last(s)).toBe('Join a chat room first.');
    s.run(true, (db, ctx) => createRoom(db, ctx, { name: 'general' }));
    type(s, '/join #general');
    type(s, '/upload');
    expect(ctrl).toEqual([expect.stringMatching(new RegExp(`^upload ${s.roomId} \\d+ image web$`))]);
    type(s, '/upload'); expect(last(s)).toBe('A picture upload is already waiting.');
    s.upload(Buffer.from('fail too big', 'latin1'));
    expect(last(s)).toBe('too big');
    const tn = open('ann', { upload: 'none', conn: 'telnet' });
    tn.run(true, (db, ctx) => createRoom(db, ctx, { name: 'other' }));
    type(tn, '/join #other'); type(tn, '/upload');
    expect(last(tn)).toBe('Picture upload is not available from this client.');
  });

  it('/files lists, refuses get, and deletes by number', () => {
    const s = open('bob');
    s.run(true, (db, ctx) => createRoom(db, ctx, { name: 'general' }));
    type(s, '/join #general');
    type(s, '/files'); expect(last(s)).toBe('No files shared in this room yet. /upload shares a picture.');
    s.run(true, (db, ctx) => {
      const b = beginUpload(db, dir, ctx, s.roomId, { clientId: 'c1', name: 'notes.txt', size: 5 });
      uploadChunk(db, dir, ctx, b.id, 0, Buffer.from('hello'));
      finishUpload(db, dir, ctx, b.id);
    });
    type(s, '/files list');
    expect(texts(s).some((t) => /^ {2}1\. notes\.txt \(1 KB, \w+\) by /.test(t))).toBe(true);
    type(s, '/files get 1'); expect(last(s)).toBe('Downloading is not on Partyline yet; use the web chat.');
    type(s, '/files delete 9'); expect(last(s)).toBe('No such file. /files lists them.');
    type(s, '/files delete 1'); expect(last(s)).toBe('Deleted notes.txt');
    type(s, '/files'); expect(last(s)).toBe('No files shared in this room yet. /upload shares a picture.');
    type(s, '/files nope'); expect(last(s)).toBe('Usage: /files [list | delete <number> | get <number>]');
  });

  it('/voice joins the store call, mutes, deafens and leaves; the peer sees it', () => {
    const bob = open('bob');
    const ann = open('ann', {}, false);
    bob.run(true, (db, ctx) => createRoom(db, ctx, { name: 'talk', kind: 'voice' }));
    bob.run(true, (db, ctx) => createRoom(db, ctx, { name: 'text' }));
    type(bob, '/join #text');
    type(bob, '/voice join'); expect(last(bob)).toBe('only a voice room has a call');
    type(bob, '/voice join #talk'); expect(last(bob)).toBe('join the room first');
    type(bob, '/join #talk'); type(bob, '/voice join #talk');
    expect(last(bob)).toBe('Joined the call (1 in call)');
    const talk = bob.av.call;
    expect(bob.run(false, (db, ctx) => voiceMembers(db, ctx, talk).members.map((m) => m.user))).toEqual(['bob@UPROUGH']);
    expect(media.some((p) => p.toString('latin1').startsWith('audio:start-streaming\0'))).toBe(true);

    type(ann, '/join #talk'); type(ann, '/voice join');
    type(bob, '/nick'); // take() pulls ann's store event into bob's pane
    expect(texts(bob)).toContain('ann@UPROUGH joined the call');

    // Peer audio reaches bob's board, and stops when he deafens.
    const audio = Buffer.concat(encodeMedia('audio:data', Buffer.from([1, 2, 3])));
    media.length = 0;
    ann.media(audio);
    expect(media.filter((p) => p.toString('latin1').startsWith('audio:data\0'))).toHaveLength(1);
    type(bob, '/deafen'); expect(last(bob)).toBe('Deafened - cannot hear others');
    media.length = 0; ann.media(audio);
    expect(media).toHaveLength(0);
    type(bob, '/undeafen'); expect(last(bob)).toBe('Undeafened - can hear others');

    type(bob, '/voice mute'); expect(last(bob)).toBe('Microphone muted');
    expect(bob.run(false, (db, ctx) => voiceMembers(db, ctx, talk).members.find((m) => m.user === 'bob@UPROUGH')?.isMuted)).toBe(true);
    type(ann, '/nick'); expect(texts(ann)).toContain('bob@UPROUGH muted the microphone');

    type(bob, '/voice'); expect(texts(bob)).toContain('In a call: bob@UPROUGH (muted), ann@UPROUGH');
    type(bob, '/voice zap'); expect(last(bob)).toBe('Usage: /voice [join <channel> | leave]');
    type(bob, '/voice leave'); expect(last(bob)).toBe('Left the call');
    expect(bob.run(false, (db, ctx) => voiceMembers(db, ctx, talk).members.map((m) => m.user))).toEqual(['ann@UPROUGH']);
    type(bob, '/voice leave'); expect(last(bob)).toBe('Not in a voice call.');
  });

  it('/mic lists the devices the board reported and selects one', () => {
    const s = open('bob');
    s.run(true, (db, ctx) => createRoom(db, ctx, { name: 'talk', kind: 'voice' }));
    type(s, '/mic'); expect(last(s)).toBe('No microphones reported yet - turn voice on first.');
    type(s, '/join #talk'); type(s, '/voice join');
    for (const p of encodeMedia('audio:devices', { devices: [{ deviceId: 'd1', label: 'Built-in' }, { deviceId: 'd2', label: 'USB' }] })) s.media(p);
    type(s, '/mic');
    expect(texts(s).slice(-4)).toEqual(['Microphones:', '  1. Built-in (in use)', '  2. USB', 'Choose one with /mic <number>']);
    media.length = 0;
    type(s, '/mic 2'); expect(last(s)).toBe('Microphone: USB');
    expect(media.map((p) => p.toString('utf8'))).toContain('audio:select-device\0{"deviceId":"d2"}');
  });
});
