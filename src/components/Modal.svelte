<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		onclose,
		maxWidth = 'max-w-md',
		children
	}: {
		onclose: () => void;
		maxWidth?: string;
		children: Snippet;
	} = $props();

	const labelId = `modal-${Math.random().toString(36).slice(2, 8)}`;

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.stopPropagation();
			onclose();
		}
	}

	function handleBackdropClick(e: MouseEvent) {
		if (e.target === e.currentTarget) {
			onclose();
		}
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="fixed inset-0 bg-black/80 flex items-center justify-center z-50"
	role="dialog"
	aria-modal="true"
	aria-labelledby={labelId}
	tabindex="-1"
	onclick={handleBackdropClick}
>
	<div class="bg-bg border border-border rounded-lg w-full {maxWidth} mx-4" data-modal-label-id={labelId}>
		{@render children()}
	</div>
</div>
