/**
 * Inferring which Amiga BBS door-software a demozoo.org production targets,
 * from the production's own tags and release-group name — independent of
 * whatever the door's own FILE_ID.DIZ says (or fails to say). Shared between
 * scripts/demozoo-import.ts (fresh imports) and any later backfill pass
 * over already-catalogued rows that only ever got a demozoo_url attached,
 * never this inference.
 *
 * Source for the tag list: https://demozoo.org/pages/bbs-related-tags/
 * (curated by Demozoo — covers all known scene-BBS software).
 */

export const BBS_TAGS: { tag: string; implies: string }[] = [
  // ── Amiga BBS software ──────────────────────────────────────────────────
  { tag: 'amiex',         implies: 'AmiExpress' },        // 50+ productions
  { tag: 'ami-express-web',implies: 'AmiExpress-Web' },   // new web port
  { tag: 'amiex-web',     implies: 'AmiExpress-Web' },   // alt slug
  { tag: 's!x',           implies: 'System-X' },          // predecessor
  { tag: 'maxs',          implies: 'Maxs' },              // predecessor of S!X
  { tag: 'daydream-amiga',implies: 'DayDream' },          // 50+
  { tag: 'fame',          implies: 'FAME' },              // 47
  { tag: 'cnet-bbs',      implies: 'CNet' },              // 41
  { tag: 'mystic-bbs',    implies: 'Mystic' },            // 50+
  { tag: 'tempest-bbs',   implies: 'Tempest' },
  { tag: 'descent',       implies: 'Descent' },
  { tag: 'lame',          implies: 'Lame' },
  { tag: 'obbs',          implies: 'OBBS' },
  { tag: 's!x-bbs',       implies: 'System-X' },          // alt slug
  { tag: 'aquila-bbs-ripoff', implies: 'Aquila' },
  { tag: 'celerity-bbs',  implies: 'Celerity' },
  { tag: 'hysteria-bbs',  implies: 'Hysteria' },
  { tag: 'illusion-bbs',  implies: 'Illusion' },
  { tag: 'impulse-bbs',   implies: 'Impulse' },
  { tag: 'insanity-bbs',  implies: 'Insanity' },
  { tag: 'major-bbs',     implies: 'Major' },
  { tag: 'metro-bbs',     implies: 'Metro' },
  { tag: 'monarch-bbs',   implies: 'Monarch' },
  { tag: 'narcosys-bbs',  implies: 'Narcosys' },
  { tag: 'oblivion2',     implies: 'Oblivion' },
  { tag: 'opus-bbs',      implies: 'Opus' },
  { tag: 'original-bbs',  implies: 'Original' },
  { tag: 'paragon-bbs',   implies: 'Paragon' },
  { tag: 'pipeline-bbs',  implies: 'Pipeline' },
  { tag: 'revelation-bbs',implies: 'Revelation' },
  { tag: 'sentinel-bbs',  implies: 'Sentinel' },
  { tag: 'skylight-bbs-ripoff', implies: 'Skylight' },
  { tag: 'solarium-bbs-ripoff', implies: 'Solarium' },
  { tag: 'squid-bbs-ripoff', implies: 'Squid' },
  { tag: 'starport2-ripoff', implies: 'Starport' },
  { tag: 'vision-x',      implies: 'Vision-X' },
  { tag: 'vision2',      implies: 'Vision 2' },
  { tag: 'waffle-bbs',    implies: 'Waffle' },
  { tag: 'warning-bbs-ripoff', implies: 'Warning' },

  // ── PC BBS software (disabled — uncomment to enable) ──────────────────
  // { tag: 'pcboard',         implies: 'PCBoard' },
  // { tag: 'qbbs',            implies: 'QBBS' },
  // { tag: 'wildcat',         implies: 'WildCat' },
  // { tag: 'wwiv',            implies: 'WWIV' },
  // { tag: 'renegade-bbs',    implies: 'Renegade' },
  // { tag: 'remoteaccess',    implies: 'RemoteAccess' },
  // { tag: 'telegard',        implies: 'Telegard' },
  // { tag: 'synchronet',      implies: 'Synchronet' },
  // { tag: 'elebbs',          implies: 'EleBBS' },
  // { tag: 'flash-bbs',       implies: 'Flash' },
  // { tag: 'genesis-deluxe',  implies: 'Genesis' },
  // { tag: 'iniquity',        implies: 'Iniquity' },
  // { tag: 'proboard',        implies: 'ProBoard' },
  // { tag: 'smbx',            implies: 'SMBX' },
  // { tag: 'superbbs',        implies: 'SuperBBS' },
  // { tag: 'tbbs',            implies: 'TBBS' },
];

