<script lang="ts">
	import { untrack } from 'svelte';
	import type { Adb } from '@yume-chan/adb';
	import { DEVICE_PATHS } from '$lib/adb/types.js';
	import { listDirectory, pullFile } from '$lib/adb/file-ops.js';
	import { beginTransfer, endTransfer, trackedPull } from '$lib/stores/transfer.svelte.js';
	import { adbExec } from '$lib/stores/connection.svelte.js';
	import {
		formatSize,
		formatError,
		getMimeType,
		plural,
		errorMsg,
		successMsg,
		type Notification
	} from '$lib/utils.js';
	import { ShellCmd } from '$lib/adb/adb-utils.js';
	import ActionButton from './ActionButton.svelte';
	import ImagePreview from './ImagePreview.svelte';
	import StatusMessage from './StatusMessage.svelte';
	import JSZip from 'jszip';

	let { adb }: { adb: Adb } = $props();

	interface Screenshot {
		name: string;
		size: bigint;
		mtime: bigint;
		thumbnailUrl: string | null;
		loadingThumb: boolean;
		selected: boolean;
	}

	const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.bmp']);

	let screenshots: Screenshot[] = $state([]);
	let loading = $state(false);
	let notice: Notification | null = $state(null);
	let previewSrc: string | null = $state(null);
	let previewAlt: string = $state('');
	let removingFile: string | null = $state(null);
	let downloading = $state(false);
	let deleting = $state(false);
	let progress: string = $state('');

	const totalSize = $derived(screenshots.reduce((sum, s) => sum + Number(s.size), 0));
	const selectedShots = $derived(screenshots.filter((s) => s.selected));
	const allSelected = $derived(
		screenshots.length > 0 && selectedShots.length === screenshots.length
	);
	const busy = $derived(loading || downloading || deleting || removingFile !== null);

	function isImage(name: string): boolean {
		const dot = name.lastIndexOf('.');
		if (dot < 0) return false;
		return IMAGE_EXTENSIONS.has(name.substring(dot).toLowerCase());
	}

	function formatDate(mtime: bigint): string {
		const ms = Number(mtime) * 1000;
		if (ms === 0) return '';
		return new Date(ms).toLocaleDateString();
	}

	async function refresh() {
		loading = true;
		notice = null;

		// Clean up old thumbnails
		for (const s of screenshots) {
			if (s.thumbnailUrl) URL.revokeObjectURL(s.thumbnailUrl);
		}
		screenshots = [];

		try {
			const entries = await listDirectory(adb, DEVICE_PATHS.screenshots);
			screenshots = entries
				.filter((e) => e.isFile && isImage(e.name))
				.sort((a, b) => Number(b.mtime - a.mtime)) // newest first
				.map((e) => ({
					name: e.name,
					size: e.size,
					mtime: e.mtime,
					thumbnailUrl: null,
					loadingThumb: false,
					selected: false
				}));

			if (screenshots.length === 0) {
				notice = errorMsg('No screenshots found on device.');
			}
		} catch {
			notice = errorMsg('Screenshots directory not found on device.');
		}

		loading = false;

		// Load thumbnails
		loadThumbnails();
	}

	async function loadThumbnails() {
		for (const shot of screenshots) {
			if (shot.thumbnailUrl || shot.loadingThumb) continue;
			shot.loadingThumb = true;
			try {
				const data = await pullFile(adb, `${DEVICE_PATHS.screenshots}/${shot.name}`);
				const blob = new Blob([data], { type: getMimeType(shot.name) });
				shot.thumbnailUrl = URL.createObjectURL(blob);
			} catch {
				// skip
			}
			shot.loadingThumb = false;
		}
	}

	function openPreview(shot: Screenshot) {
		if (shot.thumbnailUrl) {
			previewSrc = shot.thumbnailUrl;
			previewAlt = shot.name;
		}
	}

	function closePreview() {
		previewSrc = null;
		previewAlt = '';
	}

	/**
	 * `rm` is silent on success, so any output means the device refused the delete
	 * (read-only mount, permission denied). The shell helper resolves on non-zero
	 * exits rather than throwing, so this is the only signal we get.
	 */
	function assertDeleted(output: string) {
		const message = output.trim();
		if (message) throw new Error(message);
	}

	/** Drop screenshots from the list, releasing their thumbnails and any open preview. */
	function forget(shots: Screenshot[]) {
		if (shots.length === 0) return;
		for (const shot of shots) {
			if (!shot.thumbnailUrl) continue;
			if (previewSrc === shot.thumbnailUrl) closePreview();
			URL.revokeObjectURL(shot.thumbnailUrl);
		}
		const removed = new Set(shots);
		screenshots = screenshots.filter((s) => !removed.has(s));
	}

	async function removeScreenshot(shot: Screenshot) {
		if (!confirm(`Delete "${shot.name}"?`)) return;
		removingFile = shot.name;
		try {
			assertDeleted(await adbExec(ShellCmd.rm(`${DEVICE_PATHS.screenshots}/${shot.name}`)));
			forget([shot]);
		} catch (e) {
			notice = errorMsg(`Delete failed: ${formatError(e)}`);
		} finally {
			removingFile = null;
		}
	}

	function toggleSelectAll() {
		const select = !allSelected;
		for (const shot of screenshots) shot.selected = select;
	}

	async function deleteSelected() {
		const targets = selectedShots;
		if (targets.length === 0) return;
		if (!confirm(`Delete ${plural(targets.length, 'screenshot')} from the device?`)) return;

		deleting = true;
		notice = null;
		const deleted: Screenshot[] = [];
		try {
			// Batch the removals so a large selection doesn't need one shell call per file
			const CHUNK = 50;
			for (let i = 0; i < targets.length; i += CHUNK) {
				const chunk = targets.slice(i, i + CHUNK);
				progress = `Deleting ${Math.min(i + chunk.length, targets.length)}/${targets.length}...`;
				assertDeleted(
					await adbExec(ShellCmd.rmMany(chunk.map((s) => `${DEVICE_PATHS.screenshots}/${s.name}`)))
				);
				deleted.push(...chunk);
			}
			notice = successMsg(`Deleted ${plural(targets.length, 'screenshot')}`);
		} catch (e) {
			notice = errorMsg(
				deleted.length > 0
					? `Deleted ${deleted.length} of ${targets.length}, then failed: ${formatError(e)}`
					: `Delete failed: ${formatError(e)}`
			);
		} finally {
			// Prune whatever actually made it off the device, even if a later chunk failed
			forget(deleted);
			progress = '';
			deleting = false;
		}
	}

	async function downloadAll() {
		const targets = selectedShots.length > 0 ? selectedShots : screenshots;
		if (targets.length === 0) return;
		downloading = true;
		notice = null;
		progress = '';

		beginTransfer('download', targets.length);
		try {
			const zip = new JSZip();
			let completed = 0;

			for (const shot of targets) {
				progress = `Downloading ${completed + 1}/${targets.length}: ${shot.name}`;
				const data = await trackedPull(adb, `${DEVICE_PATHS.screenshots}/${shot.name}`);
				zip.file(shot.name, data);
				completed++;
			}

			progress = 'Creating zip...';
			const blob = await zip.generateAsync({ type: 'blob' });

			const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
			const filename = `NextUI_screenshots_${timestamp}.zip`;

			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = filename;
			a.click();
			URL.revokeObjectURL(url);

			progress = '';
			notice = successMsg(`Downloaded ${filename} (${targets.length} files)`);
		} catch (e) {
			notice = errorMsg(`Download failed: ${formatError(e)}`);
			progress = '';
		} finally {
			endTransfer();
		}
		downloading = false;
	}

	// Refresh on mount + cleanup blob URLs on unmount
	$effect(() => {
		untrack(() => refresh());
		return () => {
			for (const s of screenshots) {
				if (s.thumbnailUrl) URL.revokeObjectURL(s.thumbnailUrl);
			}
		};
	});
