/**
 * How NextUI ties save data to ROM filenames, mirroring minarch's ma_saves.c.
 *
 * The filename pattern depends on the saveFormat and stateFormat settings, and
 * changing those leaves the older files in place, so every pattern is recognised
 * rather than only the one currently configured:
 *
 *   Saves/<TAG>/<rom.ext>.sav     default
 *   Saves/<TAG>/<rom>.srm         or <rom>.sav; other extensions come from the core
 *   Saves/<TAG>/<rom.ext>.rtc
 *   .userdata/shared/<TAG>-<core>/<rom.ext>.st<N>       default
 *   .userdata/shared/<TAG>-<core>/<rom>.state[N]        or <rom>.state.<N|auto>
 *   .userdata/shared/.minui/<TAG>/<rom.ext>.<N>.bmp     slot preview
 *
 * This file has no dependencies so it can be tested against real card listings.
 */

export interface ListedFile {
	name: string;
	path: string;
	size: bigint;
	mtime: bigint;
}

/** A launchable game. `names` are the filenames NextUI may key its save data on. */
export interface ListedGame {
	title: string;
	path: string;
	names: string[];
}

export interface SystemListing {
	tag: string;
	name: string;
	games: ListedGame[];
	saves: ListedFile[];
	stateDirs: { core: string; files: ListedFile[] }[];
	/** Everything in `.userdata/shared/.minui/<TAG>/` */
	slotData: ListedFile[];
}

export type SaveKind = 'save' | 'rtc' | 'state';

/** The part of a filename that comes from the ROM, so a rename can swap it out. */
export interface RomKeyedFile extends ListedFile {
	stem: string;
	/** Whether the stem is the full `<rom.ext>`, rather than the extensionless `<rom>` */
	stemIsFullName: boolean;
}

export interface SaveFile extends RomKeyedFile {
	kind: SaveKind;
	/** State slot; null for anything else */
	slot: number | null;
	/** Emulator core that wrote a state */
	core: string | null;
	/** How many games this file could belong to; above 1 it can't be attributed */
	owners: number;
}

/**
 * The menu's record of a game's states: `<rom.ext>.txt` holds the last-used slot
 * (slot null here), `<rom.ext>.<N>.bmp` and `<rom.ext>.<N>.txt` describe slot N.
 */
export interface SlotDataFile extends RomKeyedFile {
	slot: number | null;
	/** How many games this file could belong to, as for SaveFile */
	owners: number;
}

export interface GameSaves {
	key: string;
	title: string;
	/** ROM filenames, empty when no ROM matches */
	romNames: string[];
	files: SaveFile[];
	slotData: SlotDataFile[];
	/** Slot preview images by state slot */
	previews: Map<number, ListedFile>;
}

export interface SystemSaves {
	tag: string;
	name: string;
	games: GameSaves[];
	/** Saves and states that match no ROM in this system */
	orphans: GameSaves[];
	/** Core-written data with no ROM filename in it, such as memory cards */
	other: ListedFile[];
}

const DEFAULT_RESUME_SLOT = 8;
const AUTO_RESUME_SLOT = 9;

/** Extensions minarch itself writes; anything else unmatched is left to its core. */
const FRONTEND_SAVE_EXTENSIONS = new Set(['.srm', '.sav', '.rtc']);

const STATE_NAME = /^(.+)\.(?:st(\d+)|state(\d*)|state\.(\d+|auto))$/;
const SLOT_FILE_NAME = /^(.+)\.(\d+)\.(?:bmp|txt)$/;

/** minarch's extension rule: a final dot followed by 2-4 characters. */
export function stripRomExtension(name: string): string {
	const dot = name.lastIndexOf('.');
	if (dot < 0) return name;
	const length = name.length - dot;
	return length > 2 && length <= 5 ? name.slice(0, dot) : name;
}

function extensionOf(name: string): string {
	const dot = name.lastIndexOf('.');
	return dot < 0 ? '' : name.slice(dot).toLowerCase();
}

