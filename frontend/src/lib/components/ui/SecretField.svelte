<!--
  SecretField — a masked input for a secret the USER types (fr-agui SPEC §6.2,
  R7). It is never pre-filled from anything the agent produced: it has no
  initial-value prop, only a bindable value that starts empty, and the agent's
  proposal never carries the secret (backend agent/proposal.ts strips it).
-->
<script lang="ts">
	let {
		id,
		value = $bindable(''),
		placeholder = '',
		class: className = ''
	}: { id: string; value?: string; placeholder?: string; class?: string } = $props();
</script>

<input
	{id}
	type="password"
	bind:value
	autocomplete="off"
	spellcheck="false"
	data-secret-field="true"
	{placeholder}
	class={className}
/>
