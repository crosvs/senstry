<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { identity } from '$lib/store/identity';
	import { loadOrCreateIdentity } from '$lib/nostr/keys';
	import { loadSettings, settings } from '$lib/store/settings';
	import { loadPairedDevices } from '$lib/store/identity';
	import { setRelays } from '$lib/nostr/client';

	let { children } = $props();
	let ready = $state(false);

	onMount(async () => {
		await loadSettings();
		const id = await loadOrCreateIdentity();
		identity.set(id);
		await loadPairedDevices();
		setRelays([$settings.relayUrl]);
		ready = true;

		// Identity is always created in loadOrCreateIdentity; no setup redirect needed
	});
</script>

{#if ready}
	<div class="min-h-screen flex flex-col">
		{@render children()}
	</div>
{:else}
	<div class="min-h-screen flex items-center justify-center" style="background:var(--color-bg)">
		<span style="color:var(--color-muted)">Loading…</span>
	</div>
{/if}
