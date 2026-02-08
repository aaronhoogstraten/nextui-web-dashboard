<script lang="ts">
	import type { Adb } from '@yume-chan/adb';
	import { BIOS_SYSTEMS, getBiosDevicePath, type BiosFileDefinition } from '$lib/bios/index.js';
	import { validateBiosFile } from '$lib/bios/validation.js';
	import { pathExists, pullFile, pushFile, listDirectory } from '$lib/adb/file-ops.js';

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
		files: BiosFileState[];
		expanded: boolean;
	}

	let systems: SystemState[] = $state(
		BIOS_SYSTEMS.map((sys) => ({
			systemName: sys.systemName,
			systemCode: sys.systemCode,
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
	let uploadingFile: string | null = $state(null);

	async function checkAllSystems() {
		checking = true;
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
					file.detail = e instanceof Error ? e.message : String(e);
				}
			}
		}
		checking = false;
	}

	function statusColor(status: FileStatus): string {
		switch (status) {
			case 'valid':
				return 'text-green-500';
			case 'present':
				return 'text-blue-500';
			case 'missing':
				return 'text-red-500';
			case 'invalid':
				return 'text-yellow-500';
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

	async function uploadBiosFile(file: BiosFileState) {
		const input = document.createElement('input');
		input.type = 'file';
		input.accept = file.definition.fileName;

		input.onchange = async () => {
			const selected = input.files?.[0];
			if (!selected) return;

			uploadingFile = `${file.definition.systemCode}/${file.definition.fileName}`;

			try {
				const data = new Uint8Array(await selected.arrayBuffer());

				const result = await validateBiosFile(data, file.definition);
				if (!result.valid) {
					file.status = 'invalid';
					file.detail = `Selected file hash doesn't match expected. Got: ${result.actualSha1.substring(0, 16)}...`;
					return;
				}

				await pushFile(adb, file.devicePath, data);
				file.status = 'valid';
				file.detail = 'Uploaded, hash OK';
			} catch (e) {
				file.detail = `Upload failed: ${e instanceof Error ? e.message : String(e)}`;
			} finally {
				uploadingFile = null;
			}
		};

		input.click();
	}

	// Check on mount
	$effect(() => {
		checkAllSystems();
	});
</script>

<div class="p-6">
	<div class="flex items-center justify-between mb-6">
		<h2 class="text-2xl font-bold text-text">BIOS Files</h2>
		<button
			onclick={checkAllSystems}
			disabled={checking}
			class="text-sm bg-surface hover:bg-surface-hover text-text disabled:opacity-50 px-3 py-1.5 rounded"
		>
			{checking ? 'Checking...' : 'Refresh'}
		</button>
	</div>

	<div class="space-y-3">
		{#each systems as system}
			<div class="border border-border rounded-lg overflow-hidden">
				<!-- System Header -->
				<button
					onclick={() => (system.expanded = !system.expanded)}
					class="w-full flex items-center justify-between p-3 bg-surface hover:bg-surface-hover text-left"
				>
					<div>
						<span class="font-semibold text-text">{system.systemName}</span>
						<span class="text-sm text-text-muted ml-2">({system.systemCode})</span>
					</div>
					<div class="flex items-center gap-3">
						{#each system.files as file}
							<span class="text-xs px-1.5 py-0.5 rounded {statusColor(file.status)}">
								{file.definition.fileName}: {statusLabel(file.status)}
							</span>
						{/each}
						<span class="text-text-muted">{system.expanded ? '\u25B2' : '\u25BC'}</span>
					</div>
				</button>

				<!-- File Details (expanded) -->
				{#if system.expanded}
					<div class="p-3 space-y-2">
						{#each system.files as file}
							<div class="flex items-center justify-between py-2 px-3 bg-bg rounded border border-border">
								<div class="flex-1 min-w-0">
									<div class="font-mono text-sm text-text">{file.definition.fileName}</div>
									<div class="text-xs text-text-muted truncate">{file.devicePath}</div>
									{#if file.detail}
										<div class="text-xs {statusColor(file.status)} mt-0.5">{file.detail}</div>
									{/if}
								</div>
								<div class="flex items-center gap-2 ml-4">
									<span class="text-sm font-medium {statusColor(file.status)}">
										{statusLabel(file.status)}
									</span>
									{#if file.status === 'missing' || file.status === 'invalid' || file.status === 'unknown'}
										<button
											onclick={() => uploadBiosFile(file)}
											disabled={uploadingFile !== null}
											class="text-xs bg-accent text-white px-2 py-1 rounded hover:bg-accent-hover disabled:opacity-50"
										>
											{uploadingFile === `${file.definition.systemCode}/${file.definition.fileName}` ? 'Uploading...' : 'Upload'}
										</button>
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
