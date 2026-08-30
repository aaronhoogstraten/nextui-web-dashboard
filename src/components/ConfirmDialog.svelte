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
		/** Adds a "remember my choice" checkbox whose state comes back from showWithRemember() */
		remember?: { label: string; checked?: boolean };
	}

	export interface ConfirmResult {
		confirmed: boolean;
		/** State of the remember checkbox; always false when `remember` was not requested */
		remember: boolean;
	}
</script>

<script lang="ts">
	import ActionButton from './ActionButton.svelte';
	import Modal from './Modal.svelte';

	let options: ConfirmOptions | null = $state.raw(null);
	let resolver: ((result: ConfirmResult) => void) | null = $state.raw(null);
	let remember = $state(false);

	/**
	 * Show the dialog and resolve with the user's choice. Replaces window.confirm,
	 * whose height the browser caps — long warnings get clipped and scrolled.
	 */
	export async function show(opts: ConfirmOptions): Promise<boolean> {
		return (await showWithRemember(opts)).confirmed;
	}

	/** Same dialog, but also reports the `remember` checkbox — only meaningful with `opts.remember` */
	export function showWithRemember(opts: ConfirmOptions): Promise<ConfirmResult> {
		return new Promise((resolve) => {
			// A second dialog replaces the first; settle that one as a cancel so its
			// caller isn't left awaiting a promise nothing can resolve.
			resolver?.({ confirmed: false, remember: false });
			options = opts;
			remember = opts.remember?.checked ?? false;
			resolver = resolve;
		});
	}

	function resolve(confirmed: boolean) {
		if (!resolver) return;
		resolver({ confirmed, remember: options?.remember ? remember : false });
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

			<div class="flex items-center justify-between gap-3 mt-5">
				{#if options.remember}
					<label class="flex items-center gap-2 text-xs text-text-muted cursor-pointer">
						<input type="checkbox" bind:checked={remember} class="accent-accent" />
						{options.remember.label}
					</label>
				{/if}
				<div class="flex justify-end gap-2 ml-auto">
					<ActionButton onclick={() => resolve(false)} variant="secondary">
						{options.cancelLabel ?? 'Cancel'}
					</ActionButton>
					<ActionButton onclick={() => resolve(true)} variant={options.confirmVariant ?? 'primary'}>
						{options.confirmLabel ?? 'Continue'}
					</ActionButton>
				</div>
			</div>
		</div>
	</Modal>
{/if}
