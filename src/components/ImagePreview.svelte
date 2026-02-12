<script lang="ts">
	let { src, alt, onClose }: { src: string; alt: string; onClose: () => void } = $props();

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.stopPropagation();
			onClose();
		}
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<button
	class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 cursor-pointer border-none p-0"
	onclick={onClose}
	aria-label="Close image preview"
	aria-modal="true"
	role="dialog"
	type="button"
>
	<div class="text-center">
		<img {src} {alt} class="max-w-[80vw] max-h-[80vh] object-contain rounded" />
		<div class="text-text-muted text-sm mt-2">{alt}</div>
	</div>
</button>
