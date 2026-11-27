/**
 * The register-or-link form a board caller sees when POST /sessions (in process:
 * AccountGateway.open) answers NeedsAccountReply: the BBS user has no Partyline
 * account link yet. Register makes a new global account (password twice); link
 * ties this BBS user to an existing account by its password, entered once.
 * Never auto-links (plan D4, security invariant 1): the prefill is only form defaults.
 *
 * A plain line form, repainted whole: it is shown once per BBS user, so no cell diffing.
 */
import type Database from 'better-sqlite3';
import type {
  AccountPrefill, BoardAccountReply, BoardSessionReply, LinkViaBoardRequest, NeedsAccountReply,
  RegisterViaBoardRequest, SessionRequest,
} from '../../contract/chat-types';
import { validHandle } from '../chat/sessions';
import type { PartylineScreen, ScreenInfo } from './session';

/**
 * The account endpoints as the PLP session calls them in process, on its own store handle inside a
 * transaction (as createSession).
 * Refusals throw an error carrying `status` and `code` (SurfaceError): 409 `handle_taken` /
 * `email_taken`, 401 `unauthorized`, 400 on a bad field.
 */
export interface AccountGateway {
  open(db: Database.Database, boardId: string, req: SessionRequest): BoardSessionReply;
  register(db: Database.Database, boardId: string, req: RegisterViaBoardRequest): BoardAccountReply;
  link(db: Database.Database, boardId: string, req: LinkViaBoardRequest): BoardAccountReply;
}

export const isNeedsAccount = (r: BoardSessionReply): r is NeedsAccountReply => 'needs_account' in r && r.needs_account === true;

export const FORM_TEXT = {
  title: 'Partyline needs a Partyline account for you. One account works on every board.',
  choose: '[R] Register a new account   [L] Link an account you already have   [Q] Quit',
  handleTaken: 'That handle is taken. Pick another handle.',
  emailTaken: 'That email is already used by another account.',
  badHandle: 'A handle is 1-32 characters with no spaces, | or @.',
  badPassword: 'A password is 8-128 characters.',
  mismatch: 'The passwords do not match. Type them again.',
  wrongPassword: 'Wrong handle or password. Try again, or Esc to go back.',
  failed: 'Partyline could not save the account. Try again in a moment.',
} as const;

type FieldKey = 'handle' | 'realname' | 'location' | 'email' | 'password' | 'password2';
interface Field { key: FieldKey; label: string; masked: boolean; optional: boolean }

const REGISTER: Field[] = [
  { key: 'handle', label: 'Handle', masked: false, optional: false },
  { key: 'realname', label: 'Real name', masked: false, optional: true },
  { key: 'location', label: 'Location', masked: false, optional: true },
  { key: 'email', label: 'Email (optional, for password reset)', masked: false, optional: true },
  { key: 'password', label: 'Password', masked: true, optional: false },
  { key: 'password2', label: 'Password again', masked: true, optional: false },
];
const LINK: Field[] = [
  { key: 'handle', label: 'Partyline handle', masked: false, optional: false },
  { key: 'password', label: 'Its Partyline password', masked: true, optional: false },
];

const MAX_FIELD = 128;

export interface AccountFormInfo {
  /** The board's username for this caller: the link key, never the account handle. */
  bbsUser: string;
  reply: NeedsAccountReply;
  hello: ScreenInfo['hello'];
  /** AccountGateway.register / .link bound to this caller's board and a store transaction. */
  register: (req: RegisterViaBoardRequest) => BoardAccountReply;
  link: (req: LinkViaBoardRequest) => BoardAccountReply;
  markDirty: () => void;
  quit: () => void;
  /** The account exists and is linked: the session continues into Partyline on this sid. */
  done: (reply: BoardAccountReply) => void;
}

export class AccountForm implements PartylineScreen {
  private mode: 'choose' | 'register' | 'link' = 'choose';
  private at = 0;
  private values: Record<FieldKey, string>;
  private message = '';

  constructor(private readonly info: AccountFormInfo) {
    this.values = this.fromPrefill(info.reply.prefill);
  }

  private fromPrefill(p: AccountPrefill): Record<FieldKey, string> {
    return { handle: p.handle ?? '', realname: p.realname ?? '', location: p.location ?? '', email: p.email ?? '', password: '', password2: '' };
  }

  private get fields(): Field[] {
    return this.mode === 'link' ? LINK : REGISTER;
  }

  resize(): void { /* full repaint each time */ }

  input(bytes: Buffer): void {
    // An escape sequence (arrow keys) arrives as one chunk: a lone ESC is the Esc key, anything longer is ignored.
    if (bytes[0] === 0x1b) {
      if (bytes.length === 1) this.escape();
      this.info.markDirty();
      return;
    }
    for (const b of bytes) {
      if (this.mode === 'choose') this.choose(String.fromCharCode(b).toLowerCase());
      else if (b === 0x0d) this.enter();
      else if (b === 0x08 || b === 0x7f) this.edit((v) => v.slice(0, -1));
      else if (b >= 0x20 && b !== 0x7f) this.edit((v) => (v.length < MAX_FIELD ? v + String.fromCharCode(b) : v));
    }
    this.info.markDirty();
  }

