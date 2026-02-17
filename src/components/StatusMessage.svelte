<script lang="ts">
	import type { Notification } from '$lib/utils.js';

	let { notification }: { notification: Notification } = $props();
</script>

<div class="text-xs mb-3 {notification.type === 'success' ? 'text-success' : 'text-warning'}">
	{notification.message}
</div>
