<script lang="ts">
	import { untrack } from 'svelte';
	import type { Adb } from '@yume-chan/adb';
	import { DEVICE_PATHS } from '$lib/adb/types.js';
	import { listDirectory, pullFile, pushFile, pathExists } from '$lib/adb/file-ops.js';
	import { adbExec } from '$lib/stores/connection.svelte.js';
	import { formatSize, formatError, pickFiles } from '$lib/utils.js';
	import { ShellCmd } from '$lib/adb/adb-utils.js';
	import ImagePreview from './ImagePreview.svelte';

	let { adb }: { adb: Adb } = $props();

	interface OverlayFile {
		name: string;
		size: bigint;
		thumbnailUrl: string | null;
		loadingThumb: boolean;
	}

	interface SystemOverlays {
		systemCode: string;
		devicePath: string;
		files: OverlayFile[];
		loading: boolean;
		expanded: boolean;
		error: string;
	}

	let systems: SystemOverlays[] = $state([]);
	let refreshing = $state(false);
	let hideEmpty = $state(true);
	let uploadingTo: string | null = $state(null);
	let previewSrc: string | null = $state(null);
	let previewAlt: string = $state('');

	let filteredSystems = $derived(
		hideEmpty ? systems.filter((s) => s.files.length > 0) : systems
	);

	async function refreshAll() {
		refreshing = true;

		// Clean up old blob URLs
		for (const sys of systems) {
			for (const f of sys.files) {
				if (f.thumbnailUrl) URL.revokeObjectURL(f.thumbnailUrl);
			}
		}

		const discovered: SystemOverlays[] = [];

		try {
			const dirs = await listDirectory(adb, DEVICE_PATHS.overlays);
			for (const dir of dirs) {
				if (!dir.isDirectory || dir.name.startsWith('.')) continue;

				const devicePath = `${DEVICE_PATHS.overlays}/${dir.name}`;
				const entry: SystemOverlays = {
					systemCode: dir.name,
					devicePath,
					files: [],
					loading: true,
					expanded: false,
					error: ''
				};

				try {
					const files = await listDirectory(adb, devicePath);
					entry.files = files
						.filter((f) => f.isFile && f.name.toLowerCase().endsWith('.png'))
						.sort((a, b) =>
							a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
						)
						.map((f) => ({
							name: f.name,
							size: f.size,
							thumbnailUrl: null,
							loadingThumb: false
						}));
				} catch {
					entry.error = 'Could not list directory';
				}

				entry.loading = false;
				discovered.push(entry);
			}
		} catch {
			// Overlays directory may not exist
		}

		discovered.sort((a, b) => a.systemCode.localeCompare(b.systemCode));
		systems = discovered;
		refreshing = false;
	}

	async function loadThumbnails(sys: SystemOverlays) {
		for (const file of sys.files) {
			if (file.thumbnailUrl || file.loadingThumb) continue;
			file.loadingThumb = true;
			try {
				const data = await pullFile(adb, `${sys.devicePath}/${file.name}`);
				const blob = new Blob([data as unknown as BlobPart], { type: 'image/png' });
				file.thumbnailUrl = URL.createObjectURL(blob);
			} catch {
				// skip
			}
			file.loadingThumb = false;
		}
	}

	async function toggleExpand(sys: SystemOverlays) {
		sys.expanded = !sys.expanded;
		if (sys.expanded && sys.files.some((f) => !f.thumbnailUrl && !f.loadingThumb)) {
			await loadThumbnails(sys);
		}
	}

	function openPreview(file: OverlayFile, systemCode: string) {
		if (file.thumbnailUrl) {
			previewSrc = file.thumbnailUrl;
			previewAlt = `${systemCode} — ${file.name}`;
		}
	}

	function closePreview() {
		previewSrc = null;
		previewAlt = '';
	}

	async function uploadOverlays(sys: SystemOverlays) {
		const files = await pickFiles({ accept: '.png' });
		if (files.length === 0) return;

		uploadingTo = sys.systemCode;
		let uploaded = 0;

		try {
			const dirExists = await pathExists(adb, sys.devicePath);
			if (!dirExists) {
				await adbExec(ShellCmd.mkdir(sys.devicePath));
			}

			for (const file of files) {
				if (!file.name.toLowerCase().endsWith('.png')) continue;
				const data = new Uint8Array(await file.arrayBuffer());
				await pushFile(adb, `${sys.devicePath}/${file.name}`, data);
				uploaded++;
			}

			if (uploaded > 0) {
				sys.error = `Uploaded ${uploaded} overlay(s)`;
				try {
					const entries = await listDirectory(adb, sys.devicePath);
					for (const f of sys.files) {
						if (f.thumbnailUrl) URL.revokeObjectURL(f.thumbnailUrl);
					}
					sys.files = entries
						.filter((f) => f.isFile && f.name.toLowerCase().endsWith('.png'))
						.sort((a, b) =>
							a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
						)
						.map((f) => ({
							name: f.name,
							size: f.size,
							thumbnailUrl: null,
							loadingThumb: false
						}));
					if (sys.expanded) {
						await loadThumbnails(sys);
					}
				} catch {
					// ignore
				}
			} else {
				sys.error = 'No PNG files selected';
			}
		} catch (e) {
			sys.error = `Upload failed: ${formatError(e)}`;
		} finally {
			uploadingTo = null;
		}
	}

	let removingFile: string | null = $state(null);

	// --- Community overlays ---
	interface CommunityOverlay {
		name: string;
		path: string;
		rawUrl: string;
		author: string;
		resolution: string;
	}

	const COMMUNITY_REPO = 'LoveRetro/nextui-community-overlays';
	const communityCache = new Map<string, CommunityOverlay[]>();

	let communityOpen: string | null = $state(null);
	let communityOverlays: CommunityOverlay[] = $state([]);
	let communityLoading = $state(false);
	let communityError: string = $state('');
	let installingOverlay: string | null = $state(null);

	async function fetchJson(url: string): Promise<any[]> {
		const res = await fetch(url);
		if (!res.ok) {
			if (res.status === 404) return [];
			throw new Error(`GitHub API ${res.status}: ${res.statusText}`);
		}
		return res.json();
	}

	async function collectPngs(
		basePath: string,
		author: string,
		resolution: string,
		overlays: CommunityOverlay[]
	) {
		const base = `https://api.github.com/repos/${COMMUNITY_REPO}/contents`;
		const entries = await fetchJson(`${base}/${basePath}`);
		for (const entry of entries) {
			if (entry.type === 'file' && entry.name.toLowerCase().endsWith('.png')) {
				overlays.push({
					name: entry.name,
					path: entry.path,
					rawUrl: `https://raw.githubusercontent.com/${COMMUNITY_REPO}/main/${encodeURI(entry.path)}`,
					author,
					resolution
				});
			} else if (entry.type === 'dir') {
				await collectPngs(entry.path, author, resolution, overlays);
			}
		}
	}

	async function openCommunityBrowser(systemCode: string) {
		if (communityOpen === systemCode) {
			communityOpen = null;
			return;
		}

		communityOpen = systemCode;
		communityError = '';

		// Check cache
		const cached = communityCache.get(systemCode);
		if (cached) {
			communityOverlays = cached;
			return;
		}

		communityLoading = true;
		communityOverlays = [];

		try {
			const base = `https://api.github.com/repos/${COMMUNITY_REPO}/contents`;
			const overlays: CommunityOverlay[] = [];

			const resolutions = await fetchJson(`${base}/${systemCode}`);
			for (const resDir of resolutions) {
				if (resDir.type !== 'dir') continue;
				const authors = await fetchJson(`${base}/${resDir.path}`);
				for (const authorDir of authors) {
					if (authorDir.type !== 'dir') continue;
					await collectPngs(authorDir.path, authorDir.name, resDir.name, overlays);
				}
			}

			communityOverlays = overlays;
			communityCache.set(systemCode, overlays);
		} catch (e) {
			communityError = formatError(e);
		} finally {
			communityLoading = false;
		}
	}

	async function installCommunityOverlay(sys: SystemOverlays, overlay: CommunityOverlay) {
		installingOverlay = overlay.path;
		try {
			// Fetch the image from GitHub
			const res = await fetch(overlay.rawUrl);
			if (!res.ok) throw new Error(`Failed to fetch: ${res.status}`);
			const data = new Uint8Array(await res.arrayBuffer());

			// Ensure device directory exists
			const dirExists = await pathExists(adb, sys.devicePath);
			if (!dirExists) {
				await adbExec(ShellCmd.mkdir(sys.devicePath));
			}

			// Push to device
			await pushFile(adb, `${sys.devicePath}/${overlay.name}`, data);

			// Reload device overlays for this system
			try {
				const entries = await listDirectory(adb, sys.devicePath);
				for (const f of sys.files) {
					if (f.thumbnailUrl) URL.revokeObjectURL(f.thumbnailUrl);
				}
				sys.files = entries
					.filter((f) => f.isFile && f.name.toLowerCase().endsWith('.png'))
					.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
					.map((f) => ({
						name: f.name,
						size: f.size,
						thumbnailUrl: null,
						loadingThumb: false
					}));
				if (sys.expanded) {
					await loadThumbnails(sys);
				}
			} catch {
				// ignore reload error
			}

			sys.error = `Installed ${overlay.name}`;
		} catch (e) {
			sys.error = `Install failed: ${formatError(e)}`;
		} finally {
			installingOverlay = null;
		}
	}

	function openCommunityPreview(overlay: CommunityOverlay) {
		previewSrc = overlay.rawUrl;
		previewAlt = `${overlay.name} — by ${overlay.author} (${overlay.resolution})`;
	}

	async function removeOverlay(sys: SystemOverlays, file: OverlayFile) {
		removingFile = `${sys.systemCode}/${file.name}`;
		try {
			await adbExec(ShellCmd.rm(`${sys.devicePath}/${file.name}`));
			if (file.thumbnailUrl) URL.revokeObjectURL(file.thumbnailUrl);
			sys.files = sys.files.filter((f) => f !== file);
		} catch (e) {
			sys.error = `Remove failed: ${formatError(e)}`;
		} finally {
			removingFile = null;
		}
	}

	// Refresh on mount
	$effect(() => {
		untrack(() => refreshAll());
	});