/**
 * Name to group a full `<rom.ext>` under when its ROM is gone. Only used for
 * display and grouping, so a version suffix like `-v4.1.0GBA` is left alone.
 */
function orphanTitle(fullRomName: string): string {
	return /\.[a-z][a-z0-9]{1,3}$/i.test(fullRomName) ? stripRomExtension(fullRomName) : fullRomName;
}

export function parseStateName(
	name: string
): { stem: string; slot: number; fullRomName: boolean } | null {
	const match = STATE_NAME.exec(name);
	if (!match) return null;
	const [, stem, stSlot, stateSlot, dottedSlot] = match;
	if (stSlot !== undefined) return { stem, slot: Number(stSlot), fullRomName: true };
	if (dottedSlot !== undefined) {
		const slot = dottedSlot === 'auto' ? AUTO_RESUME_SLOT : Number(dottedSlot);
		return { stem, slot, fullRomName: false };
	}
	return { stem, slot: stateSlot ? Number(stateSlot) : 0, fullRomName: false };
}

export function slotLabel(slot: number): string {
	if (slot === DEFAULT_RESUME_SLOT) return 'Default';
	if (slot === AUTO_RESUME_SLOT) return 'Auto-resume';
	return `Slot ${slot + 1}`;
}

/** Split `<TAG>-<core>`. Tags may contain hyphens, so known tags are tried first. */
export function parseStateDirName(
	dirName: string,
	knownTags: Iterable<string>
): { tag: string; core: string } | null {
	let tag: string | undefined;
	for (const known of knownTags) {
		if (dirName.startsWith(`${known}-`) && (!tag || known.length > tag.length)) tag = known;
	}
	if (tag === undefined) {
		const hyphen = dirName.indexOf('-');
		if (hyphen <= 0) return null;
		tag = dirName.slice(0, hyphen);
	}
	const core = dirName.slice(tag.length + 1);
	return core ? { tag, core } : null;
}

function addTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
	const list = map.get(key);
	if (!list) map.set(key, [value]);
	else if (!list.includes(value)) list.push(value);
}

function compareFiles(a: SaveFile, b: SaveFile): number {
	const rank = { save: 0, rtc: 1, state: 2 };
	return (
		rank[a.kind] - rank[b.kind] ||
		(a.slot ?? 0) - (b.slot ?? 0) ||
		(a.core ?? '').localeCompare(b.core ?? '') ||
		a.name.localeCompare(b.name)
	);
}

const compareGames = (a: GameSaves, b: GameSaves) =>
	a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });

