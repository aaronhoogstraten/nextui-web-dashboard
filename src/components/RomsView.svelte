<script lang="ts">
	import { untrack } from 'svelte';
	import type { Adb } from '@yume-chan/adb';
	import {
		ROM_SYSTEMS,
		getRomDevicePath,
		getRomMediaPath,
		isValidRomExtension,
		parseRomDirectoryName,
		type RomSystem
	} from '$lib/roms/index.js';
	import { DEVICE_PATHS } from '$lib/adb/types.js';
	import { listDirectory, pathExists, pullFile, pushFile, shell } from '$lib/adb/file-ops.js';
	import ImagePreview from './ImagePreview.svelte';

	let { adb }: { adb: Adb } = $props();

	interface RomEntry {
		name: string;
		baseName: string;
		size: bigint;
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
	let uploadingTo: string | null = $state(null);
	let uploadingBg: string | null = $state(null);
	let removingBg: string | null = $state(null);
	let uploadingMediaFor: string | null = $state(null);
	let previewSrc: string | null = $state(null);
	let previewAlt: string = $state('');

	async function refreshAll() {
		refreshing = true;

		// Remove previously discovered custom systems (they'll be re-discovered)
		for (const s of systems) {
			if (s.system.isCustom) cleanupThumbnails(s);
		}
		systems = systems.filter((s) => !s.system.isCustom);

		// Check predefined systems
		for (const s of systems) {
			s.loading = true;
			s.error = '';
			try {
				const entries = await listDirectory(adb, s.devicePath);
				s.romCount = entries.filter((e) => e.isFile && !e.name.startsWith('.')).length;
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

		// Discover custom systems from device
		const knownCodes = new Set(ROM_SYSTEMS.map((s) => s.systemCode));
		try {
			const romDirs = await listDirectory(adb, DEVICE_PATHS.roms);
			for (const dir of romDirs) {
				if (!dir.isDirectory || dir.name.startsWith('.')) continue;
				const parsed = parseRomDirectoryName(dir.name);
				if (!parsed || knownCodes.has(parsed.systemCode)) continue;

				const devicePath = `${DEVICE_PATHS.roms}/${dir.name}`;
				let romCount = 0;
				try {
					const entries = await listDirectory(adb, devicePath);
					romCount = entries.filter((e) => e.isFile && !e.name.startsWith('.')).length;
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
		} catch {
			// Roms directory unreadable — skip discovery
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
				.filter((e) => e.isFile && !e.name.startsWith('.'))
				.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

			// Get media files
			let mediaNames = new Set<string>();
			const mediaPath = getRomMediaPath(state.system);
			try {
				const mediaEntries = await listDirectory(adb, mediaPath);
				mediaNames = new Set(mediaEntries.filter((e) => e.isFile).map((e) => e.name));
			} catch {
				// .media directory may not exist — that's fine
			}

			// Load special media images if present
			if (state.bgUrl) { URL.revokeObjectURL(state.bgUrl); state.bgUrl = null; }
			if (state.bglistUrl) { URL.revokeObjectURL(state.bglistUrl); state.bglistUrl = null; }
			if (state.iconUrl) { URL.revokeObjectURL(state.iconUrl); state.iconUrl = null; }
			for (const fileName of ['bg.png', 'bglist.png']) {
				if (mediaNames.has(fileName)) {
					try {
						const data = await pullFile(adb, `${mediaPath}/${fileName}`);
						const url = URL.createObjectURL(new Blob([data as unknown as BlobPart], { type: 'image/png' }));
						if (fileName === 'bg.png') state.bgUrl = url;
						else state.bglistUrl = url;
					} catch { /* skip */ }
				}
			}
			// System icon lives in Roms/.media/ (parent directory)
			try {
				const iconPath = `${DEVICE_PATHS.roms}/.media/${state.iconFileName}`;
				const data = await pullFile(adb, iconPath);
				state.iconUrl = URL.createObjectURL(new Blob([data as unknown as BlobPart], { type: 'image/png' }));
			} catch { /* icon doesn't exist — skip */ }

			// Load map.txt for display names
			let displayNameMap = new Map<string, string>();
			try {
				const mapExists = await pathExists(adb, `${state.devicePath}/map.txt`);
				if (mapExists) {
					const mapData = await pullFile(adb, `${state.devicePath}/map.txt`);
					const mapContent = new TextDecoder().decode(mapData);
					displayNameMap = parseMapTxt(mapContent);
				}
			} catch { /* map.txt read failed — skip */ }
			state.displayNameMap = displayNameMap;
			state.displayNameDirty = false;

			// Build ROM entries with media matching
			state.roms = romFiles.map((f) => {
				const baseName = getBaseName(f.name);
				const mediaFileName = `${baseName}.png`;
				const hasMedia = mediaNames.has(mediaFileName);
				return {
					name: f.name,
					baseName,
					size: f.size,
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
			state.error = `Failed to load ROMs: ${e instanceof Error ? e.message : String(e)}`;
		}

		state.loadingRoms = false;
	}

	async function loadThumbnails(state: SystemState) {
		const mediaPath = getRomMediaPath(state.system);
		for (const rom of state.roms) {
			if (!rom.hasMedia || rom.thumbnailUrl) continue;
			rom.loadingThumb = true;
			try {
				const data = await pullFile(adb, `${mediaPath}/${rom.mediaFileName}`);
				const blob = new Blob([data as unknown as BlobPart], { type: 'image/png' });
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
		if (state.bgUrl) { URL.revokeObjectURL(state.bgUrl); state.bgUrl = null; }
		if (state.bglistUrl) { URL.revokeObjectURL(state.bglistUrl); state.bglistUrl = null; }
		if (state.iconUrl) { URL.revokeObjectURL(state.iconUrl); state.iconUrl = null; }
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
		return `${getRomMediaPath(state.system)}/${filename}`;
	}

	function getSpecialMediaDir(state: SystemState, filename: string): string {
		if (filename === state.iconFileName) {
			return `${DEVICE_PATHS.roms}/.media`;
		}
		return getRomMediaPath(state.system);
	}

	async function uploadSpecialMedia(state: SystemState, filename: string) {
		const input = document.createElement('input');
		input.type = 'file';
		input.accept = '.png';

		input.onchange = async () => {
			const file = input.files?.[0];
			if (!file) return;

			uploadingBg = `${state.system.systemCode}/${filename}`;
			try {
				const dir = getSpecialMediaDir(state, filename);
				const dirExists = await pathExists(adb, dir);
				if (!dirExists) {
					await shell(adb, `mkdir -p "${dir}"`);
				}

				const data = new Uint8Array(await file.arrayBuffer());
				await pushFile(adb, getSpecialMediaPath(state, filename), data);
				const url = URL.createObjectURL(new Blob([data as unknown as BlobPart], { type: 'image/png' }));
				setSpecialMedia(state, filename, url);
			} catch (e) {
				state.error = `Upload failed: ${e instanceof Error ? e.message : String(e)}`;
			} finally {
				uploadingBg = null;
			}
		};

		input.click();
	}

	async function removeSpecialMedia(state: SystemState, filename: string) {
		if (!confirm(`Delete ${filename} from ${state.system.systemName}?`)) return;

		removingBg = `${state.system.systemCode}/${filename}`;
		try {
			await shell(adb, `rm "${getSpecialMediaPath(state, filename)}"`);
			setSpecialMedia(state, filename, null);
		} catch (e) {
			state.error = `Delete failed: ${e instanceof Error ? e.message : String(e)}`;
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

	function formatSize(size: bigint): string {
		const n = Number(size);
		if (n < 1024) return `${n} B`;
		if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
		if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
		return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
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

	async function uploadRoms(state: SystemState) {
		const input = document.createElement('input');
		input.type = 'file';
		input.multiple = true;
		input.accept = state.system.isCustom ? '' : state.system.supportedFormats.join(',');

		input.onchange = async () => {
			const files = input.files;
			if (!files || files.length === 0) return;

			uploadingTo = state.system.systemCode;
			let uploaded = 0;

			try {
				for (const file of files) {
					const ext = '.' + file.name.split('.').pop()?.toLowerCase();
					if (!isValidRomExtension(ext, state.system)) {
						continue;
					}

					const data = new Uint8Array(await file.arrayBuffer());
					const remotePath = `${state.devicePath}/${file.name}`;
					await pushFile(adb, remotePath, data);
					uploaded++;
				}

				state.error = uploaded > 0 ? `Uploaded ${uploaded} file(s)` : 'No valid files selected';
				// Reload ROM details
				cleanupThumbnails(state);
				state.roms = [];
				state.romsLoaded = false;
				if (state.expanded) {
					await loadRomDetails(state);
				} else {
					// At least refresh count
					try {
						const entries = await listDirectory(adb, state.devicePath);
						state.romCount = entries.filter((e) => e.isFile && !e.name.startsWith('.')).length;
					} catch {
						// ignore
					}
				}
			} catch (e) {
				state.error = `Upload failed: ${e instanceof Error ? e.message : String(e)}`;
			} finally {
				uploadingTo = null;
			}
		};

		input.click();
	}

	async function uploadMedia(state: SystemState, rom: RomEntry) {
		const input = document.createElement('input');
		input.type = 'file';
		input.accept = '.png';

		input.onchange = async () => {
			const file = input.files?.[0];
			if (!file) return;

			uploadingMediaFor = rom.name;

			try {
				const mediaPath = getRomMediaPath(state.system);

				// Ensure .media directory exists
				const mediaDirExists = await pathExists(adb, mediaPath);
				if (!mediaDirExists) {
					await shell(adb, `mkdir -p "${mediaPath}"`);
				}

				const data = new Uint8Array(await file.arrayBuffer());
				// Auto-rename to match the ROM's base name
				const remotePath = `${mediaPath}/${rom.mediaFileName}`;
				await pushFile(adb, remotePath, data);

				// Update state and load the new thumbnail
				rom.hasMedia = true;
				const blob = new Blob([data as unknown as BlobPart], { type: 'image/png' });
				if (rom.thumbnailUrl) URL.revokeObjectURL(rom.thumbnailUrl);
				rom.thumbnailUrl = URL.createObjectURL(blob);
				state.mediaCount = state.roms.filter((r) => r.hasMedia).length;
			} catch (e) {
				state.error = `Media upload failed: ${e instanceof Error ? e.message : String(e)}`;
			} finally {
				uploadingMediaFor = null;
			}
		};

		input.click();
	}

	let removingRom: string | null = $state(null);
	let removingMediaFor: string | null = $state(null);

	async function removeRom(state: SystemState, rom: RomEntry) {
		if (!confirm(`Delete "${rom.name}"${rom.hasMedia ? ' and its box art' : ''}?`)) return;
		removingRom = rom.name;
		try {
			// Remove the ROM file
			await shell(adb, `rm "${state.devicePath}/${rom.name}"`);

			// Also remove media art if present
			if (rom.hasMedia) {
				const mediaPath = getRomMediaPath(state.system);
				await shell(adb, `rm "${mediaPath}/${rom.mediaFileName}"`);
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
			state.error = `Delete failed: ${e instanceof Error ? e.message : String(e)}`;
		} finally {
			removingRom = null;
		}
	}

	async function removeMedia(state: SystemState, rom: RomEntry) {
		removingMediaFor = rom.name;
		try {
			const mediaPath = getRomMediaPath(state.system);
			const remotePath = `${mediaPath}/${rom.mediaFileName}`;
			await shell(adb, `rm "${remotePath}"`);

			if (rom.thumbnailUrl) {
				URL.revokeObjectURL(rom.thumbnailUrl);
				rom.thumbnailUrl = null;
			}
			rom.hasMedia = false;
			state.mediaCount = state.roms.filter((r) => r.hasMedia).length;
		} catch (e) {
			state.error = `Remove failed: ${e instanceof Error ? e.message : String(e)}`;
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
				await shell(adb, `rm -f "${state.devicePath}/map.txt"`);
			} else {
				const content = serializeMapTxt(newMap);
				const data = new TextEncoder().encode(content);
				await pushFile(adb, `${state.devicePath}/map.txt`, data);
			}
			state.displayNameMap = newMap;
			state.displayNameDirty = false;
		} catch (e) {
			state.error = `Failed to save names: ${e instanceof Error ? e.message : String(e)}`;
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
				await shell(adb, `rm -f "${state.devicePath}/map.txt"`);
			} else {
				const content = serializeMapTxt(cleanMap);
				const data = new TextEncoder().encode(content);
				await pushFile(adb, `${state.devicePath}/map.txt`, data);
			}
			state.displayNameMap = cleanMap;

			// Recheck system dirty state
			state.displayNameDirty = state.roms.some(
				(r) => (r.displayName || '') !== (state.displayNameMap.get(r.name) || '')
			);
		} catch (e) {
			state.error = `Failed to save name: ${e instanceof Error ? e.message : String(e)}`;
		} finally {
			savingNameFor = null;
		}
	}

	let filteredSystems = $derived(
		hideEmpty
			? systems.filter((s) => s.romCount === null || s.romCount > 0)
			: systems
	);

	// Refresh on mount (untrack to prevent reactive loop)
	$effect(() => {
		untrack(() => refreshAll());
	});

	// =============================================
	// ROM Sync
	// =============================================

	interface SyncFile {
		name: string;
		localSize: number;
		deviceSize: number | null;
		status: 'new' | 'exists';
		checked: boolean;
		isMedia: boolean;
		fileHandle: FileSystemFileHandle;
	}

	interface SyncSystem {
		dirName: string;
		files: SyncFile[];
		expanded: boolean;
	}

	type SyncPhase = 'idle' | 'scanning' | 'review' | 'syncing' | 'done';
	type ConflictResolution = 'overwrite' | 'skip' | 'overwrite-all' | 'skip-all';

	let syncPhase: SyncPhase = $state('idle');
	let syncError: string = $state('');
	let syncSystems: SyncSystem[] = $state([]);
	let syncScanStatus: string = $state('');
	let syncCurrentSystem: string = $state('');
	let syncCurrentFile: string = $state('');
	let syncCompleted = $state(0);
	let syncTotal = $state(0);
	let syncTransferred = $state(0);
	let syncSkipped = $state(0);
	let syncFailed = $state(0);
	let syncConflictFile: SyncFile | null = $state(null);
	let syncConflictResolve: ((r: ConflictResolution) => void) | null = $state(null);

	const hasDirectoryPicker = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

	const syncTotalNew = $derived(
		syncSystems.reduce((sum, s) => sum + s.files.filter((f) => f.status === 'new').length, 0)
	);
	const syncTotalExisting = $derived(
		syncSystems.reduce((sum, s) => sum + s.files.filter((f) => f.status === 'exists').length, 0)
	);
	const syncTotalChecked = $derived(
		syncSystems.reduce((sum, s) => sum + s.files.filter((f) => f.checked).length, 0)
	);

	function syncSystemCounts(sys: SyncSystem) {
		return {
			newCount: sys.files.filter((f) => f.status === 'new').length,
			existsCount: sys.files.filter((f) => f.status === 'exists').length,
			checkedCount: sys.files.filter((f) => f.checked).length
		};
	}

	function syncFormatSize(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
		return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
	}

	async function startSyncFlow() {
		syncError = '';
		try {
			const dirHandle = await (window as any).showDirectoryPicker({ mode: 'read' });
			syncPhase = 'scanning';
			await scanSyncFolder(dirHandle);
			syncPhase = 'review';
		} catch (e: any) {
			if (e.name === 'AbortError') return;
			syncError = `Failed to select folder: ${e.message || String(e)}`;
		}
	}

	async function scanSyncFolder(dirHandle: FileSystemDirectoryHandle) {
		syncSystems = [];
		syncScanStatus = 'Scanning local folder...';

		const localSystems: { dirName: string; files: SyncFile[] }[] = [];

		for await (const entry of (dirHandle as any).values()) {
			if (entry.kind !== 'directory') continue;
			const parsed = parseRomDirectoryName(entry.name);
			if (!parsed) continue;

			syncScanStatus = `Scanning ${entry.name}...`;
			const sysFiles: SyncFile[] = [];

			const sysDirHandle = await (dirHandle as any).getDirectoryHandle(entry.name);
			for await (const fileEntry of (sysDirHandle as any).values()) {
				if (fileEntry.kind !== 'file' || fileEntry.name.startsWith('.')) continue;
				const file = await fileEntry.getFile();
				sysFiles.push({
					name: fileEntry.name, localSize: file.size, deviceSize: null,
					status: 'new', checked: true, isMedia: false, fileHandle: fileEntry
				});
			}

			try {
				const mediaDirHandle = await (sysDirHandle as any).getDirectoryHandle('.media');
				for await (const mediaEntry of (mediaDirHandle as any).values()) {
					if (mediaEntry.kind !== 'file' || mediaEntry.name.startsWith('.')) continue;
					const file = await mediaEntry.getFile();
					sysFiles.push({
						name: mediaEntry.name, localSize: file.size, deviceSize: null,
						status: 'new', checked: true, isMedia: true, fileHandle: mediaEntry
					});
				}
			} catch { /* no .media/ */ }

			if (sysFiles.length > 0) {
				localSystems.push({ dirName: entry.name, files: sysFiles });
			}
		}

		if (localSystems.length === 0) {
			syncError = 'No system directories found matching the expected pattern (e.g. "Game Boy (GB)").';
			syncPhase = 'idle';
			return;
		}

		syncScanStatus = 'Comparing with device...';

		for (const sys of localSystems) {
			syncScanStatus = `Comparing ${sys.dirName}...`;
			const devicePath = `${DEVICE_PATHS.roms}/${sys.dirName}`;

			const deviceFileMap = new Map<string, number>();
			try {
				for (const e of await listDirectory(adb, devicePath)) {
					if (e.isFile && !e.name.startsWith('.')) deviceFileMap.set(e.name, Number(e.size));
				}
			} catch { /* dir doesn't exist */ }

			const deviceMediaMap = new Map<string, number>();
			try {
				for (const e of await listDirectory(adb, `${devicePath}/.media`)) {
					if (e.isFile && !e.name.startsWith('.')) deviceMediaMap.set(e.name, Number(e.size));
				}
			} catch { /* no .media/ */ }

			for (const file of sys.files) {
				const deviceSize = (file.isMedia ? deviceMediaMap : deviceFileMap).get(file.name);
				if (deviceSize !== undefined) {
					file.status = 'exists';
					file.deviceSize = deviceSize;
					file.checked = false;
				}
			}
		}

		syncSystems = localSystems
			.sort((a, b) => a.dirName.localeCompare(b.dirName, undefined, { sensitivity: 'base' }))
			.map((s) => ({ ...s, expanded: false }));
		syncScanStatus = '';
	}

	function syncCheckAllNew() {
		for (const sys of syncSystems) {
			for (const f of sys.files) {
				if (f.status === 'new') f.checked = true;
			}
		}
	}

	function syncCheckNewInSystem(sys: SyncSystem) {
		for (const f of sys.files) {
			if (f.status === 'new') f.checked = true;
		}
	}

	function syncCheckAllInSystem(sys: SyncSystem) {
		for (const f of sys.files) f.checked = true;
	}

	function syncUncheckSystem(sys: SyncSystem) {
		for (const f of sys.files) f.checked = false;
	}

	function exitSync() {
		syncPhase = 'idle';
		syncSystems = [];
		syncError = '';
		syncCompleted = 0;
		syncTotal = 0;
		syncTransferred = 0;
		syncSkipped = 0;
		syncFailed = 0;
		// Refresh the ROM list to reflect any synced files
		refreshAll();
	}

	async function executeSync() {
		const filesToSync = syncSystems.flatMap((sys) =>
			sys.files.filter((f) => f.checked).map((f) => ({ system: sys.dirName, file: f }))
		);
		if (filesToSync.length === 0) { syncError = 'No files selected.'; return; }

		syncPhase = 'syncing';
		syncError = '';
		syncCompleted = 0;
		syncTotal = filesToSync.length;
		syncTransferred = 0;
		syncSkipped = 0;
		syncFailed = 0;

		let conflictPolicy: 'ask' | 'overwrite-all' | 'skip-all' = 'ask';

		for (const item of filesToSync) {
			syncCurrentSystem = item.system;
			syncCurrentFile = item.file.name;

			if (item.file.status === 'exists') {
				if (conflictPolicy === 'skip-all') {
					syncSkipped++; syncCompleted++; continue;
				}
				if (conflictPolicy === 'ask') {
					const resolution = await showSyncConflict(item.file);
					if (resolution === 'skip') { syncSkipped++; syncCompleted++; continue; }
					if (resolution === 'skip-all') { syncSkipped++; syncCompleted++; conflictPolicy = 'skip-all'; continue; }
					if (resolution === 'overwrite-all') conflictPolicy = 'overwrite-all';
				}
			}

			try {
				const devicePath = `${DEVICE_PATHS.roms}/${item.system}`;
				await shell(adb, `mkdir -p "${item.file.isMedia ? devicePath + '/.media' : devicePath}"`);
				const file = await item.file.fileHandle.getFile();
				const data = new Uint8Array(await file.arrayBuffer());
				const remotePath = item.file.isMedia
					? `${devicePath}/.media/${item.file.name}`
					: `${devicePath}/${item.file.name}`;
				await pushFile(adb, remotePath, data);
				syncTransferred++;
			} catch { syncFailed++; }

			syncCompleted++;
		}

		syncCurrentSystem = '';
		syncCurrentFile = '';
		syncPhase = 'done';
	}

	function showSyncConflict(file: SyncFile): Promise<ConflictResolution> {
		return new Promise((resolve) => {
			syncConflictFile = file;
			syncConflictResolve = resolve;
		});
	}

	function resolveSyncConflict(resolution: ConflictResolution) {
		if (syncConflictResolve) {
			syncConflictResolve(resolution);
			syncConflictFile = null;
			syncConflictResolve = null;
		}
	}
</script>

<div class="p-6 flex flex-col h-full">
{#if syncPhase === 'idle'}
	<!-- Browse Mode -->
	<div class="flex items-center justify-between mb-6">
		<h2 class="text-2xl font-bold text-text">ROM Systems</h2>
		<div class="flex items-center gap-4">
			{#if hasDirectoryPicker}
				<button
					onclick={startSyncFlow}
					class="text-sm bg-accent text-white px-3 py-1.5 rounded hover:bg-accent-hover"
				>
					Sync from Folder
				</button>
			{/if}
			<label class="flex items-center gap-2 text-sm text-text-muted cursor-pointer">
				<input type="checkbox" bind:checked={hideEmpty} class="accent-accent" />
				Show systems with files only
			</label>
			<button
				onclick={refreshAll}
				disabled={refreshing}
				class="text-sm bg-surface hover:bg-surface-hover text-text disabled:opacity-50 px-3 py-1.5 rounded"
			>
				{refreshing ? 'Refreshing...' : 'Refresh'}
			</button>
		</div>
	</div>

	{#if syncError}
		<div class="text-xs text-yellow-500 mb-3">{syncError}</div>
	{/if}

	<div class="space-y-2">
		{#each filteredSystems as s}
			<div class="border border-border rounded-lg overflow-hidden">
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
					</div>
					<div class="flex items-center gap-3">
						{#if s.loading}
							<span class="text-sm text-text-muted">Counting...</span>
						{:else if s.romCount !== null}
							<span class="text-sm {s.romCount > 0 ? 'text-green-500' : 'text-text-muted'}">
								{s.romCount} ROM{s.romCount !== 1 ? 's' : ''}
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
									<button
										onclick={() => saveDisplayNames(s)}
										disabled={s.savingNames}
										class="text-sm bg-green-700 text-white px-3 py-1.5 rounded hover:bg-green-600 disabled:opacity-50"
									>
										{s.savingNames ? 'Saving...' : 'Save Names'}
									</button>
								{/if}
								<button
									onclick={() => uploadRoms(s)}
									disabled={uploadingTo !== null}
									class="text-sm bg-accent text-white px-3 py-1.5 rounded hover:bg-accent-hover disabled:opacity-50"
								>
									{uploadingTo === s.system.systemCode ? 'Uploading...' : 'Upload ROMs'}
								</button>
							</div>
						</div>

						{#if s.error}
							<div class="text-xs text-yellow-500">{s.error}</div>
						{/if}

						<!-- Special media images -->
						{#if s.romsLoaded}
							<div class="flex gap-3">
								{#each [{ name: s.iconFileName, label: 'Icon', url: s.iconUrl }, { name: 'bg.png', label: 'bg.png', url: s.bgUrl }, { name: 'bglist.png', label: 'bglist.png', url: s.bglistUrl }] as media (media.name)}
									<div class="w-40 border border-border rounded-lg overflow-hidden bg-bg shrink-0">
										<!-- Preview area -->
										{#if media.url}
											<!-- svelte-ignore a11y_click_events_have_key_events -->
											<!-- svelte-ignore a11y_no_static_element_interactions -->
											<div
												onclick={() => { previewSrc = media.url; previewAlt = `${s.system.systemName} — ${media.label}`; }}
												class="h-28 bg-surface cursor-pointer grid place-items-center p-1"
											>
												<img src={media.url} alt={media.label} class="max-w-full max-h-full object-contain" />
											</div>
										{:else}
											<div class="h-28 bg-surface grid place-items-center">
												<span class="text-text-muted text-xs">No {media.label}</span>
											</div>
										{/if}
										<!-- Buttons -->
										<div class="flex items-center justify-between px-1.5 py-1">
											<span class="text-xs text-text-muted truncate">{media.label}</span>
											<div class="flex items-center shrink-0">
												<button
													onclick={() => uploadSpecialMedia(s, media.name)}
													disabled={uploadingBg !== null || removingBg !== null}
													class="text-xs {media.url ? 'text-text-muted hover:bg-surface' : 'text-accent'} px-1 py-0.5 rounded disabled:opacity-50"
												>
													{uploadingBg === `${s.system.systemCode}/${media.name}` ? '...' : media.url ? 'Replace' : 'Add'}
												</button>
												{#if media.url}
													<button
														onclick={() => removeSpecialMedia(s, media.name)}
														disabled={removingBg !== null || uploadingBg !== null}
														class="text-xs text-red-400 hover:bg-surface px-1 py-0.5 rounded disabled:opacity-50"
													>
														{removingBg === `${s.system.systemCode}/${media.name}` ? '...' : 'Delete'}
													</button>
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
										<div class="w-10 h-10 shrink-0 rounded overflow-hidden bg-surface flex items-center justify-center">
											{#if rom.loadingThumb}
												<div class="w-10 h-10 bg-surface-hover animate-pulse rounded"></div>
											{:else if rom.thumbnailUrl}
												<button onclick={() => openPreview(rom)} class="w-full h-full cursor-pointer">
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
											<button
												onclick={() => renameRom(s, rom)}
												class="text-xs px-2 py-1 rounded text-text-muted hover:bg-surface"
												title="Set display name"
											>
												Rename
											</button>
											{#if (rom.displayName || '') !== (s.displayNameMap.get(rom.name) || '')}
												<button
													onclick={() => saveDisplayNameForRom(s, rom)}
													disabled={savingNameFor !== null}
													class="text-xs px-2 py-1 rounded text-green-400 hover:bg-surface disabled:opacity-50"
													title="Save display name to device"
												>
													{savingNameFor === rom.name ? 'Saving...' : 'Save name'}
												</button>
											{/if}
											<button
												onclick={() => uploadMedia(s, rom)}
												disabled={uploadingMediaFor !== null || removingMediaFor !== null || removingRom !== null}
												class="text-xs px-2 py-1 rounded
													{rom.hasMedia
														? 'text-text-muted hover:bg-surface'
														: 'bg-accent text-white hover:bg-accent-hover'}
													disabled:opacity-50"
												title={rom.hasMedia ? `Replace ${rom.mediaFileName}` : `Upload art as ${rom.mediaFileName}`}
											>
												{#if uploadingMediaFor === rom.name}
													Uploading...
												{:else if rom.hasMedia}
													Replace art
												{:else}
													Add art
												{/if}
											</button>
											{#if rom.hasMedia}
												<button
													onclick={() => removeMedia(s, rom)}
													disabled={removingMediaFor !== null || uploadingMediaFor !== null || removingRom !== null}
													class="text-xs px-2 py-1 rounded text-text-muted hover:bg-surface disabled:opacity-50"
													title={`Remove ${rom.mediaFileName}`}
												>
													{removingMediaFor === rom.name ? 'Removing...' : 'Remove art'}
												</button>
											{/if}
											<button
												onclick={() => removeRom(s, rom)}
												disabled={removingRom !== null || removingMediaFor !== null || uploadingMediaFor !== null}
												class="text-xs px-2 py-1 rounded text-red-400 hover:bg-surface disabled:opacity-50"
												title={`Delete ${rom.name}`}
											>
												{removingRom === rom.name ? 'Deleting...' : 'Delete'}
											</button>
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

{:else if syncPhase === 'scanning'}
	<!-- Sync: Scanning -->
	<div class="flex-1 flex items-center justify-center">
		<div class="text-center">
			<div class="text-text mb-2">Scanning...</div>
			<div class="text-sm text-text-muted">{syncScanStatus}</div>
		</div>
	</div>

{:else if syncPhase === 'review'}
	<!-- Sync: Review Diff -->
	<div class="flex items-center justify-between mb-4">
		<div class="flex items-center gap-3">
			<button onclick={exitSync} class="text-sm text-accent hover:underline">&larr; Back</button>
			<h2 class="text-2xl font-bold text-text">Sync Review</h2>
		</div>
	</div>

	{#if syncError}
		<div class="text-xs text-yellow-500 mb-3">{syncError}</div>
	{/if}

	<div class="flex items-center gap-4 mb-3 text-sm">
		<span class="text-green-500">+{syncTotalNew} new</span>
		<span class="text-yellow-500">~{syncTotalExisting} existing</span>
		<span class="text-text-muted">{syncTotalChecked} selected</span>
		<div class="flex-1"></div>
		<button onclick={syncCheckAllNew} class="text-sm text-accent hover:underline">
			Select All New
		</button>
		<button
			onclick={executeSync}
			disabled={syncTotalChecked === 0}
			class="bg-accent text-white px-4 py-1.5 rounded hover:bg-accent-hover disabled:opacity-50 text-sm"
		>
			Start Sync ({syncTotalChecked} file{syncTotalChecked !== 1 ? 's' : ''})
		</button>
	</div>

	<div class="flex-1 overflow-auto space-y-2">
		{#each syncSystems as sys}
			{@const counts = syncSystemCounts(sys)}
			<div class="border border-border rounded-lg overflow-hidden">
				<button
					onclick={() => (sys.expanded = !sys.expanded)}
					class="w-full flex items-center justify-between p-3 bg-surface hover:bg-surface-hover text-left"
				>
					<span class="font-semibold text-text">{sys.dirName}</span>
					<div class="flex items-center gap-3 text-xs">
						{#if counts.newCount > 0}
							<span class="text-green-500">+{counts.newCount} new</span>
						{/if}
						{#if counts.existsCount > 0}
							<span class="text-yellow-500">~{counts.existsCount} existing</span>
						{/if}
						<span class="text-text-muted">{counts.checkedCount} selected</span>
						<span class="text-text-muted">{sys.expanded ? '\u25B2' : '\u25BC'}</span>
					</div>
				</button>

				{#if sys.expanded}
					<div class="p-3">
						<div class="flex items-center gap-2 mb-2">
							<button onclick={() => syncCheckNewInSystem(sys)} class="text-xs text-accent hover:underline">Select new</button>
							<button onclick={() => syncCheckAllInSystem(sys)} class="text-xs text-accent hover:underline">Select all</button>
							<button onclick={() => syncUncheckSystem(sys)} class="text-xs text-text-muted hover:text-text">Deselect all</button>
						</div>
						<table class="w-full text-sm">
							<thead>
								<tr class="text-left text-text-muted text-xs">
									<th class="py-1 px-2 w-8"></th>
									<th class="py-1 px-2 font-medium">File</th>
									<th class="py-1 px-2 font-medium w-20 text-right">Local</th>
									<th class="py-1 px-2 font-medium w-20 text-right">Device</th>
									<th class="py-1 px-2 font-medium w-16">Status</th>
								</tr>
							</thead>
							<tbody>
								{#each sys.files as file}
									<tr class="border-t border-border hover:bg-surface-hover transition-colors">
										<td class="py-1 px-2">
											<input type="checkbox" bind:checked={file.checked} class="accent-accent" />
										</td>
										<td class="py-1 px-2">
											<span class="text-text text-xs truncate block" title={file.name}>
												{#if file.isMedia}<span class="text-text-muted">.media/</span>{/if}{file.name}
											</span>
										</td>
										<td class="py-1 px-2 text-right text-text-muted text-xs tabular-nums">
											{syncFormatSize(file.localSize)}
										</td>
										<td class="py-1 px-2 text-right text-text-muted text-xs tabular-nums">
											{file.deviceSize !== null ? syncFormatSize(file.deviceSize) : '\u2014'}
										</td>
										<td class="py-1 px-2">
											{#if file.status === 'new'}
												<span class="text-xs text-green-500">New</span>
											{:else}
												<span class="text-xs text-yellow-500">Exists</span>
											{/if}
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}
			</div>
		{/each}
	</div>

{:else if syncPhase === 'syncing'}
	<!-- Sync: Progress -->
	<div class="flex-1 flex flex-col items-center justify-center gap-4">
		<div class="text-text font-medium">Syncing...</div>
		<div class="w-full max-w-md">
			<div class="flex justify-between text-xs text-text-muted mb-1">
				<span>{syncCurrentSystem}</span>
				<span>{syncCompleted}/{syncTotal}</span>
			</div>
			<div class="w-full bg-surface rounded-full h-2">
				<div class="bg-accent h-2 rounded-full transition-all" style="width: {syncTotal > 0 ? (syncCompleted / syncTotal) * 100 : 0}%"></div>
			</div>
			<div class="text-xs text-text-muted mt-2 truncate text-center" title={syncCurrentFile}>{syncCurrentFile}</div>
		</div>
		<div class="flex gap-4 text-xs">
			<span class="text-green-500">{syncTransferred} transferred</span>
			<span class="text-text-muted">{syncSkipped} skipped</span>
			{#if syncFailed > 0}
				<span class="text-red-400">{syncFailed} failed</span>
			{/if}
		</div>
	</div>

{:else if syncPhase === 'done'}
	<!-- Sync: Complete -->
	<div class="flex-1 flex items-center justify-center">
		<div class="text-center space-y-3">
			<div class="text-xl font-bold text-text">Sync Complete</div>
			<div class="flex gap-6 justify-center text-sm">
				<div class="text-center">
					<div class="text-2xl font-bold text-green-500">{syncTransferred}</div>
					<div class="text-text-muted">Transferred</div>
				</div>
				<div class="text-center">
					<div class="text-2xl font-bold text-text-muted">{syncSkipped}</div>
					<div class="text-text-muted">Skipped</div>
				</div>
				{#if syncFailed > 0}
					<div class="text-center">
						<div class="text-2xl font-bold text-red-400">{syncFailed}</div>
						<div class="text-text-muted">Failed</div>
					</div>
				{/if}
			</div>
			<button onclick={exitSync} class="bg-surface hover:bg-surface-hover text-text px-4 py-1.5 rounded text-sm mt-4">
				Back to ROMs
			</button>
		</div>
	</div>
{/if}
</div>

<!-- Sync Conflict Dialog -->
{#if syncConflictFile}
	<div class="fixed inset-0 bg-black/80 flex items-center justify-center z-50" role="dialog">
		<div class="bg-bg border border-border rounded-lg w-full max-w-md mx-4 p-6">
			<h3 class="text-lg font-bold text-text mb-3">File Already Exists</h3>
			<div class="text-sm text-text mb-4">
				<div class="font-mono text-xs text-text-muted mb-3 truncate" title={syncConflictFile.name}>{syncConflictFile.name}</div>
				<div class="flex justify-between text-xs">
					<div><span class="text-text-muted">Local:</span> <span class="text-text">{syncFormatSize(syncConflictFile.localSize)}</span></div>
					<div><span class="text-text-muted">Device:</span> <span class="text-text">{syncConflictFile.deviceSize !== null ? syncFormatSize(syncConflictFile.deviceSize) : 'unknown'}</span></div>
				</div>
			</div>
			<div class="grid grid-cols-2 gap-2">
				<button onclick={() => resolveSyncConflict('overwrite')} class="text-sm bg-accent text-white px-3 py-2 rounded hover:bg-accent-hover">Overwrite</button>
				<button onclick={() => resolveSyncConflict('skip')} class="text-sm bg-surface text-text px-3 py-2 rounded hover:bg-surface-hover">Skip</button>
				<button onclick={() => resolveSyncConflict('overwrite-all')} class="text-sm bg-accent/70 text-white px-3 py-2 rounded hover:bg-accent">Overwrite All</button>
				<button onclick={() => resolveSyncConflict('skip-all')} class="text-sm bg-surface text-text-muted px-3 py-2 rounded hover:bg-surface-hover">Skip All</button>
			</div>
		</div>
	</div>
{/if}

{#if previewSrc}
	<ImagePreview src={previewSrc} alt={previewAlt} onClose={closePreview} />
{/if}