</script>

<div class="p-6">
	<div class="flex items-center justify-between mb-6">
		<h2 class="text-2xl font-bold text-text">Overlays</h2>
		<div class="flex items-center gap-4">
			<label class="flex items-center gap-2 text-sm text-text-muted cursor-pointer">
				<input type="checkbox" bind:checked={hideEmpty} class="accent-accent" />
				Show systems with overlays only
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

	{#if refreshing && systems.length === 0}
		<div class="text-sm text-text-muted py-8 text-center">Scanning overlays...</div>
	{:else if systems.length === 0 && !refreshing}
		<div class="text-sm text-text-muted py-8 text-center">No Overlays directory found on device</div>
	{:else}
		<div class="space-y-2">
			{#each filteredSystems as sys}
				<div class="border border-border rounded-lg overflow-hidden">
					<!-- System Header -->
					<button
						onclick={() => toggleExpand(sys)}
						class="w-full flex items-center justify-between p-3 bg-surface hover:bg-surface-hover text-left"
					>
						<span class="font-semibold text-text">{sys.systemCode}</span>
						<div class="flex items-center gap-3">
							<span
								class="text-sm {sys.files.length > 0 ? 'text-green-500' : 'text-text-muted'}"
							>
								{sys.files.length} overlay{sys.files.length !== 1 ? 's' : ''}
							</span>
							<span class="text-text-muted">{sys.expanded ? '\u25B2' : '\u25BC'}</span>
						</div>
					</button>

					<!-- Expanded Details -->
					{#if sys.expanded}
						<div class="p-3 space-y-3">
							<div class="flex items-center justify-between">
								<div class="text-xs text-text-muted font-mono">{sys.devicePath}</div>
								<div class="flex items-center gap-2">
									<button
										onclick={() => openCommunityBrowser(sys.systemCode)}
										disabled={communityLoading}
										class="text-sm border border-border text-text px-3 py-1.5 rounded hover:bg-surface-hover disabled:opacity-50"
									>
										{communityOpen === sys.systemCode ? 'Close Community' : 'Browse Community'}
									</button>
									<button
										onclick={() => uploadOverlays(sys)}
										disabled={uploadingTo !== null}
										class="text-sm bg-accent text-white px-3 py-1.5 rounded hover:bg-accent-hover disabled:opacity-50"
									>
										{uploadingTo === sys.systemCode ? 'Uploading...' : 'Upload Overlays'}
									</button>
								</div>
							</div>

							{#if sys.error}
								<div class="text-xs text-yellow-500">{sys.error}</div>
							{/if}

							<!-- Device overlays -->
							{#if sys.files.length === 0}
								<div class="text-sm text-text-muted py-4 text-center">No overlays on device</div>
							{:else}
								<div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
									{#each sys.files as file}
										<div class="border border-border rounded-lg overflow-hidden bg-bg group">
											<div class="aspect-[4/3] bg-surface flex items-center justify-center">
												{#if file.loadingThumb}
													<div class="w-full h-full bg-surface-hover animate-pulse"></div>
												{:else if file.thumbnailUrl}
													<button onclick={() => openPreview(file, sys.systemCode)} class="w-full h-full cursor-pointer">
														<img src={file.thumbnailUrl} alt={file.name} class="w-full h-full object-contain" />
													</button>
												{:else}
													<span class="text-text-muted text-2xl">&#128444;</span>
												{/if}
											</div>
											<div class="p-2">
												<div class="text-xs text-text truncate" title={file.name}>{file.name}</div>
												<div class="flex items-center justify-between mt-1">
													<span class="text-xs text-text-muted">{formatSize(file.size)}</span>
													<button
														onclick={() => removeOverlay(sys, file)}
														disabled={removingFile !== null}
														class="text-xs text-red-400 hover:text-red-300 disabled:opacity-50"
														title="Remove overlay"
													>
														{removingFile === `${sys.systemCode}/${file.name}` ? '...' : 'Delete'}
													</button>
												</div>
											</div>
										</div>
									{/each}
								</div>
							{/if}

							<!-- Community overlays section -->
							{#if communityOpen === sys.systemCode}
								<div class="border-t border-border pt-3 mt-3">
									<div class="flex items-center justify-between mb-3">
										<h3 class="text-sm font-semibold text-text">Community Overlays</h3>
										<a
											href="https://github.com/{COMMUNITY_REPO}"
											target="_blank"
											rel="noopener noreferrer"
											class="text-xs text-accent hover:underline"
										>
											View on GitHub
										</a>
									</div>

									{#if communityLoading}
										<div class="text-sm text-text-muted py-4 text-center">Loading community overlays...</div>
									{:else if communityError}
										<div class="text-sm text-red-400 py-4 text-center">{communityError}</div>
									{:else if communityOverlays.length === 0}
										<div class="text-sm text-text-muted py-4 text-center">No community overlays available for {sys.systemCode}</div>
									{:else}
										<div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
											{#each communityOverlays as overlay}
												<div class="border border-border rounded-lg overflow-hidden bg-bg">
													<div class="aspect-[4/3] bg-surface flex items-center justify-center">
														<button onclick={() => openCommunityPreview(overlay)} class="w-full h-full cursor-pointer">
															<img
																src={overlay.rawUrl}
																alt={overlay.name}
																class="w-full h-full object-contain"
																loading="lazy"
															/>
														</button>
													</div>
													<div class="p-2">
														<div class="text-xs text-text truncate" title={overlay.name}>{overlay.name}</div>
														<div class="text-xs text-text-muted truncate">by {overlay.author}</div>
														<div class="flex items-center justify-between mt-1">
															<span class="text-xs text-text-muted">{overlay.resolution}</span>
															<button
																onclick={() => installCommunityOverlay(sys, overlay)}
																disabled={installingOverlay !== null}
																class="text-xs bg-accent text-white px-2 py-0.5 rounded hover:bg-accent-hover disabled:opacity-50"
															>
																{installingOverlay === overlay.path ? 'Downloading...' : 'Download'}
															</button>
														</div>
													</div>
												</div>
											{/each}
										</div>
									{/if}
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