export function matchSystemSaves(listing: SystemListing): SystemSaves {
	// The card is vfat, where minarch opens `pokemon.gba.sav` for `Pokemon.gba`,
	// so names are compared ignoring case. Stems keep the file's own spelling.
	const byFullName = new Map<string, GameSaves[]>();
	const byBaseName = new Map<string, GameSaves[]>();
	const fullNameOwners = (name: string) => byFullName.get(name.toLowerCase());
	const baseNameOwners = (name: string) => byBaseName.get(name.toLowerCase());
	const games = listing.games.map((game): GameSaves => {
		const entry: GameSaves = {
			key: `rom:${game.path}`,
			title: game.title,
			romNames: game.names,
			files: [],
			slotData: [],
			previews: new Map()
		};
		for (const name of game.names) {
			addTo(byFullName, name.toLowerCase(), entry);
			addTo(byBaseName, stripRomExtension(name).toLowerCase(), entry);
		}
		return entry;
	});

	const orphans = new Map<string, GameSaves>();
	const other: ListedFile[] = [];

	function place(file: SaveFile, owners: GameSaves[] | undefined, title: string) {
		if (owners) {
			for (const owner of owners) owner.files.push({ ...file, owners: owners.length });
			return;
		}
		let orphan = orphans.get(title.toLowerCase());
		if (!orphan) {
			orphan = {
				key: `orphan:${listing.tag}/${title}`,
				title,
				romNames: [],
				files: [],
				slotData: [],
				previews: new Map()
			};
			orphans.set(title.toLowerCase(), orphan);
		}
		orphan.files.push(file);
	}

	for (const file of listing.saves) {
		const extension = extensionOf(file.name);
		const base = stripRomExtension(file.name);
		const hasFullName = extension === '.sav' || extension === '.rtc';
		const fullName = hasFullName ? file.name.slice(0, -extension.length) : undefined;
		const fullNameMatch = fullName !== undefined ? fullNameOwners(fullName) : undefined;
		const owners = fullNameMatch ?? baseNameOwners(base);
		if (!owners && !FRONTEND_SAVE_EXTENSIONS.has(extension)) {
			other.push(file);
			continue;
		}
		// With no ROM to go by, `<x>.zip.sav` reads as the default full-name
		// format and `<x>.sav` as the extensionless one
		const stemIsFullName =
			fullNameMatch !== undefined ||
			(!owners && fullName !== undefined && orphanTitle(fullName) !== fullName);
		const saveFile: SaveFile = {
			...file,
			kind: extension === '.rtc' ? 'rtc' : 'save',
			slot: null,
			core: null,
			owners: 1,
			stem: stemIsFullName ? fullName! : base,
			stemIsFullName
		};
		place(saveFile, owners, orphanTitle(fullName ?? base));
	}

	for (const dir of listing.stateDirs) {
		for (const file of dir.files) {
			const state = parseStateName(file.name);
			if (!state) continue;
			const owners = (state.fullRomName ? fullNameOwners : baseNameOwners)(state.stem);
			const stateFile: SaveFile = {
				...file,
				kind: 'state',
				slot: state.slot,
				core: dir.core,
				owners: 1,
				stem: state.stem,
				stemIsFullName: state.fullRomName
			};
			place(stateFile, owners, state.fullRomName ? orphanTitle(state.stem) : state.stem);
		}
	}

	for (const file of listing.slotData) {
		// `Foo.zip.0.txt` reads as slot 0 of `Foo.zip`, or as the last-slot file of
		// `Foo.zip.0`; whichever names a ROM wins
		const readings: { fullName: string; slot: number | null }[] = [];
		const slotMatch = SLOT_FILE_NAME.exec(file.name);
		if (slotMatch) readings.push({ fullName: slotMatch[1], slot: Number(slotMatch[2]) });
		if (file.name.endsWith('.txt')) readings.push({ fullName: file.name.slice(0, -4), slot: null });
		if (readings.length === 0) continue;
		const exact = readings.find((r) => fullNameOwners(r.fullName) !== undefined);
		const reading = exact ?? readings[0];
		// Base name as a fallback: after a .cue to .chd change the state still
		// matches, while its slot data keeps the old extension. Slot data alone
		// never creates an orphan entry, since there is nothing in it to keep.
		const owners =
			(exact ? fullNameOwners(exact.fullName) : undefined) ??
			baseNameOwners(stripRomExtension(reading.fullName)) ??
			[orphans.get(orphanTitle(reading.fullName).toLowerCase())].filter((o) => o !== undefined);
		for (const owner of owners) {
			owner.slotData.push({
				...file,
				slot: reading.slot,
				stem: reading.fullName,
				stemIsFullName: true,
				owners: owners.length
			});
			if (reading.slot !== null && file.name.endsWith('.bmp')) {
				owner.previews.set(reading.slot, file);
			}
		}
	}

	const finish = (list: GameSaves[]) => {
		const kept = list.filter((game) => game.files.length > 0).sort(compareGames);
		for (const game of kept) game.files.sort(compareFiles);
		return kept;
	};

	return {
		tag: listing.tag,
		name: listing.name,
		games: finish(games),
		orphans: finish([...orphans.values()]),
		other: other.sort((a, b) => a.name.localeCompare(b.name))
	};
}
