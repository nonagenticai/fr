<script lang="ts">
	// Tenant card view. A card on a PROJECT board redirects into the project
	// shell (/projects/P/cards/[id], fr-agui SPEC §7.5) once the server has
	// resolved card → board → project; a card with no project stays here.
	import { page } from '$app/stores';
	import CardDetailPage from '$lib/cards/CardDetailPage.svelte';

	const cardId = $derived($page.params.id ?? '');
</script>

<CardDetailPage {cardId} routeProjectId={null} />
