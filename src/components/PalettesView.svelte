<script lang="ts">
	import { untrack } from 'svelte';
	import type { Adb } from '@yume-chan/adb';
	import { DEVICE_PATHS } from '$lib/adb/types.js';
	import { listDirectory, pullFile, pushFile, pathExists } from '$lib/adb/file-ops.js';
	import { beginTransfer, endTransfer, trackedPush } from '$lib/stores/transfer.svelte.js';
	import { adbExec } from '$lib/stores/connection.svelte.js';
	import {
		formatError,
		compareByName,
		plural,
		pickFiles,
		getDroppedFiles,
		hasDraggedFiles
	} from '$lib/utils.js';
	import { ShellCmd } from '$lib/adb/adb-utils.js';
	import {
		parsePalette,
		paletteDisplayName,
		cssColor,
		studioUrl,
		STUDIO_BASE,
		SLOT_LABELS,
		type Palette
	} from '$lib/palettes/palette.js';
	import ActionButton from './ActionButton.svelte';

	let { adb }: { adb: Adb } = $props();

	interface PaletteEntry {
		filename: string;
		devicePath: string;
		palette: Palette;
	}

	let entries: PaletteEntry[] = $state([]);
	let refreshing = $state(false);
	let dirExists = $state(true);
	let uploading = $state(false);
	let notice = $state('');
	let removing: string | null = $state(null);
	let dragOver = $state(false);
	let dragCounter = $state(0);

	function isPaletteFile(name: string): boolean {
		return (
			name.toLowerCase().endsWith('.txt') &&
			!name.startsWith('._') &&
			name.toLowerCase() !== 'readme.txt'
		);
	}

	async function refreshAll() {
		refreshing = true;
		notice = '';
		const discovered: PaletteEntry[] = [];

		try {
			dirExists = await pathExists(adb, DEVICE_PATHS.palettes);
			if (dirExists) {
				const files = await listDirectory(adb, DEVICE_PATHS.palettes);
				const paletteFiles = files
					.filter((f) => f.isFile && isPaletteFile(f.name))
					.sort(compareByName);

				for (const f of paletteFiles) {
					const devicePath = `${DEVICE_PATHS.palettes}/${f.name}`;
					try {
						const data = await pullFile(adb, devicePath);
						const text = new TextDecoder().decode(data);
						discovered.push({ filename: f.name, devicePath, palette: parsePalette(text) });
					} catch {
						// Skip unreadable files
					}
				}
			}
		} catch {
			dirExists = false;
		}

		entries = discovered;
		refreshing = false;
	}

	/** Upload a set of local files, keeping only `.txt` palettes and giving each
	 * a name that doesn't collide with existing palettes on the device. */
	async function uploadPaletteFiles(files: File[]) {
		const txtFiles = files.filter((f) => f.name.toLowerCase().endsWith('.txt'));
		if (txtFiles.length === 0) {
			notice = 'No .txt palette files found';
			return;
		}

		uploading = true;
		notice = '';
		const totalBytes = txtFiles.reduce((sum, f) => sum + f.size, 0);
		beginTransfer('upload', txtFiles.length, totalBytes);

		try {
			const taken = await existingPaletteNames();
			if (!(await pathExists(adb, DEVICE_PATHS.palettes))) {
				await adbExec(ShellCmd.mkdir(DEVICE_PATHS.palettes));
			}

			let uploaded = 0;
			for (const file of txtFiles) {
				const filename = makeUnique(file.name, taken);
				const data = new Uint8Array(await file.arrayBuffer());
				await trackedPush(adb, `${DEVICE_PATHS.palettes}/${filename}`, data);
				uploaded++;
			}

			notice = `Uploaded ${plural(uploaded, 'palette')}`;
			await refreshAll();
		} catch (e) {
			notice = `Upload failed: ${formatError(e)}`;
		} finally {
			endTransfer();
			uploading = false;
		}
	}

	async function uploadPalettes() {
		const files = await pickFiles({ accept: '.txt' });
		if (files.length === 0) return;
		await uploadPaletteFiles(files);
	}

	/** Turn a palette name into a safe `<Name>.txt` device filename. */
	function sanitizePaletteFilename(name: string): string {
		let n = name.replace(/\.txt$/i, '');
		n = n
			.replace(/[/\\:*?"<>|]/g, '')
			.replace(/\s+/g, '_')
			.trim();
		if (!n) n = 'Custom';
		return `${n}.txt`;
	}

	/** Lowercased set of palette filenames currently on the device. */
	async function existingPaletteNames(): Promise<Set<string>> {
		try {
			const files = await listDirectory(adb, DEVICE_PATHS.palettes);
			return new Set(files.map((f) => f.name.toLowerCase()));
		} catch {
			// Directory may not exist yet → no conflicts possible
			return new Set();
		}
	}

	/**
	 * Return a filename that doesn't collide with `taken`, appending `_2`, `_3`,
	 * ... before the extension. The chosen name is added to `taken` so repeated
	 * calls within one upload batch stay unique.
	 */
	function makeUnique(desired: string, taken: Set<string>): string {
		let result = desired;
		if (taken.has(result.toLowerCase())) {
			const dot = desired.lastIndexOf('.');
			const base = dot === -1 ? desired : desired.slice(0, dot);
			const ext = dot === -1 ? '' : desired.slice(dot);
			let i = 2;
			do {
				result = `${base}_${i}${ext}`;
				i++;
			} while (taken.has(result.toLowerCase()));
		}
		taken.add(result.toLowerCase());
		return result;
	}

	async function uploadFromClipboard() {
		let text: string;
		try {
			text = await navigator.clipboard.readText();
		} catch (e) {
			notice = `Could not read clipboard: ${formatError(e)}`;
			return;
		}

		if (!text.trim()) {
			notice = 'Clipboard is empty';
			return;
		}

		const palette = parsePalette(text);
		const hasColors = palette.colors.some((c) => c !== null);
		if (!hasColors && palette.version === null) {
			notice = "Clipboard doesn't look like a NextUI palette";
			return;
		}

		let baseName = palette.name?.trim() ?? '';
		if (!baseName) {
			baseName = window.prompt('Name for this palette:', 'Custom')?.trim() ?? '';
			if (!baseName) return; // cancelled
		}
		uploading = true;
		notice = '';
		const filename = makeUnique(sanitizePaletteFilename(baseName), await existingPaletteNames());
		const data = new TextEncoder().encode(text);
		beginTransfer('upload', 1, data.byteLength);

		try {
			if (!(await pathExists(adb, DEVICE_PATHS.palettes))) {
				await adbExec(ShellCmd.mkdir(DEVICE_PATHS.palettes));
			}
			await trackedPush(adb, `${DEVICE_PATHS.palettes}/${filename}`, data);
			notice = `Uploaded ${filename}`;
			await refreshAll();
		} catch (e) {
			notice = `Upload failed: ${formatError(e)}`;
		} finally {
			endTransfer();
			uploading = false;
		}
	}

	function downloadPalette(entry: PaletteEntry) {
		const blob = new Blob([entry.palette.raw], { type: 'text/plain' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = entry.filename;
		a.click();
		URL.revokeObjectURL(url);
	}

	async function removePalette(entry: PaletteEntry) {
		removing = entry.filename;
		try {
			await adbExec(ShellCmd.rm(entry.devicePath));
			entries = entries.filter((e) => e !== entry);
			if (editorPath === entry.devicePath) resetEditor();
			notice = `Deleted ${entry.filename}`;
		} catch (e) {
			notice = `Delete failed: ${formatError(e)}`;
		} finally {
			removing = null;
		}
	}

	// --- Text Editor (side panel) ---

	let editorPath: string | null = $state(null);
	let editorFilename = $state('');
	let editorContent = $state('');
	let editorOriginal = $state('');
	let editorSaving = $state(false);
	let editorError = $state('');

	let editorDirty = $derived(editorContent !== editorOriginal);
	// Hide the transient "Saved" note once the user starts editing again.
	let editorStatus = $derived(editorError === 'Saved' && editorDirty ? '' : editorError);

	function resetEditor() {
		editorPath = null;
		editorFilename = '';
		editorContent = '';
		editorOriginal = '';
		editorError = '';
	}

	function openEditor(entry: PaletteEntry) {
		if (editorPath === entry.devicePath) return; // already editing this palette
		if (editorDirty && !confirm('Discard unsaved changes?')) return;
		editorPath = entry.devicePath;
		editorFilename = entry.filename;
		editorContent = entry.palette.raw;
		editorOriginal = entry.palette.raw;
		editorError = '';
	}

	async function saveEditor() {
		if (!editorPath) return;
		const savingPath = editorPath;
		editorSaving = true;
		editorError = '';
		try {
			const data = new TextEncoder().encode(editorContent);
			await pushFile(adb, savingPath, data);
			editorOriginal = editorContent;
			// Re-parse so the card's name/swatches reflect the saved content
			const parsed = parsePalette(editorContent);
			entries = entries.map((e) => (e.devicePath === savingPath ? { ...e, palette: parsed } : e));
			editorError = 'Saved';
		} catch (e) {
			editorError = `Save failed: ${formatError(e)}`;
		} finally {
			editorSaving = false;
		}
	}

	function closeEditor() {
		if (editorDirty && !confirm('Discard unsaved changes?')) return;
		resetEditor();
	}

	// --- Drag-and-drop upload ---

	function handleDragEnter(e: DragEvent) {
		if (!hasDraggedFiles(e)) return;
		e.preventDefault();
		dragCounter++;
		dragOver = true;
	}

	function handleDragOver(e: DragEvent) {
		if (!hasDraggedFiles(e)) return;
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
	}

	function handleDragLeave(e: DragEvent) {
		e.preventDefault();
		dragCounter--;
		if (dragCounter <= 0) {
			dragCounter = 0;
			dragOver = false;
		}
	}

	async function handleDrop(e: DragEvent) {
		e.preventDefault();
		dragCounter = 0;
		dragOver = false;
		if (uploading) return;
		const dropped = await getDroppedFiles(e);
		const files = dropped.map((d) => d.file);
		if (files.length === 0) return;
		await uploadPaletteFiles(files);
	}

	$effect(() => {
		untrack(() => refreshAll());
	});
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="p-6 flex flex-col h-full relative"
	ondragenter={handleDragEnter}
	ondragover={handleDragOver}
	ondragleave={handleDragLeave}
	ondrop={handleDrop}
>
	{#if dragOver}
		<div
			class="absolute inset-0 z-50 bg-bg/80 border-2 border-dashed border-accent rounded-lg flex items-center justify-center pointer-events-none"
		>
			<span class="text-lg font-medium text-accent">Drop palette .txt files to upload</span>
		</div>
	{/if}

	<div class="flex items-center justify-between mb-2">
		<h2 class="text-2xl font-bold text-text">Palettes</h2>
		<div class="flex items-center gap-3">
			<ActionButton onclick={uploadPalettes} disabled={uploading} variant="primary">
				{uploading ? 'Uploading...' : 'Upload Palettes'}
			</ActionButton>
			<ActionButton
				onclick={uploadFromClipboard}
				disabled={uploading}
				variant="secondary"
				title="Read palette text from the clipboard and upload it"
			>
				Paste from Clipboard
			</ActionButton>
			<ActionButton onclick={refreshAll} disabled={refreshing} variant="secondary">
				{refreshing ? 'Refreshing...' : 'Refresh'}
			</ActionButton>
		</div>
	</div>

	<a
		href={STUDIO_BASE}
		target="_blank"
		rel="noopener noreferrer"
		class="group mb-4 flex items-center gap-3 rounded-lg border border-accent/40 bg-accent/10 p-3 transition-colors hover:bg-accent/15"
	>
		<span class="text-sm text-text">
			Use the community-made
			<span class="font-semibold text-accent group-hover:underline">NextUI Palette Studio ↗</span>
			to create and preview System appearance palettes.
		</span>
	</a>

	<p class="text-sm text-text-muted mb-4">
		Custom palettes live in <span class="font-mono">{DEVICE_PATHS.palettes}</span> and appear under
		Settings &gt; Appearance &gt; Color Palette. Upload an exported
		<span class="font-mono">.txt</span> here, or drag one in.
	</p>

	{#if notice}
		<div class="text-sm text-warning mb-4">{notice}</div>
	{/if}

	<div class="flex-1 flex gap-0 overflow-hidden">
		<div class="flex-1 overflow-auto min-w-0 pr-1">
			{#if refreshing && entries.length === 0}
				<div class="text-sm text-text-muted py-8 text-center">Scanning palettes...</div>
			{:else if !dirExists}
				<div class="text-sm text-text-muted py-8 text-center">
					No Palettes directory on device. Upload a palette to create it.
				</div>
			{:else if entries.length === 0}
				<div class="text-sm text-text-muted py-8 text-center">No custom palettes on device</div>
			{:else}
				<div class="space-y-3">
					{#each entries as entry (entry.devicePath)}
						<div class="border border-border rounded-lg p-4 bg-surface">
							<div class="flex items-start justify-between gap-4 flex-wrap">
								<div class="min-w-0">
									<div class="font-semibold text-text truncate" title={entry.filename}>
										{paletteDisplayName(entry.palette, entry.filename)}
									</div>
									<div class="text-xs text-text-muted font-mono truncate">
										{entry.filename}{entry.palette.version !== null
											? ` · v${entry.palette.version}`
											: ''}
									</div>
								</div>
								<div class="flex items-center gap-2 shrink-0">
									<a
										href={studioUrl(entry.palette.colors)}
										target="_blank"
										rel="noopener noreferrer"
										class="inline-flex items-center justify-center gap-1.5 rounded font-medium whitespace-nowrap transition-colors text-sm px-3 py-1.5 bg-accent text-white hover:bg-accent-hover"
									>
										Open in Palette Studio ↗
									</a>
									<ActionButton
										onclick={() => openEditor(entry)}
										variant={editorPath === entry.devicePath ? 'primary' : 'secondary'}
									>
										{editorPath === entry.devicePath ? 'Editing' : 'Edit'}
									</ActionButton>
									<ActionButton onclick={() => downloadPalette(entry)} variant="subtle">
										Download
									</ActionButton>
									<ActionButton
										onclick={() => removePalette(entry)}
										disabled={removing !== null}
										variant="danger"
									>
										{removing === entry.filename ? '...' : 'Delete'}
									</ActionButton>
								</div>
							</div>

							<!-- Color swatches -->
							<div class="flex gap-2 mt-3 flex-wrap">
								{#each entry.palette.colors as color, i}
									<div class="flex flex-col items-center gap-1">
										<div
											class="w-10 h-10 rounded border border-border"
											style={color
												? `background-color: ${cssColor(color)}`
												: 'background-image: repeating-conic-gradient(var(--color-surface-hover, #888) 0% 25%, transparent 0% 50%); background-size: 10px 10px;'}
											title={`color${i + 1} — ${SLOT_LABELS[i]}${color ? ` (#${color})` : ' (default)'}`}
										></div>
										<span class="text-[10px] text-text-muted" title={SLOT_LABELS[i]}>{i + 1}</span>
									</div>
								{/each}
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</div>

		<!-- Editor panel -->
		{#if editorPath}
			<div class="w-1/2 border border-border rounded-lg ml-2 flex flex-col min-w-0">
				<div
					class="flex items-center justify-between p-2 bg-surface border-b border-border shrink-0"
				>
					<span class="text-sm font-mono text-text truncate" title={editorPath}>
						{editorFilename}{editorDirty ? ' *' : ''}
					</span>
					<div class="flex items-center gap-2 shrink-0">
						<ActionButton
							onclick={saveEditor}
							disabled={!editorDirty || editorSaving}
							variant="primary"
							size="xs"
						>
							{editorSaving ? 'Saving...' : 'Save'}
						</ActionButton>
						<ActionButton onclick={closeEditor} variant="subtle" size="xs" title="Close editor">
							Close
						</ActionButton>
					</div>
				</div>

				<textarea
					bind:value={editorContent}
					class="flex-1 w-full p-3 bg-bg text-text font-mono text-sm resize-none border-none outline-none"
					spellcheck="false"
				></textarea>

				{#if editorStatus}
					<div
						class="px-2 py-1 text-xs border-t border-border shrink-0 {editorStatus === 'Saved'
							? 'text-success'
							: 'text-red-400'}"
					>
						{editorStatus}
					</div>
				{/if}
			</div>
		{/if}
	</div>
</div>
