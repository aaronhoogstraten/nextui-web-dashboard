/**
 * Renaming a game and everything keyed to its filename, in two steps: plan reads
 * the device and writes nothing, so the user can see exactly what will happen;
 * apply carries it out. See docs/rom-rename-and-replace-plan.md.
 */
import type { Adb } from '@yume-chan/adb';
import { DEVICE_PATHS } from '$lib/adb/types.js';
import {
	isCaseOnlyRename,
	isVisibleDirectory,
	listDirectory,
	movePath,
	movePathViaTemp,
	pathExists,
	pullFile,
	pushFile,
	shell
} from '$lib/adb/file-ops.js';
import { ShellCmd } from '$lib/adb/adb-utils.js';
import { getRomBaseName, getRomSystem, isRomEntry } from '$lib/roms/definitions.js';
import { listRomSystemFolders, scanSystemSaves, type RomSystemFolder } from '$lib/saves/scan.js';
import {
	stripRomExtension,
	type GameSaves,
	type SaveFile,
	type SlotDataFile
} from '$lib/saves/matching.js';
import {
	copyMapKey,
	planSaveDataMoves,
	renameListedPath,
	renameMapKey,
	type PlannedMove
} from '$lib/saves/relink.js';
import { fileName, formatError, parentPath } from '$lib/utils.js';

/** A text file that lists ROMs, with the content it will be rewritten to. */
export interface RefEdit {
	path: string;
	label: string;
	content: string;
}

export interface RenamePlan {
	moves: PlannedMove[];
	refEdits: RefEdit[];
	/** Shared with another ROM, so left under the old name */
	kept: (SaveFile | SlotDataFile)[];
	/** States and slot data that stay behind when saves move to another system */
	left: number;
	/** Destinations already taken; the plan must not be applied while there are any */
	conflicts: string[];
}

export interface RenameResult {
	moved: number;
	refsUpdated: number;
	failures: { path: string; error: string }[];
}

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Whether any of `otherNames` reduces to the same name as `oldName` under `reduce`. */
function nameShared(otherNames: string[], oldName: string, reduce: (name: string) => string) {
	const key = reduce(oldName);
	return otherNames.some((n) => sameName(reduce(n), key));
}

/**
 * Folders that are one system under different emulators, such as GBA and MGBA,
 * matched as RomsView's getSiblingStates matches them.
 */
function siblingKey(folder: RomSystemFolder): string {
	const system = getRomSystem(folder.tag);
	return system ? (system.romPathSystemName ?? system.systemName) : folder.name;
}

async function listRomNames(adb: Adb, folderPath: string): Promise<string[]> {
	return (await listDirectory(adb, folderPath))
		.filter((e) => e.isFile && isRomEntry(e))
		.map((e) => e.name);
}

async function readText(adb: Adb, path: string): Promise<string | null> {
	if (!(await pathExists(adb, path))) return null;
	return new TextDecoder().decode(await pullFile(adb, path));
}

async function findConflicts(adb: Adb, moves: PlannedMove[]): Promise<string[]> {
	// A path can fail both checks, and the dialog keys its list by path
	const conflicts = new Set<string>();
	const seen = new Set<string>();
	for (const move of moves) {
		// vfat ignores case, so two moves to differently cased names still collide
		const key = move.to.toLowerCase();
		if (seen.has(key)) conflicts.add(move.to);
		seen.add(key);
		if (isCaseOnlyRename(move.from, move.to)) continue;
		if (await pathExists(adb, move.to)) conflicts.add(move.to);
	}
	return [...conflicts];
}

/** The part after `<rom.ext>` in a per-game options file: `.cfg` or `-<device>.cfg`. */
const OPTIONS_SUFFIX = /^(?:-[^.]+)?\.cfg$/;

/** Per-game emulator options, one folder per platform: `<rom.ext>[-<device>].cfg`. */
async function planOptionMoves(
	adb: Adb,
	tag: string,
	oldName: string,
	newName: string
): Promise<PlannedMove[]> {
	if (!(await pathExists(adb, DEVICE_PATHS.userdata))) return [];
	const moves: PlannedMove[] = [];
	const platforms = (await listDirectory(adb, DEVICE_PATHS.userdata)).filter(
		(d) => isVisibleDirectory(d) && d.name !== 'shared' && d.name !== 'logs'
	);
	for (const platform of platforms) {
		const platformPath = `${DEVICE_PATHS.userdata}/${platform.name}`;
		const coreDirs = (await listDirectory(adb, platformPath)).filter(
			(d) => d.isDirectory && d.name.startsWith(`${tag}-`)
		);
		for (const coreDir of coreDirs) {
			const dirPath = `${platformPath}/${coreDir.name}`;
			for (const file of await listDirectory(adb, dirPath)) {
				// A device tag has no dot, so `Foo.gba-hack.gba.cfg` belongs to another ROM
				const isGameConfig =
					file.isFile &&
					file.name.startsWith(oldName) &&
					OPTIONS_SUFFIX.test(file.name.slice(oldName.length));
				if (!isGameConfig) continue;
				moves.push({
					kind: 'game-options',
					from: `${dirPath}/${file.name}`,
					to: `${dirPath}/${newName}${file.name.slice(oldName.length)}`
				});
			}
		}
	}
	return moves;
}

