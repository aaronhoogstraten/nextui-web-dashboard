<script lang="ts">
	import { untrack } from 'svelte';
	import type { Adb } from '@yume-chan/adb';
	import { BIOS_SYSTEMS, getBiosDevicePath, type BiosFileDefinition } from '$lib/bios/index.js';
	import { validateBiosFile } from '$lib/bios/validation.js';
	import { DEVICE_PATHS } from '$lib/adb/types.js';
	import { pathExists, pullFile, pushFile, listDirectory } from '$lib/adb/file-ops.js';
	import { adbExec } from '$lib/stores/connection.svelte.js';
	import { formatError, plural, pickFile } from '$lib/utils.js';
	import { ShellCmd } from '$lib/adb/adb-utils.js';

	let { adb }: { adb: Adb } = $props();

	type FileStatus = 'unknown' | 'checking' | 'missing' | 'present' | 'valid' | 'invalid';

	interface BiosFileState {
		definition: BiosFileDefinition;
		devicePath: string;
		status: FileStatus;
		detail: string;
	}

	interface SystemState {
		systemName: string;
		systemCode: string;
		anyOneOf: boolean;
		isCustom: boolean;
		files: BiosFileState[];
		expanded: boolean;
	}

	let systems: SystemState[] = $state(
		BIOS_SYSTEMS.filter((sys) => sys.files.length > 0).map((sys) => ({
			systemName: sys.systemName,
			systemCode: sys.systemCode,
			anyOneOf: sys.anyOneOf ?? false,
			isCustom: false,
			files: sys.files.map((f) => ({
				definition: f,
				devicePath: getBiosDevicePath(f),
				status: 'unknown' as FileStatus,
				detail: ''
			})),
			expanded: false
		}))
	);

	let checking = $state(false);
	let hideComplete = $state(false);
	let uploadingFile: string | null = $state(null);
	let removingFile: string | null = $state(null);

	async function checkAllSystems() {
		checking = true;

		// Remove previously discovered custom systems (they'll be re-discovered)
		systems = systems.filter((s) => !s.isCustom);

		// Check predefined systems
		for (const system of systems) {
			for (const file of system.files) {
				file.status = 'checking';
				file.detail = '';
				try {
					const exists = await pathExists(adb, file.devicePath);
					if (!exists) {
						file.status = 'missing';
						file.detail = 'Not found on device';
					} else {
						// Pull and validate hash
						const content = await pullFile(adb, file.devicePath);
						const result = await validateBiosFile(content, file.definition);
						if (result.valid) {
							file.status = 'valid';
							file.detail = 'Present, hash OK';
						} else {
							file.status = 'invalid';
							file.detail = `Hash mismatch: ${result.actualSha1.substring(0, 12)}...`;
						}
					}
				} catch (e) {
					file.status = 'missing';
					file.detail = formatError(e);
				}
			}
		}

		// Discover custom BIOS systems from device
		const knownCodes = new Set(
			BIOS_SYSTEMS.flatMap((s) => {
				// Collect all system codes referenced by files (e.g. "GBA" and "MGBA" for GBA system)
				const codes = s.files.map((f) => f.systemCode);
				// Also include the system-level code (may contain " / " separator like "GBA / MGBA")
				codes.push(...s.systemCode.split(/\s*\/\s*/));
				return codes;
			})
		);
		try {
			const biosDirs = await listDirectory(adb, DEVICE_PATHS.bios);
			for (const dir of biosDirs) {
				if (!dir.isDirectory || dir.name.startsWith('.')) continue;
				if (knownCodes.has(dir.name)) continue;

				const biosPath = `${DEVICE_PATHS.bios}/${dir.name}`;
				const customFiles: BiosFileState[] = [];
				try {
					const entries = await listDirectory(adb, biosPath);
					for (const entry of entries) {
						if (entry.isFile && !entry.name.startsWith('.')) {
							customFiles.push({
								definition: {
									fileName: entry.name,
									systemCode: dir.name,
									sha1: '',
									md5: ''
								},
								devicePath: `${biosPath}/${entry.name}`,
								status: 'present',
								detail: 'Custom file (no validation)'
							});
						}
					}
				} catch {
					// Directory unreadable
				}

				if (customFiles.length > 0) {
					systems.push({
						systemName: dir.name,
						systemCode: dir.name,
						anyOneOf: false,
						isCustom: true,
						files: customFiles,
						expanded: false
					});
				}
			}
		} catch {
			// Bios directory unreadable — skip discovery
		}

		checking = false;
	}

	/** Check if a system's BIOS requirements are satisfied */
	function isSystemSatisfied(system: SystemState): boolean {
		if (system.isCustom) return true;
		if (system.anyOneOf) {
			return system.files.some((f) => f.status === 'valid');
		}
		return system.files.every((f) => f.status === 'valid');
	}

	/**
	 * For anyOneOf systems, get the effective display color for a file.
	 * If the system is satisfied, missing alternatives show as muted instead of red.
	 */
	function effectiveStatusColor(file: BiosFileState, system: SystemState): string {
		if (system.anyOneOf && file.status === 'missing' && isSystemSatisfied(system)) {
			return 'text-text-muted';
		}
		return statusColor(file.status);
	}

	function effectiveStatusLabel(file: BiosFileState, system: SystemState): string {
		if (system.anyOneOf && file.status === 'missing' && isSystemSatisfied(system)) {
			return 'Not needed';
		}
		return statusLabel(file.status);
	}

	function statusColor(status: FileStatus): string {
		switch (status) {
			case 'valid':
				return 'text-success';
			case 'present':
				return 'text-blue-500';
			case 'missing':
				return 'text-red-500';
			case 'invalid':
				return 'text-warning';
			case 'checking':
				return 'text-text-muted';
			default:
				return 'text-text-muted';
		}
	}

	function statusLabel(status: FileStatus): string {
		switch (status) {
			case 'valid':
				return 'OK';
			case 'present':
				return 'Present';
			case 'missing':
				return 'Missing';
			case 'invalid':
				return 'Bad Hash';
			case 'checking':
				return 'Checking...';
			default:
				return '\u2014';
		}
	}

	async function uploadBiosFile(file: BiosFileState, isCustom: boolean) {
		const ext = file.definition.fileName.substring(file.definition.fileName.lastIndexOf('.'));
		const selected = await pickFile({ accept: isCustom ? undefined : ext });
		if (!selected) return;

		uploadingFile = `${file.definition.systemCode}/${file.definition.fileName}`;

		try {
			const data = new Uint8Array(await selected.arrayBuffer());

			if (!isCustom) {
				const result = await validateBiosFile(data, file.definition);
				if (!result.valid) {
					file.status = 'invalid';
					file.detail = `Selected file hash doesn't match expected. Got: ${result.actualSha1.substring(0, 16)}...`;
					return;
				}
			}

			await pushFile(adb, file.devicePath, data);
			file.status = isCustom ? 'present' : 'valid';
			file.detail = isCustom ? 'Uploaded' : 'Uploaded, hash OK';
		} catch (e) {
			file.detail = `Upload failed: ${formatError(e)}`;
		} finally {
			uploadingFile = null;
		}
	}

	async function removeBiosFile(file: BiosFileState, system: SystemState) {
		if (!confirm(`Delete "${file.definition.fileName}" from ${system.systemName}?`)) return;
		const key = `${file.definition.systemCode}/${file.definition.fileName}`;
		removingFile = key;
		try {
			await adbExec(ShellCmd.rm(file.devicePath));
			if (system.isCustom) {
				// Remove from the custom system's file list
				system.files = system.files.filter((f) => f !== file);
				// If no files left, remove the whole custom system
				if (system.files.length === 0) {
					systems = systems.filter((s) => s !== system);
				}
			} else {
				file.status = 'missing';
				file.detail = 'Removed';
			}
		} catch (e) {
			file.detail = `Remove failed: ${formatError(e)}`;
		} finally {
			removingFile = null;
		}
	}

	let filteredSystems = $derived(
		hideComplete ? systems.filter((s) => !isSystemSatisfied(s)) : systems
	);

	// Check on mount (untrack to prevent reactive loop)
	$effect(() => {
		untrack(() => checkAllSystems());
	});
