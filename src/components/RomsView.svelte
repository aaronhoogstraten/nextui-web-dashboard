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
				iconFileName: `${dirName(devicePath)}.png`
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
					iconFileName: `${dirName(devicePath)}.png`
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
					loadingThumb: false
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

	let filteredSystems = $derived(
		hideEmpty
			? systems.filter((s) => s.romCount === null || s.romCount > 0)
			: systems
	);

	// Refresh on mount (untrack to prevent reactive loop)
	$effect(() => {
		untrack(() => refreshAll());
	});
</script>

<div class="p-6">
	<div class="flex items-center justify-between mb-6">
		<h2 class="text-2xl font-bold text-text">ROM Systems</h2>
		<div class="flex items-center gap-4">
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
							<button
								onclick={() => uploadRoms(s)}
								disabled={uploadingTo !== null}
								class="text-sm bg-accent text-white px-3 py-1.5 rounded hover:bg-accent-hover disabled:opacity-50"
							>
								{uploadingTo === s.system.systemCode ? 'Uploading...' : 'Upload ROMs'}
							</button>
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
											<div class="text-sm text-text truncate">{rom.name}</div>
											{#if rom.hasMedia}
												<div class="text-xs text-text-muted truncate">{rom.mediaFileName}</div>
											{:else}
												<div class="text-xs text-text-muted italic">No media</div>
											{/if}
										</div>

										<!-- Size -->
										<div class="text-xs text-text-muted tabular-nums shrink-0">
											{formatSize(rom.size)}
										</div>

										<!-- Action buttons -->
										<div class="flex items-center gap-1 shrink-0">
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
</div>

{#if previewSrc}
	<ImagePreview src={previewSrc} alt={previewAlt} onClose={closePreview} />
{/if}