/**
 * minarch looks for `<rom.ext>.cht` and `<rom>.cht`, among others, in one folder
 * per tag. Either stays put while another ROM with that tag, in any folder,
 * still uses the name.
 */
async function planCheatMoves(
	adb: Adb,
	tag: string,
	oldName: string,
	newName: string,
	otherTagRomNames: string[]
): Promise<PlannedMove[]> {
	const dir = `${DEVICE_PATHS.cheats}/${tag}`;
	if (!(await pathExists(adb, dir))) return [];
	const oldBase = stripRomExtension(oldName);
	const moves: PlannedMove[] = [];
	for (const file of await listDirectory(adb, dir)) {
		if (!file.isFile) continue;
		const from = `${dir}/${file.name}`;
		if (file.name === `${oldName}.cht`) {
			if (!nameShared(otherTagRomNames, oldName, (n) => n)) {
				moves.push({ kind: 'cheat', from, to: `${dir}/${newName}.cht` });
			}
		} else if (file.name === `${oldBase}.cht`) {
			if (!nameShared(otherTagRomNames, oldName, stripRomExtension)) {
				moves.push({ kind: 'cheat', from, to: `${dir}/${stripRomExtension(newName)}.cht` });
			}
		}
	}
	return moves;
}

/**
 * The display name entry for `oldName` in a map.txt that other ROMs also read:
 * moved to `newName`, or copied when one of them still has a ROM called
 * `oldName`. A map that already names a `newName` of its own is left alone.
 */
function editSharedMap(
	text: string,
	oldName: string,
	newName: string,
	otherNames: string[]
): string | null {
	if (otherNames.some((n) => sameName(n, newName))) return null;
	if (otherNames.some((n) => sameName(n, oldName))) return copyMapKey(text, oldName, newName);
	return renameMapKey(text, oldName, newName);
}

/** map.txt in the ROM's folder and its sibling folders, Collections, and Recents. */
async function planRefEdits(
	adb: Adb,
	romDir: string,
	oldName: string,
	newName: string,
	siblingRomNames: Map<RomSystemFolder, string[]>,
	otherRomNames: string[]
): Promise<RefEdit[]> {
	const edits: RefEdit[] = [];
	const add = (path: string, label: string, content: string | null) => {
		if (content !== null) edits.push({ path, label, content });
	};
	const romDirName = fileName(romDir);

	const ownMap = await readText(adb, `${romDir}/map.txt`);
	if (ownMap !== null) {
		add(
			`${romDir}/map.txt`,
			`Display names in ${romDirName}`,
			renameMapKey(ownMap, oldName, newName)
		);
	}
	// Sibling folders keep matching map.txt files; see RomsView's syncMapTxtToSiblings
	for (const [sibling, names] of siblingRomNames) {
		const path = `${sibling.path}/map.txt`;
		const text = await readText(adb, path);
		if (text !== null) {
			add(
				path,
				`Display names in ${sibling.dirName}`,
				editSharedMap(text, oldName, newName, names)
			);
		}
	}

	const romPath = `/Roms/${romDirName}/${oldName}`;
	const newRomPath = `/Roms/${romDirName}/${newName}`;
	if (await pathExists(adb, DEVICE_PATHS.collections)) {
		for (const file of await listDirectory(adb, DEVICE_PATHS.collections)) {
			if (!file.isFile || file.name.startsWith('.')) continue;
			const path = `${DEVICE_PATHS.collections}/${file.name}`;
			const text = file.name.endsWith('.txt') ? await readText(adb, path) : null;
			if (text === null) continue;
			if (file.name === 'map.txt') {
				// Display names inside collections, keyed by bare filename
				const content = editSharedMap(text, oldName, newName, otherRomNames);
				add(path, 'Collection display names', content);
			} else {
				const label = `Collection "${file.name.slice(0, -4)}"`;
				add(path, label, renameListedPath(text, romPath, newRomPath));
			}
		}
	}

	const recentPath = `${DEVICE_PATHS.sharedUserdata}/.minui/recent.txt`;
	const recent = await readText(adb, recentPath);
	if (recent !== null) {
		add(recentPath, 'Recently played', renameListedPath(recent, romPath, newRomPath));
	}
	return edits;
}

