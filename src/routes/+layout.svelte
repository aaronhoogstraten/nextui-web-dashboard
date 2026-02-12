<script lang="ts">
	import '../app.css';

	let { children } = $props();
</script>

<div class="h-screen flex overflow-hidden">
	{@render children()}
</div>
