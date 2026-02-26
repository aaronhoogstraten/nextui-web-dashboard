<script lang="ts">
	import { tick, untrack } from 'svelte';
	import type { Adb, AdbSocket } from '@yume-chan/adb';
	import { listDirectory } from '$lib/adb/file-ops.js';
	import { beginTransfer, endTransfer, trackedPull } from '$lib/stores/transfer.svelte.js';
	import { DEVICE_PATHS } from '$lib/adb/types.js';
	import { getNextUIVersion } from '$lib/stores/connection.svelte.js';
	import { ShellCmd } from '$lib/adb/adb-utils.js';
	import { formatSize, formatError, plural, errorMsg, successMsg, type Notification } from '$lib/utils.js';
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

	const MAX_LINES = 2000;

	let logFiles: LogFile[] = $state([]);
	let scanning = $state(false);
	let downloading = $state(false);
	let notice: Notification | null = $state(null);
	let progress: string = $state('');

	// Tail view state
	let viewingFile: LogFile | null = $state(null);
	let logLines: string[] = $state([]);
	let tailSocket: AdbSocket | null = $state.raw(null);
	let tailAbort: AbortController | null = null;
	let autoScroll = $state(true);
	let tailError: string | null = $state(null);
	let logContainer: HTMLElement | undefined = $state();

	const totalSize = $derived(logFiles.reduce((sum, f) => sum + Number(f.size), 0));

	async function scrollToBottom() {
		await tick();
		if (autoScroll && logContainer) {
			logContainer.scrollTop = logContainer.scrollHeight;
		}
	}

	async function startTail(file: LogFile) {
		viewingFile = file;
		logLines = [];
		tailError = null;

		const abort = new AbortController();
		tailAbort = abort;

		try {
			const cmd = ShellCmd.tailFollow(file.fullPath);
			const socket = await adb.createSocket(`shell:${cmd}`);
			tailSocket = socket;

			const reader = socket.readable.getReader();
			const decoder = new TextDecoder();
			let partial = '';

			try {
				while (!abort.signal.aborted) {
					const { done, value } = await reader.read();
					if (done) break;

					const text = partial + decoder.decode(value, { stream: true });
					const lines = text.split('\n');
					// Last element may be incomplete — save for next chunk
					partial = lines.pop() ?? '';

					const cleaned = lines.map((l) => l.replace(/\r$/, ''));
					if (cleaned.length > 0) {
						const combined = logLines.concat(cleaned);
						logLines =
							combined.length > MAX_LINES
								? combined.slice(-MAX_LINES)
								: combined;
						scrollToBottom();
					}
				}
			} catch (e) {
				// Only report errors if we weren't intentionally stopped
				if (!abort.signal.aborted) {
					tailError = `Stream ended: ${formatError(e)}`;
				}
			} finally {
				reader.releaseLock();
			}
		} catch (e) {
			tailError = `Failed to open tail: ${formatError(e)}`;
		}
	}

	async function stopTail() {
		const abort = tailAbort;
		const socket = tailSocket;
		tailAbort = null;
		tailSocket = null;
		viewingFile = null;
		logLines = [];
		tailError = null;
		if (abort) abort.abort();
		if (socket) {
			try {
				await socket.close();
			} catch {
				// ignore close errors
			}
		}
	}

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

		beginTransfer('download', logFiles.length);
		try {
			const zip = new JSZip();
			let completed = 0;

			for (const file of logFiles) {
				progress = `Downloading ${completed + 1}/${logFiles.length}: ${file.relativePath}`;
				const data = await trackedPull(adb, file.fullPath);
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
		} finally {
			endTransfer();
		}
		downloading = false;
	}

	// Scan on mount; clean up tail socket on destroy
	$effect(() => {
		untrack(() => scanForLogs());
		return () => {
			untrack(() => stopTail());
		};
	});
</script>

{#if viewingFile}
	<!-- Tail view -->
	<div class="p-6 flex flex-col h-full">
		<div class="flex items-center justify-between mb-4">
			<div class="flex items-center gap-3">
				<button
					onclick={stopTail}
					class="text-sm bg-surface hover:bg-surface-hover text-text px-3 py-1.5 rounded"
				>
					&larr; Back
				</button>
				<h2 class="text-lg font-bold text-text truncate" title={viewingFile.fullPath}>
					{viewingFile.relativePath}
				</h2>
			</div>
			<div class="flex items-center gap-3">
				<label class="flex items-center gap-2 text-sm text-text-muted cursor-pointer">
					<input type="checkbox" bind:checked={autoScroll} class="accent-accent" />
					Auto-scroll
				</label>
				<button
					onclick={() => (logLines = [])}
					class="text-sm bg-surface hover:bg-surface-hover text-text px-3 py-1.5 rounded"
					title="Clear the viewer (does not affect the log file on device)"
				>
					Clear View
				</button>
			</div>
		</div>

		{#if tailError}
			<StatusMessage notification={errorMsg(tailError)} />
		{/if}

		<div
			bind:this={logContainer}
			class="flex-1 overflow-auto border border-border rounded-lg bg-terminal p-3 font-mono text-xs leading-relaxed text-terminal-text"
		>
			{#if logLines.length === 0 && !tailError}
				<div class="text-text-muted italic">Waiting for log output...</div>
			{:else}
				{#each logLines as line}
					<div class="whitespace-pre-wrap break-all">{line}</div>
				{/each}
			{/if}
		</div>

		<div class="mt-2 text-xs text-text-muted">
			{logLines.length} line{logLines.length !== 1 ? 's' : ''}{logLines.length >= MAX_LINES ? ` (capped at ${MAX_LINES})` : ''}
		</div>
	</div>
{:else}
	<!-- File list view -->
	<div class="p-6 flex flex-col h-full">
		<div class="flex items-center justify-between mb-4">
			<h2 class="text-2xl font-bold text-text">Log Viewer</h2>
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
						<th class="py-2 px-3 font-medium text-text-muted w-20"></th>
					</tr>
				</thead>
				<tbody>
					{#if scanning}
						<tr>
							<td colspan="3" class="py-8 text-center text-text-muted">Scanning for log files...</td>
						</tr>
					{:else if logFiles.length === 0}
						<tr>
							<td colspan="3" class="py-8 text-center text-text-muted">No log files found</td>
						</tr>
					{:else}
						{#each logFiles as file}
							<tr class="border-t border-border hover:bg-surface-hover transition-colors">
								<td class="py-1.5 px-3 font-mono text-text">{file.relativePath}</td>
								<td class="py-1.5 px-3 text-right text-text-muted tabular-nums">
									{formatSize(Number(file.size))}
								</td>
								<td class="py-1.5 px-3 text-right">
									<button
										onclick={() => startTail(file)}
										class="text-xs bg-accent text-white px-2 py-1 rounded hover:bg-accent-hover"
									>
										View
									</button>
								</td>
							</tr>
						{/each}
					{/if}
				</tbody>
			</table>
		</div>

		<div class="mt-2 text-xs text-text-muted flex justify-between">
			<span>{plural(logFiles.length, 'log file')}</span>
			{#if logFiles.length > 0}
				<span>Total: {formatSize(totalSize)}</span>
			{/if}
		</div>
	</div>
{/if}
