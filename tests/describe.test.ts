/**
 * The description classifier, tested against real archives' FILE_ID.DIZ.
 *
 * These are the same cases, with the same fixtures, as the prototype's
 * amiexpress-web:dev/scripts/door-index/test_description_rules.py. The two
 * implementations are one classifier - verified row for row over the whole
 * 3301-door corpus - and this file is half of what keeps them that way.
 * Every case here is a row the catalog's owner reported as reading wrong.
 */
import {
  analyseDoor,
  bestCell,
  buildGroupTags,
  bodyAddsNothing,
  clean,
  finalise,
  normaliseRequirement,
  toPlain,
} from '../src/describe';

// The corpus derives its group tags from the archive names; these are the
// prefixes the real catalog yields for the archives used below.
const TAGS = buildGroupTags(['MST-A.LHA', 'MST-B.LHA', 'MST-C.LHA', '5D-A.LHA', '5D-B.LHA', '5D-C.LHA']);

function read(
  diz: string | null,
  binaryName: string | null,
  name: string | null,
  archiveName: string,
  extra?: { version?: string | null; author?: string | null }
) {
  return analyseDoor(
    {
      dizText: diz,
      name,
      archiveName,
      binaryName,
      catalogVersion: extra?.version ?? null,
      catalogAuthor: extra?.author ?? null,
    },
    TAGS
  );
}

const JC40 = [
  '+[ MYSTiC /X-POWER ]-----[ JoinCnf 4.0 ]---+',
  '\u00a6_/\\___/\\___/\\___                          \u00a6',
  '|\\   /\\ __/_  __/ Added Features:          |',
  '|/ Y \\/_.\u00ac\\/  \\   o Totally NEW Lay-Out    |',
  '/  | \\\\\u00ac\u00a6 \\\\  \\\\  o Manages up to 256 Cnfs |',
  '\\__l_//___//__//                           \u00a6',
  '|dL!\\/   \\/  \\/    Try it and be AMAZED!!  |',
  '+-[ EMPiRE/MYSTiC ]----[ XIM - /X 3.38+ ]--+',
].join('\n');

const MT20 = [
  ' _/\\___/\u00a6___/\\___/\\___/\u00a6_/\\__.-------------.',
  ' \\   /\\ | /\\ __/\\ . /\\ |\\ . /| bObO/mYStiC |',
  ' / V \\/_. \\/_.\u00ac\\/_| \\/ |/ |_\\| ~~~~~~~~~~~ |',
  '/  |  \\\u00ac|  \\\u00ac\u00a6  \\\u00ac|  \\ |  \u00a6 \u00ac\\  PRESENTS:  |',
  '\\__\u00a6  /__  /__  / \u00a6__/_\u00a6___  /  ~~~~~~~~~  |',
  '.---\\/---\\/---\\/-/X-pOwEr!-\\/^-------------|',
  '|   MultiTop (Version 2.0)  [RELEASE 2]    |',
  '| The BEST Top Utility ever written for /X |',
  '|  Make your OWN DESIGN (16 designs incl)  |',
  '|        ! WORTH TAKING A LOOK AT !        |',
  "`------------------------------------------'",
].join('\n');

const KB13 = [
  '  __/\\  __________ _ ___  /\\__',
  '.-\\_  \\/  _/   __/______\\/___/-------------.',
  '| /   \\/   \\______  \\_  \\/  \\_   mYSTIC!   |',
  ':/     \\____/   _____/___    / /X dIVISION .',
  '/_______\\-\\_____/--sTZ--l___/--------------:',
  '| KiLLraVeN/MYSTiC BRiNGS: KiLLER-BAUD 1.3 |',
  "| *Creates bulls about users' baud-rates!* :",
  ': o Exclude baud-rates  o Nice lay-out     |',
  '| o Two pages of info!  o Future proof!    |',
  "`------------------------------------------'",
].join('\n');

const USR11 = [
  '      _______   _______           _______',
  '______\\     /__|      /___________\\___  /___',
  '\\_____ \\  _/   /     /__\\   ____/  _ /_/   /',
  '     5D-User V1.10 [-5th Dynasty-]',
  'Command to list all users of the bbs with',
  'many extra features like SEARCH NAME PART or',
].join('\n');

const WHO24 = [
  '|\\______/___/_|\\  /___\\  /_____/___|____/Rpd',
  "`---------------\\/-----\\/----\u00b7presents\u00b7----'",
  '                5D-Who v2.40',
  '   Coded by SvEN tHE CREAToR/5tH DyNASTY',
  '           Now working on /X 3.30',
].join('\n');

