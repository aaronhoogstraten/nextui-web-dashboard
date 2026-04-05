<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLButtonAttributes } from 'svelte/elements';

	type ActionVariant = 'primary' | 'secondary' | 'subtle' | 'danger' | 'success' | 'warning';
	type ActionSize = 'sm' | 'xs' | 'none';

	let {
		variant = 'secondary',
		size = 'sm',
		disabled = false,
		title,
		type = 'button',
		onclick,
		children,
		class: className = '',
		...restProps
	}: {
		variant?: ActionVariant;
		size?: ActionSize;
		disabled?: boolean;
		title?: string;
		type?: 'button' | 'submit' | 'reset';
		onclick?: HTMLButtonAttributes['onclick'];
		children?: Snippet;
		class?: string;
	} = $props();

	const sizeClasses: Record<ActionSize, string> = {
		sm: 'text-sm px-3 py-1.5',
		xs: 'text-xs px-2 py-1',
		none: ''
	};

	const variantClasses: Record<ActionVariant, string> = {
		primary: 'bg-accent text-white hover:bg-accent-hover',
		secondary: 'border border-border bg-surface text-text hover:bg-surface-hover',
		subtle: 'border border-border bg-surface text-text-muted hover:bg-surface-hover hover:text-text',
		danger:
			'border border-red-500/30 bg-red-500/10 text-red-500 hover:bg-red-500/20 hover:text-red-400',
		success: 'bg-green-700 text-white hover:bg-green-600',
		warning:
			'border border-warning/40 bg-warning/10 text-warning hover:bg-warning/20 hover:text-warning'
	};

	const baseClasses =
		'inline-flex items-center justify-center gap-1.5 rounded font-medium whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:opacity-50 disabled:cursor-not-allowed';

	const classes = $derived(
		`${baseClasses} ${sizeClasses[size]} ${variantClasses[variant]} ${className}`.trim()
	);
</script>

<button
	{...restProps}
	{type}
	{title}
	{disabled}
	onclick={onclick}
	class={classes}
>
	{#if children}
		{@render children()}
	{/if}
</button>