</script>

<div class="p-6 flex flex-col h-full">
	<div class="flex items-center justify-between mb-4">
		<h2 class="text-2xl font-bold text-text">Screenshots</h2>
		<div class="flex items-center gap-2">
			<ActionButton onclick={refresh} disabled={busy} variant="secondary">
				{loading ? 'Loading...' : 'Refresh'}
			</ActionButton>
			<ActionButton
				onclick={toggleSelectAll}
				disabled={busy || screenshots.length === 0}
				variant="secondary"
			>
				{allSelected ? 'Clear Selection' : 'Select All'}
			</ActionButton>
			<ActionButton
				onclick={downloadAll}
				disabled={busy || screenshots.length === 0}
				variant="primary"
			>
				{#if downloading}
					Downloading...
				{:else if selectedShots.length > 0}
					Download {plural(selectedShots.length, 'File')} as Zip
				{:else}
					Download All as Zip
				{/if}
			</ActionButton>
			{#if selectedShots.length > 0}
				<ActionButton onclick={deleteSelected} disabled={busy} variant="danger">
					{deleting ? 'Deleting...' : `Delete ${plural(selectedShots.length, 'File')}`}
				</ActionButton>
			{/if}
		</div>
	</div>

	{#if notice}
		<StatusMessage notification={notice} />
	{/if}

	{#if progress}
		<div class="text-xs text-text-muted mb-3">{progress}</div>
	{/if}

	<div class="text-xs text-text-muted mb-3">
		Source: <span class="font-mono">{DEVICE_PATHS.screenshots}/</span>
	</div>

	<div class="flex-1 overflow-auto">
		{#if loading && screenshots.length === 0}
			<div class="text-sm text-text-muted py-8 text-center">Scanning for screenshots...</div>
		{:else if screenshots.length === 0 && !loading}
			<div class="text-sm text-text-muted py-8 text-center">No screenshots found</div>
		{:else}
			<div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
				{#each screenshots as shot (shot.name)}
					<div
						class="border rounded-lg overflow-hidden bg-bg group {shot.selected
							? 'border-accent'
							: 'border-border'}"
					>
						<div class="aspect-video bg-surface flex items-center justify-center">
							{#if shot.loadingThumb}
								<div class="w-full h-full bg-surface-hover animate-pulse"></div>
							{:else if shot.thumbnailUrl}
								<button onclick={() => openPreview(shot)} class="w-full h-full cursor-pointer">
									<img
										src={shot.thumbnailUrl}
										alt={shot.name}
										class="w-full h-full object-contain"
									/>
								</button>
							{:else}
								<span class="text-text-muted text-2xl">&#128247;</span>
							{/if}
						</div>
						<div class="p-2">
							<label class="flex items-center gap-2 cursor-pointer">
								<input
									type="checkbox"
									bind:checked={shot.selected}
									disabled={busy}
									class="accent-accent shrink-0"
									title="Select screenshot"
								/>
								<span class="text-xs text-text truncate" title={shot.name}>{shot.name}</span>
							</label>
							<div class="flex items-center justify-between gap-2 mt-1">
								<span class="text-xs text-text-muted">
									{formatSize(Number(shot.size))}
									{#if formatDate(shot.mtime)}
										&middot; {formatDate(shot.mtime)}
									{/if}
								</span>
								<ActionButton
									onclick={() => removeScreenshot(shot)}
									disabled={busy}
									variant="danger"
									size="xs"
									title="Delete screenshot"
								>
									{removingFile === shot.name ? '...' : 'Delete'}
								</ActionButton>
							</div>
						</div>
					</div>
				{/each}
			</div>
		{/if}
	</div>

	<div class="mt-2 text-xs text-text-muted flex justify-between">
		<span>
			{plural(screenshots.length, 'screenshot')}
			{#if selectedShots.length > 0}
				&middot; {selectedShots.length} selected
			{/if}
		</span>
		{#if screenshots.length > 0}
			<span>Total: {formatSize(totalSize)}</span>
		{/if}
	</div>
</div>

{#if previewSrc}
	<ImagePreview src={previewSrc} alt={previewAlt} onClose={closePreview} />
{/if}
