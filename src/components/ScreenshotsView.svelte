<script lang="ts">
	import { untrack } from 'svelte';
	import type { Adb } from '@yume-chan/adb';
	import { DEVICE_PATHS } from '$lib/adb/types.js';
	import { listDirectory, pullFile } from '$lib/adb/file-ops.js';
	import { adbExec } from '$lib/stores/connection.svelte.js';
	import { formatSize, formatError, getMimeType, plural, errorMsg, successMsg, type Notification } from '$lib/utils.js';
	import { ShellCmd } from '$lib/adb/adb-utils.js';
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
	}

	const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.bmp']);

	let screenshots: Screenshot[] = $state([]);
	let loading = $state(false);
	let notice: Notification | null = $state(null);
	let previewSrc: string | null = $state(null);
	let previewAlt: string = $state('');
	let removingFile: string | null = $state(null);
	let downloading = $state(false);
	let downloadProgress: string = $state('');

	const totalSize = $derived(screenshots.reduce((sum, s) => sum + Number(s.size), 0));

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
					loadingThumb: false
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

	async function removeScreenshot(shot: Screenshot) {
		if (!confirm(`Delete "${shot.name}"?`)) return;
		removingFile = shot.name;
		try {
			await adbExec(ShellCmd.rm(`${DEVICE_PATHS.screenshots}/${shot.name}`));
			if (shot.thumbnailUrl) URL.revokeObjectURL(shot.thumbnailUrl);
			screenshots = screenshots.filter((s) => s !== shot);
		} catch (e) {
			notice = errorMsg(`Delete failed: ${formatError(e)}`);
		} finally {
			removingFile = null;
		}
	}

	async function downloadAll() {
		if (screenshots.length === 0) return;
		downloading = true;
		notice = null;
		downloadProgress = '';

		try {
			const zip = new JSZip();
			let completed = 0;

			for (const shot of screenshots) {
				downloadProgress = `Downloading ${completed + 1}/${screenshots.length}: ${shot.name}`;
				const data = await pullFile(adb, `${DEVICE_PATHS.screenshots}/${shot.name}`);
				zip.file(shot.name, data);
				completed++;
			}

			downloadProgress = 'Creating zip...';
			const blob = await zip.generateAsync({ type: 'blob' });

			const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
			const filename = `NextUI_screenshots_${timestamp}.zip`;

			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = filename;
			a.click();
			URL.revokeObjectURL(url);

			downloadProgress = '';
			notice = successMsg(`Downloaded ${filename} (${screenshots.length} files)`);
		} catch (e) {
			notice = errorMsg(`Download failed: ${formatError(e)}`);
			downloadProgress = '';
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
			<button
				onclick={refresh}
				disabled={loading || downloading}
				class="text-sm bg-surface hover:bg-surface-hover text-text disabled:opacity-50 px-3 py-1.5 rounded"
			>
				{loading ? 'Loading...' : 'Refresh'}
			</button>
			<button
				onclick={downloadAll}
				disabled={loading || downloading || screenshots.length === 0}
				class="text-sm bg-accent text-white px-3 py-1.5 rounded hover:bg-accent-hover disabled:opacity-50"
			>
				{downloading ? 'Downloading...' : 'Download All as Zip'}
			</button>
		</div>
	</div>

	{#if notice}
		<StatusMessage notification={notice} />
	{/if}

	{#if downloadProgress}
		<div class="text-xs text-text-muted mb-3">{downloadProgress}</div>
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
				{#each screenshots as shot}
					<div class="border border-border rounded-lg overflow-hidden bg-bg group">
						<div class="aspect-video bg-surface flex items-center justify-center">
							{#if shot.loadingThumb}
								<div class="w-full h-full bg-surface-hover animate-pulse"></div>
							{:else if shot.thumbnailUrl}
								<button onclick={() => openPreview(shot)} class="w-full h-full cursor-pointer">
									<img src={shot.thumbnailUrl} alt={shot.name} class="w-full h-full object-contain" />
								</button>
							{:else}
								<span class="text-text-muted text-2xl">&#128247;</span>
							{/if}
						</div>
						<div class="p-2">
							<div class="text-xs text-text truncate" title={shot.name}>{shot.name}</div>
							<div class="flex items-center justify-between mt-1">
								<span class="text-xs text-text-muted">
									{formatSize(Number(shot.size))}
									{#if formatDate(shot.mtime)}
										&middot; {formatDate(shot.mtime)}
									{/if}
								</span>
								<button
									onclick={() => removeScreenshot(shot)}
									disabled={removingFile !== null}
									class="text-xs text-accent hover:text-accent-hover disabled:opacity-50"
									title="Delete screenshot"
								>
									{removingFile === shot.name ? '...' : 'Delete'}
								</button>
							</div>
						</div>
					</div>
				{/each}
			</div>
		{/if}
	</div>

	<div class="mt-2 text-xs text-text-muted flex justify-between">
		<span>{plural(screenshots.length, 'screenshot')}</span>
		{#if screenshots.length > 0}
			<span>Total: {formatSize(totalSize)}</span>
		{/if}
	</div>
</div>

{#if previewSrc}
	<ImagePreview src={previewSrc} alt={previewAlt} onClose={closePreview} />
{/if}
