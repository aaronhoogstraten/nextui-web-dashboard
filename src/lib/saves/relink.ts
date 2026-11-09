/**
 * The pure half of renaming a game: which save data moves where, and how text
 * files that list ROMs change. The device half is `$lib/roms/game-rename.ts`.
 */
import {
	stripRomExtension,
	type GameSaves,
	type RomKeyedFile,
	type SaveFile,
	type SlotDataFile
} from '$lib/saves/matching.js';
import { parentPath } from '$lib/utils.js';

export type AssetKind = 'rom' | 'art' | 'save' | 'state' | 'slot-data' | 'game-options' | 'cheat';

export interface PlannedMove {
	kind: AssetKind;
	from: string;
	to: string;
}

/**
 * The name a file takes for a ROM called `newFullName`, keeping its own pattern:
 * `Old.gba.st0` becomes `New.gba.st0`, `Old.state.1` becomes `New.state.1`.
 */
export function renamedFileName(file: RomKeyedFile, newFullName: string): string {
	const stem = file.stemIsFullName ? newFullName : stripRomExtension(newFullName);
	return stem + file.name.slice(file.stem.length);
}

export interface SaveDataMoves {
	moves: PlannedMove[];
	/** Files another ROM also uses, which keep their name */
	kept: (SaveFile | SlotDataFile)[];
	/** States and slot data that can't follow saves into another system */
	left: (SaveFile | SlotDataFile)[];
}

const isState = (file: SaveFile | SlotDataFile) => 'kind' in file && file.kind === 'state';

/**
 * Moves that give a game's save data the names NextUI looks for under
 * `newFullName`. With `savesDir`, saves also move to another system's folder;
 * states stay, since they only load in the emulator core that wrote them.
 */
export function planSaveDataMoves(
	game: GameSaves,
	newFullName: string,
	savesDir?: string
): SaveDataMoves {
	const moves: PlannedMove[] = [];
	const kept: (SaveFile | SlotDataFile)[] = [];
	const left: (SaveFile | SlotDataFile)[] = [];
	for (const file of game.files) {
		if (file.owners > 1) kept.push(file);
		else if (savesDir !== undefined && file.kind === 'state') left.push(file);
		else {
			const dir = savesDir ?? parentPath(file.path);
			moves.push({
				kind: file.kind === 'state' ? 'state' : 'save',
				from: file.path,
				to: `${dir}/${renamedFileName(file, newFullName)}`
			});
		}
	}
	// Slot data describes states, so a slot's files stay with a state that stays.
	// The rest is keyed by this ROM's full name alone, so it follows the rename.
	const keptSlots = new Set(kept.filter(isState).map((f) => (f as SaveFile).slot));
	for (const file of game.slotData) {
		if (savesDir !== undefined) {
			left.push(file);
		} else if (file.owners > 1 || (file.slot !== null && keptSlots.has(file.slot))) {
			// Matched to several ROMs by base name, or describing a shared state
			kept.push(file);
		} else {
			moves.push({
				kind: 'slot-data',
				from: file.path,
				to: `${parentPath(file.path)}/${renamedFileName(file, newFullName)}`
			});
		}
	}
	return { moves: moves.filter((m) => m.from !== m.to), kept, left };
}

/** The filename a map.txt line names, or null for a line without a tab. */
function keyOf(line: string): string | null {
	const tab = line.indexOf('\t');
	return tab < 0 ? null : line.slice(0, tab);
}

/**
 * Add an entry for `to` with the display name `from` has, keeping `from`, for a
 * map.txt that another ROM called `from` still reads. Returns null when `from`
 * isn't there or `to` already has an entry.
 */
export function copyMapKey(text: string, from: string, to: string): string | null {
	const lines = text.split('\n');
	const index = lines.findIndex((line) => keyOf(line) === from);
	if (index < 0 || lines.some((line) => keyOf(line) === to)) return null;
	lines.splice(index + 1, 0, to + lines[index].slice(from.length));
	return lines.join('\n');
}

/**
 * Rename a key in a map.txt (`<filename>\t<display name>` per line), keeping its
 * display name. Returns null when the key isn't there. A stale entry already
 * under the new name is dropped, since it would otherwise shadow the moved one.
 */
export function renameMapKey(text: string, from: string, to: string): string | null {
	const lines = text.split('\n');
	if (!lines.some((line) => keyOf(line) === from)) return null;
	return lines
		.filter((line) => keyOf(line) !== to)
		.map((line) => (keyOf(line) === from ? to + line.slice(from.length) : line))
		.join('\n');
}

/**
 * Replace a ROM path in a collection or recent.txt, where each line is a card
 * path, optionally followed by a tab and a display name. Returns null when the
 * path isn't listed. Line endings are kept as they are.
 */
export function renameListedPath(text: string, from: string, to: string): string | null {
	let changed = false;
	const lines = text.split('\n').map((line) => {
		const cr = line.endsWith('\r') ? '\r' : '';
		const body = cr ? line.slice(0, -1) : line;
		const tab = body.indexOf('\t');
		const path = tab < 0 ? body : body.slice(0, tab);
		if (path !== from) return line;
		changed = true;
		return to + body.slice(path.length) + cr;
	});
	return changed ? lines.join('\n') : null;
}
