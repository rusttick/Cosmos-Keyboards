<script lang="ts">
  // Shared between multi-view and bones (and any future page needing "which prior sources am I
  // looking at") so the two never drift apart -- both should offer the exact same registered sources,
  // in the exact same fused-as-equal-peers shape (fuseSources.ts).
  import { ALL_PRIOR_SOURCES } from '../../scan3/lib/priors/registry'
  import { MY_HAND_SOURCE_ID, myHandPrior } from '../../scan3/lib/priors/myHandStore'
  import type { PriorSource } from '../../scan3/lib/priors/priorSource'

  // "My hand" is a live, reactive source built incrementally in the browser (flexion-sweep, or the
  // caliper tool on /bones) -- both hands' data live inside its own `data` pair, so it's composed here
  // rather than living in registry.ts (which stays purely file-based/generated sources). See
  // priorSource.ts's PriorSourcePair doc comment for why a Right sweep and a Left sweep never get
  // averaged together even though they're the same checked-off row here.
  $: myHandSource = {
    id: MY_HAND_SOURCE_ID,
    label: 'My hand (captured)',
    sourceType: 'scan3-capture',
    description:
      "Built live by flexion-sweep/bones in this browser. Only fields you've actually measured, on either hand, are populated.",
    data: $myHandPrior,
  } satisfies PriorSource
  $: allSources = [...ALL_PRIOR_SOURCES, myHandSource]

  let selected: Record<string, boolean> = Object.fromEntries([
    ...ALL_PRIOR_SOURCES.map((s) => [s.id, s.sourceType === 'literature'] as const),
    [MY_HAND_SOURCE_ID, false] as const,
  ])

  // Bindable -- the parent reads this to fuse (fuseHandPriorState(selectedSources, handedness)); this
  // component only owns which sources are checked, never the fusion or the handedness choice, since
  // those are page-specific (multi-view's live tracked hand vs. bones' measurement-entry hand).
  export let selectedSources: PriorSource[] = []
  $: selectedSources = allSources.filter((s) => selected[s.id])
</script>

<div>
  <span class="text-sm block mb-1">
    Prior sources (check any combination -- fused as equal, independent peers; see fuseSources.ts)
  </span>
  <div class="flex flex-col gap-1">
    {#each allSources as source (source.id)}
      <label class="flex items-start gap-2 text-sm">
        <input type="checkbox" bind:checked={selected[source.id]} class="mt-1" />
        <span>
          <span class="font-semibold">{source.label}</span>
          <span class="block text-xs text-gray-400">{source.description}</span>
        </span>
      </label>
    {/each}
  </div>
  {#if selectedSources.length === 0}
    <p class="text-amber-400 text-xs mt-1">
      No source selected -- every field is genuinely unconstrained (see fuseSources.ts); expect the model
      to visibly do whatever an unconstrained joint does.
    </p>
  {/if}
</div>