</script>

<div class="p-6">
	<div class="flex items-center justify-between mb-6">
		<h2 class="text-2xl font-bold text-text">BIOS Files</h2>
		<div class="flex items-center gap-4">
			<label class="flex items-center gap-2 text-sm text-text-muted cursor-pointer">
				<input type="checkbox" bind:checked={hideComplete} class="accent-accent" />
				Show missing only
			</label>
			<button
				onclick={checkAllSystems}
				disabled={checking}
				class="text-sm bg-surface hover:bg-surface-hover text-text disabled:opacity-50 px-3 py-1.5 rounded"
			>
				{checking ? 'Checking...' : 'Refresh'}
			</button>
		</div>
	</div>

	<div class="space-y-3">
		{#each filteredSystems as system}
			<div class="border border-border rounded-lg overflow-hidden">
				<!-- System Header -->
				<button
					onclick={() => (system.expanded = !system.expanded)}
					class="w-full flex items-center justify-between p-3 bg-surface hover:bg-surface-hover text-left"
				>
					<div>
						<span class="font-semibold text-text">{system.systemName}</span>
						<span class="text-sm text-text-muted ml-2">({system.systemCode})</span>
						{#if system.isCustom}
							<span class="text-xs text-text-muted ml-1 italic">Custom</span>
						{/if}
					</div>
					<div class="flex items-center gap-3">
						{#if system.isCustom}
							<span class="text-xs text-blue-500">
								{plural(system.files.length, 'file')}
							</span>
						{:else}
							{#if system.anyOneOf}
								<span class="text-xs text-text-muted">(any one needed)</span>
							{/if}
							{#each system.files as file}
								<span class="text-xs px-1.5 py-0.5 rounded {effectiveStatusColor(file, system)}">
									{file.definition.fileName}: {effectiveStatusLabel(file, system)}
								</span>
							{/each}
						{/if}
						<span class="text-text-muted">{system.expanded ? '\u25B2' : '\u25BC'}</span>
					</div>
				</button>

				<!-- File Details (expanded) -->
				{#if system.expanded}
					<div class="p-3 space-y-2">
						{#if system.isCustom}
							<div class="text-xs text-text-muted italic mb-1">Custom system — no validation</div>
						{:else if system.anyOneOf}
							<div class="text-xs text-text-muted italic mb-1">
								Only one of these files is required.
							</div>
						{/if}
						{#each system.files as file}
							<div
								class="flex items-center justify-between py-2 px-3 bg-bg rounded border border-border"
							>
								<div class="flex-1 min-w-0">
									<div class="font-mono text-sm text-text">{file.definition.fileName}</div>
									<div class="text-xs text-text-muted truncate">{file.devicePath}</div>
									{#if file.detail}
										<div
											class="text-xs {system.isCustom
												? 'text-blue-500'
												: effectiveStatusColor(file, system)} mt-0.5"
										>
											{file.detail}
										</div>
									{/if}
								</div>
								<div class="flex items-center gap-2 ml-4">
									{#if system.isCustom}
										<span class="text-sm font-medium text-blue-500">Present</span>
										<button
											onclick={() => removeBiosFile(file, system)}
											disabled={removingFile !== null || uploadingFile !== null}
											class="text-xs px-2 py-1 rounded text-accent hover:bg-surface disabled:opacity-50"
											title={`Delete ${file.definition.fileName}`}
										>
											{removingFile === `${file.definition.systemCode}/${file.definition.fileName}` ? 'Deleting...' : 'Delete'}
										</button>
									{:else}
										<span class="text-sm font-medium {effectiveStatusColor(file, system)}">
											{effectiveStatusLabel(file, system)}
										</span>
										{#if file.status === 'missing' || file.status === 'invalid' || file.status === 'unknown'}
											<button
												onclick={() => uploadBiosFile(file, system.isCustom)}
												disabled={uploadingFile !== null || removingFile !== null}
												class="text-xs bg-accent text-white px-2 py-1 rounded hover:bg-accent-hover disabled:opacity-50"
											>
												{uploadingFile ===
												`${file.definition.systemCode}/${file.definition.fileName}`
													? 'Uploading...'
													: 'Upload'}
											</button>
									{/if}
									{#if file.status !== 'missing' && file.status !== 'unknown' && file.status !== 'checking'}
											<button
												onclick={() => removeBiosFile(file, system)}
												disabled={removingFile !== null || uploadingFile !== null}
												class="text-xs px-2 py-1 rounded text-accent hover:bg-surface disabled:opacity-50"
												title={`Delete ${file.definition.fileName}`}
											>
												{removingFile === `${file.definition.systemCode}/${file.definition.fileName}` ? 'Deleting...' : 'Delete'}
											</button>
										{/if}
									{/if}
								</div>
							</div>
						{/each}
					</div>
				{/if}
			</div>
		{/each}
	</div>
</div>
