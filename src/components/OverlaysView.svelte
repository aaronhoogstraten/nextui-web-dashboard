<script lang="ts">
	import { untrack } from 'svelte';
	import type { Adb } from '@yume-chan/adb';
	import { DEVICE_PATHS } from '$lib/adb/types.js';
	import { listDirectory, pullFile, pushFile, shell, pathExists } from '$lib/adb/file-ops.js';
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

	function formatSize(size: bigint): string {
		const n = Number(size);
		if (n < 1024) return `${n} B`;
		if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
		return `${(n / 1024 / 1024).toFixed(1)} MB`;
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
		const input = document.createElement('input');
		input.type = 'file';
		input.multiple = true;
		input.accept = '.png';

		input.onchange = async () => {
			const files = input.files;
			if (!files || files.length === 0) return;

			uploadingTo = sys.systemCode;
			let uploaded = 0;

			try {
				// Ensure directory exists
				const dirExists = await pathExists(adb, sys.devicePath);
				if (!dirExists) {
					await shell(adb, `mkdir -p "${sys.devicePath}"`);
				}

				for (const file of files) {
					if (!file.name.toLowerCase().endsWith('.png')) continue;
					const data = new Uint8Array(await file.arrayBuffer());
					await pushFile(adb, `${sys.devicePath}/${file.name}`, data);
					uploaded++;
				}

				if (uploaded > 0) {
					sys.error = `Uploaded ${uploaded} overlay(s)`;
					// Reload this system's files
					try {
						const entries = await listDirectory(adb, sys.devicePath);
						// Clean up old thumbnails
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
				sys.error = `Upload failed: ${e instanceof Error ? e.message : String(e)}`;
			} finally {
				uploadingTo = null;
			}
		};

		input.click();
	}

	let removingFile: string | null = $state(null);

	async function removeOverlay(sys: SystemOverlays, file: OverlayFile) {
		removingFile = `${sys.systemCode}/${file.name}`;
		try {
			await shell(adb, `rm "${sys.devicePath}/${file.name}"`);
			if (file.thumbnailUrl) URL.revokeObjectURL(file.thumbnailUrl);
			sys.files = sys.files.filter((f) => f !== file);
		} catch (e) {
			sys.error = `Remove failed: ${e instanceof Error ? e.message : String(e)}`;
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
								<button
									onclick={() => uploadOverlays(sys)}
									disabled={uploadingTo !== null}
									class="text-sm bg-accent text-white px-3 py-1.5 rounded hover:bg-accent-hover disabled:opacity-50"
								>
									{uploadingTo === sys.systemCode ? 'Uploading...' : 'Upload Overlays'}
								</button>
							</div>

							{#if sys.error}
								<div class="text-xs text-yellow-500">{sys.error}</div>
							{/if}

							{#if sys.files.length === 0}
								<div class="text-sm text-text-muted py-4 text-center">No overlays</div>
							{:else}
								<div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
									{#each sys.files as file}
										<div
											class="border border-border rounded-lg overflow-hidden bg-bg group"
										>
											<!-- Thumbnail -->
											<div
												class="aspect-[4/3] bg-surface flex items-center justify-center"
											>
												{#if file.loadingThumb}
													<div
														class="w-full h-full bg-surface-hover animate-pulse"
													></div>
												{:else if file.thumbnailUrl}
													<button
														onclick={() =>
															openPreview(file, sys.systemCode)}
														class="w-full h-full cursor-pointer"
													>
														<img
															src={file.thumbnailUrl}
															alt={file.name}
															class="w-full h-full object-contain"
														/>
													</button>
												{:else}
													<span class="text-text-muted text-2xl"
														>&#128444;</span
													>
												{/if}
											</div>
											<!-- Info -->
											<div class="p-2">
												<div class="text-xs text-text truncate" title={file.name}>
													{file.name}
												</div>
												<div
													class="flex items-center justify-between mt-1"
												>
													<span class="text-xs text-text-muted"
														>{formatSize(file.size)}</span
													>
													<button
														onclick={() => removeOverlay(sys, file)}
														disabled={removingFile !== null}
														class="text-xs text-red-400 hover:text-red-300 disabled:opacity-50"
														title="Remove overlay"
													>
														{removingFile ===
														`${sys.systemCode}/${file.name}`
															? '...'
															: 'Remove'}
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
			{/each}
		</div>
	{/if}
</div>

{#if previewSrc}
	<ImagePreview src={previewSrc} alt={previewAlt} onClose={closePreview} />
{/if}
