/**
 * Hub file_shared / file_deleted -> Discord: pictures go up as an attachment,
 * other files as a text line, the same guards as a message (loop guard, board
 * list, replay dedupe), and a deleted file takes its Discord copy with it.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BridgeState } from '../src/discord-bridge/state';
import { createOutbound, PICTURE_UPLOAD_MAX } from '../src/discord-bridge/outbound';
import type { DiscordOut, WebhookPost } from '../src/discord-bridge/discord-out';
import type { BridgeEvent } from '../src/discord-bridge/wire';

const ev = (over: Partial<BridgeEvent>): BridgeEvent => ({
  seq: 1, type: 'file_shared', room: 'r', user: 'Bob@B', ref: 'f1', at: '', roleColor: '', text: 'cat.png|2048|image', replyTo: '', label: 'Bob', ...over,
});

function setup(opts: { fetchFile?: (id: string) => Promise<Buffer>; boards?: string[] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-pic-'));
  const state = new BridgeState(path.join(dir, 's.db'));
  const posts: { channel: string; post: WebhookPost }[] = [];
  const removed: string[] = [];
  const out: DiscordOut = {
    prepare: async () => undefined,
    post: async (channel, post) => { posts.push({ channel, post }); return `d${posts.length}`; },
    edit: async () => undefined,
    remove: async (_c, id) => { removed.push(id); },
    jumpLink: () => undefined,
  };
  const handler = createOutbound({
    rooms: new Map<string, readonly string[]>([['r', ['c1', 'c2']]]),
    state,
    out,
    fetchBoards: async () => ({ rev: 1, boards: new Set(opts.boards ?? ['B']) }),
    fetchFile: opts.fetchFile,
    log: () => undefined,
  });
  return { handler, posts, removed, state, done: () => { state.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

describe('hub pictures to Discord', () => {
  it('uploads a picture as an attachment to every linked channel, once per replay', async () => {
    const bytes = Buffer.from('PNGDATA');
    const t = setup({ fetchFile: async () => bytes });
    await t.handler(ev({}));
    expect(t.posts.map((p) => p.channel)).toEqual(['c1', 'c2']);
    expect(t.posts[0].post.username).toBe('Bob');
    expect(t.posts[0].post.attachment).toEqual({ name: 'cat.png', data: bytes });
    await t.handler(ev({})); // replay after a restart
    expect(t.posts).toHaveLength(2);
    t.done();
  });

  it('posts a text line for a non-image file, and for a picture it cannot read or that is too big', async () => {
    const t = setup({ fetchFile: async () => { throw new Error('GET -> 404'); } });
    await t.handler(ev({ ref: 'f2', text: 'doc.zip|3072|binary' }));
    await t.handler(ev({ ref: 'f3' })); // unreadable picture
    await t.handler(ev({ ref: 'f4', text: `big.png|${PICTURE_UPLOAD_MAX + 1}|image` }));
    const sent = t.posts.filter((p) => p.channel === 'c1').map((p) => p.post);
    expect(sent.map((p) => p.content)).toEqual(['shared file doc.zip \\(3 KB\\)', 'shared file cat.png \\(2 KB\\)', 'shared file big.png \\(8.0 MB\\)']) // Discord markdown escapes the parentheses;
    expect(sent.every((p) => !p.attachment)).toBe(true);
    t.done();
  });

  it('skips Discord-origin files and boards that are not mirrored', async () => {
    const t = setup({ fetchFile: async () => Buffer.from('x') });
    await t.handler(ev({ user: 'Zed@DISCORD' }));
    await t.handler(ev({ ref: 'f9', user: 'Cy@NOPE' }));
    expect(t.posts).toHaveLength(0);
    t.done();
  });

  it('removes the Discord copies when the file is deleted', async () => {
    const t = setup({ fetchFile: async () => Buffer.from('x') });
    await t.handler(ev({}));
    await t.handler(ev({ type: 'file_deleted', text: 'cat.png|owner', user: 'Bob@B' }));
    expect(t.removed.sort()).toEqual(['d1', 'd2']);
    expect(t.state.linksOf('f1')).toEqual([]);
    t.done();
  });
});
