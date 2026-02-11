<script lang="ts">
	import { untrack } from 'svelte';
	import type { Adb } from '@yume-chan/adb';
	import { DEVICE_PATHS } from '$lib/adb/types.js';
	import { listDirectory, pullFile, pushFile, shell, pathExists } from '$lib/adb/file-ops.js';
	import { parseRomDirectoryName } from '$lib/roms/definitions.js';
	import ImagePreview from './ImagePreview.svelte';

	let { adb }: { adb: Adb } = $props();

	// --- Types ---

	interface CollectionState {
		name: string;
		fileName: string;
		romPaths: string[];
		iconUrl: string | null;
		loadingIcon: boolean;
	}

	interface RomPickerSystem {
		dirName: string;
		displayName: string;
		systemCode: string | null;
		expanded: boolean;
		loading: boolean;
		files: RomPickerFile[];
		fileCount: number;
	}

	interface RomPickerFile {
		name: string;
		selected: boolean;
	}

	// --- State: List View ---

	let collections: CollectionState[] = $state([]);
	let loading = $state(false);
	let error: string = $state('');
	let bgUrl: string | null = $state(null);

	// --- State: Editor View ---

	let editing: CollectionState | null = $state(null);
	let editorPaths: string[] = $state([]);
	let editorOriginal: string[] = $state([]);
	let editorValidation: Map<string, boolean> = $state(new Map());
	let validating = $state(false);
	let saving = $state(false);

	const editorDirty = $derived(JSON.stringify(editorPaths) !== JSON.stringify(editorOriginal));

	// --- State: ROM Picker ---

	let pickerOpen = $state(false);
	let pickerSystems: RomPickerSystem[] = $state([]);
	let pickerLoading = $state(false);

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
		error = '';

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
				await shell(adb, `mkdir -p "${COLLECTIONS_PATH}"`);
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
			error = `Failed to load collections: ${e instanceof Error ? e.message : String(e)}`;
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
			error = 'Collection name cannot contain slashes';
			return;
		}

		error = '';
		try {
			await shell(adb, `mkdir -p "${COLLECTIONS_PATH}"`);
			const content = new TextEncoder().encode('');
			await pushFile(adb, `${COLLECTIONS_PATH}/${trimmed}.txt`, content);
			await refresh();
		} catch (e) {
			error = `Failed to create collection: ${e instanceof Error ? e.message : String(e)}`;
		}
	}

	async function deleteCollection(col: CollectionState) {
		if (!confirm(`Delete collection "${col.name}"? This will remove the collection file and its icon.`))
			return;
		deletingCollection = col.name;
		try {
			await shell(adb, `rm "${COLLECTIONS_PATH}/${col.fileName}"`);
			// Remove icon if exists
			const iconPath = `${MEDIA_PATH}/${col.name}.png`;
			const iconExists = await pathExists(adb, iconPath);
			if (iconExists) {
				await shell(adb, `rm "${iconPath}"`);
			}
			if (col.iconUrl) URL.revokeObjectURL(col.iconUrl);
			collections = collections.filter((c) => c !== col);
		} catch (e) {
			error = `Delete failed: ${e instanceof Error ? e.message : String(e)}`;
		}
		deletingCollection = null;
	}

	async function uploadIcon(col: CollectionState) {
		const input = document.createElement('input');
		input.type = 'file';
		input.accept = '.png';

		input.onchange = async () => {
			const file = input.files?.[0];
			if (!file) return;
			uploadingIcon = col.name;
			try {
				await shell(adb, `mkdir -p "${MEDIA_PATH}"`);
				const data = new Uint8Array(await file.arrayBuffer());
				await pushFile(adb, `${MEDIA_PATH}/${col.name}.png`, data);
				// Reload icon
				if (col.iconUrl) URL.revokeObjectURL(col.iconUrl);
				const blob = new Blob([data as unknown as BlobPart], { type: 'image/png' });
				col.iconUrl = URL.createObjectURL(blob);
			} catch (e) {
				error = `Icon upload failed: ${e instanceof Error ? e.message : String(e)}`;
			}
			uploadingIcon = null;
		};
		input.click();
	}

	async function removeIcon(col: CollectionState) {
		if (!confirm(`Remove icon for "${col.name}"?`)) return;
		try {
			await shell(adb, `rm "${MEDIA_PATH}/${col.name}.png"`);
			if (col.iconUrl) URL.revokeObjectURL(col.iconUrl);
			col.iconUrl = null;
		} catch (e) {
			error = `Remove icon failed: ${e instanceof Error ? e.message : String(e)}`;
		}
	}

	async function uploadBg() {
		const input = document.createElement('input');
		input.type = 'file';
		input.accept = '.png';

		input.onchange = async () => {
			const file = input.files?.[0];
			if (!file) return;
			try {
				await shell(adb, `mkdir -p "${MEDIA_PATH}"`);
				const data = new Uint8Array(await file.arrayBuffer());
				await pushFile(adb, `${MEDIA_PATH}/bg.png`, data);
				if (bgUrl) URL.revokeObjectURL(bgUrl);
				const blob = new Blob([data as unknown as BlobPart], { type: 'image/png' });
				bgUrl = URL.createObjectURL(blob);
			} catch (e) {
				error = `Background upload failed: ${e instanceof Error ? e.message : String(e)}`;
			}
		};
		input.click();
	}

	async function removeBg() {
		if (!confirm('Remove collections list background?')) return;
		try {
			await shell(adb, `rm "${MEDIA_PATH}/bg.png"`);
			if (bgUrl) URL.revokeObjectURL(bgUrl);
			bgUrl = null;
		} catch (e) {
			error = `Remove background failed: ${e instanceof Error ? e.message : String(e)}`;
		}
	}

	// --- Editor Logic ---

	async function openEditor(col: CollectionState) {
		editing = col;
		editorPaths = [...col.romPaths];
		editorOriginal = [...col.romPaths];
		editorValidation = new Map();
		validatePaths();
	}

	function closeEditor() {
		if (editorDirty && !confirm('Discard unsaved changes?')) return;
		editing = null;
		editorPaths = [];
		editorOriginal = [];
		editorValidation = new Map();
	}

	async function validatePaths() {
		validating = true;
		const results = new Map<string, boolean>();
		for (const p of editorPaths) {
			try {
				const fullPath = DEVICE_PATHS.base + p;
				const exists = await pathExists(adb, fullPath);
				results.set(p, exists);
			} catch {
				results.set(p, false);
			}
		}
		editorValidation = results;
		validating = false;
	}

	async function saveCollection() {
		if (!editing) return;
		saving = true;
		error = '';
		try {
			const content = editorPaths.join('\n') + (editorPaths.length > 0 ? '\n' : '');
			const data = new TextEncoder().encode(content);
			await pushFile(adb, `${COLLECTIONS_PATH}/${editing.fileName}`, data);
			editing.romPaths = [...editorPaths];
			editorOriginal = [...editorPaths];
			error = 'Saved';
		} catch (e) {
			error = `Save failed: ${e instanceof Error ? e.message : String(e)}`;
		}
		saving = false;
	}

	function moveUp(index: number) {
		if (index <= 0) return;
		const temp = editorPaths[index - 1];
		editorPaths[index - 1] = editorPaths[index];
		editorPaths[index] = temp;
	}

	function moveDown(index: number) {
		if (index >= editorPaths.length - 1) return;
		const temp = editorPaths[index + 1];
		editorPaths[index + 1] = editorPaths[index];
		editorPaths[index] = temp;
	}

	function removeEntry(index: number) {
		editorPaths = editorPaths.filter((_, i) => i !== index);
	}

	function extractRomName(path: string): string {
		const lastSlash = path.lastIndexOf('/');
		return lastSlash >= 0 ? path.substring(lastSlash + 1) : path;
	}

	function extractSystemName(path: string): string {
		// Path format: /Roms/SystemName (Code)/file.ext
		const parts = path.split('/');
		if (parts.length >= 3) return parts[2];
		return '';
	}

	// --- ROM Picker Logic ---

	async function openPicker() {
		pickerOpen = true;
		pickerSystems = [];
		pickerLoading = true;

		try {
			const entries = await listDirectory(adb, DEVICE_PATHS.roms);
			const dirs = entries
				.filter((e) => e.isDirectory && !e.name.startsWith('.'))
				.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

			// Pre-scan each system to get file counts and hide empty ones
			const systems: RomPickerSystem[] = [];
			for (const d of dirs) {
				const parsed = parseRomDirectoryName(d.name);
				try {
					const sysEntries = await listDirectory(adb, `${DEVICE_PATHS.roms}/${d.name}`);
					const romFiles = sysEntries.filter((e) => e.isFile && !e.name.startsWith('.'));
					if (romFiles.length === 0) continue;
					systems.push({
						dirName: d.name,
						displayName: parsed ? parsed.systemName : d.name,
						systemCode: parsed ? parsed.systemCode : null,
						expanded: false,
						loading: false,
						files: romFiles
							.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
							.map((e) => ({ name: e.name, selected: false })),
						fileCount: romFiles.length
					});
				} catch {
					// skip systems that can't be listed
				}
			}
			pickerSystems = systems;
		} catch (e) {
			error = `Failed to load ROM systems: ${e instanceof Error ? e.message : String(e)}`;
		}

		pickerLoading = false;
	}

	function closePicker() {
		pickerOpen = false;
		pickerSystems = [];
	}

	function togglePickerSystem(sys: RomPickerSystem) {
		sys.expanded = !sys.expanded;
	}

	function addSelectedRoms() {
		const newPaths: string[] = [];
		for (const sys of pickerSystems) {
			for (const file of sys.files) {
				if (file.selected) {
					const romPath = `/Roms/${sys.dirName}/${file.name}`;
					if (!editorPaths.includes(romPath)) {
						newPaths.push(romPath);
					}
					file.selected = false;
				}
			}
		}
		if (newPaths.length > 0) {
			editorPaths = [...editorPaths, ...newPaths];
			// Validate the new paths
			validateNewPaths(newPaths);
		}
		closePicker();
	}

	async function validateNewPaths(paths: string[]) {
		for (const p of paths) {
			try {
				const fullPath = DEVICE_PATHS.base + p;
				const exists = await pathExists(adb, fullPath);
				editorValidation.set(p, exists);
				editorValidation = new Map(editorValidation);
			} catch {
				editorValidation.set(p, false);
				editorValidation = new Map(editorValidation);
			}
		}
	}

	const selectedCount = $derived(
		pickerSystems.reduce(
			(sum, sys) => sum + sys.files.filter((f) => f.selected).length,
			0
		)
	);

	function openPreview(src: string, alt: string) {
		previewSrc = src;
		previewAlt = alt;
	}

	function closePreview() {
		previewSrc = null;
		previewAlt = '';
	}

	// Refresh on mount
	$effect(() => {
		untrack(() => refresh());
	});
