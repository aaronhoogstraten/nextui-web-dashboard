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
	import { listDirectory, pathExists, pullFile, pushFile } from '$lib/adb/file-ops.js';
	import { adbExec } from '$lib/stores/connection.svelte.js';
	import { formatSize, formatError, pickFile, pickFiles } from '$lib/utils.js';
	import { ShellCmd } from '$lib/adb/adb-utils.js';
	import ImagePreview from './ImagePreview.svelte';
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
			state.error = `Failed to load ROMs: ${formatError(e)}`;
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
		const file = await pickFile({ accept: '.png' });
		if (!file) return;

		uploadingBg = `${state.system.systemCode}/${filename}`;
		try {
			const dir = getSpecialMediaDir(state, filename);
			const dirExists = await pathExists(adb, dir);
			if (!dirExists) {
				await adbExec(ShellCmd.mkdir(dir));
			}

			const data = new Uint8Array(await file.arrayBuffer());
				await pushFile(adb, getSpecialMediaPath(state, filename), data);
			const url = URL.createObjectURL(new Blob([data as unknown as BlobPart], { type: 'image/png' }));
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

	async function uploadRoms(state: SystemState) {
		const accept = state.system.isCustom ? undefined : state.system.supportedFormats.join(',');
		const files = await pickFiles({ accept });
		if (files.length === 0) return;

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
			cleanupThumbnails(state);
			state.roms = [];
			state.romsLoaded = false;
			if (state.expanded) {
				await loadRomDetails(state);
			} else {
				try {
					const entries = await listDirectory(adb, state.devicePath);
					state.romCount = entries.filter((e) => e.isFile && !e.name.startsWith('.')).length;
				} catch {
					// ignore
				}
			}
		} catch (e) {
			state.error = `Upload failed: ${formatError(e)}`;
		} finally {
			uploadingTo = null;
		}
	}

	async function uploadMedia(state: SystemState, rom: RomEntry) {
		const file = await pickFile({ accept: '.png' });
		if (!file) return;

		uploadingMediaFor = rom.name;

		try {
			const mediaPath = getRomMediaPath(state.system);

			const mediaDirExists = await pathExists(adb, mediaPath);
			if (!mediaDirExists) {
				await adbExec(ShellCmd.mkdir(mediaPath));
			}

			const data = new Uint8Array(await file.arrayBuffer());
			const remotePath = `${mediaPath}/${rom.mediaFileName}`;
			await pushFile(adb, remotePath, data);

			rom.hasMedia = true;
			const blob = new Blob([data as unknown as BlobPart], { type: 'image/png' });
			if (rom.thumbnailUrl) URL.revokeObjectURL(rom.thumbnailUrl);
			rom.thumbnailUrl = URL.createObjectURL(blob);
			state.mediaCount = state.roms.filter((r) => r.hasMedia).length;
		} catch (e) {
			state.error = `Media upload failed: ${formatError(e)}`;
		} finally {
			uploadingMediaFor = null;
		}
	}

	let removingRom: string | null = $state(null);
	let removingMediaFor: string | null = $state(null);

	async function removeRom(state: SystemState, rom: RomEntry) {
		if (!confirm(`Delete "${rom.name}"${rom.hasMedia ? ' and its box art' : ''}?`)) return;
		removingRom = rom.name;
		try {
			// Remove the ROM file
			await adbExec(ShellCmd.rm(`${state.devicePath}/${rom.name}`));

			// Also remove media art if present
			if (rom.hasMedia) {
				const mediaPath = getRomMediaPath(state.system);
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
			const mediaPath = getRomMediaPath(state.system);
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
			state.displayNameMap = newMap;
			state.displayNameDirty = false;
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
		hideEmpty
			? systems.filter((s) => s.romCount === null || s.romCount > 0)
			: systems
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
											<button
												onclick={() => { previewSrc = media.url; previewAlt = `${s.system.systemName} — ${media.label}`; }}
												class="h-28 w-full bg-surface cursor-pointer grid place-items-center p-1"
											>
												<img src={media.url} alt={media.label} class="max-w-full max-h-full object-contain" />
											</button>
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
{/if}
</div>

{#if previewSrc}
	<ImagePreview src={previewSrc} alt={previewAlt} onClose={closePreview} />
{/if}
