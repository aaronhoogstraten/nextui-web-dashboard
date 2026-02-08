<script lang="ts">
	import type { Adb } from '@yume-chan/adb';
	import { ROM_SYSTEMS, getRomDevicePath, isValidRomExtension, type RomSystem } from '$lib/roms/index.js';
	import { listDirectory, pushFile } from '$lib/adb/file-ops.js';

	let { adb }: { adb: Adb } = $props();

	interface SystemState {
		system: RomSystem;
		devicePath: string;
		romCount: number | null;
		loading: boolean;
		expanded: boolean;
		error: string;
	}

	let systems: SystemState[] = $state(
		ROM_SYSTEMS.map((sys) => ({
			system: sys,
			devicePath: getRomDevicePath(sys),
			romCount: null,
			loading: false,
			expanded: false,
			error: ''
		}))
	);

	let refreshing = $state(false);
	let uploadingTo: string | null = $state(null);

	async function refreshAll() {
		refreshing = true;
		for (const s of systems) {
			s.loading = true;
			s.error = '';
			try {
				const entries = await listDirectory(adb, s.devicePath);
				// Count files only (not directories), exclude hidden files
				s.romCount = entries.filter((e) => e.isFile && !e.name.startsWith('.')).length;
			} catch {
				s.romCount = 0;
				s.error = 'Folder not found';
			}
			s.loading = false;
		}
		refreshing = false;
	}

	async function uploadRoms(state: SystemState) {
		const input = document.createElement('input');
		input.type = 'file';
		input.multiple = true;
		// Build accept string from supported formats
		input.accept = state.system.supportedFormats.join(',');

		input.onchange = async () => {
			const files = input.files;
			if (!files || files.length === 0) return;

			uploadingTo = state.system.systemCode;
			let uploaded = 0;

			try {
				for (const file of files) {
					const ext = '.' + file.name.split('.').pop()?.toLowerCase();
					if (!isValidRomExtension(ext, state.system)) {
						continue; // skip invalid extensions
					}

					const data = new Uint8Array(await file.arrayBuffer());
					const remotePath = `${state.devicePath}/${file.name}`;
					await pushFile(adb, remotePath, data);
					uploaded++;
				}

				// Refresh count
				state.loading = true;
				try {
					const entries = await listDirectory(adb, state.devicePath);
					state.romCount = entries.filter((e) => e.isFile && !e.name.startsWith('.')).length;
				} catch {
					// ignore
				}
				state.loading = false;
				state.error = uploaded > 0 ? `Uploaded ${uploaded} file(s)` : 'No valid files selected';
			} catch (e) {
				state.error = `Upload failed: ${e instanceof Error ? e.message : String(e)}`;
			} finally {
				uploadingTo = null;
			}
		};

		input.click();
	}

	// Refresh on mount
	$effect(() => {
		refreshAll();
	});
</script>

<div class="p-6">
	<div class="flex items-center justify-between mb-6">
		<h2 class="text-2xl font-bold">ROM Systems</h2>
		<button
			onclick={refreshAll}
			disabled={refreshing}
			class="text-sm bg-gray-200 hover:bg-gray-300 disabled:opacity-50 px-3 py-1.5 rounded"
		>
			{refreshing ? 'Refreshing...' : 'Refresh'}
		</button>
	</div>

	<div class="space-y-2">
		{#each systems as s}
			<div class="border rounded-lg overflow-hidden">
				<!-- System Header -->
				<button
					onclick={() => (s.expanded = !s.expanded)}
					class="w-full flex items-center justify-between p-3 bg-gray-50 hover:bg-gray-100 text-left"
				>
					<div>
						<span class="font-semibold">{s.system.systemName}</span>
						<span class="text-sm text-gray-500 ml-2">({s.system.systemCode})</span>
					</div>
					<div class="flex items-center gap-3">
						{#if s.loading}
							<span class="text-sm text-gray-400">Counting...</span>
						{:else if s.romCount !== null}
							<span class="text-sm {s.romCount > 0 ? 'text-green-600' : 'text-gray-400'}">
								{s.romCount} ROM{s.romCount !== 1 ? 's' : ''}
							</span>
						{/if}
						<span class="text-gray-400">{s.expanded ? '\u25B2' : '\u25BC'}</span>
					</div>
				</button>

				<!-- Details (expanded) -->
				{#if s.expanded}
					<div class="p-3 space-y-2">
						<div class="text-xs text-gray-500 font-mono">{s.devicePath}</div>
						<div class="text-xs text-gray-500">
							Formats: {s.system.supportedFormats.join(', ')}
						</div>
						{#if s.error}
							<div class="text-xs text-yellow-600">{s.error}</div>
						{/if}
						<button
							onclick={() => uploadRoms(s)}
							disabled={uploadingTo !== null}
							class="text-sm bg-blue-600 text-white px-3 py-1.5 rounded hover:bg-blue-700 disabled:opacity-50"
						>
							{uploadingTo === s.system.systemCode ? 'Uploading...' : 'Upload ROMs'}
						</button>
					</div>
				{/if}
			</div>
		{/each}
	</div>
</div>