  private choose(k: string): void {
    if (k === 'q') this.info.quit();
    else if (k === 'r' || k === 'l') {
      this.mode = k === 'r' ? 'register' : 'link';
      this.at = 0;
      this.message = '';
    }
  }

  private escape(): void {
    if (this.mode === 'choose') { this.info.quit(); return; }
    this.mode = 'choose';
    this.values.password = '';
    this.values.password2 = '';
    this.message = '';
  }

  private edit(fn: (v: string) => string): void {
    const k = this.fields[this.at].key;
    this.values[k] = fn(this.values[k]);
  }

  /** Moves to `key` with its value cleared (a password, or a handle that was refused). */
  private retry(key: FieldKey, message: string, clear: FieldKey[] = [key]): void {
    for (const k of clear) this.values[k] = '';
    this.at = this.fields.findIndex((f) => f.key === key);
    this.message = message;
  }

  private enter(): void {
    const f = this.fields[this.at];
    const v = this.values[f.key].trim();
    if (f.key === 'handle' && !validHandle(v)) return this.retry('handle', FORM_TEXT.badHandle);
    if (f.key === 'password' && this.mode === 'register' && (this.values.password.length < 8 || this.values.password.length > 128)) {
      return this.retry('password', FORM_TEXT.badPassword);
    }
    if (f.key === 'password2' && this.values.password2 !== this.values.password) {
      return this.retry('password', FORM_TEXT.mismatch, ['password', 'password2']);
    }
    if (!f.optional && v === '') return;
    this.message = '';
    if (this.at < this.fields.length - 1) { this.at += 1; return; }
    this.submit();
  }

  private submit(): void {
    const { bbsUser, hello } = this.info;
    const handle = this.values.handle.trim();
    const common = { bbs_user: bbsUser, handle, password: this.values.password, sysop: hello.sysop, client: hello.client };
    let reply: BoardAccountReply;
    try {
      if (this.mode === 'link') reply = this.info.link(common);
      else {
        const opt = (k: 'email' | 'realname' | 'location'): string | undefined => this.values[k].trim() || undefined;
        reply = this.info.register({ ...common, email: opt('email'), realname: opt('realname'), location: opt('location') });
      }
    } catch (err) {
      const { status, code } = err as { status?: number; code?: string };
      if (this.mode === 'link' && status === 401) return this.retry('password', FORM_TEXT.wrongPassword);
      if (status === 409 && code === 'email_taken') return this.retry('email', FORM_TEXT.emailTaken, ['email', 'password', 'password2']);
      if (status === 409) return this.retry('handle', FORM_TEXT.handleTaken, ['handle', 'password', 'password2']);
      if (status === 400 && this.mode === 'register') return this.retry('password', FORM_TEXT.badPassword, ['password', 'password2']);
      console.error(`[ERROR] partyline account form ${bbsUser}: ${(err as Error)?.message ?? String(err)}`);
      return this.retry('password', FORM_TEXT.failed, ['password', 'password2']);
    }
    this.values.password = '';
    this.values.password2 = '';
    this.info.done(reply);
  }

  render(): Buffer {
    const lines = ['', ` ${FORM_TEXT.title}`, ''];
    if (this.mode === 'choose') {
      const h = this.info.reply.prefill.handle;
      if (h) lines.push(this.info.reply.handle_free ? ` The handle ${h} is free.` : ` The handle ${h} is taken: link it if it is yours, or register another.`, '');
      lines.push(` ${FORM_TEXT.choose}`);
    } else {
      lines.push(this.mode === 'register' ? ' Register a new Partyline account (Esc goes back)' : ' Link an existing Partyline account (Esc goes back)', '');
      this.fields.forEach((f, i) => {
        if (i > this.at) return;
        const v = this.values[f.key];
        lines.push(` ${f.label}: ${f.masked ? '*'.repeat(v.length) : v}`);
      });
    }
    if (this.message) lines.push('', ` ${this.message}`);
    const out = `\x1b[H\x1b[2J${lines.join('\r\n')}`;
    // The cursor ends at the field being typed: two lines up when a message (blank line + text) follows it.
    const cursor = this.message && this.mode !== 'choose' ? `\x1b[2A\r\x1b[${this.fieldCol()}C` : '';
    return Buffer.from(out + cursor, 'latin1');
  }

  private fieldCol(): number {
    const f = this.fields[this.at];
    const v = this.values[f.key];
    return 1 + f.label.length + 2 + v.length;
  }
}
