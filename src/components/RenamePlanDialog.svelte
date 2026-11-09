<script lang="ts">
	import type { RenamePlan } from '$lib/roms/game-rename.js';
	import type { AssetKind } from '$lib/saves/relink.js';
	import { fileName, parentPath, plural } from '$lib/utils.js';
	import ActionButton from './ActionButton.svelte';
	import Modal from './Modal.svelte';

	let {
		title,
		plan,
		confirmLabel,
		advice,
		busy = false,
		onconfirm,
		oncancel
	}: {
		title: string;
		plan: RenamePlan;
		confirmLabel: string;
		advice?: string;
		busy?: boolean;
		onconfirm: () => void;
		oncancel: () => void;
	} = $props();

	const KIND_LABELS: Record<AssetKind, string> = {
		rom: 'ROM',
		art: 'Box art',
		save: 'Save',
		state: 'State',
		'slot-data': 'Slot data',
		'game-options': 'Game options',
		cheat: 'Cheat'
	};

	const saveDataMoves = $derived(
		plan.moves.filter((m) => m.kind === 'save' || m.kind === 'state').length
	);
</script>

<!-- The preview is the only way to see a save was found before committing to it -->
<Modal onclose={() => !busy && oncancel()} maxWidth="max-w-2xl">
	<div class="p-6">
		<h3 class="text-lg font-bold text-text mb-3">{title}</h3>

		{#if plan.conflicts.length > 0}
			<div
				class="text-sm text-warning bg-warning/10 border border-warning/40 rounded px-3 py-2 mb-3"
			>
				<p>These names are already taken, so nothing can be moved:</p>
				<ul class="my-1">
					{#each plan.conflicts as conflict (conflict)}
						<li class="font-mono text-xs break-all">{conflict}</li>
					{/each}
				</ul>
				<p class="text-xs">Rename, move or delete them first, then try again.</p>
			</div>
		{:else if advice}
			<p class="text-sm text-warning bg-warning/10 border border-warning/40 rounded px-3 py-2 mb-3">
				{advice}
			</p>
		{/if}

		<p class="text-sm text-text mb-1">Moving {plural(plan.moves.length, 'file')}</p>
		{#if plan.moves.length > 0}
			<div class="max-h-72 overflow-auto border border-border rounded">
				<table class="w-full text-xs">
					<tbody>
						{#each plan.moves as move (move.from)}
							<tr class="border-t border-border first:border-t-0 align-top">
								<td class="px-2 py-1 text-text-muted whitespace-nowrap">{KIND_LABELS[move.kind]}</td
								>
								<td class="px-2 py-1 font-mono text-text break-all" title={move.from}>
									{fileName(move.from)}
								</td>
								<td class="py-1 text-text-muted">&rarr;</td>
								<td class="px-2 py-1 font-mono text-text break-all" title={move.to}>
									{fileName(move.to)}
									{#if parentPath(move.to) !== parentPath(move.from)}
										<div class="font-sans text-text-muted">into {parentPath(move.to)}</div>
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
		{#if saveDataMoves === 0}
			<p class="text-xs text-text-muted mt-2">No saves or states found to carry over.</p>
		{/if}

		{#if plan.refEdits.length > 0}
			<p class="text-sm text-text mt-3 mb-1">Updating {plural(plan.refEdits.length, 'list')}</p>
			<ul class="text-xs text-text-muted space-y-0.5">
				{#each plan.refEdits as edit (edit.path)}
					<li title={edit.path}>{edit.label}</li>
				{/each}
			</ul>
		{/if}

		{#if plan.kept.length > 0}
			<p class="text-xs text-warning mt-3">
				{plural(plan.kept.length, 'file')} shared with another ROM will keep the old name:
				<span class="font-mono">{plan.kept.map((f) => f.name).join(', ')}</span>
			</p>
		{/if}
		{#if plan.left > 0}
			<p class="text-xs text-text-muted mt-3">
				{plural(plan.left, 'state or slot data file')} will stay where they are. States only load in the
				emulator core that made them, so they can't move to another system.
			</p>
		{/if}

		<div class="flex justify-end gap-2 mt-5">
			<ActionButton onclick={oncancel} disabled={busy} variant="secondary">Cancel</ActionButton>
			<ActionButton
				onclick={onconfirm}
				disabled={busy || plan.conflicts.length > 0 || plan.moves.length === 0}
				variant="primary"
			>
				{busy ? 'Working...' : confirmLabel}
			</ActionButton>
		</div>
	</div>
</Modal>
