<script lang="ts">
	import { untrack } from 'svelte';
	import type { Adb } from '@yume-chan/adb';
	import { DEVICE_PATHS } from '$lib/adb/types.js';
	import { listDirectory, pullFile, pushFile, pathExists } from '$lib/adb/file-ops.js';
	import { adbExec } from '$lib/stores/connection.svelte.js';
	import { formatError, pickFile, errorMsg, type Notification } from '$lib/utils.js';
	import { ShellCmd } from '$lib/adb/adb-utils.js';
	import ImagePreview from './ImagePreview.svelte';
	import CollectionEditor from './CollectionEditor.svelte';
	import StatusMessage from './StatusMessage.svelte';

	let { adb }: { adb: Adb } = $props();

	// --- Types ---

	interface CollectionState {
		name: string;
		fileName: string;
		romPaths: string[];
		iconUrl: string | null;
		loadingIcon: boolean;
	}

	// --- State: List View ---

	let collections: CollectionState[] = $state([]);
	let loading = $state(false);
	let notice: Notification | null = $state(null);
	let bgUrl: string | null = $state(null);

	// --- State: Editor ---

	let editing: CollectionState | null = $state.raw(null);

	// --- State: Other ---

	let deletingCollection: string | null = $state(null);
	let uploadingIcon: string | null = $state(null);
	let previewSrc: string | null = $state(null);
	let previewAlt: string = $state('');

	// --- Helpers ---

	const COLLECTIONS_PATH = DEVICE_PATHS.collections;
	const MEDIA_PATH = `${COLLECTIONS_PATH}/.media`;

	function getBaseName(fileName: string): string {
		const dot = fileName.lastIndexOf('.');
		return dot > 0 ? fileName.substring(0, dot) : fileName;
	}

	// --- List View Logic ---

	async function refresh() {
		loading = true;
		notice = null;

		// Clean up old icon URLs
		for (const c of collections) {
			if (c.iconUrl) URL.revokeObjectURL(c.iconUrl);
		}
		if (bgUrl) {
			URL.revokeObjectURL(bgUrl);
			bgUrl = null;
		}
		collections = [];

		try {
			// Ensure Collections directory exists
			const dirExists = await pathExists(adb, COLLECTIONS_PATH);
			if (!dirExists) {
				await adbExec(ShellCmd.mkdir(COLLECTIONS_PATH));
			}

			const entries = await listDirectory(adb, COLLECTIONS_PATH);
			const txtFiles = entries
				.filter((e) => e.isFile && e.name.endsWith('.txt'))
				.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

			const results: CollectionState[] = [];
			for (const entry of txtFiles) {
				const data = await pullFile(adb, `${COLLECTIONS_PATH}/${entry.name}`);
				const text = new TextDecoder().decode(data);
				const paths = text
					.split('\n')
					.map((l) => l.trim())
					.filter((l) => l.length > 0);

				results.push({
					name: getBaseName(entry.name),
					fileName: entry.name,
					romPaths: paths,
					iconUrl: null,
					loadingIcon: false
				});
			}
			collections = results;

			// Load icons
			loadIcons();
			// Load bg
			loadBg();
		} catch (e) {
			notice = errorMsg(`Failed to load collections: ${formatError(e)}`);
		}

		loading = false;
	}

	async function loadIcons() {
		for (const col of collections) {
			if (col.iconUrl || col.loadingIcon) continue;
			col.loadingIcon = true;
			try {
				const iconPath = `${MEDIA_PATH}/${col.name}.png`;
				const exists = await pathExists(adb, iconPath);
				if (exists) {
					const data = await pullFile(adb, iconPath);
					const blob = new Blob([data as unknown as BlobPart], { type: 'image/png' });
					col.iconUrl = URL.createObjectURL(blob);
				}
			} catch {
				// skip
			}
			col.loadingIcon = false;
		}
	}

	async function loadBg() {
		try {
			const bgPath = `${MEDIA_PATH}/bg.png`;
			const exists = await pathExists(adb, bgPath);
			if (exists) {
				const data = await pullFile(adb, bgPath);
				const blob = new Blob([data as unknown as BlobPart], { type: 'image/png' });
				bgUrl = URL.createObjectURL(blob);
			}
		} catch {
			// skip
		}
	}

	async function createCollection() {
		const name = prompt('Collection name:');
		if (!name || !name.trim()) return;
		const trimmed = name.trim();
		if (trimmed.includes('/') || trimmed.includes('\\')) {
			notice = errorMsg('Collection name cannot contain slashes');
			return;
		}

		notice = null;
		try {
			await adbExec(ShellCmd.mkdir(COLLECTIONS_PATH));
			const content = new TextEncoder().encode('');
			await pushFile(adb, `${COLLECTIONS_PATH}/${trimmed}.txt`, content);
			await refresh();
		} catch (e) {
			notice = errorMsg(`Failed to create collection: ${formatError(e)}`);
		}
	}

	async function deleteCollection(col: CollectionState) {
		if (!confirm(`Delete collection "${col.name}"? This will remove the collection file and its icon.`))
			return;
		deletingCollection = col.name;
		try {
			await adbExec(ShellCmd.rm(`${COLLECTIONS_PATH}/${col.fileName}`));
			// Remove icon if exists
			const iconPath = `${MEDIA_PATH}/${col.name}.png`;
			const iconExists = await pathExists(adb, iconPath);
			if (iconExists) {
				await adbExec(ShellCmd.rm(iconPath));
			}
			if (col.iconUrl) URL.revokeObjectURL(col.iconUrl);
			collections = collections.filter((c) => c !== col);
		} catch (e) {
			notice = errorMsg(`Delete failed: ${formatError(e)}`);
		}
		deletingCollection = null;
	}

	async function uploadIcon(col: CollectionState) {
		const file = await pickFile({ accept: '.png' });
		if (!file) return;
		uploadingIcon = col.name;
		try {
			await adbExec(ShellCmd.mkdir(MEDIA_PATH));
			const data = new Uint8Array(await file.arrayBuffer());
			await pushFile(adb, `${MEDIA_PATH}/${col.name}.png`, data);
			if (col.iconUrl) URL.revokeObjectURL(col.iconUrl);
			const blob = new Blob([data as unknown as BlobPart], { type: 'image/png' });
			col.iconUrl = URL.createObjectURL(blob);
		} catch (e) {
			notice = errorMsg(`Icon upload failed: ${formatError(e)}`);
		}
		uploadingIcon = null;
	}

	async function removeIcon(col: CollectionState) {
		if (!confirm(`Remove icon for "${col.name}"?`)) return;
		try {
			await adbExec(ShellCmd.rm(`${MEDIA_PATH}/${col.name}.png`));
			if (col.iconUrl) URL.revokeObjectURL(col.iconUrl);
			col.iconUrl = null;
		} catch (e) {
			notice = errorMsg(`Remove icon failed: ${formatError(e)}`);
		}
	}

	async function uploadBg() {
		const file = await pickFile({ accept: '.png' });
		if (!file) return;
		try {
			await adbExec(ShellCmd.mkdir(MEDIA_PATH));
			const data = new Uint8Array(await file.arrayBuffer());
			await pushFile(adb, `${MEDIA_PATH}/bg.png`, data);
			if (bgUrl) URL.revokeObjectURL(bgUrl);
			const blob = new Blob([data as unknown as BlobPart], { type: 'image/png' });
			bgUrl = URL.createObjectURL(blob);
		} catch (e) {
			notice = errorMsg(`Background upload failed: ${formatError(e)}`);
		}
	}

	async function removeBg() {
		if (!confirm('Remove collections list background?')) return;
		try {
			await adbExec(ShellCmd.rm(`${MEDIA_PATH}/bg.png`));
			if (bgUrl) URL.revokeObjectURL(bgUrl);
			bgUrl = null;
		} catch (e) {
			notice = errorMsg(`Remove background failed: ${formatError(e)}`);
		}
	}

	function openEditor(col: CollectionState) {
		editing = col;
	}

	function closeEditor() {
		editing = null;
	}

	function onEditorSave(paths: string[]) {
		if (editing) {
			editing.romPaths = [...paths];
		}
	}

	function openPreview(src: string, alt: string) {
		previewSrc = src;
		previewAlt = alt;
	}

	function closePreview() {
		previewSrc = null;
		previewAlt = '';
	}

	// Refresh on mount + cleanup blob URLs on unmount
	$effect(() => {
		untrack(() => refresh());
		return () => {
			for (const c of collections) {
				if (c.iconUrl) URL.revokeObjectURL(c.iconUrl);
			}
			if (bgUrl) URL.revokeObjectURL(bgUrl);
		};
	});
