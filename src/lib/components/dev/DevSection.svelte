<script lang="ts">
  interface Props {
    title: string;
    defaultOpen?: boolean;
    badge?: string;
    badgeColor?: string;
    actions?: import('svelte').Snippet;
    children: import('svelte').Snippet;
  }
  let { title, defaultOpen = true, badge, badgeColor = 'var(--color-muted)', actions, children }: Props = $props();
  // defaultOpen is intentionally used only as initial value — not reactive
  // eslint-disable-next-line svelte/non-reactive-update
  let open = $state(defaultOpen);
</script>

<div class="dev-section">
  <div class="section-header">
    <button class="toggle-btn" onclick={() => (open = !open)}>
      <span class="caret">{open ? '▾' : '▸'}</span>
      <span class="title">{title}</span>
      {#if badge}
        <span class="badge" style="background:{badgeColor}">{badge}</span>
      {/if}
    </button>
    {#if actions}
      <div class="header-actions">
        {@render actions()}
      </div>
    {/if}
  </div>
  {#if open}
    <div class="section-body">
      {@render children()}
    </div>
  {/if}
</div>

<style>
  .dev-section {
    border: 1px solid var(--color-border);
    border-radius: 8px;
    overflow: hidden;
  }
  .section-header {
    display: flex;
    align-items: center;
    background: var(--color-surface);
    border-bottom: 1px solid var(--color-border);
    gap: 0;
  }
  .section-header:has(+ :not([style*="display: none"])) {
    border-bottom: 1px solid var(--color-border);
  }
  .toggle-btn {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 12px;
    background: none;
    border: none;
    cursor: pointer;
    text-align: left;
    color: var(--color-text);
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    font-family: inherit;
  }
  .toggle-btn:hover { background: rgba(255,255,255,0.03); }
  .caret { font-size: 10px; color: var(--color-muted); width: 10px; }
  .badge {
    font-size: 9px;
    padding: 1px 5px;
    border-radius: 3px;
    color: white;
    font-weight: 700;
    letter-spacing: 0.06em;
  }
  .header-actions {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    border-left: 1px solid var(--color-border);
  }
  .section-body {
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    background: var(--color-bg);
  }
</style>
