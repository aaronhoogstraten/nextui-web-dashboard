<script lang="ts">
	import { untrack } from 'svelte';
	import type { Adb } from '@yume-chan/adb';
	import { BIOS_SYSTEMS, getBiosDevicePath, type BiosFileDefinition } from '$lib/bios/index.js';
	import { sha1, validateBiosFile } from '$lib/bios/validation.js';
	import { DEVICE_PATHS } from '$lib/adb/types.js';
	import { pathExists, pullFile, listDirectory } from '$lib/adb/file-ops.js';
	import { beginTransfer, endTransfer, trackedPush } from '$lib/stores/transfer.svelte.js';
	import { adbExec } from '$lib/stores/connection.svelte.js';
	import { formatError, getDroppedFiles, hasDraggedFiles, plural, pickFile } from '$lib/utils.js';
	import { ShellCmd } from '$lib/adb/adb-utils.js';
	import ActionButton from './ActionButton.svelte';

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
		notice: { type: 'error' | 'success'; message: string } | null;
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
			expanded: false,
			notice: null
		}))
	);

	let checking = $state(false);
	let hideComplete = $state(false);
	let uploadingFile: string | null = $state(null);
	let removingFile: string | null = $state(null);
	let dragTargetKey: string | null = $state(null);
	let dragCounter = $state(0);

	function getFileKey(file: BiosFileState): string {
		return `${file.definition.systemCode}/${file.definition.fileName}`;
	}

	function hashMismatchDetail(lead: string, expected: string, actual: string): string {
		return `${lead}\nExpected: ${expected}\nGot: ${actual}`;
	}

	function getSystemDragKey(system: SystemState): string {
		return `${system.systemCode}:${system.files[0]?.devicePath ?? system.systemName}`;
	}

	function getSystemDirectory(system: SystemState): string | null {
		const devicePath = system.files[0]?.devicePath;
		if (!devicePath) return null;
		return devicePath.substring(0, devicePath.lastIndexOf('/'));
	}

	function resetDragTarget() {
		dragTargetKey = null;
		dragCounter = 0;
	}

	function handleSystemDragEnter(event: DragEvent, system: SystemState) {
		if (!hasDraggedFiles(event) || uploadingFile !== null || removingFile !== null) return;
		event.preventDefault();
		const key = getSystemDragKey(system);
		if (dragTargetKey !== key) {
			dragTargetKey = key;
			dragCounter = 0;
		}
		dragCounter++;
	}

	function handleSystemDragOver(event: DragEvent, system: SystemState) {
		if (!hasDraggedFiles(event) || uploadingFile !== null || removingFile !== null) return;
		event.preventDefault();
		const key = getSystemDragKey(system);
		if (dragTargetKey !== key) {
			dragTargetKey = key;
			dragCounter = 1;
		}
		if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
	}

	function handleSystemDragLeave(event: DragEvent, system: SystemState) {
		if (dragTargetKey !== getSystemDragKey(system)) return;
		event.preventDefault();
		dragCounter--;
		if (dragCounter <= 0) resetDragTarget();
	}

	async function checkAllSystems() {
		checking = true;

		// Remove previously discovered custom systems (they'll be re-discovered)
		systems = systems.filter((s) => !s.isCustom);

		// Check predefined systems
		for (const system of systems) {
			system.notice = null;
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
							file.detail = hashMismatchDetail(
								'SHA-1 hash mismatch.',
								file.definition.sha1,
								result.actualSha1
							);
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
				const codes = s.files.map((f) => f.systemCode);
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
						expanded: false,
						notice: null
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

	async function writeBiosFile(
		file: BiosFileState,
		system: SystemState,
		data: Uint8Array<ArrayBuffer>,
		detail: string
	) {
		await trackedPush(adb, file.devicePath, data);
		file.status = system.isCustom ? 'present' : 'valid';
		file.detail = detail;
	}

	async function uploadBiosFile(file: BiosFileState, system: SystemState, selected?: File) {
		const ext = file.definition.fileName.substring(file.definition.fileName.lastIndexOf('.'));
		const source = selected ?? (await pickFile({ accept: system.isCustom ? undefined : ext }));
		if (!source) return;

		system.notice = null;
		uploadingFile = getFileKey(file);

		try {
			const data = new Uint8Array(await source.arrayBuffer());

			if (!system.isCustom) {
				const result = await validateBiosFile(data, file.definition);
				if (!result.valid) {
					file.status = 'invalid';
					file.detail = hashMismatchDetail(
						"Selected file SHA-1 hash doesn't match.",
						file.definition.sha1,
						result.actualSha1
					);
					system.notice = {
						type: 'error',
						message: `Validation failed for ${file.definition.fileName}`
					};
					return;
				}
			}

			beginTransfer('upload', 1, data.byteLength);
			await writeBiosFile(file, system, data, system.isCustom ? 'Uploaded' : 'Uploaded, hash OK');
			system.notice = { type: 'success', message: `Uploaded ${file.definition.fileName}` };
		} catch (e) {
			file.detail = `Upload failed: ${formatError(e)}`;
			system.notice = { type: 'error', message: `Upload failed: ${formatError(e)}` };
		} finally {
			endTransfer();
			uploadingFile = null;
		}
	}

	async function uploadDroppedBiosFiles(system: SystemState, droppedFiles: File[]) {
		system.notice = null;

		if (system.isCustom) {
			const systemDir = getSystemDirectory(system);
			if (!systemDir) {
				system.notice = { type: 'error', message: 'Could not determine custom BIOS directory' };
				return;
			}

			beginTransfer(
				'upload',
				droppedFiles.length,
				droppedFiles.reduce((sum, file) => sum + file.size, 0)
			);

			let uploaded = 0;
			try {
				for (const source of droppedFiles) {
					const key = source.name.toLowerCase();
					let target = system.files.find((file) => file.definition.fileName.toLowerCase() === key);
					if (!target) {
						target = {
							definition: {
								fileName: source.name,
								systemCode: system.systemCode,
								sha1: '',
								md5: ''
							},
							devicePath: `${systemDir}/${source.name}`,
							status: 'present',
							detail: ''
						};
						system.files = [...system.files, target];
					}

					uploadingFile = getFileKey(target);
					const data = new Uint8Array(await source.arrayBuffer());
					await writeBiosFile(target, system, data, 'Uploaded');
					uploaded++;
				}
				system.notice = { type: 'success', message: `Uploaded ${plural(uploaded, 'file')}` };
			} catch (e) {
				system.notice = { type: 'error', message: `Upload failed: ${formatError(e)}` };
			} finally {
				endTransfer();
				uploadingFile = null;
			}
			return;
		}

		const filenameMatches = new Map<string, BiosFileState[]>();
		for (const file of system.files) {
			const key = file.definition.fileName.toLowerCase();
			const matches = filenameMatches.get(key);
			if (matches) matches.push(file);
			else filenameMatches.set(key, [file]);
		}

		const prepared = await Promise.all(
			droppedFiles.map(async (source) => {
				const data = new Uint8Array(await source.arrayBuffer());
				const hash = await sha1(data);
				return {
					source,
					data,
					hash,
					fileNameMatches: filenameMatches.get(source.name.toLowerCase()) ?? [],
					hashMatches: system.files.filter((file) => file.definition.sha1 === hash)
				};
			})
		);

		let invalid = 0;
		let skipped = 0;
		const uploadJobs = prepared.flatMap((entry) => {
			if (entry.hashMatches.length > 0) {
				return entry.hashMatches.map((file) => ({ file, data: entry.data }));
			}
			if (entry.fileNameMatches.length > 0) {
				invalid++;
				for (const file of entry.fileNameMatches) {
					file.status = 'invalid';
					file.detail = hashMismatchDetail(
						"Selected file SHA-1 hash doesn't match.",
						file.definition.sha1,
						entry.hash
					);
				}
				return [];
			}
			skipped++;
			return [];
		});

		if (uploadJobs.length === 0) {
			const parts: string[] = [];
			if (invalid > 0) parts.push(`${plural(invalid, 'file')} failed validation`);
			if (skipped > 0) parts.push(`skipped ${skipped}`);
			system.notice = {
				type: 'error',
				message: parts.join(', ') || 'No matching BIOS files found in drop'
			};
			return;
		}

		beginTransfer(
			'upload',
			uploadJobs.length,
			uploadJobs.reduce((sum, job) => sum + job.data.byteLength, 0)
		);

		let uploaded = 0;
		try {
			for (const job of uploadJobs) {
				uploadingFile = getFileKey(job.file);
				await writeBiosFile(job.file, system, job.data, 'Uploaded, hash OK');
				uploaded++;
			}

			const parts: string[] = [`Uploaded ${plural(uploaded, 'file')}`];
			if (invalid > 0) parts.push(`${plural(invalid, 'file')} failed validation`);
			if (skipped > 0) parts.push(`skipped ${skipped}`);
			system.notice = { type: invalid === 0 ? 'success' : 'error', message: parts.join(', ') };
		} catch (e) {
			system.notice = { type: 'error', message: `Upload failed: ${formatError(e)}` };
		} finally {
			endTransfer();
			uploadingFile = null;
		}
	}

	async function handleSystemDrop(event: DragEvent, system: SystemState) {
		event.preventDefault();
		const isActiveTarget = dragTargetKey === getSystemDragKey(system);
		resetDragTarget();
		if (!isActiveTarget || uploadingFile !== null || removingFile !== null) return;

		const droppedFiles = (await getDroppedFiles(event)).map(({ file }) => file);
		if (droppedFiles.length === 0) return;
		await uploadDroppedBiosFiles(system, droppedFiles);
	}

	async function removeBiosFile(file: BiosFileState, system: SystemState) {
		if (!confirm(`Delete "${file.definition.fileName}" from ${system.systemName}?`)) return;
		removingFile = getFileKey(file);
		try {
			await adbExec(ShellCmd.rm(file.devicePath));
			if (system.isCustom) {
				system.files = system.files.filter((f) => f !== file);
				if (system.files.length === 0) {
					systems = systems.filter((s) => s !== system);
				}
			} else {
				file.status = 'missing';
				file.detail = 'Removed';
			}
		} catch (e) {
			file.detail = `Remove failed: ${formatError(e)}`;
			system.notice = { type: 'error', message: `Remove failed: ${formatError(e)}` };
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
			<ActionButton
				onclick={checkAllSystems}
				disabled={checking}
				variant="secondary"
			>
				{checking ? 'Checking...' : 'Refresh'}
			</ActionButton>
		</div>
	</div>

	<div class="space-y-3">
		{#each filteredSystems as system}
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				class="relative border border-border rounded-lg overflow-hidden"
				ondragenter={(event) => handleSystemDragEnter(event, system)}
				ondragover={(event) => handleSystemDragOver(event, system)}
				ondragleave={(event) => handleSystemDragLeave(event, system)}
				ondrop={(event) => handleSystemDrop(event, system)}
			>
				{#if dragTargetKey === getSystemDragKey(system)}
					<div
						class="absolute inset-0 z-10 bg-bg/80 border-2 border-dashed border-accent rounded-lg flex items-center justify-center pointer-events-none"
					>
						<span class="text-sm font-medium text-accent">
							Upload BIOS to {system.systemName}
						</span>
					</div>
				{/if}

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
						{#if system.notice}
							<div
								class="text-xs {system.notice.type === 'error' ? 'text-warning' : 'text-success'}"
							>
								{system.notice.message}
							</div>
						{/if}
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
												: effectiveStatusColor(file, system)} mt-0.5 font-mono break-all whitespace-pre-line"
										>
											{file.detail}
										</div>
									{/if}
								</div>
								<div class="flex items-center gap-2 ml-4">
									{#if system.isCustom}
										<span class="text-sm font-medium text-blue-500">Present</span>
										<ActionButton
											onclick={() => removeBiosFile(file, system)}
											disabled={removingFile !== null || uploadingFile !== null}
											variant="danger"
											size="xs"
											title={`Delete ${file.definition.fileName}`}
										>
											{removingFile === getFileKey(file) ? 'Deleting...' : 'Delete'}
										</ActionButton>
									{:else}
										<span class="text-sm font-medium {effectiveStatusColor(file, system)}">
											{effectiveStatusLabel(file, system)}
										</span>
										{#if file.status === 'missing' || file.status === 'invalid' || file.status === 'unknown'}
											<ActionButton
												onclick={() => uploadBiosFile(file, system)}
												disabled={uploadingFile !== null || removingFile !== null}
												variant="primary"
												size="xs"
											>
												{uploadingFile === getFileKey(file) ? 'Uploading...' : 'Upload'}
											</ActionButton>
										{/if}
										{#if file.status !== 'missing' && file.status !== 'unknown' && file.status !== 'checking'}
											<ActionButton
												onclick={() => removeBiosFile(file, system)}
												disabled={removingFile !== null || uploadingFile !== null}
												variant="danger"
												size="xs"
												title={`Delete ${file.definition.fileName}`}
											>
												{removingFile === getFileKey(file) ? 'Deleting...' : 'Delete'}
											</ActionButton>
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
