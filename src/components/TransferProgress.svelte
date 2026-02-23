<script lang="ts">
	import {
		isTransferActive,
		getTransferDirection,
		getCurrentFileName,
		getFilesCompleted,
		getFilesTotal,
		getBytesTransferred,
		getBytesTotal
	} from '$lib/stores/transfer.svelte.js';
	import { formatSize } from '$lib/utils.js';

	const progressPct = $derived.by(() => {
		const total = getBytesTotal();
		const transferred = getBytesTransferred();
		if (total > 0) return Math.min((transferred / total) * 100, 100);
		const ft = getFilesTotal();
		if (ft > 0) return (getFilesCompleted() / ft) * 100;
		return 0;
	});

	const label = $derived.by(() => {
		const verb = getTransferDirection() === 'upload' ? 'Uploading' : 'Downloading';
		const completed = getFilesCompleted();
		const total = getFilesTotal();
		const fileName = getCurrentFileName();
		if (total <= 1) return `${verb} ${fileName}`;
		const fileNum = Math.min(completed + 1, total);
		return `${verb} ${fileNum}/${total}: ${fileName}`;
	});

	const bytesLabel = $derived.by(() => {
		const transferred = getBytesTransferred();
		const total = getBytesTotal();
		if (total > 0) return `${formatSize(transferred)} / ${formatSize(total)}`;
		if (transferred > 0) return formatSize(transferred);
		return '';
	});
</script>

{#if isTransferActive()}
	<div class="bg-sidebar border-t border-border px-3 py-1.5 flex items-center gap-3 text-xs shrink-0">
		<span class="text-text truncate flex-shrink min-w-0" title={getCurrentFileName()}>
			{label}
		</span>
		<div class="flex-1 bg-surface rounded-full h-1.5 min-w-[80px]">
			<div
				class="bg-accent h-1.5 rounded-full transition-all duration-150"
				style="width: {progressPct}%"
			></div>
		</div>
		{#if bytesLabel}
			<span class="text-text-muted tabular-nums whitespace-nowrap">{bytesLabel}</span>
		{/if}
	</div>
{/if}
