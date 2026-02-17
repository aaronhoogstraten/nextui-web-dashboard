<script lang="ts">
	import { untrack } from 'svelte';
	import type { Adb } from '@yume-chan/adb';
	import { DEVICE_PATHS } from '$lib/adb/types.js';
	import { listDirectory, pullFile, pushFile, pathExists } from '$lib/adb/file-ops.js';
	import { adbExec } from '$lib/stores/connection.svelte.js';
	import { formatSize, formatError, compareByName, plural, pickFiles, errorMsg, successMsg, type Notification } from '$lib/utils.js';
	import { ShellCmd } from '$lib/adb/adb-utils.js';
	import Modal from './Modal.svelte';
	import StatusMessage from './StatusMessage.svelte';

	let { adb }: { adb: Adb } = $props();

	// --- Types ---

	interface CheatSystem {
		systemCode: string;
		expanded: boolean;
		loading: boolean;
		cheats: CheatFile[];
	}

	interface CheatFile {
		fileName: string;
		romName: string;
		size: bigint;
		romExists: boolean | null;
	}

	// --- State ---

	let systems: CheatSystem[] = $state([]);
	let loading = $state(false);
	let notice: Notification | null = $state(null);
	let uploadingTo: string | null = $state(null);
	let deletingFile: string | null = $state(null);

	// System picker state
	interface PickerSystem {
		dirName: string;
		systemCode: string;
	}
	let pickerOpen = $state(false);
	let pickerSystems: PickerSystem[] = $state([]);
	let pickerLoading = $state(false);

	const totalCheats = $derived(systems.reduce((sum, s) => sum + s.cheats.length, 0));

	// --- Helpers ---

	const CHEATS_PATH = DEVICE_PATHS.cheats;

	function extractRomName(chtFileName: string): string {
		// Cheat filename format: "RomName.ext.cht" → ROM is "RomName.ext"
		if (chtFileName.endsWith('.cht')) {
			return chtFileName.slice(0, -4);
		}
		return chtFileName;
	}

	// --- Data Loading ---

	async function refresh() {
		loading = true;
		notice = null;
		systems = [];

		try {
			const dirExists = await pathExists(adb, CHEATS_PATH);
			if (!dirExists) {
				await adbExec(ShellCmd.mkdir(CHEATS_PATH));
				loading = false;
				return;
			}

			const entries = await listDirectory(adb, CHEATS_PATH);
			const dirs = entries
				.filter((e) => e.isDirectory && !e.name.startsWith('.'))
				.sort(compareByName);

			const result: CheatSystem[] = [];
			for (const dir of dirs) {
				const sysPath = `${CHEATS_PATH}/${dir.name}`;
				const sysEntries = await listDirectory(adb, sysPath);
				const chtFiles = sysEntries
					.filter((e) => e.isFile && e.name.endsWith('.cht'))
					.sort(compareByName);

				if (chtFiles.length === 0) continue;

				result.push({
					systemCode: dir.name,
					expanded: false,
					loading: false,
					cheats: chtFiles.map((f) => ({
						fileName: f.name,
						romName: extractRomName(f.name),
						size: f.size,
						romExists: null
					}))
				});
			}
			systems = result;
		} catch (e) {
			notice = errorMsg(`Failed to load cheats: ${formatError(e)}`);
		}

		loading = false;
	}

	async function toggleExpand(sys: CheatSystem) {
		sys.expanded = !sys.expanded;

		// Validate ROM existence on first expand
		if (sys.expanded && sys.cheats.some((c) => c.romExists === null)) {
			sys.loading = true;
			await validateRoms(sys);
			sys.loading = false;
		}
	}

	async function validateRoms(sys: CheatSystem) {
		// Find the ROM system directory for this system code
		// Cheats use system code (e.g. "GB"), ROMs are in dirs like "Game Boy (GB)"
		try {
			const romDirs = await listDirectory(adb, DEVICE_PATHS.roms);
			const matchingDir = romDirs.find((d) => {
				const match = d.name.match(/\(([^)]+)\)$/);
				return match && match[1] === sys.systemCode;
			});

			if (!matchingDir) {
				// No matching ROM directory — mark all as not found
				for (const cheat of sys.cheats) {
					cheat.romExists = false;
				}
				return;
			}

			const romPath = `${DEVICE_PATHS.roms}/${matchingDir.name}`;
			const romEntries = await listDirectory(adb, romPath);
			const romNames = new Set(romEntries.filter((e) => e.isFile).map((e) => e.name));

			for (const cheat of sys.cheats) {
				cheat.romExists = romNames.has(cheat.romName);
			}
		} catch {
			for (const cheat of sys.cheats) {
				cheat.romExists = false;
			}
		}
	}

	// --- Actions ---

	/** Shared upload logic: pick .cht files, push to system dir. Returns count uploaded, or 0 if cancelled. */
	async function pushCheatFiles(systemCode: string): Promise<number> {
		const files = await pickFiles({ accept: '.cht' });
		if (files.length === 0) return 0;

		uploadingTo = systemCode;
		notice = null;

		const sysPath = `${CHEATS_PATH}/${systemCode}`;
		await adbExec(ShellCmd.mkdir(sysPath));

		for (const file of files) {
			const data = new Uint8Array(await file.arrayBuffer());
			await pushFile(adb, `${sysPath}/${file.name}`, data);
		}
		return files.length;
	}

	async function uploadCheats(sys: CheatSystem) {
		try {
			const count = await pushCheatFiles(sys.systemCode);
			if (count === 0) return;

			notice = successMsg(`Uploaded ${count} cheat file(s) to ${sys.systemCode}`);
			// Reload this system's cheat list
			const sysPath = `${CHEATS_PATH}/${sys.systemCode}`;
			const sysEntries = await listDirectory(adb, sysPath);
			const chtFiles = sysEntries
				.filter((e) => e.isFile && e.name.endsWith('.cht'))
				.sort(compareByName);
			sys.cheats = chtFiles.map((f) => ({
				fileName: f.name,
				romName: extractRomName(f.name),
				size: f.size,
				romExists: null
			}));
			if (sys.expanded) {
				sys.loading = true;
				await validateRoms(sys);
				sys.loading = false;
			}
		} catch (e) {
			notice = errorMsg(`Upload failed: ${formatError(e)}`);
		}
		uploadingTo = null;
	}

	async function openSystemPicker() {
		pickerOpen = true;
		pickerLoading = true;
		pickerSystems = [];

		try {
			const entries = await listDirectory(adb, DEVICE_PATHS.roms);
			pickerSystems = entries
				.filter((e) => e.isDirectory && !e.name.startsWith('.'))
				.sort(compareByName)
				.map((d) => {
					const match = d.name.match(/\(([^)]+)\)$/);
					return {
						dirName: d.name,
						systemCode: match ? match[1] : d.name
					};
				});
		} catch (e) {
			notice = errorMsg(`Failed to load ROM systems: ${formatError(e)}`);
			pickerOpen = false;
		}
		pickerLoading = false;
	}

	async function selectSystemAndUpload(sys: PickerSystem) {
		pickerOpen = false;
		try {
			const count = await pushCheatFiles(sys.systemCode);
			if (count === 0) return;

			notice = successMsg(`Uploaded ${count} cheat file(s) to ${sys.systemCode}`);
			await refresh();
		} catch (e) {
			notice = errorMsg(`Upload failed: ${formatError(e)}`);
		}
		uploadingTo = null;
	}

	async function deleteCheat(sys: CheatSystem, cheat: CheatFile) {
		if (!confirm(`Delete cheat "${cheat.fileName}"?`)) return;
		deletingFile = cheat.fileName;
		try {
			await adbExec(ShellCmd.rm(`${CHEATS_PATH}/${sys.systemCode}/${cheat.fileName}`));
			sys.cheats = sys.cheats.filter((c) => c !== cheat);
			if (sys.cheats.length === 0) {
				systems = systems.filter((s) => s !== sys);
			}
		} catch (e) {
			notice = errorMsg(`Delete failed: ${formatError(e)}`);
		}
		deletingFile = null;
	}

	async function downloadCheat(sys: CheatSystem, cheat: CheatFile) {
		try {
			const data = await pullFile(adb, `${CHEATS_PATH}/${sys.systemCode}/${cheat.fileName}`);
			const blob = new Blob([data]);
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = cheat.fileName;
			a.click();
			URL.revokeObjectURL(url);
		} catch (e) {
			notice = errorMsg(`Download failed: ${formatError(e)}`);
		}
	}

	// Refresh on mount
	$effect(() => {
		untrack(() => refresh());
	});
