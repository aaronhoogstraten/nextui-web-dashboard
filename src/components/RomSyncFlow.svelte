<script lang="ts">
	import type { Adb } from '@yume-chan/adb';
	import { DEVICE_PATHS } from '$lib/adb/types.js';
	import { listDirectory, pushFile } from '$lib/adb/file-ops.js';
	import { adbExec } from '$lib/stores/connection.svelte.js';
	import { formatSize, formatError, errorMsg, type Notification } from '$lib/utils.js';
	import { adbLog } from '$lib/stores/log.svelte.js';
	import { ShellCmd } from '$lib/adb/adb-utils.js';
	import { parseRomDirectoryName } from '$lib/roms/index.js';
	import Modal from './Modal.svelte';
	import StatusMessage from './StatusMessage.svelte';

	let { adb, oncomplete }: { adb: Adb; oncomplete: () => void } = $props();

	// --- Types ---

	interface SyncFile {
		name: string;
		localSize: number;
		deviceSize: number | null;
		status: 'new' | 'exists';
		checked: boolean;
		isMedia: boolean;
		fileHandle: FileSystemFileHandle;
	}

	interface SyncSystem {
		dirName: string;
		files: SyncFile[];
		expanded: boolean;
	}

	type SyncPhase = 'scanning' | 'review' | 'syncing' | 'done';
	type ConflictResolution = 'overwrite' | 'skip' | 'overwrite-all' | 'skip-all';

	// --- State ---

	let syncPhase: SyncPhase = $state('scanning');
	let syncNotice: Notification | null = $state(null);
	let syncSystems: SyncSystem[] = $state([]);
	let syncScanStatus: string = $state('');
	let syncCurrentSystem: string = $state('');
	let syncCurrentFile: string = $state('');
	let syncCompleted = $state(0);
	let syncTotal = $state(0);
	let syncTransferred = $state(0);
	let syncSkipped = $state(0);
	let syncFailed = $state(0);
	let syncConflictFile: SyncFile | null = $state.raw(null);
	let syncConflictResolve: ((r: ConflictResolution) => void) | null = $state.raw(null);

	const syncTotalNew = $derived(
		syncSystems.reduce((sum, s) => sum + s.files.filter((f) => f.status === 'new').length, 0)
	);
	const syncTotalExisting = $derived(
		syncSystems.reduce((sum, s) => sum + s.files.filter((f) => f.status === 'exists').length, 0)
	);
	const syncTotalChecked = $derived(
		syncSystems.reduce((sum, s) => sum + s.files.filter((f) => f.checked).length, 0)
	);

	// --- Helpers ---

	function syncSystemCounts(sys: SyncSystem) {
		return {
			newCount: sys.files.filter((f) => f.status === 'new').length,
			existsCount: sys.files.filter((f) => f.status === 'exists').length,
			checkedCount: sys.files.filter((f) => f.checked).length
		};
	}

	// --- Sync Flow ---

	export async function start(dirHandle: FileSystemDirectoryHandle) {
		syncNotice = null;
		syncPhase = 'scanning';
		await scanSyncFolder(dirHandle);
		if (syncPhase === 'scanning') {
			syncPhase = 'review';
		}
	}

	async function scanSyncFolder(dirHandle: FileSystemDirectoryHandle) {
		syncSystems = [];
		syncScanStatus = 'Scanning local folder...';

		const localSystems: { dirName: string; files: SyncFile[] }[] = [];

		for await (const entry of dirHandle.values()) {
			if (entry.kind !== 'directory') continue;
			const parsed = parseRomDirectoryName(entry.name);
			if (!parsed) continue;

			syncScanStatus = `Scanning ${entry.name}...`;
			const sysFiles: SyncFile[] = [];

			const sysDirHandle = await dirHandle.getDirectoryHandle(entry.name);
			for await (const fileEntry of sysDirHandle.values()) {
				if (fileEntry.kind !== 'file') continue;
				if (fileEntry.name.startsWith('.')) continue;
				const fileHandle = fileEntry as FileSystemFileHandle;
				const file = await fileHandle.getFile();
				sysFiles.push({
					name: fileEntry.name, localSize: file.size, deviceSize: null,
					status: 'new', checked: true, isMedia: false, fileHandle
				});
			}

			try {
				const mediaDirHandle = await sysDirHandle.getDirectoryHandle('.media');
				for await (const mediaEntry of mediaDirHandle.values()) {
					if (mediaEntry.kind !== 'file') continue;
					if (mediaEntry.name.startsWith('.')) continue;
					const fileHandle = mediaEntry as FileSystemFileHandle;
					const file = await fileHandle.getFile();
					sysFiles.push({
						name: mediaEntry.name, localSize: file.size, deviceSize: null,
						status: 'new', checked: true, isMedia: true, fileHandle
					});
				}
			} catch { /* no .media/ */ }

			if (sysFiles.length > 0) {
				localSystems.push({ dirName: entry.name, files: sysFiles });
			}
		}

		if (localSystems.length === 0) {
			syncNotice = errorMsg('No system directories found matching the expected pattern (e.g. "Game Boy (GB)").');
			oncomplete();
			return;
		}

		syncScanStatus = 'Comparing with device...';

		for (const sys of localSystems) {
			syncScanStatus = `Comparing ${sys.dirName}...`;
			const devicePath = `${DEVICE_PATHS.roms}/${sys.dirName}`;

			const deviceFileMap = new Map<string, number>();
			try {
				for (const e of await listDirectory(adb, devicePath)) {
					if (e.isFile && !e.name.startsWith('.')) deviceFileMap.set(e.name, Number(e.size));
				}
			} catch { /* dir doesn't exist */ }

			const deviceMediaMap = new Map<string, number>();
			try {
				for (const e of await listDirectory(adb, `${devicePath}/.media`)) {
					if (e.isFile && !e.name.startsWith('.')) deviceMediaMap.set(e.name, Number(e.size));
				}
			} catch { /* no .media/ */ }

			for (const file of sys.files) {
				const deviceSize = (file.isMedia ? deviceMediaMap : deviceFileMap).get(file.name);
				if (deviceSize !== undefined) {
					file.status = 'exists';
					file.deviceSize = deviceSize;
					file.checked = false;
				}
			}
		}

		syncSystems = localSystems
			.sort((a, b) => a.dirName.localeCompare(b.dirName, undefined, { sensitivity: 'base' }))
			.map((s) => ({ ...s, expanded: false }));
		syncScanStatus = '';
	}

	function syncCheckAllNew() {
		for (const sys of syncSystems) {
			for (const f of sys.files) {
				if (f.status === 'new') f.checked = true;
			}
		}
	}

	function syncCheckNewInSystem(sys: SyncSystem) {
		for (const f of sys.files) {
			if (f.status === 'new') f.checked = true;
		}
	}

	function syncCheckAllInSystem(sys: SyncSystem) {
		for (const f of sys.files) f.checked = true;
	}

	function syncUncheckSystem(sys: SyncSystem) {
		for (const f of sys.files) f.checked = false;
	}

	function exitSync() {
		oncomplete();
	}

	async function executeSync() {
		const filesToSync = syncSystems.flatMap((sys) =>
			sys.files.filter((f) => f.checked).map((f) => ({ system: sys.dirName, file: f }))
		);
		if (filesToSync.length === 0) { syncNotice = errorMsg('No files selected.'); return; }

		syncPhase = 'syncing';
		syncNotice = null;
		syncCompleted = 0;
		syncTotal = filesToSync.length;
		syncTransferred = 0;
		syncSkipped = 0;
		syncFailed = 0;

		let conflictPolicy: 'ask' | 'overwrite-all' | 'skip-all' = 'ask';

		for (const item of filesToSync) {
			syncCurrentSystem = item.system;
			syncCurrentFile = item.file.name;

			if (item.file.status === 'exists') {
				if (conflictPolicy === 'skip-all') {
					syncSkipped++; syncCompleted++; continue;
				}
				if (conflictPolicy === 'ask') {
					const resolution = await showSyncConflict(item.file);
					if (resolution === 'skip') { syncSkipped++; syncCompleted++; continue; }
					if (resolution === 'skip-all') { syncSkipped++; syncCompleted++; conflictPolicy = 'skip-all'; continue; }
					if (resolution === 'overwrite-all') conflictPolicy = 'overwrite-all';
				}
			}

			try {
				const devicePath = `${DEVICE_PATHS.roms}/${item.system}`;
				await adbExec(ShellCmd.mkdir(item.file.isMedia ? devicePath + '/.media' : devicePath));
				const file = await item.file.fileHandle.getFile();
				const data = new Uint8Array(await file.arrayBuffer());
				const remotePath = item.file.isMedia
					? `${devicePath}/.media/${item.file.name}`
					: `${devicePath}/${item.file.name}`;
				await pushFile(adb, remotePath, data);
				syncTransferred++;
			} catch (e) {
				adbLog.error(`Sync failed for ${item.system}/${item.file.name}: ${formatError(e)}`);
				syncFailed++;
			}

			syncCompleted++;
		}

		syncCurrentSystem = '';
		syncCurrentFile = '';
		syncPhase = 'done';
	}

	function showSyncConflict(file: SyncFile): Promise<ConflictResolution> {
		return new Promise((resolve) => {
			syncConflictFile = file;
			syncConflictResolve = resolve;
		});
	}

	function resolveSyncConflict(resolution: ConflictResolution) {
		if (syncConflictResolve) {
			syncConflictResolve(resolution);
			syncConflictFile = null;
			syncConflictResolve = null;
		}
	}
