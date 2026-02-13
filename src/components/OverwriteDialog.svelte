<script lang="ts" module>
	export type ConflictResolution = 'overwrite' | 'skip' | 'overwrite-all' | 'skip-all';
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import Modal from './Modal.svelte';

	let { detail }: { detail?: Snippet<[string]> } = $props();

	let fileName: string | null = $state(null);
	let multiple = $state(false);
	let resolver: ((r: ConflictResolution) => void) | null = $state.raw(null);

	export function show(name: string, isMultiple = false): Promise<ConflictResolution> {
		return new Promise((resolve) => {
			fileName = name;
			multiple = isMultiple;
			resolver = resolve;
		});
	}

	function resolve(resolution: ConflictResolution) {
		if (resolver) {
			resolver(resolution);
			fileName = null;
			resolver = null;
		}
	}
</script>

{#if fileName}
	<Modal onclose={() => resolve('skip')}>
		<div class="p-6">
			<h3 class="text-lg font-bold text-text mb-3">File Already Exists</h3>
			<div class="text-sm text-text mb-4">
				<div class="font-mono text-xs text-text-muted mb-3 truncate" title={fileName}>{fileName}</div>
				{#if detail}
					{@render detail(fileName)}
				{/if}
			</div>
			<div class="grid grid-cols-2 gap-2">
				<button onclick={() => resolve('overwrite')} class="text-sm bg-accent text-white px-3 py-2 rounded hover:bg-accent-hover">Overwrite</button>
				<button onclick={() => resolve('skip')} class="text-sm bg-surface text-text px-3 py-2 rounded hover:bg-surface-hover">Skip</button>
				{#if multiple}
					<button onclick={() => resolve('overwrite-all')} class="text-sm bg-accent/70 text-white px-3 py-2 rounded hover:bg-accent">Overwrite All</button>
					<button onclick={() => resolve('skip-all')} class="text-sm bg-surface text-text-muted px-3 py-2 rounded hover:bg-surface-hover">Skip All</button>
				{/if}
			</div>
		</div>
	</Modal>
{/if}
