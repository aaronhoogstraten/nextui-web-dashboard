/**
 * Which files a backup, restore or delete touches. Pure, like matching.ts, so it
 * can be tested without a device.
 *
 * Backups are zips laid out like the SD card (`Saves/GBA/…`,
 * `.userdata/shared/GBA-gpsp/…`), so a restore puts every file back where it came
 * from, on the same device or another one.
 */
import type {
	GameSaves,
	ListedFile,
	SaveFile,
	SlotDataFile,
	SystemSaves
} from '$lib/saves/matching.js';

/** A device path relative to the card root, as stored in a backup zip. */
export function backupPath(devicePath: string, base: string): string {
	return devicePath.startsWith(`${base}/`) ? devicePath.slice(base.length + 1) : devicePath;
}

/**
 * The card-relative path a backup entry restores to, or null if the entry is not
 * save data. Only save locations are accepted, so a zip can't write elsewhere.
 */
export function restorePath(entryName: string): string | null {
	if (entryName.includes('\\')) return null;
	const parts = entryName.split('/');
	if (parts.some((p) => p === '' || p === '.' || p === '..')) return null;
	if (parts[0] === 'Saves' && parts.length >= 3) return entryName;
	if (parts[0] !== '.userdata' || parts[1] !== 'shared') return null;
	if (parts[2] === '.minui' && parts.length === 5) return entryName;
	const isStateDir = parts.length === 4 && !parts[2].startsWith('.') && parts[2].includes('-');
	return isStateDir ? entryName : null;
}

/** Everything a game's backup holds, including the menu's slot data. */
export function gameBackupFiles(game: GameSaves): ListedFile[] {
	return [...game.files, ...game.slotData];
}

/** Every file the scan found, once each; shared saves appear under several games. */
export function allBackupFiles(systems: SystemSaves[]): ListedFile[] {
	const byPath = new Map<string, ListedFile>();
	for (const system of systems) {
		for (const game of [...system.games, ...system.orphans]) {
			for (const file of gameBackupFiles(game)) byPath.set(file.path, file);
		}
		for (const file of system.other) byPath.set(file.path, file);
	}
	return [...byPath.values()];
}

export interface GameDeletion {
	paths: string[];
	/** Files more than one ROM uses, which deleting one game must not take away */
	kept: SaveFile[];
}

export function gameDeletion(game: GameSaves): GameDeletion {
	const kept = game.files.filter((f) => f.owners > 1);
	const removed = game.files.filter((f) => f.owners === 1);
	// A kept state still needs its slot's preview, and Resume needs the last-slot
	// file. Slot data matched to several ROMs by base name stays for the others.
	const keptStates = kept.filter((f) => f.kind === 'state');
	const keptSlots = new Set(keptStates.map((f) => f.slot));
	const slotData = game.slotData.filter(
		(f) => f.owners === 1 && (f.slot === null ? keptStates.length === 0 : !keptSlots.has(f.slot))
	);
	return { paths: [...removed, ...slotData].map((f) => f.path), kept };
}

export interface FileDeletion {
	paths: string[];
	/**
	 * The last-used slot file, when states remain: it should go too if it points
	 * at the deleted slot, which only reading it can tell.
	 */
	lastSlotCheck: { file: SlotDataFile; slot: number } | null;
}

export function fileDeletion(game: GameSaves, file: SaveFile): FileDeletion {
	if (file.kind !== 'state' || file.slot === null || file.owners > 1) {
		return { paths: [file.path], lastSlotCheck: null };
	}
	const remaining = game.files.filter((f) => f.kind === 'state' && f.path !== file.path);
	const ownSlotData = game.slotData.filter((f) => f.owners === 1);
	const lastSlot = ownSlotData.find((f) => f.slot === null);
	// Another core can hold a state in the same slot, and shares its preview
	const slotStillUsed = remaining.some((f) => f.slot === file.slot);
	const slotFiles = slotStillUsed ? [] : ownSlotData.filter((f) => f.slot === file.slot);
	const paths = [file.path, ...slotFiles.map((f) => f.path)];
	if (!lastSlot) return { paths, lastSlotCheck: null };
	if (remaining.length === 0) return { paths: [...paths, lastSlot.path], lastSlotCheck: null };
	return { paths, lastSlotCheck: slotStillUsed ? null : { file: lastSlot, slot: file.slot } };
}

/** Make a name safe to offer as a download filename. */
export function safeFileName(name: string): string {
	return name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'saves';
}