const AMN10 = [
  '  ________._____________________________.__',
  '|    5D-AdiMenu V1.0 by [tHE aDDiCT/5D!]   |',
  '| Handles Textfiles like Commands, so use  |',
  ':  it as Doormenu, Filemenu or whatever!   |',
].join('\n');

const CL0T0 = [
  '.------------[ CALL 13th HOUR ]------------.',
  '|                                          |',
  '| CALLERS LOTTERY v1.o (c) cYBER/iNDY 1995 |',
  '|                                          |',
  '| /X 3.x+ Give your users a Byte Bonus and |',
  '| File bonus when they call your cool BBS! |',
  '|   Totally configurable to your needs!    |',
  '|        Download/Leech/Suck NOW!          |',
  "`--------------------------------------[c]-'",
].join('\n');

const SNES = [
  '  \u00daÂÂÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÂÂ¿',
  '  ³Y³   ÓÄÄÙ Ð  Á ÐÄÄÙ ÓÄÄÙ   ³Y³',
  '  ³Y³ Tricks&PWs for 200 games³Y³',
  '  ÀÁÁÄÄÄÄÄ#10ÄÄSpooNManÄÄÄÄÄÄÄÁÁÙ',
].join('\n');

const BORDER_RUN = /[-_=~*/\\]{3,}/;
const DANGLING = /\[[^\]]*$|\([^)]*$/;

describe('a box row is read as cells, not as a sentence', () => {
  it('never lets a border run between two cells into the description', () => {
    const { description } = read(JC40, 'JoinCnf', 'JoinCnf', 'MST-JC40.LHA');
    expect(description).not.toMatch(BORDER_RUN);
  });

  it('does not read the neighbouring cell ("MYSTiC /X-POWER") as the door', () => {
    const { description } = read(JC40, 'JoinCnf', 'JoinCnf', 'MST-JC40.LHA');
    expect(description.toUpperCase()).not.toContain('POWER');
  });

  it('describes MST-JC40 by what the door does', () => {
    const { description } = read(JC40, 'JoinCnf', 'JoinCnf', 'MST-JC40.LHA');
    expect(description).toBe('Join Cnf - Totally NEW Lay-Out Manages up to 256 Cnfs');
  });

  it('keeps a single word trapped in border art out of the description', () => {
    // "/X-pOwEr!" is the only word on MT20's sixth line, and it is a border.
    const { description } = read(MT20, 'MultiTop', 'MultiTop', 'MST-MT20.LHA');
    expect(description.toLowerCase()).not.toContain('power');
  });
});

describe('metadata is not description', () => {
  it('leaves no "(Version )" scar when the version is pulled out', () => {
    const { description, version } = read(MT20, 'MultiTop', 'MultiTop', 'MST-MT20.LHA');
    expect(description).not.toContain('Version');
    expect(version).toBe('2.0');
  });

  it('drops "[RELEASE 2]" and never leaves a bracket hanging open', () => {
    const { description } = read(MT20, 'MultiTop', 'MultiTop', 'MST-MT20.LHA');
    expect(description.toUpperCase()).not.toContain('RELEASE');
    expect(description).not.toMatch(DANGLING);
  });

  it("keeps the door's real line instead", () => {
    const { description } = read(MT20, 'MultiTop', 'MultiTop', 'MST-MT20.LHA');
    expect(description).toBe('Multitop The BEST Top Utility ever written for /X');
  });

  it('caps on a word boundary, never mid-bracket', () => {
    expect(finalise('MultiTop [RELEASE 2]')).toBe('MultiTop');
  });

  it('leaves a balanced bracket alone', () => {
    expect(finalise('CD Axe (16 designs incl)')).toBe('CD Axe (16 designs incl)');
  });

  it('drops only the bracket when prose follows an unclosed one', () => {
    expect(finalise('Kickboxing (The Art Of Fighting')).toBe('Kickboxing The Art Of Fighting');
  });

  it('a version number alone adds nothing the door name does not', () => {
    expect(bodyAddsNothing('Join Cnf', 'JoinCnf 4.0')).toBe(true);
  });
});

describe('banners and credits', () => {
  it('splits "<handle> BRiNGS:" into author and description', () => {
    const { description, author } = read(KB13, 'KiLLER_Baud', 'KiLLER_Baud', 'MST-KB13.LHA');
    expect(description.toUpperCase()).not.toContain('BRINGS');
    expect(description).not.toContain('Killraven');
    expect(author).toBe('Killraven/Mystic');
    expect(description).toContain('Killer');
  });

  it('removes a credit tag without taking the prose after it', () => {
    const { description } = read(USR11, '5D-User', '5D-User', '5D-USR11.LHA');
    expect(description).not.toContain('Dynasty');
    expect(description).toContain('list all users');
  });

  it('leaves no dangling "by" once a credit tag is gone', () => {
    const { description } = read(AMN10, '5D-AdiMenu', '5D-AdiMenu', '5D_AMN10.LHA');
    expect(description).not.toMatch(/\bby$/i);
    expect(description).toContain('Handles Textfiles');
  });

  it('is not fooled by a compatibility note', () => {
    const { description } = read(WHO24, null, '5D-Who', '5D-WHO24.LZH');
    expect(description.toLowerCase()).not.toContain('working on');
    expect(description).toBe('Who');
  });
});

