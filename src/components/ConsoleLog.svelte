<script lang="ts">
	import { getLogEntries, clearLog, type LogLevel } from '$lib/stores/log.svelte.js';

	let collapsed = $state(false);
	let autoScroll = $state(true);
	let showDebug = $state(true);
	let scrollContainer: HTMLDivElement | undefined = $state();
	let scrollPending = false;
	let copyLabel = $state('Copy Logs');

	let panelHeight = $state(192);
	let dragging = $state(false);

	function startResize(e: MouseEvent | TouchEvent) {
		if (collapsed) return;
		e.preventDefault();
		dragging = true;
		const startY = 'touches' in e ? e.touches[0].clientY : e.clientY;
		const startHeight = panelHeight;

		function onMove(ev: MouseEvent | TouchEvent) {
			const clientY = 'touches' in ev ? ev.touches[0].clientY : ev.clientY;
			const delta = startY - clientY;
			panelHeight = Math.min(Math.max(startHeight + delta, 80), window.innerHeight * 0.9);
		}

		function onEnd() {
			dragging = false;
			window.removeEventListener('mousemove', onMove);
			window.removeEventListener('mouseup', onEnd);
			window.removeEventListener('touchmove', onMove);
			window.removeEventListener('touchend', onEnd);
		}

		window.addEventListener('mousemove', onMove);
		window.addEventListener('mouseup', onEnd);
		window.addEventListener('touchmove', onMove);
		window.addEventListener('touchend', onEnd);
	}

	async function copyLogs() {
		const text = entries
			.map((e) => `${formatTime(e.timestamp)} ${levelLabel(e.level)} ${e.message}`)
			.join('\n');
		await navigator.clipboard.writeText(text);
		copyLabel = 'Copied!';
		setTimeout(() => (copyLabel = 'Copy Logs'), 1500);
	}

	const entries = $derived.by(() => {
		const all = getLogEntries();
		return showDebug ? all : all.filter((e) => e.level !== 'debug');
	});

	function levelColor(level: LogLevel): string {
		switch (level) {
			case 'error':
				return 'text-red-400';
			case 'warn':
				return 'text-warning';
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
		return d.toLocaleTimeString('en-US', { hour12: false });
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

<div
	class="bg-sidebar border-t border-border flex flex-col shadow-[0_-2px_12px_rgba(0,0,0,0.3)] z-10 shrink-0
		{collapsed ? 'h-8' : ''} {!collapsed && !dragging ? 'transition-[height] duration-150' : ''}"
	style:height={collapsed ? undefined : `${panelHeight}px`}
>
	<!-- Drag handle (only when expanded) -->
	{#if !collapsed}
		<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
		<div
			class="h-1 shrink-0 cursor-row-resize hover:bg-accent transition-colors"
			role="separator"
			aria-orientation="horizontal"
			tabindex="-1"
			onmousedown={startResize}
			ontouchstart={startResize}
		></div>
	{/if}

	<!-- Header bar -->
	<div class="flex items-center justify-between px-3 h-8 shrink-0 border-b border-border">
		<button
			onclick={() => (collapsed = !collapsed)}
			class="flex items-center gap-2 text-xs text-text-muted hover:text-text"
		>
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
				<button onclick={copyLogs} class="text-text-muted hover:text-text">{copyLabel}</button>
				<button onclick={clearLog} class="text-text-muted hover:text-text">Clear</button>
			</div>
		{/if}
	</div>

	<!-- Log entries -->
	{#if !collapsed}
		<div
			bind:this={scrollContainer}
			class="flex-1 overflow-y-auto font-mono text-xs leading-5 px-1"
		>
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
