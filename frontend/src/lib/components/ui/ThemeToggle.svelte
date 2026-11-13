<script lang="ts">
  import { theme } from '$lib/stores/theme.svelte';
  import Select from './Select.svelte';

  const options = [
    { value: 'system' as const, label: 'System' },
    { value: 'light' as const, label: 'Light' },
    { value: 'dark' as const, label: 'Dark' }
  ];
</script>

<Select
  value={theme.preference}
  {options}
  class="w-28"
  onchange={(e: Event) => {
    const v = (e.target as HTMLSelectElement).value as 'system' | 'light' | 'dark';
    theme.setPreference(v);
  }}
/>
