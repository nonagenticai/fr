<script lang="ts">
	// Project-shell card view (fr-agui SPEC §7.3 "Board and cards", D10): the
	// tenant /cards/[id] page re-homed inside /projects/[id]. Same component; the
	// route's project id is passed so a card that belongs to another project (or
	// to none) is moved to its own view.
	import { page } from '$app/stores';
	import CardDetailPage from '$lib/cards/CardDetailPage.svelte';

	const projectId = $derived($page.params.id ?? '');
	const cardId = $derived($page.params.cardId ?? '');
</script>

<CardDetailPage {cardId} routeProjectId={projectId} />
