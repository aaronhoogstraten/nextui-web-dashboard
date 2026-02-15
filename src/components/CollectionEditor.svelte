<script lang="ts">
	import type { Adb } from '@yume-chan/adb';
	import { DEVICE_PATHS } from '$lib/adb/types.js';
	import { listDirectory, pushFile, pathExists } from '$lib/adb/file-ops.js';
	import { parseRomDirectoryName } from '$lib/roms/definitions.js';
	import { formatError, compareByName, plural, errorMsg, successMsg, type Notification } from '$lib/utils.js';
	import Modal from './Modal.svelte';
	import StatusMessage from './StatusMessage.svelte';

	interface CollectionInfo {
		name: string;
		fileName: string;
		romPaths: string[];
	}

	let {
		adb,
		collection,
		onclose,
		onsave
	}: {
		adb: Adb;
		collection: CollectionInfo;
		onclose: () => void;
		onsave: (paths: string[]) => void;
	} = $props();

	// --- Types ---

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

	// --- State ---

	// svelte-ignore state_referenced_locally -- intentional snapshot of initial prop value
	let editorPaths: string[] = $state([...collection.romPaths]);
	// svelte-ignore state_referenced_locally
	let editorOriginal: string[] = $state([...collection.romPaths]);
	let editorValidation: Map<string, boolean> = $state.raw(new Map());
	let validating = $state(false);
	let saving = $state(false);
	let notice: Notification | null = $state(null);

	const editorDirty = $derived(
		editorPaths.length !== editorOriginal.length ||
			editorPaths.some((p, i) => p !== editorOriginal[i])
	);

	const editorPathSet = $derived(new Set(editorPaths));

	// --- ROM Picker State ---

	let pickerOpen = $state(false);
	let pickerSystems: RomPickerSystem[] = $state([]);
	let pickerLoading = $state(false);

	const selectedCount = $derived(
		pickerSystems.reduce(
			(sum, sys) => sum + sys.files.filter((f) => f.selected).length,
			0
		)
	);

	// --- Helpers ---

	const COLLECTIONS_PATH = DEVICE_PATHS.collections;

	function extractRomName(path: string): string {
		const lastSlash = path.lastIndexOf('/');
		return lastSlash >= 0 ? path.substring(lastSlash + 1) : path;
	}

	function extractSystemName(path: string): string {
		const parts = path.split('/');
		if (parts.length >= 3) return parts[2];
		return '';
	}

	// --- Editor Logic ---

	function closeEditor() {
		if (editorDirty && !confirm('Discard unsaved changes?')) return;
		onclose();
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
		saving = true;
		notice = null;
		try {
			const content = editorPaths.join('\n') + (editorPaths.length > 0 ? '\n' : '');
			const data = new TextEncoder().encode(content);
			await pushFile(adb, `${COLLECTIONS_PATH}/${collection.fileName}`, data);
			editorOriginal = [...editorPaths];
			onsave(editorPaths);
			notice = successMsg('Saved');
		} catch (e) {
			notice = errorMsg(`Save failed: ${formatError(e)}`);
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

	// --- ROM Picker Logic ---

	async function openPicker() {
		pickerOpen = true;
		pickerSystems = [];
		pickerLoading = true;

		try {
			const entries = await listDirectory(adb, DEVICE_PATHS.roms);
			const dirs = entries
				.filter((e) => e.isDirectory && !e.name.startsWith('.'))
				.sort(compareByName);

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
							.sort(compareByName)
							.map((e) => ({ name: e.name, selected: false })),
						fileCount: romFiles.length
					});
				} catch {
					// skip systems that can't be listed
				}
			}
			pickerSystems = systems;
		} catch (e) {
			notice = errorMsg(`Failed to load ROM systems: ${formatError(e)}`);
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
					if (!editorPathSet.has(romPath)) {
						newPaths.push(romPath);
					}
					file.selected = false;
				}
			}
		}
		if (newPaths.length > 0) {
			editorPaths = [...editorPaths, ...newPaths];
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

	// Validate on mount
	validatePaths();
</script>

<!-- Editor View -->
<div class="flex items-center justify-between mb-4">
	<div class="flex items-center gap-3">
		<button
			onclick={closeEditor}
			class="text-sm text-accent hover:underline"
		>
			&larr; Back
		</button>
		<h2 class="text-2xl font-bold text-text">{collection.name}</h2>
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

{#if notice}
	<StatusMessage notification={notice} />
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
									class="text-xs text-accent hover:text-accent-hover px-1"
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
	{plural(editorPaths.length, 'ROM')} in collection
</div>

<!-- ROM Picker Modal -->
{#if pickerOpen}
	<Modal onclose={closePicker} maxWidth="max-w-2xl">
		<div class="max-h-[80vh] flex flex-col">
			<div class="flex items-center justify-between p-4 border-b border-border shrink-0">
				<h3 class="text-lg font-bold text-text">Add ROMs to Collection</h3>
				<div class="flex items-center gap-2">
					{#if selectedCount > 0}
						<button
							onclick={addSelectedRoms}
							class="text-sm bg-accent text-white px-3 py-1.5 rounded hover:bg-accent-hover"
						>
							Add {plural(selectedCount, 'ROM')}
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
										<span class="text-xs text-text-muted">{plural(sys.fileCount, 'ROM')}</span>
										<span class="text-text-muted text-xs">
											{sys.expanded ? '\u25B2' : '\u25BC'}
										</span>
									</div>
								</button>

								{#if sys.expanded}
									<div class="p-2 bg-bg max-h-60 overflow-auto">
										{#each sys.files as file}
											{@const romPath = `/Roms/${sys.dirName}/${file.name}`}
											{@const alreadyAdded = editorPathSet.has(romPath)}
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
	</Modal>
{/if}