/**
 * Best-effort `door_type` from demozoo's tags. The "xim" tag means the
 * archive contains an Amiga executable; "arexx" means it's an ARexx
 * script; "cli" is a CLI command. Returns null if no signal.
 */
const DOOR_TYPE_FROM_TAG: { match: RegExp; doorType: string }[] = [
  { match: /^xim$/i,    doorType: 'XIM' },
  { match: /^arexx$/i,  doorType: 'ARexx' },
  { match: /^cli$/i,    doorType: 'CLI' },
  { match: /^sim$/i,    doorType: 'SIM' },
  { match: /^rexx$/i,   doorType: 'REXX' },
  { match: /^cmd$/i,    doorType: 'CMD' },
];
export function inferDoorType(tags: string[]): string | null {
  for (const tag of tags) {
    for (const { match, doorType } of DOOR_TYPE_FROM_TAG) {
      if (match.test(tag)) return doorType;
    }
  }
  return null;
}

// Group-name signal: most release crews only release for one BBS. This map
// covers all the well-known Amiga BBS scene groups.
const GROUP_TO_BBS: { match: RegExp; bbs: string }[] = [
  { match: /up rough|amiexpress|\/x innovation/, bbs: 'AmiExpress' },
  { match: /ami-?express-?web|amiexweb/,         bbs: 'AmiExpress-Web' },
  { match: /quantum|hoodlum|tcs/,             bbs: 'System-X' },
  { match: /daydream/,                         bbs: 'DayDream' },
  { match: /^fame$|fame.*design/,              bbs: 'FAME' },
  { match: /demonic|phenom/,                  bbs: 'Mystic' },
  { match: /medellin|phenom productions/,     bbs: 'CNet' },
  { match: /sceptic|^scp$|sad-file/,           bbs: 'AmiExpress' }, // Sceptic/SAD = textadder crew
  { match: /shelter/,                          bbs: 'AmiExpress' }, // SLT! = Shelter, AmiExpress ad-tools
  { match: /outlaws|otl/,                     bbs: 'AmiExpress' }, // OTL = Outlaws, AmiExpress ad-tools
  { match: /decade|dcd/,                       bbs: 'AmiExpress' }, // Decade = AmiExpress ad-tools
  { match: /delta|logic|expose/,              bbs: 'Aquila' },
  { match: /insanity/,                         bbs: 'Insanity' },
];

export interface DemozooAuthorNick {
  abbreviation: string;
  releaser: { name: string; is_group: boolean };
}

/**
 * A demozoo production's `author_nicks` lists everyone who contributed. The
 * first one flagged `is_group` with a real abbreviation is the release
 * group's abbreviation/full-name pair for `door_catalog.release_group` and
 * `release_groups.full_name`. Returns null if no nick is both a group and
 * carries an abbreviation (demozoo itself sometimes leaves the abbreviation
 * blank even for a real group, and a solo releaser has none to find).
 */
export function extractReleaseGroup(authorNicks: DemozooAuthorNick[] | undefined): { abbrev: string; fullName: string } | null {
  for (const nick of authorNicks ?? []) {
    if (nick.releaser?.is_group && nick.abbreviation) {
      return { abbrev: nick.abbreviation, fullName: nick.releaser.name };
    }
  }
  return null;
}

/**
 * Best-effort `requires_bbs` for a production, based on its release-group
 * name and tags. Tries the group-name match first, then falls back to the
 * known tag->BBS mapping. Returns null if no signal.
 */
export function inferRequiresBbs(tags: string[], groupName: string): string | null {
  const lcGroup = groupName.toLowerCase();
  for (const { match, bbs } of GROUP_TO_BBS) {
    if (match.test(lcGroup)) return bbs;
  }
  // Tag-based signal. Many ami-express-* tags imply AmiExpress even
  // when the group isn't in the map above.
  for (const tag of tags) {
    if (/^amiex(?!-web)/i.test(tag)) return 'AmiExpress';
    if (/^amiex-?web/i.test(tag)) return 'AmiExpress-Web';
    if (/^s!x/i.test(tag)) return 'System-X';
    if (/^daydream/i.test(tag)) return 'DayDream';
    if (/^fame/i.test(tag)) return 'FAME';
    if (/^mystic/i.test(tag)) return 'Mystic';
    if (/^cnet/i.test(tag)) return 'CNet';
    if (/^tempest/i.test(tag)) return 'Tempest';
  }
  // Tag fallback: check if any tag matches the known BBS_TAGS list.
  for (const { tag, implies } of BBS_TAGS) {
    if (tags.includes(tag)) return implies;
  }
  return null;
}
