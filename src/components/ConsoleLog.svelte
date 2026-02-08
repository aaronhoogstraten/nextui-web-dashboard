<script lang="ts">
	import { getLogEntries, getLogVersion, clearLog, type LogLevel } from '$lib/stores/log.svelte.js';

	let collapsed = $state(false);
	let autoScroll = $state(true);
	let showDebug = $state(true);
	let scrollContainer: HTMLDivElement | undefined = $state();
	let scrollPending = false;

	const entries = $derived.by(() => {
		// Subscribe to version changes; slice() to return a new array reference so {#each} re-renders
		void getLogVersion();
		const all = getLogEntries();
		return showDebug ? all.slice() : all.filter((e) => e.level !== 'debug');
	});

	function levelColor(level: LogLevel): string {
		switch (level) {
			case 'error':
				return 'text-red-400';
			case 'warn':
				return 'text-yellow-400';
			case 'info':
				return 'text-blue-400';
			case 'debug':
				return 'text-text-muted';
		}
	}

	function levelLabel(level: LogLevel): string {
		switch (level) {
			case 'error':
				return 'ERR';
			case 'warn':
				return 'WRN';
			case 'info':
				return 'INF';
			case 'debug':
				return 'DBG';
		}
	}

	function formatTime(d: Date): string {
		return d.toLocaleTimeString('en-US', { hour12: false, fractionalSecondDigits: 3 });
	}

	$effect(() => {
		const _len = entries.length;
		if (autoScroll && scrollContainer && !scrollPending) {
			scrollPending = true;
			requestAnimationFrame(() => {
				scrollPending = false;
				if (scrollContainer) {
					scrollContainer.scrollTop = scrollContainer.scrollHeight;
				}
			});
		}
	});
</script>

<div class="bg-sidebar border-t border-border flex flex-col {collapsed ? 'h-8' : 'h-48'} transition-[height] duration-150">
	<!-- Header bar -->
	<div class="flex items-center justify-between px-3 h-8 shrink-0 border-b border-border">
		<button onclick={() => (collapsed = !collapsed)} class="flex items-center gap-2 text-xs text-text-muted hover:text-text">
			<span>{collapsed ? '\u25B6' : '\u25BC'}</span>
			<span class="font-medium">Console</span>
			{#if entries.length > 0}
				<span class="text-text-muted">({entries.length})</span>
			{/if}
		</button>
		{#if !collapsed}
			<div class="flex items-center gap-3 text-xs">
				<label class="flex items-center gap-1 text-text-muted cursor-pointer">
					<input type="checkbox" bind:checked={showDebug} class="accent-accent" />
					Debug
				</label>
				<label class="flex items-center gap-1 text-text-muted cursor-pointer">
					<input type="checkbox" bind:checked={autoScroll} class="accent-accent" />
					Auto-scroll
				</label>
				<button onclick={clearLog} class="text-text-muted hover:text-text">Clear</button>
			</div>
		{/if}
	</div>

	<!-- Log entries -->
	{#if !collapsed}
		<div bind:this={scrollContainer} class="flex-1 overflow-y-auto font-mono text-xs leading-5 px-1">
			{#each entries as entry (entry.id)}
				<div class="flex gap-2 px-2 hover:bg-surface">
					<span class="text-text-muted shrink-0">{formatTime(entry.timestamp)}</span>
					<span class="shrink-0 w-7 {levelColor(entry.level)}">{levelLabel(entry.level)}</span>
					<span class="text-text break-all">{entry.message}</span>
				</div>
			{/each}
			{#if entries.length === 0}
				<div class="text-text-muted px-2 py-2">No log entries yet.</div>
			{/if}
		</div>
	{/if}
</div>
