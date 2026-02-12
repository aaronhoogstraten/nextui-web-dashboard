<script lang="ts">
	import type { Notification } from '$lib/utils.js';

	let { notification }: { notification: Notification } = $props();
</script>

<div class="text-xs mb-3 {notification.type === 'success' ? 'text-green-500' : 'text-yellow-500'}">
	{notification.message}
</div>
