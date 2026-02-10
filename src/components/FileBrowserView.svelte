<script lang="ts">
	import { untrack } from 'svelte';
	import type { Adb } from '@yume-chan/adb';
	import { listDirectory, pullFile, pushFile, isDirectory } from '$lib/adb/file-ops.js';
	import { DEVICE_PATHS, type DirectoryEntry } from '$lib/adb/types.js';

	let { adb }: { adb: Adb } = $props();

	let currentPath: string = $state(DEVICE_PATHS.base);
	let entries: DirectoryEntry[] = $state([]);
	let loading = $state(false);
	let error: string = $state('');
	let sortKey: 'name' | 'size' | 'mtime' = $state('name');
	let sortAsc = $state(true);
	let uploading = $state(false);
	let downloadingFile: string | null = $state(null);

	const pathSegments = $derived(getPathSegments(currentPath));
	const sortedEntries = $derived(getSortedEntries(entries, sortKey, sortAsc));

	function getPathSegments(path: string): { name: string; path: string }[] {
		const parts = path.split('/').filter(Boolean);
		const segments: { name: string; path: string }[] = [{ name: '/', path: '/' }];
		let accumulated = '';
		for (const part of parts) {
			accumulated += '/' + part;
			segments.push({ name: part, path: accumulated });
		}
		return segments;
	}

	function getSortedEntries(
		items: DirectoryEntry[],
		key: 'name' | 'size' | 'mtime',
		asc: boolean
	): DirectoryEntry[] {
		const sorted = [...items].sort((a, b) => {
			// Directories always first
			if (a.isDirectory && !b.isDirectory) return -1;
			if (!a.isDirectory && b.isDirectory) return 1;

			let cmp = 0;
			if (key === 'name') {
				cmp = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
			} else if (key === 'size') {
				cmp = Number(a.size - b.size);
			} else {
				cmp = Number(a.mtime - b.mtime);
			}
			return asc ? cmp : -cmp;
		});
		return sorted;
	}

	function toggleSort(key: 'name' | 'size' | 'mtime') {
		if (sortKey === key) {
			sortAsc = !sortAsc;
		} else {
			sortKey = key;
			sortAsc = true;
		}
	}

	function sortIndicator(key: 'name' | 'size' | 'mtime'): string {
		if (sortKey !== key) return '';
		return sortAsc ? ' \u25B2' : ' \u25BC';
	}

	async function navigate(path: string, skipDirtyCheck = false) {
		if (!skipDirtyCheck && editorPath && editorContent !== editorOriginal) {
			if (!confirm('Discard unsaved changes?')) return;
		}
		if (editorPath && !skipDirtyCheck) {
			editorPath = null;
			editorContent = '';
			editorOriginal = '';
			editorError = '';
		}
		loading = true;
		error = '';
		try {
			const result = await listDirectory(adb, path);
			entries = result;
			currentPath = path;
		} catch (e) {
			error = `Failed to list ${path}: ${e instanceof Error ? e.message : String(e)}`;
		}
		loading = false;
	}

	async function handleEntryClick(entry: DirectoryEntry) {
		if (entry.isDirectory) {
			const newPath = currentPath === '/' ? '/' + entry.name : currentPath + '/' + entry.name;
			await navigate(newPath);
		}
	}

	function navigateUp() {
		if (currentPath === '/') return;
		const parent = currentPath.substring(0, currentPath.lastIndexOf('/')) || '/';
		navigate(parent);
	}

	async function downloadFile(entry: DirectoryEntry) {
		if (entry.isDirectory) return;
		downloadingFile = entry.name;
		try {
			const remotePath =
				currentPath === '/' ? '/' + entry.name : currentPath + '/' + entry.name;
			const content = await pullFile(adb, remotePath);

			// Trigger browser download
			const blob = new Blob([content as unknown as BlobPart]);
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = entry.name;
			a.click();
			URL.revokeObjectURL(url);
		} catch (e) {
			error = `Download failed: ${e instanceof Error ? e.message : String(e)}`;
		}
		downloadingFile = null;
	}

	async function uploadFiles() {
		const input = document.createElement('input');
		input.type = 'file';
		input.multiple = true;

		input.onchange = async () => {
			const files = input.files;
			if (!files || files.length === 0) return;

			uploading = true;
			error = '';
			let uploaded = 0;

			try {
				for (const file of files) {
					const data = new Uint8Array(await file.arrayBuffer());
					const remotePath =
						currentPath === '/'
							? '/' + file.name
							: currentPath + '/' + file.name;
					await pushFile(adb, remotePath, data);
					uploaded++;
				}
				error = `Uploaded ${uploaded} file(s)`;
				await navigate(currentPath);
			} catch (e) {
				error = `Upload failed: ${e instanceof Error ? e.message : String(e)}`;
			}
			uploading = false;
		};

		input.click();
	}

	function formatSize(size: bigint): string {
		const n = Number(size);
		if (n < 1024) return `${n} B`;
		if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
		if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
		return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
	}

	function formatDate(mtime: bigint): string {
		const ms = Number(mtime) * 1000;
		if (ms === 0) return '\u2014';
		return new Date(ms).toLocaleString();
	}

	// --- Text Editor ---
	const TEXT_EXTENSIONS = new Set(['.txt', '.cfg', '.conf', '.ini', '.json', '.sh', '.xml', '.yml', '.log', '.csv']);

	function isTextFile(name: string): boolean {
		const dot = name.lastIndexOf('.');
		if (dot < 0) return false;
		return TEXT_EXTENSIONS.has(name.substring(dot).toLowerCase());
	}

	let editorPath: string | null = $state(null);
	let editorContent: string = $state('');
	let editorOriginal: string = $state('');
	let editorLoading = $state(false);
	let editorSaving = $state(false);
	let editorError: string = $state('');

	let editorDirty = $derived(editorContent !== editorOriginal);

	function editorFileName(): string {
		if (!editorPath) return '';
		return editorPath.substring(editorPath.lastIndexOf('/') + 1);
	}

	async function openEditor(remotePath: string) {
		if (editorDirty && !confirm('Discard unsaved changes?')) return;
		editorPath = remotePath;
		editorLoading = true;
		editorError = '';
		try {
			const data = await pullFile(adb, remotePath);
			const text = new TextDecoder().decode(data);
			editorContent = text;
			editorOriginal = text;
		} catch (e) {
			editorError = `Failed to open: ${e instanceof Error ? e.message : String(e)}`;
		} finally {
			editorLoading = false;
		}
	}

	async function saveEditor() {
		if (!editorPath) return;
		editorSaving = true;
		editorError = '';
		try {
			const data = new TextEncoder().encode(editorContent);
			await pushFile(adb, editorPath, data);
			editorOriginal = editorContent;
			editorError = 'Saved';
		} catch (e) {
			editorError = `Save failed: ${e instanceof Error ? e.message : String(e)}`;
		} finally {
			editorSaving = false;
		}
	}

	function closeEditor() {
		if (editorDirty && !confirm('Discard unsaved changes?')) return;
		editorPath = null;
		editorContent = '';
		editorOriginal = '';
		editorError = '';
	}

	// Load initial directory on mount (untrack to prevent reactive loop)
	$effect(() => {
		untrack(() => navigate(DEVICE_PATHS.base, true));
	});
