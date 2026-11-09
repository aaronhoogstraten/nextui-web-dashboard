import type { Adb } from '@yume-chan/adb';
import { DEVICE_PATHS, type DirectoryEntry } from '$lib/adb/types.js';
import { isVisibleDirectory, listDirectory, pathExists } from '$lib/adb/file-ops.js';
import { getRomSystem, isRomEntry, parseRomDirectoryName } from '$lib/roms/definitions.js';
import {
	matchSystemSaves,
	parseStateDirName,
	parseStateName,
	stripRomExtension,
	type ListedFile,
	type ListedGame,
	type SystemListing,
	type SystemSaves
} from '$lib/saves/matching.js';

function toListedFiles(entries: DirectoryEntry[], dirPath: string): ListedFile[] {
	return entries
		.filter((e) => e.isFile && !e.name.startsWith('.'))
		.map((e) => ({ name: e.name, path: `${dirPath}/${e.name}`, size: e.size, mtime: e.mtime }));
}

/** A folder under Roms, e.g. `Game Boy Advance (GBA)`. One tag can have several. */
export interface RomSystemFolder {
	tag: string;
	name: string;
	dirName: string;
	path: string;
}

export async function listRomSystemFolders(adb: Adb): Promise<RomSystemFolder[]> {
	return (await listDirectory(adb, DEVICE_PATHS.roms)).filter(isVisibleDirectory).flatMap((dir) => {
		const parsed = parseRomDirectoryName(dir.name);
		if (!parsed) return [];
		return [
			{
				tag: parsed.systemCode,
				name: parsed.systemName.replace(/^\d+\)\s*/, ''),
				dirName: dir.name,
				path: `${DEVICE_PATHS.roms}/${dir.name}`
			}
		];
	});
}

/** A game folder is keyed on its .m3u when it has one, otherwise on the files inside. */
async function listFolderGame(adb: Adb, folderPath: string, folder: string): Promise<ListedGame> {
	const entries = (await listDirectory(adb, folderPath)).filter((e) => e.isFile && isRomEntry(e));
	const m3u = `${folder}.m3u`;
	return {
		title: folder,
		path: folderPath,
		names: entries.some((e) => e.name === m3u) ? [m3u] : entries.map((e) => e.name)
	};
}

/** The games in one system folder, with the filenames NextUI keys their saves on. */
export async function listFolderGames(adb: Adb, folderPath: string): Promise<ListedGame[]> {
	const games: ListedGame[] = [];
	for (const entry of (await listDirectory(adb, folderPath)).filter(isRomEntry)) {
		const path = `${folderPath}/${entry.name}`;
		games.push(
			entry.isDirectory
				? await listFolderGame(adb, path, entry.name)
				: { title: stripRomExtension(entry.name), path, names: [entry.name] }
		);
	}
	return games;
}

/** Read save-related listings for every system, or only `onlyTag`. */
async function collectListings(adb: Adb, onlyTag?: string): Promise<SystemListing[]> {
	const wanted = (tag: string) => onlyTag === undefined || tag === onlyTag;
	const listings = new Map<string, SystemListing>();
	// Every tag on the card, even when scanning one, to split `<TAG>-<core>` names
	const knownTags = new Set<string>();
	const listingFor = (tag: string, name?: string): SystemListing => {
		let listing = listings.get(tag);
		if (!listing) {
			listing = {
				tag,
				name: name ?? getRomSystem(tag)?.systemName ?? tag,
				games: [],
				saves: [],
				stateDirs: [],
				slotData: []
			};
			listings.set(tag, listing);
		}
		return listing;
	};

	const romFolders = await listRomSystemFolders(adb);
	for (const folder of romFolders) {
		knownTags.add(folder.tag);
		// Created now so the system takes its name from its ROM folder
		if (wanted(folder.tag)) listingFor(folder.tag, folder.name);
	}

	if (await pathExists(adb, DEVICE_PATHS.saves)) {
		for (const dir of (await listDirectory(adb, DEVICE_PATHS.saves)).filter(isVisibleDirectory)) {
			knownTags.add(dir.name);
			if (!wanted(dir.name)) continue;
			const dirPath = `${DEVICE_PATHS.saves}/${dir.name}`;
			listingFor(dir.name).saves = toListedFiles(await listDirectory(adb, dirPath), dirPath);
		}
	}

	if (await pathExists(adb, DEVICE_PATHS.sharedUserdata)) {
		const shared = (await listDirectory(adb, DEVICE_PATHS.sharedUserdata)).filter(
			isVisibleDirectory
		);
		for (const dir of shared) {
			// Apps also keep folders here, so only real state files make it a system
			const parsed = parseStateDirName(dir.name, knownTags);
			if (!parsed || !wanted(parsed.tag)) continue;
			const dirPath = `${DEVICE_PATHS.sharedUserdata}/${dir.name}`;
			const files = toListedFiles(await listDirectory(adb, dirPath), dirPath).filter(
				(f) => parseStateName(f.name) !== null
			);
			if (files.length > 0) listingFor(parsed.tag).stateDirs.push({ core: parsed.core, files });
		}
	}

	const hasSaveData = (listing: SystemListing | undefined): listing is SystemListing =>
		listing !== undefined && (listing.saves.length > 0 || listing.stateDirs.length > 0);

	const slotDataPath = `${DEVICE_PATHS.sharedUserdata}/.minui`;
	if (await pathExists(adb, slotDataPath)) {
		for (const dir of (await listDirectory(adb, slotDataPath)).filter(isVisibleDirectory)) {
			const listing = listings.get(dir.name);
			if (!hasSaveData(listing)) continue;
			const dirPath = `${slotDataPath}/${dir.name}`;
			listing.slotData = toListedFiles(await listDirectory(adb, dirPath), dirPath);
		}
	}

	// Games last, and only for systems with something to match: listing every
	// ROM and game folder costs one ADB round trip each
	for (const folder of romFolders) {
		const listing = listings.get(folder.tag);
		if (hasSaveData(listing)) listing.games.push(...(await listFolderGames(adb, folder.path)));
	}

	return [...listings.values()];
}

/** Read everything save-related from the device and match it to the ROMs present. */
export async function scanSaves(adb: Adb): Promise<SystemSaves[]> {
	return (await collectListings(adb))
		.map(matchSystemSaves)
		.filter((s) => s.games.length > 0 || s.orphans.length > 0 || s.other.length > 0)
		.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

/** The same scan for one system, as a rename needs. */
export async function scanSystemSaves(adb: Adb, tag: string): Promise<SystemSaves | undefined> {
	const [listing] = await collectListings(adb, tag);
	return listing ? matchSystemSaves(listing) : undefined;
}

/** Last scan per connection, shown straight away while a new scan corrects it. */
const lastScans = new WeakMap<Adb, SystemSaves[]>();

export function getLastSavesScan(adb: Adb): SystemSaves[] | undefined {
	return lastScans.get(adb);
}

export function rememberSavesScan(adb: Adb, systems: SystemSaves[]): void {
	lastScans.set(adb, systems);
}
