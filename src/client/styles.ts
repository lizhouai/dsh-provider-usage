/**
 * Panel stylesheet, injected once per page. Follows the shipped plugins'
 * convention of a `<style data-plugin-css>` tag and design-token colors.
 */
const CSS = `
.dsh-usage-root { position: relative; display: inline-flex; }
/* Tri-tone health halo: only the shadow carries the state of the provider IN
   USE (green ok / amber remaining<30% / red error or usage>=90%) — the button
   face itself stays neutral. A 1px tone ring plus a soft halo keeps the
   state readable on both light and dark skins. */
.dsh-usage-tone-ok { --dsh-usage-tone: #22a06b; }
.dsh-usage-tone-warn { --dsh-usage-tone: #e2b93b; }
.dsh-usage-tone-danger { --dsh-usage-tone: #d94f4f; }
/* Floating ball trigger: a draggable fixed circle portaled to document.body,
   one layer below the panel (1000) so the popover always covers it. Position
   comes from inline style: docked it sits at its stored coordinates, while
   dragging it follows the cursor. Keeps the shell's lv3 lift shadow; the
   tone halo stacks on top. */
.dsh-usage-ball {
  position: fixed; z-index: 999; width: 32px; height: 32px; border-radius: 50%;
  cursor: pointer; touch-action: none;
  display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid var(--dsw-alias-border-l2);
  background-color: var(--dsw-specific-menu);
  color: var(--dsw-alias-label-tertiary);
  transition: box-shadow 0.15s;
}
.dsh-usage-ball:hover, .dsh-usage-ball:focus-visible { color: var(--dsw-alias-label-secondary); }
.dsh-usage-ball svg { width: 15px; height: 15px; }
.dsh-usage-ball.dsh-usage-tone-ok,
.dsh-usage-ball.dsh-usage-tone-warn,
.dsh-usage-ball.dsh-usage-tone-danger {
  box-shadow:
    var(--dsw-shadow-lv3),
    0 0 0 1px color-mix(in srgb, var(--dsh-usage-tone) 40%, transparent),
    0 0 14px color-mix(in srgb, var(--dsh-usage-tone) 55%, transparent);
}
.dsh-usage-ball.dsh-usage-tone-ok:hover,
.dsh-usage-ball.dsh-usage-tone-warn:hover,
.dsh-usage-ball.dsh-usage-tone-danger:hover,
.dsh-usage-ball.dsh-usage-tone-ok:focus-visible,
.dsh-usage-ball.dsh-usage-tone-warn:focus-visible,
.dsh-usage-ball.dsh-usage-tone-danger:focus-visible {
  box-shadow:
    var(--dsw-shadow-lv3),
    0 0 0 1px color-mix(in srgb, var(--dsh-usage-tone) 55%, transparent),
    0 0 18px color-mix(in srgb, var(--dsh-usage-tone) 70%, transparent);
}
.dsh-usage-panel {
  z-index: 1000; box-sizing: border-box;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-specific-menu);
  box-shadow: var(--dsw-shadow-lv3);
  border-radius: 12px; margin: 0; padding: 8px;
  width: 320px; max-width: min(360px, 100vw - 16px);
  max-height: min(460px, 100vh - 60px); overflow: auto;
  display: flex; flex-direction: column; gap: 6px;
  /* position: fixed with viewport coordinates computed inline from the
     trigger rect — absolute positioning inside the sidebar gets clipped by
     the column's overflow. */
  position: fixed;
  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);
  --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);
}
.dsh-usage-head {
  display: flex; align-items: center; gap: 8px; padding: 2px 4px 6px;
  border-bottom: 1px solid var(--dsw-alias-border-l2);
}
.dsh-usage-title { color: var(--dsw-alias-label-primary); font-size: 13px; font-weight: 600; }
.dsh-usage-version {
  color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px;
  padding: 0 5px; border-radius: 4px; background: var(--dsw-alias-fill-l2);
  font-variant-numeric: tabular-nums; user-select: none; margin-right: auto;
}
.dsh-usage-lang {
  cursor: pointer; display: inline-flex; align-items: center; gap: 4px;
  border: 0; border-radius: 6px; background: 0; padding: 3px 5px;
  color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px;
}
.dsh-usage-lang:hover { color: var(--dsw-alias-label-secondary); }
.dsh-usage-refresh {
  cursor: pointer; display: inline-flex; align-items: center; justify-content: center;
  border: 0; border-radius: 6px; background: 0; padding: 4px;
  color: var(--dsw-alias-label-tertiary); line-height: 0;
}
.dsh-usage-refresh:hover { color: var(--dsw-alias-label-secondary); }
.dsh-usage-refresh:disabled { opacity: 0.5; cursor: default; }
/* Home button in the panel head: sends the ball back to its default spot. */
.dsh-usage-home {
  cursor: pointer; display: inline-flex; align-items: center; justify-content: center;
  border: 0; border-radius: 6px; background: 0; padding: 4px;
  color: var(--dsw-alias-label-tertiary); line-height: 0;
}
.dsh-usage-home:hover { color: var(--dsw-alias-label-secondary); }
@keyframes dsh-usage-spin { to { transform: rotate(360deg); } }
.dsh-usage-refresh--loading svg { animation: dsh-usage-spin 0.9s linear infinite; }
.dsh-usage-card {
  border-radius: 8px; padding: 8px 10px; display: flex; flex-direction: column; gap: 6px;
  background: var(--dsw-alias-fill-l2);
}
/* The provider in use, whose quota alone drives the ball tone. */
.dsh-usage-card--active {
  outline: 1px solid color-mix(in srgb, var(--dsw-alias-accent, #4f8cff) 45%, transparent);
  outline-offset: -1px;
}
.dsh-usage-cardHead { display: flex; align-items: center; gap: 8px; }
.dsh-usage-providerName {
  color: var(--dsw-alias-label-primary); font-size: 13px; font-weight: 600;
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1;
}
.dsh-usage-inUse {
  flex: none; font-size: 11px; line-height: 16px; padding: 0 6px; border-radius: 999px;
  color: var(--dsw-alias-label-secondary);
  background: color-mix(in srgb, var(--dsw-alias-accent, #4f8cff) 18%, transparent);
  border: 1px solid color-mix(in srgb, var(--dsw-alias-accent, #4f8cff) 35%, transparent);
}
.dsh-usage-message { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; word-break: break-all; }
.dsh-usage-balanceRow { display: flex; align-items: baseline; gap: 8px; }
.dsh-usage-balanceTotal {
  color: var(--dsw-alias-label-primary); font-size: 18px; font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.dsh-usage-balanceCurrency { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dsh-usage-balanceParts { color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; }
.dsh-usage-row { display: flex; flex-direction: column; gap: 3px; }
.dsh-usage-rowHead { display: flex; align-items: center; gap: 8px; font-size: 12px; line-height: 18px; }
.dsh-usage-rowLabel { color: var(--dsw-alias-label-secondary); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-usage-rowValue { color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; flex: none; }
.dsh-usage-barTrack {
  height: 4px; border-radius: 2px; overflow: hidden;
  background: var(--dsw-alias-border-l2);
}
.dsh-usage-barFill { height: 100%; border-radius: 2px; transition: width 0.3s; }
.dsh-usage-barFill--ok { background: #22a06b; }
.dsh-usage-barFill--warn { background: #e2b93b; }
.dsh-usage-barFill--danger { background: #d94f4f; }
.dsh-usage-rowReset { color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; }
.dsh-usage-foot {
  display: flex; align-items: center; gap: 8px; padding: 6px 4px 2px;
  border-top: 1px solid var(--dsw-alias-border-l2);
}
.dsh-usage-footLabel { color: var(--dsw-alias-label-tertiary); font-size: 11px; }
.dsh-usage-select {
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; background: 0;
  color: var(--dsw-alias-label-secondary); font-size: 11px; padding: 2px 4px; cursor: pointer;
}
.dsh-usage-updated { color: var(--dsw-alias-label-tertiary); font-size: 11px; margin-left: auto; }
`

const TAG_ID = 'dsh-provider-usage/panel.css'

/** Inject the panel stylesheet once; on HMR swap, refresh the existing tag's payload in place. */
export function ensureStyles(): void {
  if (typeof document === 'undefined') return
  const existing = document.querySelector('style[data-plugin-css=' + JSON.stringify(TAG_ID) + ']')
  if (existing !== null) {
    // A hot-swapped bundle re-runs this module while the old <style> tag is
    // still in the DOM — sync its content so the new CSS actually applies.
    if (existing.textContent !== CSS) existing.textContent = CSS
    return
  }
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-provider-usage'
  tag.dataset.pluginCss = TAG_ID
  tag.textContent = CSS
  document.head.appendChild(tag)
}