</script>

<div class="p-6 flex flex-col h-full">
	<!-- Header -->
	<div class="flex items-center justify-between mb-4">
		<h2 class="text-2xl font-bold text-text">File Browser</h2>
		<div class="flex items-center gap-2">
			<button
				onclick={uploadFiles}
				disabled={uploading}
				class="text-sm bg-accent text-white px-3 py-1.5 rounded hover:bg-accent-hover disabled:opacity-50"
			>
				{uploading ? 'Uploading...' : 'Upload'}
			</button>
			<button
				onclick={() => navigate(currentPath)}
				disabled={loading}
				class="text-sm bg-surface hover:bg-surface-hover text-text disabled:opacity-50 px-3 py-1.5 rounded"
			>
				{loading ? 'Loading...' : 'Refresh'}
			</button>
		</div>
	</div>

	<!-- Breadcrumb -->
	<div class="flex items-center gap-1 mb-4 text-sm flex-wrap min-h-[28px]">
		{#each pathSegments as segment, i}
			{#if i > 0}
				<span class="text-text-muted">/</span>
			{/if}
			{#if i === pathSegments.length - 1}
				<span class="text-text font-medium">{segment.name}</span>
			{:else}
				<button
					onclick={() => navigate(segment.path)}
					class="text-accent hover:underline"
				>
					{segment.name}
				</button>
			{/if}
		{/each}
	</div>

	<!-- Error / status -->
	{#if error}
		<div class="text-xs text-yellow-500 mb-3">{error}</div>
	{/if}

	<!-- Table + Editor split view -->
	<div class="flex-1 flex gap-0 overflow-hidden">
		<!-- File listing -->
		<div class="flex-1 overflow-auto border border-border rounded-lg min-w-0">
			<table class="w-full text-sm">
				<thead class="bg-surface sticky top-0">
					<tr class="text-left">
						<th class="py-2 px-3 font-medium text-text-muted">
							<button onclick={() => navigateUp()} disabled={currentPath === '/'} class="mr-2 text-text hover:text-accent disabled:opacity-30" title="Go up">
								..
							</button>
							<button onclick={() => toggleSort('name')} class="text-text-muted hover:text-text">
								Name{sortIndicator('name')}
							</button>
						</th>
						<th class="py-2 px-3 font-medium text-text-muted w-28 text-right">
							<button onclick={() => toggleSort('size')} class="text-text-muted hover:text-text">
								Size{sortIndicator('size')}
							</button>
						</th>
						<th class="py-2 px-3 font-medium text-text-muted w-48">
							<button onclick={() => toggleSort('mtime')} class="text-text-muted hover:text-text">
								Modified{sortIndicator('mtime')}
							</button>
						</th>
						<th class="py-2 px-3 font-medium text-text-muted w-32"></th>
					</tr>
				</thead>
				<tbody>
					{#if loading}
						<tr>
							<td colspan="4" class="py-8 text-center text-text-muted">Loading...</td>
						</tr>
					{:else if sortedEntries.length === 0}
						<tr>
							<td colspan="4" class="py-8 text-center text-text-muted">Empty directory</td>
						</tr>
					{:else}
						{#each sortedEntries as entry}
							<tr class="border-t border-border hover:bg-surface-hover transition-colors">
								<td class="py-1.5 px-3">
									{#if entry.isDirectory}
										<button
											onclick={() => handleEntryClick(entry)}
											class="text-accent hover:underline flex items-center gap-1.5"
										>
											<span class="text-text-muted">&#128193;</span>
											{entry.name}
										</button>
									{:else}
										<span class="flex items-center gap-1.5 text-text">
											<span class="text-text-muted">&#128196;</span>
											{entry.name}
										</span>
									{/if}
								</td>
								<td class="py-1.5 px-3 text-right text-text-muted tabular-nums">
									{entry.isDirectory ? '\u2014' : formatSize(entry.size)}
								</td>
								<td class="py-1.5 px-3 text-text-muted tabular-nums">
									{formatDate(entry.mtime)}
								</td>
								<td class="py-1.5 px-3">
									{#if entry.isFile}
										<div class="flex items-center gap-2">
											{#if isTextFile(entry.name)}
												<button
													onclick={() => openEditor(currentPath === '/' ? '/' + entry.name : currentPath + '/' + entry.name)}
													class="text-xs text-accent hover:underline"
												>
													Edit
												</button>
											{/if}
											<button
												onclick={() => downloadFile(entry)}
												disabled={downloadingFile !== null}
												class="text-xs text-accent hover:underline disabled:opacity-50"
											>
												{downloadingFile === entry.name ? '...' : 'Download'}
											</button>
										</div>
									{/if}
								</td>
							</tr>
						{/each}
					{/if}
				</tbody>
			</table>
		</div>

		<!-- Editor panel -->
		{#if editorPath}
			<div class="w-1/2 border border-border rounded-lg ml-2 flex flex-col min-w-0">
				<!-- Editor header -->
				<div class="flex items-center justify-between p-2 bg-surface border-b border-border shrink-0">
					<div class="flex items-center gap-2 min-w-0">
						<span class="text-sm font-mono text-text truncate" title={editorPath}>
							{editorFileName()}{editorDirty ? ' *' : ''}
						</span>
					</div>
					<div class="flex items-center gap-2 shrink-0">
						<button
							onclick={saveEditor}
							disabled={!editorDirty || editorSaving}
							class="text-xs bg-accent text-white px-2 py-1 rounded hover:bg-accent-hover disabled:opacity-50"
						>
							{editorSaving ? 'Saving...' : 'Save'}
						</button>
						<button
							onclick={closeEditor}
							class="text-xs text-text-muted hover:text-text px-1"
							title="Close editor"
						>
							&#10005;
						</button>
					</div>
				</div>

				<!-- Editor content -->
				{#if editorLoading}
					<div class="flex-1 flex items-center justify-center text-text-muted text-sm">
						Loading...
					</div>
				{:else}
					<textarea
						bind:value={editorContent}
						class="flex-1 w-full p-3 bg-bg text-text font-mono text-sm resize-none border-none outline-none"
						spellcheck="false"
					></textarea>
				{/if}

				<!-- Editor footer -->
				{#if editorError}
					<div class="px-2 py-1 text-xs border-t border-border shrink-0 {editorError === 'Saved' ? 'text-green-500' : 'text-red-400'}">
						{editorError}
					</div>
				{/if}
			</div>
		{/if}
	</div>

	<!-- Footer info -->
	<div class="mt-2 text-xs text-text-muted flex justify-between">
		<span>{entries.length} items</span>
		<span class="font-mono">{currentPath}</span>
	</div>
</div>