</script>

<div class="p-6 flex flex-col h-full">
	{#if editing}
		<!-- Editor View -->
		<div class="flex items-center justify-between mb-4">
			<div class="flex items-center gap-3">
				<button
					onclick={closeEditor}
					class="text-sm text-accent hover:underline"
				>
					&larr; Back
				</button>
				<h2 class="text-2xl font-bold text-text">{editing.name}</h2>
				{#if editorDirty}
					<span class="text-xs text-yellow-500">unsaved changes</span>
				{/if}
			</div>
			<div class="flex items-center gap-2">
				<button
					onclick={openPicker}
					class="text-sm bg-accent text-white px-3 py-1.5 rounded hover:bg-accent-hover"
				>
					Add ROMs
				</button>
				<button
					onclick={saveCollection}
					disabled={!editorDirty || saving}
					class="text-sm bg-green-700 text-white px-3 py-1.5 rounded hover:bg-green-600 disabled:opacity-50"
				>
					{saving ? 'Saving...' : 'Save'}
				</button>
			</div>
		</div>

		{#if error}
			<div class="text-xs mb-3 {error === 'Saved' ? 'text-green-500' : 'text-yellow-500'}">
				{error}
			</div>
		{/if}

		{#if validating}
			<div class="text-xs text-text-muted mb-3">Validating ROM paths...</div>
		{/if}

		<div class="flex-1 overflow-auto border border-border rounded-lg">
			{#if editorPaths.length === 0}
				<div class="text-sm text-text-muted py-8 text-center">
					No ROMs in this collection. Click "Add ROMs" to browse and select.
				</div>
			{:else}
				<table class="w-full text-sm">
					<thead class="bg-surface sticky top-0">
						<tr class="text-left">
							<th class="py-2 px-3 font-medium text-text-muted w-10">#</th>
							<th class="py-2 px-3 font-medium text-text-muted">ROM</th>
							<th class="py-2 px-3 font-medium text-text-muted">System</th>
							<th class="py-2 px-3 font-medium text-text-muted w-40"></th>
						</tr>
					</thead>
					<tbody>
						{#each editorPaths as path, i}
							{@const valid = editorValidation.get(path)}
							<tr class="border-t border-border hover:bg-surface-hover transition-colors">
								<td class="py-1.5 px-3 text-text-muted tabular-nums">{i + 1}</td>
								<td class="py-1.5 px-3">
									<div class="flex items-center gap-2">
										{#if valid === false}
											<span class="text-red-400" title="ROM not found on device">&#9888;</span>
										{:else if valid === true}
											<span class="text-green-500">&#10003;</span>
										{/if}
										<span class="text-text" title={path}>{extractRomName(path)}</span>
									</div>
								</td>
								<td class="py-1.5 px-3 text-text-muted text-xs">
									{extractSystemName(path)}
								</td>
								<td class="py-1.5 px-3">
									<div class="flex items-center gap-1">
										<button
											onclick={() => moveUp(i)}
											disabled={i === 0}
											class="text-xs text-text-muted hover:text-text disabled:opacity-30 px-1"
											title="Move up"
										>&#9650;</button>
										<button
											onclick={() => moveDown(i)}
											disabled={i === editorPaths.length - 1}
											class="text-xs text-text-muted hover:text-text disabled:opacity-30 px-1"
											title="Move down"
										>&#9660;</button>
										<button
											onclick={() => removeEntry(i)}
											class="text-xs text-red-400 hover:text-red-300 px-1"
											title="Remove from collection"
										>Remove</button>
									</div>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			{/if}
		</div>

		<div class="mt-2 text-xs text-text-muted">
			{editorPaths.length} ROM{editorPaths.length !== 1 ? 's' : ''} in collection
		</div>
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

		{#if error}
			<div class="text-xs mb-3 {error === 'Saved' ? 'text-green-500' : 'text-yellow-500'}">
				{error}
			</div>
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

<!-- ROM Picker Modal -->
{#if pickerOpen}
	<div class="fixed inset-0 bg-black/80 flex items-center justify-center z-50" role="dialog">
		<div class="bg-bg border border-border rounded-lg w-full max-w-2xl max-h-[80vh] flex flex-col mx-4">
			<div class="flex items-center justify-between p-4 border-b border-border shrink-0">
				<h3 class="text-lg font-bold text-text">Add ROMs to Collection</h3>
				<div class="flex items-center gap-2">
					{#if selectedCount > 0}
						<button
							onclick={addSelectedRoms}
							class="text-sm bg-accent text-white px-3 py-1.5 rounded hover:bg-accent-hover"
						>
							Add {selectedCount} ROM{selectedCount !== 1 ? 's' : ''}
						</button>
					{/if}
					<button
						onclick={closePicker}
						class="text-text-muted hover:text-text px-2 py-1"
						title="Close"
					>&#10005;</button>
				</div>
			</div>

			<div class="flex-1 overflow-auto p-4">
				{#if pickerLoading}
					<div class="text-sm text-text-muted py-8 text-center">Loading ROM systems...</div>
				{:else if pickerSystems.length === 0}
					<div class="text-sm text-text-muted py-8 text-center">No ROM systems found on device.</div>
				{:else}
					<div class="space-y-1">
						{#each pickerSystems as sys}
							<div class="border border-border rounded overflow-hidden">
								<button
									onclick={() => togglePickerSystem(sys)}
									class="w-full flex items-center justify-between p-2 bg-surface hover:bg-surface-hover text-left text-sm"
								>
									<span class="text-text">{sys.dirName}</span>
									<div class="flex items-center gap-2">
										<span class="text-xs text-text-muted">{sys.fileCount} ROM{sys.fileCount !== 1 ? 's' : ''}</span>
										<span class="text-text-muted text-xs">
											{sys.expanded ? '\u25B2' : '\u25BC'}
										</span>
									</div>
								</button>

								{#if sys.expanded}
									<div class="p-2 bg-bg max-h-60 overflow-auto">
										{#each sys.files as file}
											{@const romPath = `/Roms/${sys.dirName}/${file.name}`}
											{@const alreadyAdded = editorPaths.includes(romPath)}
											<label class="flex items-center gap-2 py-0.5 px-1 text-sm rounded hover:bg-surface cursor-pointer {alreadyAdded ? 'opacity-50' : ''}">
												<input
													type="checkbox"
													bind:checked={file.selected}
													disabled={alreadyAdded}
													class="accent-accent"
												/>
												<span class="text-text truncate" title={file.name}>
													{file.name}
												</span>
												{#if alreadyAdded}
													<span class="text-xs text-text-muted ml-auto shrink-0">already added</span>
												{/if}
											</label>
										{/each}
									</div>
								{/if}
							</div>
						{/each}
					</div>
				{/if}
			</div>
		</div>
	</div>
{/if}

{#if previewSrc}
	<ImagePreview src={previewSrc} alt={previewAlt} onClose={closePreview} />
{/if}