</script>

<div class="p-6 flex flex-col h-full">
	<div class="flex items-center justify-between mb-4">
		<h2 class="text-2xl font-bold text-text">Cheats</h2>
		<div class="flex items-center gap-2">
			<button
				onclick={openSystemPicker}
				disabled={uploadingTo !== null}
				class="text-sm bg-accent text-white px-3 py-1.5 rounded hover:bg-accent-hover disabled:opacity-50"
			>
				Upload to System
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
		Source: <span class="font-mono">{CHEATS_PATH}/</span>
		<span class="ml-2">Cheat files must match ROM filename + extension (e.g. game.zip.cht for game.zip)</span>
	</div>

	<div class="flex-1 overflow-auto">
		{#if loading}
			<div class="text-sm text-text-muted py-8 text-center">Loading cheats...</div>
		{:else if systems.length === 0}
			<div class="text-sm text-text-muted py-8 text-center">
				No cheat files found. Use "Upload to System" to add .cht files.
			</div>
		{:else}
			<div class="space-y-2">
				{#each systems as sys}
					<div class="border border-border rounded-lg overflow-hidden">
						<button
							onclick={() => toggleExpand(sys)}
							class="w-full flex items-center justify-between p-3 bg-surface hover:bg-surface-hover text-left"
						>
							<span class="font-semibold text-text">{sys.systemCode}</span>
							<div class="flex items-center gap-3">
								<span class="text-sm text-success">
									{plural(sys.cheats.length, 'cheat')}
								</span>
								<span class="text-text-muted">{sys.expanded ? '\u25B2' : '\u25BC'}</span>
							</div>
						</button>

						{#if sys.expanded}
							<div class="p-3 space-y-1">
								{#if sys.loading}
									<div class="text-xs text-text-muted py-2 text-center">Validating ROM matches...</div>
								{/if}

								<div class="flex items-center gap-2 mb-2">
									<button
										onclick={() => uploadCheats(sys)}
										disabled={uploadingTo !== null}
										class="text-xs bg-accent text-white px-2 py-1 rounded hover:bg-accent-hover disabled:opacity-50"
									>
										{uploadingTo === sys.systemCode ? 'Uploading...' : 'Upload .cht'}
									</button>
								</div>

								<table class="w-full text-sm">
									<thead>
										<tr class="text-left text-text-muted">
											<th class="py-1 px-2 font-medium">Cheat File</th>
											<th class="py-1 px-2 font-medium">Target ROM</th>
											<th class="py-1 px-2 font-medium w-20 text-right">Size</th>
											<th class="py-1 px-2 font-medium w-32"></th>
										</tr>
									</thead>
									<tbody>
										{#each sys.cheats as cheat}
											<tr class="border-t border-border hover:bg-surface-hover transition-colors">
												<td class="py-1.5 px-2 text-text font-mono text-xs truncate max-w-[200px]" title={cheat.fileName}>
													{cheat.fileName}
												</td>
												<td class="py-1.5 px-2">
													<div class="flex items-center gap-1.5">
														{#if cheat.romExists === true}
															<span class="text-success" title="ROM found">&#10003;</span>
														{:else if cheat.romExists === false}
															<span class="text-warning" title="ROM not found">&#9888;</span>
														{/if}
														<span class="text-text-muted text-xs truncate" title={cheat.romName}>
															{cheat.romName}
														</span>
													</div>
												</td>
												<td class="py-1.5 px-2 text-right text-text-muted text-xs tabular-nums">
													{formatSize(cheat.size)}
												</td>
												<td class="py-1.5 px-2">
													<div class="flex items-center gap-2">
														<button
															onclick={() => downloadCheat(sys, cheat)}
															class="text-xs text-accent hover:underline"
														>
															Download
														</button>
														<button
															onclick={() => deleteCheat(sys, cheat)}
															disabled={deletingFile !== null}
															class="text-xs text-accent hover:text-accent-hover disabled:opacity-50"
														>
															{deletingFile === cheat.fileName ? '...' : 'Delete'}
														</button>
													</div>
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
		{/if}
	</div>

	<div class="mt-2 text-xs text-text-muted flex justify-between">
		<span>{plural(systems.length, 'system')}</span>
		<span>{plural(totalCheats, 'cheat file')}</span>
	</div>
</div>

{#if pickerOpen}
	<Modal onclose={() => (pickerOpen = false)}>
		<div class="max-h-[70vh] flex flex-col">
			<div class="flex items-center justify-between p-4 border-b border-border shrink-0">
				<h3 class="text-lg font-bold text-text">Select System</h3>
				<button
					onclick={() => (pickerOpen = false)}
					class="text-text-muted hover:text-text px-2 py-1"
					title="Close"
				>&#10005;</button>
			</div>

			<div class="flex-1 overflow-auto p-2">
				{#if pickerLoading}
					<div class="text-sm text-text-muted py-8 text-center">Loading systems...</div>
				{:else if pickerSystems.length === 0}
					<div class="text-sm text-text-muted py-8 text-center">No ROM systems found on device.</div>
				{:else}
					{#each pickerSystems as sys}
						<button
							onclick={() => selectSystemAndUpload(sys)}
							class="w-full text-left px-3 py-2 rounded text-sm hover:bg-surface-hover transition-colors flex items-center justify-between"
						>
							<span class="text-text truncate">{sys.dirName}</span>
							<span class="text-xs text-text-muted shrink-0 ml-2">{sys.systemCode}</span>
						</button>
					{/each}
				{/if}
			</div>
		</div>
	</Modal>
{/if}
