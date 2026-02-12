<script lang="ts">
	import { untrack } from 'svelte';
	import type { Adb } from '@yume-chan/adb';
	import { listDirectory, pullFile } from '$lib/adb/file-ops.js';
	import { DEVICE_PATHS } from '$lib/adb/types.js';
	import { getNextUIVersion } from '$lib/stores/connection.svelte.js';
	import { formatSize, formatError, errorMsg, successMsg, type Notification } from '$lib/utils.js';
	import StatusMessage from './StatusMessage.svelte';
	import JSZip from 'jszip';

	let { adb }: { adb: Adb } = $props();

	interface LogFile {
		/** Relative path from .userdata, e.g. "app/logs/crash.log" */
		relativePath: string;
		/** Full device path */
		fullPath: string;
		/** File size in bytes */
		size: bigint;
	}

	let logFiles: LogFile[] = $state([]);
	let scanning = $state(false);
	let downloading = $state(false);
	let notice: Notification | null = $state(null);
	let progress: string = $state('');

	const totalSize = $derived(logFiles.reduce((sum, f) => sum + Number(f.size), 0));

	async function scanForLogs() {
		scanning = true;
		notice = null;
		logFiles = [];
		const found: LogFile[] = [];

		try {
			// List all subdirectories under .userdata
			const userdataEntries = await listDirectory(adb, DEVICE_PATHS.userdata);
			const subdirs = userdataEntries.filter((e) => e.isDirectory);

			for (const subdir of subdirs) {
				const logsPath = `${DEVICE_PATHS.userdata}/${subdir.name}/logs`;

				// Try to list the logs directory — if it doesn't exist, listDirectory will throw
				try {
					const logEntries = await listDirectory(adb, logsPath);
					for (const entry of logEntries) {
						if (entry.isFile) {
							found.push({
								relativePath: `${subdir.name}/logs/${entry.name}`,
								fullPath: `${logsPath}/${entry.name}`,
								size: entry.size
							});
						}
					}
				} catch {
					// No logs directory in this subdirectory — skip
				}
			}

			logFiles = found;
			if (found.length === 0) {
				notice = errorMsg('No log files found on device.');
			}
		} catch (e) {
			notice = errorMsg(`Failed to scan for logs: ${formatError(e)}`);
		}
		scanning = false;
	}

	async function downloadLogs() {
		if (logFiles.length === 0) return;
		downloading = true;
		notice = null;
		progress = '';

		try {
			const zip = new JSZip();
			let completed = 0;

			for (const file of logFiles) {
				progress = `Downloading ${completed + 1}/${logFiles.length}: ${file.relativePath}`;
				const data = await pullFile(adb, file.fullPath);
				zip.file(file.relativePath, data);
				completed++;
			}

			progress = 'Creating zip...';
			const blob = await zip.generateAsync({ type: 'blob' });

			// Build filename: NextUI_logs_{version}_{timestamp}.zip
			const version = getNextUIVersion() || 'unknown';
			const safeVersion = version.replace(/[^a-zA-Z0-9._-]/g, '_');
			const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
			const filename = `NextUI_logs_${safeVersion}_${timestamp}.zip`;

			// Trigger browser download
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = filename;
			a.click();
			URL.revokeObjectURL(url);

			progress = '';
			notice = successMsg(`Downloaded ${filename} (${logFiles.length} files)`);
		} catch (e) {
			notice = errorMsg(`Download failed: ${formatError(e)}`);
			progress = '';
		}
		downloading = false;
	}

	// Scan on mount
	$effect(() => {
		untrack(() => scanForLogs());
	});
</script>

<div class="p-6 flex flex-col h-full">
	<div class="flex items-center justify-between mb-4">
		<h2 class="text-2xl font-bold text-text">Download Logs</h2>
		<div class="flex items-center gap-2">
			<button
				onclick={scanForLogs}
				disabled={scanning || downloading}
				class="text-sm bg-surface hover:bg-surface-hover text-text disabled:opacity-50 px-3 py-1.5 rounded"
			>
				{scanning ? 'Scanning...' : 'Rescan'}
			</button>
			<button
				onclick={downloadLogs}
				disabled={scanning || downloading || logFiles.length === 0}
				class="text-sm bg-accent text-white px-3 py-1.5 rounded hover:bg-accent-hover disabled:opacity-50"
			>
				{downloading ? 'Downloading...' : 'Download All as Zip'}
			</button>
		</div>
	</div>

	{#if notice}
		<StatusMessage notification={notice} />
	{/if}

	{#if progress}
		<div class="text-xs text-text-muted mb-3">{progress}</div>
	{/if}

	<div class="text-xs text-text-muted mb-3">
		Source: <span class="font-mono">{DEVICE_PATHS.userdata}/*/logs/</span>
	</div>

	<div class="flex-1 overflow-auto border border-border rounded-lg">
		<table class="w-full text-sm">
			<thead class="bg-surface sticky top-0">
				<tr class="text-left">
					<th class="py-2 px-3 font-medium text-text-muted">File</th>
					<th class="py-2 px-3 font-medium text-text-muted w-28 text-right">Size</th>
				</tr>
			</thead>
			<tbody>
				{#if scanning}
					<tr>
						<td colspan="2" class="py-8 text-center text-text-muted">Scanning for log files...</td>
					</tr>
				{:else if logFiles.length === 0}
					<tr>
						<td colspan="2" class="py-8 text-center text-text-muted">No log files found</td>
					</tr>
				{:else}
					{#each logFiles as file}
						<tr class="border-t border-border hover:bg-surface-hover transition-colors">
							<td class="py-1.5 px-3 font-mono text-text">{file.relativePath}</td>
							<td class="py-1.5 px-3 text-right text-text-muted tabular-nums">
								{formatSize(Number(file.size))}
							</td>
						</tr>
					{/each}
				{/if}
			</tbody>
		</table>
	</div>

	<div class="mt-2 text-xs text-text-muted flex justify-between">
		<span>{logFiles.length} log file{logFiles.length !== 1 ? 's' : ''}</span>
		{#if logFiles.length > 0}
			<span>Total: {formatSize(totalSize)}</span>
		{/if}
	</div>
</div>
