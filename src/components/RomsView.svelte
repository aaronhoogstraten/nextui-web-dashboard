<script lang="ts">
	import { untrack } from 'svelte';
	import type { Adb } from '@yume-chan/adb';
	import {
		ROM_SYSTEMS,
		ROM_SYSTEM_CODES,
		buildDeviceDirMap,
		getRomDevicePath,
		isValidRomExtension,
		parseRomDirectoryName,
		type RomSystem
	} from '$lib/roms/index.js';
	import { DEVICE_PATHS } from '$lib/adb/types.js';
	import { listDirectory, pathExists, pullFile, pushFile } from '$lib/adb/file-ops.js';
	import {
		beginTransfer,
		endTransfer,
		trackedPush,
		skipTransferFile
	} from '$lib/stores/transfer.svelte.js';
	import { adbExec, getPlatform } from '$lib/stores/connection.svelte.js';
	import {
		formatSize,
		formatError,
		compareByName,
		getDroppedFiles,
		hasDraggedFiles,
		joinPath,
		plural,
		pickFile,
		pickFiles,
		type DroppedFile
	} from '$lib/utils.js';
	import { ShellCmd } from '$lib/adb/adb-utils.js';
	import ActionButton from './ActionButton.svelte';
	import ImagePreview from './ImagePreview.svelte';
	import Modal from './Modal.svelte';
	import OverwriteDialog from './OverwriteDialog.svelte';
	import LargeArtDialog from './LargeArtDialog.svelte';
	import RomSyncFlow from './RomSyncFlow.svelte';

	let { adb }: { adb: Adb } = $props();

	let syncActive = $state(false);
	let syncFlow: RomSyncFlow | undefined = $state.raw(undefined);
	const hasDirectoryPicker = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

	async function startSyncFlow() {
		try {
			const dirHandle = await window.showDirectoryPicker!({ mode: 'read' });
			syncActive = true;
			// Wait for component to mount, then start
			await new Promise((r) => setTimeout(r, 0));
			if (syncFlow) await syncFlow.start(dirHandle);
		} catch (e) {
			if (e instanceof DOMException && e.name === 'AbortError') return;
		}
	}

	function onSyncComplete() {
		syncActive = false;
		refreshAll();
	}

	interface RomEntry {
		name: string;
		baseName: string;
		size: bigint;
		isDirectory: boolean;
		mediaFileName: string;
		hasMedia: boolean;
		thumbnailUrl: string | null;
		loadingThumb: boolean;
		displayName: string;
	}

	interface SystemState {
		system: RomSystem;
		devicePath: string;
		romCount: number | null;
		mediaCount: number;
		loading: boolean;
		expanded: boolean;
		error: string;
		roms: RomEntry[];
		romsLoaded: boolean;
		loadingRoms: boolean;
		bgUrl: string | null;
		bglistUrl: string | null;
		iconUrl: string | null;
		iconFileName: string;
		displayNameMap: Map<string, string>;
		displayNameDirty: boolean;
		savingNames: boolean;
	}

	function dirName(path: string): string {
		return path.substring(path.lastIndexOf('/') + 1);
	}

	let systems: SystemState[] = $state(
		ROM_SYSTEMS.map((sys) => {
			const devicePath = getRomDevicePath(sys);
			return {
				system: sys,
				devicePath,
				romCount: null,
				mediaCount: 0,
				loading: false,
				expanded: false,
				error: '',
				roms: [],
				romsLoaded: false,
				loadingRoms: false,
				bgUrl: null,
				bglistUrl: null,
				iconUrl: null,
				iconFileName: `${dirName(devicePath)}.png`,
				displayNameMap: new Map(),
				displayNameDirty: false,
				savingNames: false
			};
		})
	);

	let refreshing = $state(false);
	let hideEmpty = $state(true);
	let availableEmus = $state(new Set<string>());
	let missingEmuInfo: string | null = $state(null);
	let uploadingTo: string | null = $state(null);
	let uploadingBg: string | null = $state(null);
	let removingBg: string | null = $state(null);
	let uploadingMediaFor: string | null = $state(null);
	let dragTargetPath: string | null = $state(null);
	let dragCounter = $state(0);
	let previewSrc: string | null = $state(null);
	let previewAlt: string = $state('');
	let detectedPlatform: string = $state('');

	let overwriteDialog: OverwriteDialog;
	let largeArtDialog: LargeArtDialog;

	async function scanAvailableEmulators(): Promise<Set<string>> {
		const codes = new Set<string>();
		detectedPlatform = getPlatform();

		// Collect all directories that may contain .pak emulators
		const emuDirs: string[] = [];
		if (detectedPlatform) {
			// User-installed emulators: Emus/{platform}/
			emuDirs.push(`${DEVICE_PATHS.emus}/${detectedPlatform}`);
			// Built-in emulators: .system/{platform}/paks/Emus/
			emuDirs.push(`${DEVICE_PATHS.system}/${detectedPlatform}/paks/Emus`);
		} else {
			// Platform unknown — scan all subdirs under Emus/
			try {
				const deviceDirs = await listDirectory(adb, DEVICE_PATHS.emus);
				for (const dir of deviceDirs) {
					if (dir.isDirectory && !dir.name.startsWith('.')) {
						emuDirs.push(`${DEVICE_PATHS.emus}/${dir.name}`);
					}
				}
			} catch {
				// Emus directory doesn't exist or unreadable
			}
		}

		for (const dir of emuDirs) {
			try {
				const paks = await listDirectory(adb, dir);
				for (const pak of paks) {
					if (pak.name.endsWith('.pak')) {
						codes.add(pak.name.slice(0, -4));
					}
				}
			} catch {
				// Skip unreadable dirs
			}
		}
		return codes;
	}

	async function refreshAll() {
		refreshing = true;

		// Scan available emulators
		availableEmus = await scanAvailableEmulators();

		// Remove previously discovered custom systems (they'll be re-discovered)
		for (const s of systems) {
			if (s.system.isCustom) cleanupThumbnails(s);
		}
		systems = systems.filter((s) => !s.system.isCustom);

		// Map systemCode → actual device directory name to handle
		// directories with ordering prefixes like "1) Game Boy (GB)"
		let deviceDirByCode = new Map<string, string>();
		const unmatchedDirs: { dirName: string; parsed: { systemName: string; systemCode: string } }[] =
			[];
		try {
			const romDirs = await listDirectory(adb, DEVICE_PATHS.roms);
			deviceDirByCode = buildDeviceDirMap(romDirs);
			// Collect directories with unknown system codes for custom system discovery
			for (const dir of romDirs) {
				if (!dir.isDirectory || dir.name.startsWith('.')) continue;
				const parsed = parseRomDirectoryName(dir.name);
				if (parsed && !ROM_SYSTEM_CODES.has(parsed.systemCode)) {
					unmatchedDirs.push({ dirName: dir.name, parsed });
				}
			}
		} catch {
			// Roms directory unreadable — skip discovery
		}

		// Check predefined systems, using actual device paths when available
		for (const s of systems) {
			s.loading = true;
			s.error = '';

			// If the device has a directory matching this system code (possibly with
			// an ordering prefix like "1) "), use that path instead of the default.
			// Always reset to the canonical path otherwise, in case a previously
			// discovered prefixed directory was renamed or removed.
			const actualDir = deviceDirByCode.get(s.system.systemCode);
			if (actualDir) {
				s.devicePath = `${DEVICE_PATHS.roms}/${actualDir}`;
				s.iconFileName = `${actualDir}.png`;
			} else {
				s.devicePath = getRomDevicePath(s.system);
				s.iconFileName = `${dirName(s.devicePath)}.png`;
			}

			try {
				const entries = await listDirectory(adb, s.devicePath);
				s.romCount = entries.filter(
					(e) => (e.isFile || e.isDirectory) && !e.name.startsWith('.')
				).length;
			} catch {
				s.romCount = 0;
				s.error = 'Folder not found';
			}
			s.loading = false;
			// Clear cached ROM details so they reload on next expand
			if (s.romsLoaded) {
				cleanupThumbnails(s);
				s.roms = [];
				s.romsLoaded = false;
				s.mediaCount = 0;
			}
		}

		// Discover custom systems from device (directories with unknown system codes)
		for (const { dirName: dName, parsed } of unmatchedDirs) {
			const devicePath = `${DEVICE_PATHS.roms}/${dName}`;
			let romCount = 0;
			try {
				const entries = await listDirectory(adb, devicePath);
				romCount = entries.filter(
					(e) => (e.isFile || e.isDirectory) && !e.name.startsWith('.')
				).length;
			} catch {
				// ignore
			}

			systems.push({
				system: {
					systemName: parsed.systemName,
					systemCode: parsed.systemCode,
					supportedFormats: [],
					isCustom: true
				},
				devicePath,
				romCount,
				mediaCount: 0,
				loading: false,
				expanded: false,
				error: '',
				roms: [],
				romsLoaded: false,
				loadingRoms: false,
				bgUrl: null,
				bglistUrl: null,
				iconUrl: null,
				iconFileName: `${dirName(devicePath)}.png`,
				displayNameMap: new Map(),
				displayNameDirty: false,
				savingNames: false
			});
		}

		refreshing = false;
	}

	function getBaseName(filename: string): string {
		const lastDot = filename.lastIndexOf('.');
		return lastDot > 0 ? filename.substring(0, lastDot) : filename;
	}

	async function loadRomDetails(state: SystemState) {
		if (state.romsLoaded || state.loadingRoms) return;
		state.loadingRoms = true;

		try {
			// Get ROM files
			const entries = await listDirectory(adb, state.devicePath);
			const romFiles = entries
				.filter((e) => (e.isFile || e.isDirectory) && !e.name.startsWith('.'))
				.sort(compareByName);

			// Get media files
			let mediaNames = new Set<string>();
			const mediaPath = `${state.devicePath}/.media`;
			try {
				const mediaEntries = await listDirectory(adb, mediaPath);
				mediaNames = new Set(mediaEntries.filter((e) => e.isFile).map((e) => e.name));
			} catch {
				// .media directory may not exist — that's fine
			}

			// Load special media images if present
			if (state.bgUrl) {
				URL.revokeObjectURL(state.bgUrl);
				state.bgUrl = null;
			}
			if (state.bglistUrl) {
				URL.revokeObjectURL(state.bglistUrl);
				state.bglistUrl = null;
			}
			if (state.iconUrl) {
				URL.revokeObjectURL(state.iconUrl);
				state.iconUrl = null;
			}
			for (const fileName of ['bg.png', 'bglist.png']) {
				if (mediaNames.has(fileName)) {
					try {
						const data = await pullFile(adb, `${mediaPath}/${fileName}`);
						const url = URL.createObjectURL(new Blob([data], { type: 'image/png' }));
						if (fileName === 'bg.png') state.bgUrl = url;
						else state.bglistUrl = url;
					} catch {
						/* skip */
					}
				}
			}
			// System icon lives in Roms/.media/ (parent directory)
			try {
				const iconPath = `${DEVICE_PATHS.roms}/.media/${state.iconFileName}`;
				const data = await pullFile(adb, iconPath);
				state.iconUrl = URL.createObjectURL(new Blob([data], { type: 'image/png' }));
			} catch {
				/* icon doesn't exist — skip */
			}

			// Load map.txt for display names
			let displayNameMap = new Map<string, string>();
			try {
				const mapExists = await pathExists(adb, `${state.devicePath}/map.txt`);
				if (mapExists) {
					const mapData = await pullFile(adb, `${state.devicePath}/map.txt`);
					const mapContent = new TextDecoder().decode(mapData);
					displayNameMap = parseMapTxt(mapContent);
				}
			} catch {
				/* map.txt read failed — skip */
			}
			state.displayNameMap = displayNameMap;
			state.displayNameDirty = false;

			// Compute total sizes for subdirectories (disc-based games)
			const dirSizes = new Map<string, bigint>();
			await Promise.all(
				romFiles
					.filter((f) => f.isDirectory)
					.map(async (f) => {
						try {
							const children = await listDirectory(adb, `${state.devicePath}/${f.name}`);
							const total = children.filter((c) => c.isFile).reduce((sum, c) => sum + c.size, 0n);
							dirSizes.set(f.name, total);
						} catch {
							// unreadable — leave size as-is
						}
					})
			);

			// Build ROM entries with media matching
			state.roms = romFiles.map((f) => {
				const baseName = f.isDirectory ? f.name : getBaseName(f.name);
				const mediaFileName = `${baseName}.png`;
				const hasMedia = mediaNames.has(mediaFileName);
				return {
					name: f.name,
					baseName,
					size: dirSizes.get(f.name) ?? f.size,
					isDirectory: f.isDirectory,
					mediaFileName,
					hasMedia,
					thumbnailUrl: null,
					loadingThumb: false,
					displayName: displayNameMap.get(f.name) || ''
				};
			});

			state.mediaCount = state.roms.filter((r) => r.hasMedia).length;
			state.romCount = state.roms.length;
			state.romsLoaded = true;

			// Start loading thumbnails
			loadThumbnails(state);
		} catch (e) {
			state.error = `Failed to load ROMs: ${formatError(e)}`;
		}

		state.loadingRoms = false;
	}

	async function loadThumbnails(state: SystemState) {
		const mediaPath = `${state.devicePath}/.media`;
		for (const rom of state.roms) {
			if (!rom.hasMedia || rom.thumbnailUrl) continue;
			rom.loadingThumb = true;
			try {
				const data = await pullFile(adb, `${mediaPath}/${rom.mediaFileName}`);
				const blob = new Blob([data], { type: 'image/png' });
				rom.thumbnailUrl = URL.createObjectURL(blob);
			} catch {
				rom.hasMedia = false;
			}
			rom.loadingThumb = false;
		}
	}

	function cleanupThumbnails(state: SystemState) {
		for (const rom of state.roms) {
			if (rom.thumbnailUrl) {
				URL.revokeObjectURL(rom.thumbnailUrl);
				rom.thumbnailUrl = null;
			}
		}
		if (state.bgUrl) {
			URL.revokeObjectURL(state.bgUrl);
			state.bgUrl = null;
		}
		if (state.bglistUrl) {
			URL.revokeObjectURL(state.bglistUrl);
			state.bglistUrl = null;
		}
		if (state.iconUrl) {
			URL.revokeObjectURL(state.iconUrl);
			state.iconUrl = null;
		}
	}

	function setSpecialMedia(state: SystemState, filename: string, url: string | null) {
		if (filename === 'bg.png') {
			if (state.bgUrl) URL.revokeObjectURL(state.bgUrl);
			state.bgUrl = url;
		} else if (filename === 'bglist.png') {
			if (state.bglistUrl) URL.revokeObjectURL(state.bglistUrl);
			state.bglistUrl = url;
		} else if (filename === state.iconFileName) {
			if (state.iconUrl) URL.revokeObjectURL(state.iconUrl);
			state.iconUrl = url;
		}
	}

	function getSpecialMediaPath(state: SystemState, filename: string): string {
		if (filename === state.iconFileName) {
			return `${DEVICE_PATHS.roms}/.media/${filename}`;
		}
		return `${state.devicePath}/.media/${filename}`;
	}

	function getSpecialMediaDir(state: SystemState, filename: string): string {
		if (filename === state.iconFileName) {
			return `${DEVICE_PATHS.roms}/.media`;
		}
		return `${state.devicePath}/.media`;
	}

	async function uploadSpecialMedia(state: SystemState, filename: string) {
		const file = await pickFile({ accept: '.png' });
		if (!file) return;

		const data = await largeArtDialog.check(file);
		if (!data) return;

		uploadingBg = `${state.system.systemCode}/${filename}`;
		try {
			const dir = getSpecialMediaDir(state, filename);
			const dirExists = await pathExists(adb, dir);
			if (!dirExists) {
				await adbExec(ShellCmd.mkdir(dir));
			}

			await pushFile(adb, getSpecialMediaPath(state, filename), data);
			const url = URL.createObjectURL(new Blob([data], { type: 'image/png' }));
			setSpecialMedia(state, filename, url);
		} catch (e) {
			state.error = `Upload failed: ${formatError(e)}`;
		} finally {
			uploadingBg = null;
		}
	}

	async function removeSpecialMedia(state: SystemState, filename: string) {
		if (!confirm(`Delete ${filename} from ${state.system.systemName}?`)) return;

		removingBg = `${state.system.systemCode}/${filename}`;
		try {
			await adbExec(ShellCmd.rm(getSpecialMediaPath(state, filename)));
			setSpecialMedia(state, filename, null);
		} catch (e) {
			state.error = `Delete failed: ${formatError(e)}`;
		} finally {
			removingBg = null;
		}
	}

	async function toggleExpand(state: SystemState) {
		state.expanded = !state.expanded;
		if (state.expanded && !state.romsLoaded) {
			await loadRomDetails(state);
		}
	}

	function openPreview(rom: RomEntry) {
		if (rom.thumbnailUrl) {
			previewSrc = rom.thumbnailUrl;
			previewAlt = `${rom.baseName} — ${rom.mediaFileName}`;
		}
	}

	function closePreview() {
		previewSrc = null;
		previewAlt = '';
	}

	/**
	 * Derive a game folder name from multiple .cue file base names.
	 * Finds the longest common prefix, then strips any trailing incomplete
	 * parenthetical (e.g. " (Disc " from "Game (USA) (Disc 1)" / "Game (USA) (Disc 2)").
	 */
	function deriveGameFolderName(cueBaseNames: string[]): string {
		if (cueBaseNames.length === 1) return cueBaseNames[0];
		let prefix = cueBaseNames[0];
		for (let i = 1; i < cueBaseNames.length; i++) {
			while (!cueBaseNames[i].startsWith(prefix)) {
				prefix = prefix.substring(0, prefix.length - 1);
			}
		}
		prefix = prefix.trimEnd();
		// Strip trailing incomplete parenthetical like " (Disc"
		const lastOpen = prefix.lastIndexOf('(');
		const lastClose = prefix.lastIndexOf(')');
		if (lastOpen > lastClose) {
			prefix = prefix.substring(0, lastOpen).trimEnd();
		}
		return prefix || cueBaseNames[0];
	}

	function getLeafName(relativePath: string): string {
		const lastSlash = relativePath.lastIndexOf('/');
		return lastSlash >= 0 ? relativePath.substring(lastSlash + 1) : relativePath;
	}

	async function refreshSystemAfterUpload(state: SystemState) {
		cleanupThumbnails(state);
		state.roms = [];
		state.romsLoaded = false;
		if (state.expanded) {
			await loadRomDetails(state);
		} else {
			try {
				const entries = await listDirectory(adb, state.devicePath);
				state.romCount = entries.filter(
					(e) => (e.isFile || e.isDirectory) && !e.name.startsWith('.')
				).length;
			} catch {
				// ignore
			}
		}
	}

	interface StructuredRomUploadPlan {
		validEntries: DroppedFile[];
		invalidEntries: DroppedFile[];
		totalFileCount: number;
		totalBytes: number;
	}

	type DiscGroup = {
		files: File[];
		contentFiles: File[];
		m3uFile?: File;
		generateM3u: boolean;
	};

	interface FlatRomUploadPlan {
		discGroups: DiscGroup[];
		flatFiles: File[];
		invalidFiles: File[];
		totalFileCount: number;
		totalBytes: number;
		workCount: number;
	}

	function buildStructuredRomUploadPlan(
		state: SystemState,
		entries: DroppedFile[]
	): StructuredRomUploadPlan {
		const validEntries: DroppedFile[] = [];
		const invalidEntries: DroppedFile[] = [];
		for (const entry of entries) {
			const leafName = getLeafName(entry.relativePath);
			const dotIndex = leafName.lastIndexOf('.');
			const ext = dotIndex > 0 ? leafName.substring(dotIndex).toLowerCase() : '';
			if (!isValidRomExtension(ext, state.system)) {
				invalidEntries.push(entry);
				continue;
			}
			validEntries.push(entry);
		}

		return {
			validEntries,
			invalidEntries,
			totalFileCount: entries.length,
			totalBytes: entries.reduce((sum, entry) => sum + entry.file.size, 0)
		};
	}

	async function executeStructuredRomUpload(
		state: SystemState,
		plan: StructuredRomUploadPlan
	): Promise<{ uploaded: number; skipped: number }> {
		let uploaded = 0;
		let skipped = 0;
		const createdDirs = new Set<string>();
		const topLevelDecision = new Map<string, 'upload' | 'skip'>();
		const clearedTopLevelConflicts = new Set<string>();
		let conflictPolicy: 'ask' | 'overwrite-all' | 'skip-all' = 'ask';

		let existingEntries = new Map<string, { isFile: boolean; isDirectory: boolean }>();
		try {
			existingEntries = new Map(
				(await listDirectory(adb, state.devicePath)).map((entry) => [
					entry.name,
					{ isFile: entry.isFile, isDirectory: entry.isDirectory }
				])
			);
		} catch {
			/* ignore */
		}

		const sortedEntries = [...plan.validEntries].sort((a, b) =>
			a.relativePath.localeCompare(b.relativePath)
		);
		for (const entry of sortedEntries) {
			const relativePath = entry.relativePath.replaceAll('\\', '/');
			const pathParts = relativePath.split('/').filter(Boolean);
			if (pathParts.length === 0) {
				skipped++;
				skipTransferFile(entry.file.size);
				continue;
			}

			const topLevelName = pathParts[0];
			const hasNestedPath = pathParts.length > 1;
			const existingTopLevel = existingEntries.get(topLevelName);
			if (!topLevelDecision.has(topLevelName)) {
				if (existingTopLevel) {
					if (conflictPolicy === 'skip-all') {
						topLevelDecision.set(topLevelName, 'skip');
					} else if (conflictPolicy === 'overwrite-all') {
						topLevelDecision.set(topLevelName, 'upload');
					} else {
						const resolution = await overwriteDialog.show(topLevelName, sortedEntries.length > 1);
						if (resolution === 'skip' || resolution === 'skip-all') {
							topLevelDecision.set(topLevelName, 'skip');
							if (resolution === 'skip-all') conflictPolicy = 'skip-all';
						} else {
							topLevelDecision.set(topLevelName, 'upload');
							if (resolution === 'overwrite-all') conflictPolicy = 'overwrite-all';
						}
					}
				} else {
					topLevelDecision.set(topLevelName, 'upload');
				}
			}

			if (topLevelDecision.get(topLevelName) !== 'upload') {
				skipped++;
				skipTransferFile(entry.file.size);
				continue;
			}

			if (existingTopLevel?.isFile && !clearedTopLevelConflicts.has(topLevelName)) {
				await adbExec(ShellCmd.rm(joinPath(state.devicePath, topLevelName)));
				clearedTopLevelConflicts.add(topLevelName);
				existingEntries.set(topLevelName, { isFile: false, isDirectory: true });
			}

			const lastSlash = relativePath.lastIndexOf('/');
			if (lastSlash > 0) {
				const dirPath = joinPath(state.devicePath, relativePath.substring(0, lastSlash));
				if (!createdDirs.has(dirPath)) {
					await adbExec(ShellCmd.mkdir(dirPath));
					createdDirs.add(dirPath);
				}
			}

			const data = new Uint8Array(await entry.file.arrayBuffer());
			await trackedPush(adb, joinPath(state.devicePath, relativePath), data);
			uploaded++;
		}

		return { uploaded, skipped };
	}

	function buildFlatRomUploadPlan(state: SystemState, entries: DroppedFile[]): FlatRomUploadPlan {
		const files = entries.map((entry) => entry.file);
		const DISC_EXTS = new Set(['.cue', '.bin', '.m3u', '.chd']);
		const cueFiles: File[] = [];
		const chdFiles: File[] = [];
		const discFiles: File[] = [];
		const flatFiles: File[] = [];
		const invalidFiles: File[] = [];

		for (const file of files) {
			const dotIndex = file.name.lastIndexOf('.');
			const ext = dotIndex > 0 ? file.name.substring(dotIndex).toLowerCase() : '';
			if (!isValidRomExtension(ext, state.system)) {
				invalidFiles.push(file);
				continue;
			}
			if (DISC_EXTS.has(ext)) {
				if (ext === '.cue') cueFiles.push(file);
				if (ext === '.chd') chdFiles.push(file);
				discFiles.push(file);
			} else {
				flatFiles.push(file);
			}
		}

		const hasM3uFile = discFiles.some((f) => f.name.toLowerCase().endsWith('.m3u'));
		const stripParens = (name: string) =>
			getBaseName(name)
				.replace(/\s*\([^)]*\)/g, '')
				.trim();

		const discGroups: DiscGroup[] = [];

		if (hasM3uFile) {
			const m3uFile = discFiles.find((f) => f.name.toLowerCase().endsWith('.m3u'))!;
			const contentFiles = cueFiles.length > 0 ? cueFiles : chdFiles;
			discGroups.push({
				files: [...discFiles],
				contentFiles,
				m3uFile,
				generateM3u: false
			});
		} else if (cueFiles.length > 0) {
			const binFiles = discFiles.filter((f) => f.name.toLowerCase().endsWith('.bin'));
			const cueGrouped = new Map<string, File[]>();
			for (const f of cueFiles) {
				const key = stripParens(f.name);
				if (!cueGrouped.has(key)) cueGrouped.set(key, []);
				cueGrouped.get(key)!.push(f);
			}
			const matchedBins = new Set<File>();
			for (const [, cues] of cueGrouped) {
				const cueStrippedTitles = new Set(cues.map((f) => stripParens(f.name)));
				const associatedBins = binFiles.filter((b) => cueStrippedTitles.has(stripParens(b.name)));
				for (const b of associatedBins) matchedBins.add(b);
				discGroups.push({
					files: [...cues, ...associatedBins],
					contentFiles: cues,
					generateM3u: cues.length > 1
				});
			}
			for (const bin of binFiles) {
				if (!matchedBins.has(bin)) flatFiles.push(bin);
			}
		} else if (chdFiles.length > 0) {
			const grouped = new Map<string, File[]>();
			for (const f of chdFiles) {
				const key = stripParens(f.name);
				if (!grouped.has(key)) grouped.set(key, []);
				grouped.get(key)!.push(f);
			}
			for (const [, group] of grouped) {
				if (group.length > 1) {
					discGroups.push({ files: group, contentFiles: group, generateM3u: true });
				} else {
					flatFiles.push(group[0]);
				}
			}
		} else {
			flatFiles.push(...discFiles);
		}

		const discGroupFileCount = discGroups.reduce((sum, g) => sum + g.files.length, 0);
		const generatedM3uCount = discGroups.filter((g) => g.generateM3u).length;

		return {
			discGroups,
			flatFiles,
			invalidFiles,
			totalFileCount:
				discGroupFileCount + flatFiles.length + invalidFiles.length + generatedM3uCount,
			totalBytes: files.reduce((sum, f) => sum + f.size, 0),
			workCount: discGroupFileCount + flatFiles.length
		};
	}

	async function executeFlatRomUpload(
		state: SystemState,
		plan: FlatRomUploadPlan
	): Promise<{ uploaded: number; skipped: number }> {
		let uploaded = 0;
		let skipped = 0;

		// --- Disc-based upload: create game folder(s) and push files into them ---
		let existingDirs: Set<string> | null = null;
		if (plan.discGroups.length > 0) {
			try {
				const entries = await listDirectory(adb, state.devicePath);
				existingDirs = new Set(entries.filter((e) => e.isDirectory).map((e) => e.name));
			} catch {
				/* ignore */
			}
		}

		let discConflictPolicy: 'ask' | 'overwrite-all' | 'skip-all' = 'ask';

		for (const group of plan.discGroups) {
			const folderName = group.m3uFile
				? getBaseName(group.m3uFile.name)
				: deriveGameFolderName(group.contentFiles.map((f) => getBaseName(f.name)));
			const folderPath = `${state.devicePath}/${folderName}`;

			if (existingDirs?.has(folderName)) {
				if (discConflictPolicy === 'skip-all') {
					skipped += group.files.length;
					for (const file of group.files) skipTransferFile(file.size);
					if (group.generateM3u) skipTransferFile(0);
					continue;
				}
				if (discConflictPolicy === 'ask') {
					const resolution = await overwriteDialog.show(folderName, plan.discGroups.length > 1);
					if (resolution === 'skip' || resolution === 'skip-all') {
						skipped += group.files.length;
						for (const file of group.files) skipTransferFile(file.size);
						if (group.generateM3u) skipTransferFile(0);
						if (resolution === 'skip-all') discConflictPolicy = 'skip-all';
						continue;
					}
					if (resolution === 'overwrite-all') discConflictPolicy = 'overwrite-all';
				}
			}

			await adbExec(ShellCmd.mkdir(folderPath));

			for (const file of group.files) {
				const data = new Uint8Array(await file.arrayBuffer());
				await trackedPush(adb, `${folderPath}/${file.name}`, data);
				uploaded++;
			}

			if (group.generateM3u) {
				const m3uContent =
					group.contentFiles
						.map((f) => f.name)
						.sort()
						.join('\n') + '\n';
				const m3uData = new TextEncoder().encode(m3uContent);
				await trackedPush(adb, `${folderPath}/${folderName}.m3u`, m3uData);
				uploaded++;
			}
		}

		// --- Flat upload: files go directly into the system directory ---
		if (plan.flatFiles.length > 0) {
			let existingEntries = new Map<string, { isFile: boolean; isDirectory: boolean }>();
			try {
				existingEntries = new Map(
					(await listDirectory(adb, state.devicePath)).map((entry) => [
						entry.name,
						{ isFile: entry.isFile, isDirectory: entry.isDirectory }
					])
				);
			} catch {
				/* ignore */
			}

			let conflictPolicy: 'ask' | 'overwrite-all' | 'skip-all' = 'ask';

			for (const file of plan.flatFiles) {
				const existingEntry = existingEntries.get(file.name);
				if (existingEntry) {
					if (conflictPolicy === 'skip-all') {
						skipped++;
						skipTransferFile(file.size);
						continue;
					}
					if (conflictPolicy === 'ask') {
						const resolution = await overwriteDialog.show(file.name, plan.flatFiles.length > 1);
						if (resolution === 'skip') {
							skipped++;
							skipTransferFile(file.size);
							continue;
						}
						if (resolution === 'skip-all') {
							skipped++;
							skipTransferFile(file.size);
							conflictPolicy = 'skip-all';
							continue;
						}
						if (resolution === 'overwrite-all') conflictPolicy = 'overwrite-all';
					}

					if (existingEntry.isDirectory) {
						await adbExec(ShellCmd.rmrf(`${state.devicePath}/${file.name}`));
						existingEntries.set(file.name, { isFile: true, isDirectory: false });
					}
				}

				const data = new Uint8Array(await file.arrayBuffer());
				await trackedPush(adb, `${state.devicePath}/${file.name}`, data);
				uploaded++;
			}
		}

		return { uploaded, skipped };
	}

	function resetDragTarget() {
		dragTargetPath = null;
		dragCounter = 0;
	}

	function handleSystemDragEnter(event: DragEvent, state: SystemState) {
		if (!hasDraggedFiles(event) || uploadingTo !== null) return;
		event.preventDefault();
		if (dragTargetPath !== state.devicePath) {
			dragTargetPath = state.devicePath;
			dragCounter = 0;
		}
		dragCounter++;
	}

	function handleSystemDragOver(event: DragEvent, state: SystemState) {
		if (!hasDraggedFiles(event) || uploadingTo !== null) return;
		event.preventDefault();
		if (dragTargetPath !== state.devicePath) {
			dragTargetPath = state.devicePath;
			dragCounter = 1;
		}
		if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
	}

	function handleSystemDragLeave(event: DragEvent, state: SystemState) {
		if (dragTargetPath !== state.devicePath) return;
		event.preventDefault();
		dragCounter--;
		if (dragCounter <= 0) resetDragTarget();
	}

	async function handleSystemDrop(event: DragEvent, state: SystemState) {
		event.preventDefault();
		const isActiveTarget = dragTargetPath === state.devicePath;
		resetDragTarget();
		if (!isActiveTarget || uploadingTo !== null) return;

		const droppedFiles = await getDroppedFiles(event);
		if (droppedFiles.length === 0) return;
		await uploadRoms(state, droppedFiles);
	}

	async function uploadRoms(state: SystemState, selectedFiles?: File[] | DroppedFile[]) {
		const accept = state.system.isCustom ? undefined : state.system.supportedFormats.join(',');
		const entries: DroppedFile[] = selectedFiles
			? selectedFiles.map((entry) =>
					entry instanceof File ? { file: entry, relativePath: entry.name } : entry
				)
			: (await pickFiles({ accept })).map((file) => ({ file, relativePath: file.name }));
		if (entries.length === 0) return;

		uploadingTo = state.system.systemCode;
		try {
			const structuredEntries = entries.filter((entry) => entry.relativePath.includes('/'));
			const flatEntries = entries.filter((entry) => !entry.relativePath.includes('/'));
			const structuredPlan =
				structuredEntries.length > 0
					? buildStructuredRomUploadPlan(state, structuredEntries)
					: null;
			const flatPlan = flatEntries.length > 0 ? buildFlatRomUploadPlan(state, flatEntries) : null;

			const totalWorkCount =
				(structuredPlan?.validEntries.length ?? 0) + (flatPlan?.workCount ?? 0);
			if (totalWorkCount === 0) {
				state.error = 'No valid files selected';
				return;
			}

			beginTransfer(
				'upload',
				(structuredPlan?.totalFileCount ?? 0) + (flatPlan?.totalFileCount ?? 0),
				(structuredPlan?.totalBytes ?? 0) + (flatPlan?.totalBytes ?? 0)
			);

			for (const entry of structuredPlan?.invalidEntries ?? []) {
				skipTransferFile(entry.file.size);
			}
			for (const file of flatPlan?.invalidFiles ?? []) {
				skipTransferFile(file.size);
			}

			let uploaded = 0;
			let skipped = 0;

			if (structuredPlan && structuredPlan.validEntries.length > 0) {
				const result = await executeStructuredRomUpload(state, structuredPlan);
				uploaded += result.uploaded;
				skipped += result.skipped;
			}

			if (flatPlan && flatPlan.workCount > 0) {
				const result = await executeFlatRomUpload(state, flatPlan);
				uploaded += result.uploaded;
				skipped += result.skipped;
			}

			const parts: string[] = [];
			if (uploaded > 0) parts.push(`Uploaded ${plural(uploaded, 'file')}`);
			if (skipped > 0) parts.push(`skipped ${skipped}`);
			state.error = parts.length > 0 ? parts.join(', ') : 'No valid files selected';
			await refreshSystemAfterUpload(state);
		} catch (e) {
			state.error = `Upload failed: ${formatError(e)}`;
		} finally {
			endTransfer();
			uploadingTo = null;
		}
	}

	async function uploadMedia(state: SystemState, rom: RomEntry) {
		const file = await pickFile({ accept: '.png' });
		if (!file) return;

		const data = await largeArtDialog.check(file);
		if (!data) return;

		uploadingMediaFor = rom.name;
		beginTransfer('upload', 1, data.byteLength);

		try {
			const mediaPath = `${state.devicePath}/.media`;

			const mediaDirExists = await pathExists(adb, mediaPath);
			if (!mediaDirExists) {
				await adbExec(ShellCmd.mkdir(mediaPath));
			}

			const remotePath = `${mediaPath}/${rom.mediaFileName}`;
			await trackedPush(adb, remotePath, data);

			rom.hasMedia = true;
			const blob = new Blob([data], { type: 'image/png' });
			if (rom.thumbnailUrl) URL.revokeObjectURL(rom.thumbnailUrl);
			rom.thumbnailUrl = URL.createObjectURL(blob);
			state.mediaCount = state.roms.filter((r) => r.hasMedia).length;
		} catch (e) {
			state.error = `Media upload failed: ${formatError(e)}`;
		} finally {
			endTransfer();
			uploadingMediaFor = null;
		}
	}

	let removingRom: string | null = $state(null);
	let removingMediaFor: string | null = $state(null);

	async function removeRom(state: SystemState, rom: RomEntry) {
		if (!confirm(`Delete "${rom.name}"${rom.hasMedia ? ' and its box art' : ''}?`)) return;
		removingRom = rom.name;
		try {
			const romPath = `${state.devicePath}/${rom.name}`;
			// Remove the ROM file or game folder
			await adbExec(rom.isDirectory ? ShellCmd.rmrf(romPath) : ShellCmd.rm(romPath));

			// Also remove media art if present
			if (rom.hasMedia) {
				const mediaPath = `${state.devicePath}/.media`;
				await adbExec(ShellCmd.rm(`${mediaPath}/${rom.mediaFileName}`));
			}

			// Clean up thumbnail
			if (rom.thumbnailUrl) {
				URL.revokeObjectURL(rom.thumbnailUrl);
			}

			// Remove from list
			state.roms = state.roms.filter((r) => r.name !== rom.name);
			state.romCount = state.roms.length;
			state.mediaCount = state.roms.filter((r) => r.hasMedia).length;
		} catch (e) {
			state.error = `Delete failed: ${formatError(e)}`;
		} finally {
			removingRom = null;
		}
	}

	async function removeMedia(state: SystemState, rom: RomEntry) {
		removingMediaFor = rom.name;
		try {
			const mediaPath = `${state.devicePath}/.media`;
			const remotePath = `${mediaPath}/${rom.mediaFileName}`;
			await adbExec(ShellCmd.rm(remotePath));

			if (rom.thumbnailUrl) {
				URL.revokeObjectURL(rom.thumbnailUrl);
				rom.thumbnailUrl = null;
			}
			rom.hasMedia = false;
			state.mediaCount = state.roms.filter((r) => r.hasMedia).length;
		} catch (e) {
			state.error = `Remove failed: ${formatError(e)}`;
		} finally {
			removingMediaFor = null;
		}
	}

	// =============================================
	// Display Name Mapping (map.txt)
	// =============================================

	function parseMapTxt(content: string): Map<string, string> {
		const map = new Map<string, string>();
		for (const line of content.split('\n')) {
			const tabIdx = line.indexOf('\t');
			if (tabIdx < 0) continue;
			const filename = line.substring(0, tabIdx);
			const displayName = line.substring(tabIdx + 1).trimEnd();
			if (filename && displayName) map.set(filename, displayName);
		}
		return map;
	}

	function serializeMapTxt(map: Map<string, string>): string {
		const lines: string[] = [];
		for (const [filename, displayName] of map) {
			if (displayName) lines.push(`${filename}\t${displayName}`);
		}
		return lines.join('\n') + (lines.length > 0 ? '\n' : '');
	}

	/** Find sibling system states (same system, different emulator — e.g. GBA/MGBA, SFC/SUPA) */
	function getSiblingStates(state: SystemState): SystemState[] {
		const pathName = state.system.romPathSystemName ?? state.system.systemName;
		return systems.filter(
			(s) => s !== state && (s.system.romPathSystemName ?? s.system.systemName) === pathName
		);
	}

	/**
	 * Sync map.txt to sibling emulator directories.
	 * Workaround for NextUI bug: when a system has multiple emulator directories
	 * (e.g. GBA + MGBA), all directories must have a consistent map.txt.
	 * Merges entries so sibling-specific display names are preserved.
	 */
	async function syncMapTxtToSiblings(
		state: SystemState,
		mapContent: Map<string, string>,
		deletedKeys: ReadonlySet<string>
	) {
		const siblings = getSiblingStates(state);
		for (const sib of siblings) {
			try {
				// Read existing sibling map.txt to preserve sibling-specific entries
				const mergedMap = new Map<string, string>();
				try {
					const exists = await pathExists(adb, `${sib.devicePath}/map.txt`);
					if (exists) {
						const raw = await pullFile(adb, `${sib.devicePath}/map.txt`);
						const existing = parseMapTxt(new TextDecoder().decode(raw));
						for (const [k, v] of existing) mergedMap.set(k, v);
					}
				} catch {
					// No existing map — start fresh
				}

				// Layer primary system's entries on top
				for (const [k, v] of mapContent) {
					mergedMap.set(k, v);
				}
				// Remove entries that were explicitly deleted
				for (const k of deletedKeys) {
					mergedMap.delete(k);
				}

				if (mergedMap.size === 0) {
					await adbExec(ShellCmd.rmf(`${sib.devicePath}/map.txt`));
				} else {
					const content = serializeMapTxt(mergedMap);
					const data = new TextEncoder().encode(content);
					await pushFile(adb, `${sib.devicePath}/map.txt`, data);
				}

				// Update sibling's in-memory state
				sib.displayNameMap = mergedMap;
				for (const rom of sib.roms) {
					rom.displayName = mergedMap.get(rom.name) || '';
				}
				sib.displayNameDirty = false;
			} catch {
				// Sibling directory may not exist on device — skip
			}
		}
	}

	function renameRom(state: SystemState, rom: RomEntry) {
		const current = rom.displayName || '';
		const result = prompt('Display name for ' + rom.name + ':', current);
		if (result === null) return; // cancelled
		const trimmed = result.trim();
		rom.displayName = trimmed;
		// Mark system dirty if any ROM differs from saved map
		state.displayNameDirty = state.roms.some(
			(r) => (r.displayName || '') !== (state.displayNameMap.get(r.name) || '')
		);
	}

	async function saveDisplayNames(state: SystemState) {
		state.savingNames = true;
		try {
			// Rebuild map from current ROM entries + preserve unknown entries
			const newMap = new Map<string, string>();
			// Keep entries for filenames not in the current ROM list (preserved unknowns)
			const romNames = new Set(state.roms.map((r) => r.name));
			for (const [k, v] of state.displayNameMap) {
				if (!romNames.has(k) && v) newMap.set(k, v);
			}
			// Add current ROM display names
			for (const rom of state.roms) {
				if (rom.displayName) newMap.set(rom.name, rom.displayName);
			}

			if (newMap.size === 0) {
				await adbExec(ShellCmd.rmf(`${state.devicePath}/map.txt`));
			} else {
				const content = serializeMapTxt(newMap);
				const data = new TextEncoder().encode(content);
				await pushFile(adb, `${state.devicePath}/map.txt`, data);
			}
			// Compute keys removed from the map (for sibling sync)
			const deletedKeys = new Set<string>();
			for (const k of state.displayNameMap.keys()) {
				if (!newMap.has(k)) deletedKeys.add(k);
			}

			state.displayNameMap = newMap;
			state.displayNameDirty = false;

			// Sync to sibling emulator directories
			await syncMapTxtToSiblings(state, newMap, deletedKeys);
		} catch (e) {
			state.error = `Failed to save names: ${formatError(e)}`;
		} finally {
			state.savingNames = false;
		}
	}

	let savingNameFor: string | null = $state(null);

	async function saveDisplayNameForRom(state: SystemState, rom: RomEntry) {
		savingNameFor = rom.name;
		try {
			// Update the saved map with this ROM's current display name
			if (rom.displayName) {
				state.displayNameMap.set(rom.name, rom.displayName);
			} else {
				state.displayNameMap.delete(rom.name);
			}

			// Write the full map (including preserved unknowns)
			const cleanMap = new Map<string, string>();
			for (const [k, v] of state.displayNameMap) {
				if (v) cleanMap.set(k, v);
			}

			if (cleanMap.size === 0) {
				await adbExec(ShellCmd.rmf(`${state.devicePath}/map.txt`));
			} else {
				const content = serializeMapTxt(cleanMap);
				const data = new TextEncoder().encode(content);
				await pushFile(adb, `${state.devicePath}/map.txt`, data);
			}
			state.displayNameMap = cleanMap;

			// Sync to sibling emulator directories
			const deletedKeys = rom.displayName ? new Set<string>() : new Set([rom.name]);
			await syncMapTxtToSiblings(state, cleanMap, deletedKeys);

			// Recheck system dirty state
			state.displayNameDirty = state.roms.some(
				(r) => (r.displayName || '') !== (state.displayNameMap.get(r.name) || '')
			);
		} catch (e) {
			state.error = `Failed to save name: ${formatError(e)}`;
		} finally {
			savingNameFor = null;
		}
	}

	let filteredSystems = $derived(
		hideEmpty ? systems.filter((s) => s.romCount === null || s.romCount > 0) : systems
	);

	// Refresh on mount + cleanup blob URLs on unmount
	$effect(() => {
		untrack(() => refreshAll());
		return () => {
			for (const s of systems) {
				cleanupThumbnails(s);
			}
		};
	});
