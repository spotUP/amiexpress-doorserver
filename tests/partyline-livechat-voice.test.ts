/**
 * Partyline voice parity with LC (board voice-channel.handler.ts + audio-video.handler.ts):
 * the same door/browser event sequence in gives the same events out, across two boards.
 */
import { encodeMedia, joinVoiceHub, MediaDecoder, resetVoiceHub, VoiceSink } from '../src/partyline/livechat-voice';

type Got = { ev: string; data: Record<string, unknown> };

function caller(userId: string, username: string) {
  const events: Got[] = [];
  const media: { ev: string; body: Buffer }[] = [];
  const dec = new MediaDecoder();
  const sink: VoiceSink = {
    userId, username,
    room: () => 'main',
    event: (ev, data) => events.push({ ev, data }),
    media: (p) => { const m = dec.push(p); if (m) media.push(m); },
  };
  return { sink, events, media, voice: joinVoiceHub(sink) };
}

const fromBrowser = (ev: string, body: Buffer | Record<string, unknown>): Buffer[] => encodeMedia(ev, body);

beforeEach(() => resetVoiceHub());

test('join acks the roster and tells the others, as voice:join-channel does in LC', () => {
  const a = caller('alice@x', 'alice');
  const b = caller('bob@y', 'bob');
  let ack: unknown;
  a.voice.onDoorEmit('voice:join-channel', { channelId: 'v1' });
  b.voice.onDoorEmit('voice:join-channel', { channelId: 'v1' }, (r) => { ack = r; });
  expect(ack).toEqual({
    success: true, channelId: 'v1',
    participants: [
      { userId: 'alice@x', username: 'alice', isMuted: false, hasVideo: false, hasScreenShare: false },
      { userId: 'bob@y', username: 'bob', isMuted: false, hasVideo: false, hasScreenShare: false },
    ],
  });
  expect(a.events).toEqual([{ ev: 'voice:joined', data: { userId: 'bob@y', username: 'bob', isMuted: false, hasVideo: false, hasScreenShare: false, channelId: 'v1' } }]);

  b.voice.onDoorEmit('voice:mute', { isMuted: true });
  b.voice.onDoorEmit('voice:video-toggle', { hasVideo: true });
  b.voice.close();
  expect(a.events.slice(1)).toEqual([
    { ev: 'voice:mute', data: { userId: 'bob@y', isMuted: true } },
    { ev: 'voice:video-toggle', data: { userId: 'bob@y', hasVideo: true } },
    { ev: 'voice:left', data: { userId: 'bob@y', channelId: 'v1' } },
  ]);
});

test('capture commands go to the own browser; media fans out like audio-video.handler', () => {
  const a = caller('alice@x', 'alice');
  const b = caller('bob@y', 'bob');
  a.voice.onDoorEmit('voice:join-channel', { channelId: 'v1' });
  b.voice.onDoorEmit('voice:join-channel', { channelId: 'v1' });
  a.events.length = 0;

  expect(a.voice.onDoorEmit('audio:start-streaming', { sampleRate: 48000 })).toBe(true);
  expect(a.media).toEqual([{ ev: 'audio:start-streaming', body: Buffer.from('{"sampleRate":48000}') }]);
  expect(a.voice.onDoorEmit('chat:message', {})).toBe(false);

  const pcm = Buffer.alloc(9000, 7); // over one frame: split and rejoined
  for (const p of fromBrowser('audio:data', pcm)) a.voice.onMedia(p);
  expect(b.media).toEqual([{ ev: 'audio:data', body: Buffer.concat([Buffer.from('alice@x\0'), pcm]) }]);
  expect(a.media).toHaveLength(1); // no echo of own audio

  const cells = Buffer.from([1, 2, 3]);
  for (const p of fromBrowser('video:cells', cells)) a.voice.onMedia(p);
  for (const p of fromBrowser('voice:speaking', { isSpeaking: true, audioLevel: 0.5 })) a.voice.onMedia(p);
  for (const p of fromBrowser('audio:levels', { level: 0.2 })) a.voice.onMedia(p);
  const status = { userId: 'alice@x', username: 'alice', isSpeaking: true, audioLevel: 0.5 };
  expect(a.events).toEqual([
    { ev: 'video:cells', data: { userId: 'alice@x', username: 'alice', packet: cells } },
    { ev: 'audio-speaking-status', data: status },
    { ev: 'audio:levels', data: { level: 0.2 } },
  ]);
  expect(b.events.slice(-2)).toEqual([
    { ev: 'video:cells', data: { userId: 'alice@x', username: 'alice', packet: cells } },
    { ev: 'audio-speaking-status', data: status },
  ]);
});
