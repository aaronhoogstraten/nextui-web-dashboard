<script lang="ts" module>
	export interface ConfirmOptions {
		title: string;
		/** Lead line — the concrete facts the decision rests on */
		summary?: string;
		/** Highlighted recommendation, set apart from the mechanical detail */
		advice?: string;
		/** Supporting paragraphs, rendered muted below the advice */
		details?: string[];
		confirmLabel?: string;
		cancelLabel?: string;
		confirmVariant?: 'primary' | 'danger' | 'warning';
	}
</script>

<script lang="ts">
	import ActionButton from './ActionButton.svelte';
	import Modal from './Modal.svelte';

	let options: ConfirmOptions | null = $state.raw(null);
	let resolver: ((confirmed: boolean) => void) | null = $state.raw(null);

	/**
	 * Show the dialog and resolve with the user's choice. Replaces window.confirm,
	 * whose height the browser caps — long warnings get clipped and scrolled.
	 */
	export function show(opts: ConfirmOptions): Promise<boolean> {
		return new Promise((resolve) => {
			options = opts;
			resolver = resolve;
		});
	}

	function resolve(confirmed: boolean) {
		if (!resolver) return;
		resolver(confirmed);
		resolver = null;
		options = null;
	}
</script>

{#if options}
	<!-- Escape and backdrop clicks mean "no", matching confirm() -->
	<Modal onclose={() => resolve(false)} maxWidth="max-w-lg">
		<div class="p-6">
			<h3 class="text-lg font-bold text-text mb-3">{options.title}</h3>

			{#if options.summary}
				<p class="text-sm text-text mb-3">{options.summary}</p>
			{/if}

			{#if options.advice}
				<p
					class="text-sm text-warning bg-warning/10 border border-warning/40 rounded px-3 py-2 mb-3"
				>
					{options.advice}
				</p>
			{/if}

			<!-- Keyed by index: the list is built fresh per show() and never reorders -->
			{#each options.details ?? [] as detail, i (i)}
				<p class="text-xs text-text-muted mb-2">{detail}</p>
			{/each}

			<div class="flex justify-end gap-2 mt-5">
				<ActionButton onclick={() => resolve(false)} variant="secondary">
					{options.cancelLabel ?? 'Cancel'}
				</ActionButton>
				<ActionButton onclick={() => resolve(true)} variant={options.confirmVariant ?? 'primary'}>
					{options.confirmLabel ?? 'Continue'}
				</ActionButton>
			</div>
		</div>
	</Modal>
{/if}
