<script lang="ts">
  import { debugLog, clearLog, type LogEntry, type LogSource } from '$lib/store/debug';

  interface Props {
    sources?: LogSource[];
    maxEntries?: number;
    filter?: (e: LogEntry) => boolean;
  }
  let { sources, maxEntries = 60, filter }: Props = $props();

  let entries = $derived(
    $debugLog
      .filter(e => {
        if (sources && !sources.includes(e.source)) return false;
        if (filter && !filter(e)) return false;
        return true;
      })
      .slice(0, maxEntries)
  );

  let el: HTMLDivElement | undefined = $state();
  let autoScroll = $state(true);

  $effect(() => {
    if (autoScroll && el) el.scrollTop = el.scrollHeight;
  });

  const dirColor: Record<string, string> = {
    in: '#34d399',
    out: '#60a5fa',
    info: '#a78bfa',
    warn: '#fbbf24',
    error: '#f87171',
  };

  function fmt(ts: number): string {
    return new Date(ts).toLocaleTimeString('en', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  let copyLabel = $state('Copy');
  function copyLogs() {
    const text = entries.map(e =>
      `${fmt(e.ts)} ${e.dir.toUpperCase().padEnd(5)} [${e.source}] ${e.label}`
    ).join('\n');
    navigator.clipboard.writeText(text).then(() => {
      copyLabel = 'Copied!';
      setTimeout(() => { copyLabel = 'Copy'; }, 1500);
    });
  }
</script>

<div class="log-wrap">
  <div class="log-toolbar">
    <span class="log-title">Logs</span>
    <label class="scroll-label">
      <input type="checkbox" bind:checked={autoScroll} />
      auto-scroll
    </label>
    <button class="clear-btn" onclick={copyLogs}>{copyLabel}</button>
    <button class="clear-btn" onclick={() => clearLog()}>Clear</button>
  </div>
  <div class="log-body" bind:this={el}>
    {#each entries as e (e.id)}
      <div class="log-entry">
        <span class="ts">{fmt(e.ts)}</span>
        <span class="dir" style="color:{dirColor[e.dir] ?? '#9ca3af'}">{e.dir.toUpperCase()}</span>
        <span class="src">[{e.source}]</span>
        <span class="label">{e.label}</span>
      </div>
    {/each}
    {#if entries.length === 0}
      <div class="empty">— no entries —</div>
    {/if}
  </div>
</div>

<style>
  .log-wrap {
    border: 1px solid var(--color-border);
    border-radius: 6px;
    overflow: hidden;
  }
  .log-toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 8px;
    background: var(--color-surface);
    border-bottom: 1px solid var(--color-border);
  }
  .log-title { font-size: 10px; font-weight: 600; color: var(--color-muted); text-transform: uppercase; letter-spacing: 0.05em; flex: 1; }
  .scroll-label { display: flex; align-items: center; gap: 4px; font-size: 10px; color: var(--color-muted); cursor: pointer; }
  .clear-btn { font-size: 10px; padding: 1px 6px; border-radius: 3px; border: 1px solid var(--color-border); background: none; color: var(--color-muted); cursor: pointer; font-family: inherit; }
  .clear-btn:hover { color: var(--color-danger); border-color: var(--color-danger); }
  .log-body {
    height: 160px;
    overflow-y: auto;
    font-family: ui-monospace, monospace;
    font-size: 10px;
    padding: 4px 8px;
    display: flex;
    flex-direction: column;
    gap: 1px;
    background: #09090b;
  }
  .log-entry { display: flex; gap: 6px; align-items: baseline; line-height: 1.5; }
  .ts { color: #52525b; flex-shrink: 0; }
  .dir { font-weight: 700; width: 32px; flex-shrink: 0; }
  .src { color: #6b7280; flex-shrink: 0; }
  .label { color: #d4d4d8; word-break: break-all; }
  .empty { color: #3f3f46; text-align: center; padding: 20px 0; font-size: 11px; }
</style>