describe('/X is a name, not punctuation', () => {
  it('never strips the slash as decoration', () => {
    expect(clean('  /X dIVISION .')).toBe('/X dIVISION');
  });

  it('does not let a border run swallow it', () => {
    expect(bestCell('|-------- /X 3.xx door by DELTAFORCE |').text.startsWith('/X')).toBe(true);
  });
});

describe('CP437 box art is not a description', () => {
  it('keeps the words and drops the pillars', () => {
    const { description } = read(SNES, null, 'SnesDX', 'SNESDX10.LZH');
    expect(description).toContain('Tricks');
    expect(description).not.toMatch(/[\u00b3\u00c4\u00d3\u00da\u00c1]/);
  });

  it('treats a superscript digit as art, not as an alphanumeric', () => {
    expect(toPlain('\u00b3Y\u00b3 games')).toBe('Y games');
  });
});

describe('which BBS the door needs', () => {
  it('moves the requirement into its own field and leaves the description behind', () => {
    const { description, requiresBbs } = read(CL0T0, null, 'Callers Lottery', 'AECL0T0.LHA');
    expect(requiresBbs).toBe('/X 3.x+');
    expect(description).toContain('Byte Bonus');
    expect(description).not.toContain('/X 3.x');
  });

  it('finds a requirement stamped in the box border', () => {
    const { requiresBbs } = read(JC40, 'JoinCnf', 'JoinCnf', 'MST-JC40.LHA');
    expect(requiresBbs).toBe('/X 3.38+');
  });

  it('normalises the BBS name and the wildcard case', () => {
    expect(normaliseRequirement('AE', '3,30')).toBe('/X 3.30');
    expect(normaliseRequirement('AmiExpress', '4.X')).toBe('AmiExpress 4.x');
  });
});

describe('falling back', () => {
  it('uses the catalog name when every DIZ line is art', () => {
    const diz = '______    ________.  /\\    ______.__________\n____ _____________';
    expect(read(diz, null, 'Account Editor', 'ACC-V103.LHA').description).toBe('Account Editor');
  });

  it('uses the archive base name when the DIZ and the name are both art', () => {
    const diz = '______    ________.  /\\    ______.__________';
    const name = '____ _________________________________ _  :····/ __';
    expect(read(diz, null, name, 'ACC-V103.LHA').description).toBe('Acc-V103');
  });

  it('uses the archive base name when there is no DIZ at all', () => {
    expect(read(null, null, null, 'ACC-V103.LHA').description).toBe('Acc-V103');
  });

  it('rejects a repeated-character placeholder (the real AE_DOORS.LHA)', () => {
    expect(read('XXXX....', null, 'XXXX....', 'AE_DOORS.LHA').description).toBe('Ae_Doors');
  });

  it('prefixes the program name when the line does not already carry it', () => {
    const diz = 'Split Chat Door For /X +4.x, S!X and FAME';
    expect(read(diz, 'FullChat', null, 'FULLCHAT.LHA').description).toBe(
      'Full Chat - Split Chat Door For /X +4.x, S!X and FAME'
    );
  });

  it('does not name the door twice', () => {
    expect(read('Snes-Tool v1.10', 'Snes-Tool', null, 'SNES.LHA').description).toBe('Snes-Tool');
  });

  it('skips a copyright line in favour of a later one', () => {
    const diz = 'hAUSfRAU!.exe - © FLi7e/SAD 1996\nHousewife simulator for AmiExpress';
    expect(read(diz, null, null, 'HAUSFRAU.LHA').description).toBe('Housewife simulator for Amiexpress');
  });

  it('keeps accented letters: they are letters, not decoration', () => {
    expect(read('Größe der Datei anzeigen', null, null, 'X.LHA').description).toBe('Größe der Datei anzeigen');
  });

  it('strips control characters and collapses whitespace', () => {
    expect(read('Account   Editor\tv1.0\x01\x02 for real', null, null, 'ACC-V103.LHA').description).toBe(
      'Account Editor for real'
    );
  });

  it('never returns more than 60 characters', () => {
    const long = 'Account Editor supports every field of the AmiExpress config file format';
    expect(read(long, null, null, 'ACC-V103.LHA').description.length).toBeLessThanOrEqual(60);
  });
});