/** Plan renaming the ROM file `oldName` in `romDir`, carrying everything keyed to it. */
export async function planRomRename(
	adb: Adb,
	romDir: string,
	oldName: string,
	newName: string
): Promise<RenamePlan> {
	const folders = await listRomSystemFolders(adb);
	const folder = folders.find((f) => f.path === romDir);
	if (!folder) throw new Error(`${fileName(romDir)} is not a system folder`);
	const tag = folder.tag;

	const romEntries = await listDirectory(adb, romDir);
	const rom = romEntries.find((e) => e.name === oldName);
	if (!rom) throw new Error(`${oldName} is no longer on the device`);
	if (rom.isDirectory) {
		throw new Error('Game folders, such as multi-disc games, cannot be renamed yet');
	}
	const romPath = `${romDir}/${oldName}`;
	const folderRomNames = romEntries
		.filter((e) => e.isFile && isRomEntry(e) && e.name !== oldName)
		.map((e) => e.name);

	// Other folders whose map.txt or cheats this ROM's name can reach
	const siblingRomNames = new Map<RomSystemFolder, string[]>();
	const sameTagRomNames: string[] = [];
	for (const other of folders) {
		if (other === folder) continue;
		const isSibling = siblingKey(other) === siblingKey(folder);
		if (!isSibling && other.tag !== tag) continue;
		const names = await listRomNames(adb, other.path);
		if (isSibling) siblingRomNames.set(other, names);
		if (other.tag === tag) sameTagRomNames.push(...names);
	}
	const otherRomNames = [...folderRomNames, ...[...siblingRomNames.values()].flat()];

	const moves: PlannedMove[] = [{ kind: 'rom', from: romPath, to: `${romDir}/${newName}` }];

	// `Foo.gba` and `Foo.zip` both show `Foo.png`, so shared art stays put
	const artFrom = `${romDir}/.media/${getRomBaseName(oldName)}.png`;
	if (!nameShared(folderRomNames, oldName, getRomBaseName) && (await pathExists(adb, artFrom))) {
		const artTo = `${romDir}/.media/${getRomBaseName(newName)}.png`;
		moves.push({ kind: 'art', from: artFrom, to: artTo });
	}

	let kept: RenamePlan['kept'] = [];
	const game = (await scanSystemSaves(adb, tag))?.games.find((g) => g.key === `rom:${romPath}`);
	if (game) {
		const saveData = planSaveDataMoves(game, newName);
		moves.push(...saveData.moves);
		kept = saveData.kept;
	}

	moves.push(...(await planOptionMoves(adb, tag, oldName, newName)));
	const cheatSharers = [...folderRomNames, ...sameTagRomNames];
	moves.push(...(await planCheatMoves(adb, tag, oldName, newName, cheatSharers)));

	const finalMoves = moves.filter((m) => m.from !== m.to);
	return {
		moves: finalMoves,
		refEdits: await planRefEdits(adb, romDir, oldName, newName, siblingRomNames, otherRomNames),
		kept,
		left: 0,
		conflicts: await findConflicts(adb, finalMoves)
	};
}

/**
 * Plan giving saves that match no ROM the names `target` looks for. A target in
 * another system takes the saves only: states stay with the core that wrote them.
 */
export async function planSaveLink(
	adb: Adb,
	orphan: GameSaves,
	sourceTag: string,
	target: { tag: string; fullName: string }
): Promise<RenamePlan> {
	const savesDir = target.tag === sourceTag ? undefined : `${DEVICE_PATHS.saves}/${target.tag}`;
	const saveData = planSaveDataMoves(orphan, target.fullName, savesDir);
	return {
		moves: saveData.moves,
		refEdits: [],
		kept: saveData.kept,
		left: saveData.left.length,
		conflicts: await findConflicts(adb, saveData.moves)
	};
}

/**
 * Carry out a plan. Destinations are checked again first, since `mv -f` would
 * overwrite anything written there while the preview was open. The ROM moves
 * next, and a failure there stops everything, as nothing else has changed yet.
 * Files move before references are rewritten: a reference left pointing at the
 * old name is visible and easy to fix, while one pointing at a file that never
 * moved is not.
 */
export async function applyRenamePlan(adb: Adb, plan: RenamePlan): Promise<RenameResult> {
	const conflicts = await findConflicts(adb, plan.moves);
	if (conflicts.length > 0) {
		throw new Error(
			`${conflicts.map(fileName).join(', ')} appeared since the preview, so nothing was changed`
		);
	}
	const failures: RenameResult['failures'] = [];
	let moved = 0;
	for (const move of plan.moves) {
		try {
			if (parentPath(move.to) !== parentPath(move.from)) {
				await shell(adb, ShellCmd.mkdir(parentPath(move.to)).toString());
			}
			if (isCaseOnlyRename(move.from, move.to)) await movePathViaTemp(adb, move.from, move.to);
			else await movePath(adb, move.from, move.to);
			moved++;
		} catch (e) {
			if (move.kind === 'rom') throw e;
			failures.push({ path: move.from, error: formatError(e) });
		}
	}
	let refsUpdated = 0;
	for (const edit of plan.refEdits) {
		try {
			await pushFile(adb, edit.path, new TextEncoder().encode(edit.content));
			refsUpdated++;
		} catch (e) {
			failures.push({ path: edit.path, error: formatError(e) });
		}
	}
	return { moved, refsUpdated, failures };
}