</script>

<div class="p-6 flex flex-col h-full">
	{#if syncActive}
		<RomSyncFlow bind:this={syncFlow} {adb} oncomplete={onSyncComplete} />
	{:else}
		<!-- Browse Mode -->
		<div class="flex items-center justify-between mb-6">
			<h2 class="text-2xl font-bold text-text">ROM Systems</h2>
			<div class="flex items-center gap-4">
				{#if hasDirectoryPicker}
					<ActionButton
						onclick={startSyncFlow}
						variant="primary"
					>
						Sync from Folder
					</ActionButton>
				{/if}
				<label class="flex items-center gap-2 text-sm text-text-muted cursor-pointer">
					<input type="checkbox" bind:checked={hideEmpty} class="accent-accent" />
					Show systems with files only
				</label>
				<ActionButton
					onclick={refreshAll}
					disabled={refreshing}
					variant="secondary"
				>
					{refreshing ? 'Refreshing...' : 'Refresh'}
				</ActionButton>
			</div>
		</div>

		<div class="space-y-2">
			{#each filteredSystems as s}
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					class="relative border border-border rounded-lg overflow-hidden"
					ondragenter={(event) => handleSystemDragEnter(event, s)}
					ondragover={(event) => handleSystemDragOver(event, s)}
					ondragleave={(event) => handleSystemDragLeave(event, s)}
					ondrop={(event) => handleSystemDrop(event, s)}
				>
					{#if dragTargetPath === s.devicePath}
						<div
							class="absolute inset-0 z-10 bg-bg/80 border-2 border-dashed border-accent rounded-lg flex items-center justify-center pointer-events-none"
						>
							<span class="text-sm font-medium text-accent">
								Upload ROMs to {s.system.systemName}
							</span>
						</div>
					{/if}
					<!-- System Header -->
					<button
						onclick={() => toggleExpand(s)}
						class="w-full flex items-center justify-between p-3 bg-surface hover:bg-surface-hover text-left"
					>
						<div>
							<span class="font-semibold text-text">{s.system.systemName}</span>
							<span class="text-sm text-text-muted ml-2">({s.system.systemCode})</span>
							{#if s.system.isCustom}
								<span class="text-xs text-text-muted ml-1 italic">Custom</span>
							{/if}
							{#if availableEmus.size > 0 && !availableEmus.has(s.system.systemCode)}
								{@const emuMsg = `No emulator found at Emus/${detectedPlatform}/${s.system.systemCode}.pak\n\nUse the Pak Store on your device to download more emulators.`}
								<!-- svelte-ignore a11y_no_static_element_interactions -->
								<span
									onclick={(e: MouseEvent) => {
										e.stopPropagation();
										missingEmuInfo = emuMsg;
									}}
									onkeydown={(e: KeyboardEvent) => {
										if (e.key === 'Enter' || e.key === ' ') {
											e.stopPropagation();
											e.preventDefault();
											missingEmuInfo = emuMsg;
										}
									}}
									role="button"
									tabindex="0"
									title={emuMsg}
									class="text-xs text-warning ml-2 hover:opacity-80 cursor-pointer"
								>
									&#9888; Missing emulator
								</span>
							{/if}
						</div>
						<div class="flex items-center gap-3">
							{#if s.loading}
								<span class="text-sm text-text-muted">Counting...</span>
							{:else if s.romCount !== null}
								<span class="text-sm {s.romCount > 0 ? 'text-success' : 'text-text-muted'}">
									{plural(s.romCount, 'ROM')}
								</span>
								{#if s.mediaCount > 0}
									<span class="text-sm text-text-muted">
										{s.mediaCount} w/art
									</span>
								{/if}
							{/if}
							<span class="text-text-muted">{s.expanded ? '\u25B2' : '\u25BC'}</span>
						</div>
					</button>

					<!-- Details (expanded) -->
					{#if s.expanded}
						<div class="p-3 space-y-3">
							<div class="flex items-center justify-between">
								<div>
									<div class="text-xs text-text-muted font-mono">{s.devicePath}</div>
									{#if s.system.isCustom}
										<div class="text-xs text-text-muted italic">All file types</div>
									{:else}
										<div class="text-xs text-text-muted">
											Formats: {s.system.supportedFormats.join(', ')}
										</div>
									{/if}
								</div>
								<div class="flex items-center gap-2">
									{#if s.displayNameDirty}
										<ActionButton
											onclick={() => saveDisplayNames(s)}
											disabled={s.savingNames}
											variant="success"
										>
											{s.savingNames ? 'Saving...' : 'Save Names'}
										</ActionButton>
									{/if}
									<ActionButton
										onclick={() => uploadRoms(s)}
										disabled={uploadingTo !== null}
										variant="primary"
									>
										{uploadingTo === s.system.systemCode ? 'Uploading...' : 'Upload ROMs'}
									</ActionButton>
								</div>
							</div>

							{#if s.error}
								<div class="text-xs text-warning">{s.error}</div>
							{/if}

							<!-- Special media images -->
							{#if s.romsLoaded}
								<div class="flex gap-3">
									{#each [{ name: s.iconFileName, label: 'Icon', url: s.iconUrl }, { name: 'bg.png', label: 'bg.png', url: s.bgUrl }, { name: 'bglist.png', label: 'bglist.png', url: s.bglistUrl }] as media (media.name)}
										<div
											class="w-40 border border-border rounded-lg overflow-hidden bg-bg shrink-0"
										>
											<!-- Preview area -->
											{#if media.url}
												<button
													onclick={() => {
														previewSrc = media.url;
														previewAlt = `${s.system.systemName} — ${media.label}`;
													}}
													class="h-28 w-full bg-surface cursor-pointer grid place-items-center p-1"
												>
													<img
														src={media.url}
														alt={media.label}
														class="max-w-full max-h-full object-contain"
													/>
												</button>
											{:else}
												<div class="h-28 bg-surface grid place-items-center">
													<span class="text-text-muted text-xs">No {media.label}</span>
												</div>
											{/if}
											<!-- Buttons -->
											<div class="border-t border-border/60 px-1.5 pt-1.5 pb-1 space-y-1.5">
												<div class="text-[11px] leading-tight text-text-muted break-all text-center">
													{media.label}
												</div>
												<div class="flex items-center justify-center gap-1">
													<ActionButton
														onclick={() => uploadSpecialMedia(s, media.name)}
														disabled={uploadingBg !== null || removingBg !== null}
														variant={media.url ? 'subtle' : 'primary'}
														size="none"
														class={media.url ? 'text-xs px-1.5 py-0.5' : 'text-xs px-2 py-0.5'}
													>
														{uploadingBg === `${s.system.systemCode}/${media.name}`
															? '...'
															: media.url
																? 'Replace'
																: 'Add'}
													</ActionButton>
													{#if media.url}
														<ActionButton
															onclick={() => removeSpecialMedia(s, media.name)}
															disabled={removingBg !== null || uploadingBg !== null}
															variant="danger"
															size="none"
															class="text-xs px-1.5 py-0.5"
														>
															{removingBg === `${s.system.systemCode}/${media.name}`
																? '...'
																: 'Delete'}
														</ActionButton>
													{/if}
												</div>
											</div>
										</div>
									{/each}
								</div>
							{/if}

							<!-- ROM List -->
							{#if s.loadingRoms}
								<div class="text-sm text-text-muted py-4 text-center">Loading ROMs...</div>
							{:else if s.roms.length === 0 && s.romsLoaded}
								<div class="text-sm text-text-muted py-4 text-center">No ROMs found</div>
							{:else}
								<div class="space-y-1 max-h-96 overflow-y-auto">
									{#each s.roms as rom}
										<div class="flex items-center gap-3 py-1.5 px-2 rounded hover:bg-surface-hover">
											<!-- Thumbnail -->
											<div
												class="w-10 h-10 shrink-0 rounded overflow-hidden bg-surface flex items-center justify-center"
											>
												{#if rom.loadingThumb}
													<div class="w-10 h-10 bg-surface-hover animate-pulse rounded"></div>
												{:else if rom.thumbnailUrl}
													<button
														onclick={() => openPreview(rom)}
														class="w-full h-full cursor-pointer"
													>
														<img
															src={rom.thumbnailUrl}
															alt={rom.baseName}
															class="w-10 h-10 object-cover"
														/>
													</button>
												{:else}
													<span class="text-text-muted text-lg">&#127918;</span>
												{/if}
											</div>

											<!-- ROM info -->
											<div class="flex-1 min-w-0">
												{#if rom.displayName}
													<div class="text-sm text-text truncate">
														{#if rom.displayName.startsWith('.')}
															<span class="text-text-muted text-xs mr-1">[hidden]</span>
														{/if}
														{rom.displayName}
													</div>
													<div class="text-xs text-text-muted truncate">{rom.name}</div>
												{:else}
													<div class="text-sm text-text truncate">{rom.name}</div>
													{#if rom.hasMedia}
														<div class="text-xs text-text-muted truncate">{rom.mediaFileName}</div>
													{:else}
														<div class="text-xs text-text-muted italic">No media</div>
													{/if}
												{/if}
											</div>

											<!-- Size -->
											<div class="text-xs text-text-muted tabular-nums shrink-0">
												{formatSize(rom.size)}
											</div>

											<!-- Action buttons -->
											<div class="flex items-center gap-1 shrink-0">
												<ActionButton
													onclick={() => renameRom(s, rom)}
													variant="subtle"
													size="xs"
													title="Set display name"
												>
													Rename
												</ActionButton>
												{#if (rom.displayName || '') !== (s.displayNameMap.get(rom.name) || '')}
													<ActionButton
														onclick={() => saveDisplayNameForRom(s, rom)}
														disabled={savingNameFor !== null}
														variant="success"
														size="xs"
														title="Save display name to device"
													>
														{savingNameFor === rom.name ? 'Saving...' : 'Save name'}
													</ActionButton>
												{/if}
												<ActionButton
													onclick={() => uploadMedia(s, rom)}
													disabled={uploadingMediaFor !== null ||
														removingMediaFor !== null ||
														removingRom !== null}
													variant={rom.hasMedia ? 'subtle' : 'primary'}
													size="xs"
													title={rom.hasMedia
														? `Replace ${rom.mediaFileName}`
														: `Upload art as ${rom.mediaFileName}`}
												>
													{#if uploadingMediaFor === rom.name}
														Uploading...
													{:else if rom.hasMedia}
														Replace art
													{:else}
														Add art
													{/if}
												</ActionButton>
												{#if rom.hasMedia}
													<ActionButton
														onclick={() => removeMedia(s, rom)}
														disabled={removingMediaFor !== null ||
															uploadingMediaFor !== null ||
															removingRom !== null}
														variant="subtle"
														size="xs"
														title={`Remove ${rom.mediaFileName}`}
													>
														{removingMediaFor === rom.name ? 'Removing...' : 'Remove art'}
													</ActionButton>
												{/if}
												<ActionButton
													onclick={() => removeRom(s, rom)}
													disabled={removingRom !== null ||
														removingMediaFor !== null ||
														uploadingMediaFor !== null}
													variant="danger"
													size="xs"
													title={`Delete ${rom.name}`}
												>
													{removingRom === rom.name ? 'Deleting...' : 'Delete'}
												</ActionButton>
											</div>
										</div>
									{/each}
								</div>
							{/if}
						</div>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</div>

{#if previewSrc}
	<ImagePreview src={previewSrc} alt={previewAlt} onClose={closePreview} />
{/if}

<OverwriteDialog bind:this={overwriteDialog} />
<LargeArtDialog bind:this={largeArtDialog} />

{#if missingEmuInfo}
	<Modal onclose={() => (missingEmuInfo = null)}>
		<div class="p-6">
			<h3 class="text-lg font-bold text-text mb-3">Missing Emulator</h3>
			<p class="text-sm text-text whitespace-pre-line">{missingEmuInfo}</p>
			<div class="mt-4 flex justify-end">
				<ActionButton
					onclick={() => (missingEmuInfo = null)}
					variant="secondary"
				>
					OK
				</ActionButton>
			</div>
		</div>
	</Modal>
{/if}