</script>

<div class="p-6 flex flex-col h-full">
	{#if editing}
		<CollectionEditor {adb} collection={editing} onclose={closeEditor} onsave={onEditorSave} />
	{:else}
		<!-- List View -->
		<div class="flex items-center justify-between mb-4">
			<h2 class="text-2xl font-bold text-text">Collections</h2>
			<div class="flex items-center gap-2">
				<button
					onclick={createCollection}
					class="text-sm bg-accent text-white px-3 py-1.5 rounded hover:bg-accent-hover"
				>
					New Collection
				</button>
				<button
					onclick={refresh}
					disabled={loading}
					class="text-sm bg-surface hover:bg-surface-hover text-text disabled:opacity-50 px-3 py-1.5 rounded"
				>
					{loading ? 'Loading...' : 'Refresh'}
				</button>
			</div>
		</div>

		{#if notice}
			<StatusMessage notification={notice} />
		{/if}

		<div class="text-xs text-text-muted mb-3">
			Source: <span class="font-mono">{COLLECTIONS_PATH}/</span>
		</div>

		<!-- Background image -->
		<div class="mb-4 flex items-center gap-3">
			<span class="text-sm text-text-muted">List Background:</span>
			{#if bgUrl}
				<button onclick={() => openPreview(bgUrl!, 'Collections background')} class="h-10 cursor-pointer">
					<img src={bgUrl} alt="Collections bg" class="h-10 rounded border border-border object-contain" />
				</button>
				<button
					onclick={uploadBg}
					class="text-xs text-accent hover:underline"
				>Replace</button>
				<button
					onclick={removeBg}
					class="text-xs text-red-400 hover:text-red-300"
				>Delete</button>
			{:else}
				<span class="text-xs text-text-muted">None</span>
				<button
					onclick={uploadBg}
					class="text-xs text-accent hover:underline"
				>Upload</button>
			{/if}
		</div>

		<div class="flex-1 overflow-auto">
			{#if loading}
				<div class="text-sm text-text-muted py-8 text-center">Loading collections...</div>
			{:else if collections.length === 0}
				<div class="text-sm text-text-muted py-8 text-center">
					No collections found. Click "New Collection" to create one.
				</div>
			{:else}
				<div class="space-y-2">
					{#each collections as col}
						<div class="border border-border rounded-lg overflow-hidden bg-bg">
							<div class="flex items-center gap-3 p-3">
								<!-- Icon -->
								<div class="w-12 h-12 bg-surface rounded flex items-center justify-center shrink-0">
									{#if col.loadingIcon}
										<div class="w-full h-full bg-surface-hover animate-pulse rounded"></div>
									{:else if col.iconUrl}
										<button onclick={() => openPreview(col.iconUrl!, col.name + ' icon')} class="w-full h-full cursor-pointer">
											<img src={col.iconUrl} alt="{col.name} icon" class="w-full h-full object-contain rounded" />
										</button>
									{:else}
										<span class="text-text-muted text-lg">&#128194;</span>
									{/if}
								</div>

								<!-- Info -->
								<div class="flex-1 min-w-0">
									<button
										onclick={() => openEditor(col)}
										class="text-text font-semibold hover:text-accent text-left truncate block"
									>
										{col.name}
									</button>
									<div class="text-xs text-text-muted">
										{col.romPaths.length} ROM{col.romPaths.length !== 1 ? 's' : ''}
									</div>
								</div>

								<!-- Actions -->
								<div class="flex items-center gap-2 shrink-0">
									{#if col.iconUrl}
										<button onclick={() => removeIcon(col)} class="text-xs text-red-400 hover:text-red-300">
											Remove icon
										</button>
									{:else}
										<button
											onclick={() => uploadIcon(col)}
											disabled={uploadingIcon !== null}
											class="text-xs text-accent hover:underline disabled:opacity-50"
										>
											{uploadingIcon === col.name ? 'Uploading...' : 'Add icon'}
										</button>
									{/if}
									<button
										onclick={() => openEditor(col)}
										class="text-xs text-accent hover:underline"
									>
										Edit
									</button>
									<button
										onclick={() => deleteCollection(col)}
										disabled={deletingCollection !== null}
										class="text-xs text-red-400 hover:text-red-300 disabled:opacity-50"
									>
										{deletingCollection === col.name ? '...' : 'Delete'}
									</button>
								</div>
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</div>

		<div class="mt-2 text-xs text-text-muted">
			{collections.length} collection{collections.length !== 1 ? 's' : ''}
		</div>
	{/if}
</div>

{#if previewSrc}
	<ImagePreview src={previewSrc} alt={previewAlt} onClose={closePreview} />
{/if}