</script>

{#if syncPhase === 'scanning'}
	<!-- Sync: Scanning -->
	<div class="flex-1 flex items-center justify-center">
		<div class="text-center">
			<div class="text-text mb-2">Scanning...</div>
			<div class="text-sm text-text-muted">{syncScanStatus}</div>
		</div>
	</div>

{:else if syncPhase === 'review'}
	<!-- Sync: Review Diff -->
	<div class="flex items-center justify-between mb-4">
		<div class="flex items-center gap-3">
			<button onclick={exitSync} class="text-sm text-accent hover:underline">&larr; Back</button>
			<h2 class="text-2xl font-bold text-text">Sync Review</h2>
		</div>
	</div>

	{#if syncNotice}
		<StatusMessage notification={syncNotice} />
	{/if}

	<div class="flex items-center gap-4 mb-3 text-sm">
		<span class="text-green-500">+{syncTotalNew} new</span>
		<span class="text-yellow-500">~{syncTotalExisting} existing</span>
		<span class="text-text-muted">{syncTotalChecked} selected</span>
		<div class="flex-1"></div>
		<button onclick={syncCheckAllNew} class="text-sm text-accent hover:underline">
			Select All New
		</button>
		<button
			onclick={executeSync}
			disabled={syncTotalChecked === 0}
			class="bg-accent text-white px-4 py-1.5 rounded hover:bg-accent-hover disabled:opacity-50 text-sm"
		>
			Start Sync ({syncTotalChecked} file{syncTotalChecked !== 1 ? 's' : ''})
		</button>
	</div>

	<div class="flex-1 overflow-auto space-y-2">
		{#each syncSystems as sys}
			{@const counts = syncSystemCounts(sys)}
			<div class="border border-border rounded-lg overflow-hidden">
				<button
					onclick={() => (sys.expanded = !sys.expanded)}
					class="w-full flex items-center justify-between p-3 bg-surface hover:bg-surface-hover text-left"
				>
					<span class="font-semibold text-text">{sys.dirName}</span>
					<div class="flex items-center gap-3 text-xs">
						{#if counts.newCount > 0}
							<span class="text-green-500">+{counts.newCount} new</span>
						{/if}
						{#if counts.existsCount > 0}
							<span class="text-yellow-500">~{counts.existsCount} existing</span>
						{/if}
						<span class="text-text-muted">{counts.checkedCount} selected</span>
						<span class="text-text-muted">{sys.expanded ? '\u25B2' : '\u25BC'}</span>
					</div>
				</button>

				{#if sys.expanded}
					<div class="p-3">
						<div class="flex items-center gap-2 mb-2">
							<button onclick={() => syncCheckNewInSystem(sys)} class="text-xs text-accent hover:underline">Select new</button>
							<button onclick={() => syncCheckAllInSystem(sys)} class="text-xs text-accent hover:underline">Select all</button>
							<button onclick={() => syncUncheckSystem(sys)} class="text-xs text-text-muted hover:text-text">Deselect all</button>
						</div>
						<table class="w-full text-sm">
							<thead>
								<tr class="text-left text-text-muted text-xs">
									<th class="py-1 px-2 w-8"></th>
									<th class="py-1 px-2 font-medium">File</th>
									<th class="py-1 px-2 font-medium w-20 text-right">Local</th>
									<th class="py-1 px-2 font-medium w-20 text-right">Device</th>
									<th class="py-1 px-2 font-medium w-16">Status</th>
								</tr>
							</thead>
							<tbody>
								{#each sys.files as file}
									<tr class="border-t border-border hover:bg-surface-hover transition-colors">
										<td class="py-1 px-2">
											<input type="checkbox" bind:checked={file.checked} class="accent-accent" />
										</td>
										<td class="py-1 px-2">
											<span class="text-text text-xs truncate block" title={file.name}>
												{#if file.isMedia}<span class="text-text-muted">.media/</span>{/if}{file.name}
											</span>
										</td>
										<td class="py-1 px-2 text-right text-text-muted text-xs tabular-nums">
											{formatSize(file.localSize)}
										</td>
										<td class="py-1 px-2 text-right text-text-muted text-xs tabular-nums">
											{file.deviceSize !== null ? formatSize(file.deviceSize) : '\u2014'}
										</td>
										<td class="py-1 px-2">
											{#if file.status === 'new'}
												<span class="text-xs text-green-500">New</span>
											{:else}
												<span class="text-xs text-yellow-500">Exists</span>
											{/if}
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}
			</div>
		{/each}
	</div>

{:else if syncPhase === 'syncing'}
	<!-- Sync: Progress -->
	<div class="flex-1 flex flex-col items-center justify-center gap-4">
		<div class="text-text font-medium">Syncing...</div>
		<div class="w-full max-w-md">
			<div class="flex justify-between text-xs text-text-muted mb-1">
				<span>{syncCurrentSystem}</span>
				<span>{syncCompleted}/{syncTotal}</span>
			</div>
			<div class="w-full bg-surface rounded-full h-2">
				<div class="bg-accent h-2 rounded-full transition-all" style="width: {syncTotal > 0 ? (syncCompleted / syncTotal) * 100 : 0}%"></div>
			</div>
			<div class="text-xs text-text-muted mt-2 truncate text-center" title={syncCurrentFile}>{syncCurrentFile}</div>
		</div>
		<div class="flex gap-4 text-xs">
			<span class="text-green-500">{syncTransferred} transferred</span>
			<span class="text-text-muted">{syncSkipped} skipped</span>
			{#if syncFailed > 0}
				<span class="text-red-400">{syncFailed} failed</span>
			{/if}
		</div>
	</div>

{:else if syncPhase === 'done'}
	<!-- Sync: Complete -->
	<div class="flex-1 flex items-center justify-center">
		<div class="text-center space-y-3">
			<div class="text-xl font-bold text-text">Sync Complete</div>
			<div class="flex gap-6 justify-center text-sm">
				<div class="text-center">
					<div class="text-2xl font-bold text-green-500">{syncTransferred}</div>
					<div class="text-text-muted">Transferred</div>
				</div>
				<div class="text-center">
					<div class="text-2xl font-bold text-text-muted">{syncSkipped}</div>
					<div class="text-text-muted">Skipped</div>
				</div>
				{#if syncFailed > 0}
					<div class="text-center">
						<div class="text-2xl font-bold text-red-400">{syncFailed}</div>
						<div class="text-text-muted">Failed</div>
					</div>
				{/if}
			</div>
			<button onclick={exitSync} class="bg-surface hover:bg-surface-hover text-text px-4 py-1.5 rounded text-sm mt-4">
				Back to ROMs
			</button>
		</div>
	</div>
{/if}

<!-- Sync Conflict Dialog -->
{#if syncConflictFile}
	<Modal onclose={() => resolveSyncConflict('skip')}>
		<div class="p-6">
			<h3 class="text-lg font-bold text-text mb-3">File Already Exists</h3>
			<div class="text-sm text-text mb-4">
				<div class="font-mono text-xs text-text-muted mb-3 truncate" title={syncConflictFile.name}>{syncConflictFile.name}</div>
				<div class="flex justify-between text-xs">
					<div><span class="text-text-muted">Local:</span> <span class="text-text">{formatSize(syncConflictFile.localSize)}</span></div>
					<div><span class="text-text-muted">Device:</span> <span class="text-text">{syncConflictFile.deviceSize !== null ? formatSize(syncConflictFile.deviceSize) : 'unknown'}</span></div>
				</div>
			</div>
			<div class="grid grid-cols-2 gap-2">
				<button onclick={() => resolveSyncConflict('overwrite')} class="text-sm bg-accent text-white px-3 py-2 rounded hover:bg-accent-hover">Overwrite</button>
				<button onclick={() => resolveSyncConflict('skip')} class="text-sm bg-surface text-text px-3 py-2 rounded hover:bg-surface-hover">Skip</button>
				<button onclick={() => resolveSyncConflict('overwrite-all')} class="text-sm bg-accent/70 text-white px-3 py-2 rounded hover:bg-accent">Overwrite All</button>
				<button onclick={() => resolveSyncConflict('skip-all')} class="text-sm bg-surface text-text-muted px-3 py-2 rounded hover:bg-surface-hover">Skip All</button>
			</div>
		</div>
	</Modal>
{/if}
