/**
 * Panel stylesheet, injected once per page. Follows the shipped plugins'
 * convention of a `<style data-plugin-css>` tag and design-token colors.
 */
const CSS = `
.dsh-quota-root { position: relative; display: inline-flex; }
.dsh-quota-trigger {
  position: relative; flex: none; min-height: 28px; cursor: pointer; background-color: transparent; border: 0; border-radius: 6px;
  align-items: center; justify-content: center; gap: 4px; padding: 3px 6px;
  font-size: 12px; line-height: 18px; display: inline-flex;
  color: var(--dsw-alias-label-tertiary);
  transition: box-shadow 0.15s;
}
.dsh-quota-trigger:hover, .dsh-quota-trigger:focus-visible {
  color: var(--dsw-alias-label-secondary);
  background-color: var(--dsw-alias-fill-l2);
}
/* Tri-tone health halo: only the shadow carries the worst provider state
   (green ok / amber remaining<30% / red error or usage>=90%) — the button
   face itself stays neutral. A 1px tone ring plus a soft halo keeps the
   state readable on both light and dark skins. */
.dsh-quota-tone-ok { --dsh-quota-tone: #22a06b; }
.dsh-quota-tone-warn { --dsh-quota-tone: #e2b93b; }
.dsh-quota-tone-danger { --dsh-quota-tone: #d94f4f; }
.dsh-quota-trigger, .dsh-quota-ball {
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--dsh-quota-tone) 35%, transparent),
    0 2px 10px color-mix(in srgb, var(--dsh-quota-tone) 45%, transparent);
}
.dsh-quota-trigger:hover, .dsh-quota-trigger:focus-visible,
.dsh-quota-ball:hover, .dsh-quota-ball:focus-visible {
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--dsh-quota-tone) 50%, transparent),
    0 2px 14px color-mix(in srgb, var(--dsh-quota-tone) 60%, transparent);
}
/* Collapsed sidebar: a centered square icon button with the same footprint
   as the neighboring rail actions (36×36, 16px icon), so it stays aligned
   in the narrow column instead of sticking out wider/off-center. */
.dsh-quota-trigger--icon { width: 36px; height: 36px; padding: 0; gap: 0; }
.dsh-quota-trigger--icon .dsh-quota-triggerIcon svg { width: 16px; height: 16px; }
/* Sidebar rail layout fix: the shell keeps its footer actions in a horizontal
   row even when collapsed, which leaves injected actions floating beside its
   vertically stacked rail entries. Stack the row instead, so this trigger
   joins the rail column. Matches via the stable data-slot / data-rail hooks
   (not hashed class names); if the shell changes, the rule harmlessly stops
   matching and the layout falls back to the shell default. */
div:has(> [data-slot="sidebar.footer.action"] > [data-rail="rail"]) {
  flex-direction: column;
  align-items: center;
}
.dsh-quota-triggerIcon { flex: none; display: inline-flex; }
/* Floating ball trigger: a draggable fixed circle portaled to document.body,
   one layer below the panel (1000) so the popover always covers it. Position
   comes from inline style: docked it pins to a viewport edge, while dragging
   it follows the cursor. Keeps the shell's lv3 lift shadow; the tone halo
   stacks on top via the shared glow rule above. */
.dsh-quota-ball {
  position: fixed; z-index: 999; width: 40px; height: 40px; border-radius: 50%;
  cursor: pointer; touch-action: none;
  display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid var(--dsw-alias-border-l2);
  background-color: var(--dsw-specific-menu);
  color: var(--dsw-alias-label-tertiary);
  transition: box-shadow 0.15s;
}
.dsh-quota-ball:hover, .dsh-quota-ball:focus-visible { color: var(--dsw-alias-label-secondary); }
.dsh-quota-ball svg { width: 18px; height: 18px; }
.dsh-quota-ball.dsh-quota-tone-ok,
.dsh-quota-ball.dsh-quota-tone-warn,
.dsh-quota-ball.dsh-quota-tone-danger {
  box-shadow:
    var(--dsw-shadow-lv3),
    0 0 0 1px color-mix(in srgb, var(--dsh-quota-tone) 40%, transparent),
    0 0 14px color-mix(in srgb, var(--dsh-quota-tone) 55%, transparent);
}
.dsh-quota-panel {
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
.dsh-quota-head {
  display: flex; align-items: center; gap: 8px; padding: 2px 4px 6px;
  border-bottom: 1px solid var(--dsw-alias-border-l2);
}
.dsh-quota-title { color: var(--dsw-alias-label-primary); font-size: 13px; font-weight: 600; }
.dsh-quota-version {
  color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px;
  padding: 0 5px; border-radius: 4px; background: var(--dsw-alias-fill-l2);
  font-variant-numeric: tabular-nums; user-select: none; margin-right: auto;
}
.dsh-quota-lang {
  cursor: pointer; display: inline-flex; align-items: center; gap: 4px;
  border: 0; border-radius: 6px; background: 0; padding: 3px 5px;
  color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px;
}
.dsh-quota-lang:hover { color: var(--dsw-alias-label-secondary); }
.dsh-quota-refresh {
  cursor: pointer; display: inline-flex; align-items: center; justify-content: center;
  border: 0; border-radius: 6px; background: 0; padding: 4px;
  color: var(--dsw-alias-label-tertiary); line-height: 0;
}
.dsh-quota-refresh:hover { color: var(--dsw-alias-label-secondary); }
.dsh-quota-refresh:disabled { opacity: 0.5; cursor: default; }
/* Display-mode toggle in the panel head; highlighted while any floating
   surface is enabled. */
.dsh-quota-mode {
  cursor: pointer; display: inline-flex; align-items: center; justify-content: center;
  border: 0; border-radius: 6px; background: 0; padding: 4px;
  color: var(--dsw-alias-label-tertiary); line-height: 0;
}
.dsh-quota-mode:hover { color: var(--dsw-alias-label-secondary); }
.dsh-quota-mode--active { color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-fill-l2); }
@keyframes dsh-quota-spin { to { transform: rotate(360deg); } }
.dsh-quota-refresh--loading svg { animation: dsh-quota-spin 0.9s linear infinite; }
.dsh-quota-card {
  border-radius: 8px; padding: 8px 10px; display: flex; flex-direction: column; gap: 6px;
  background: var(--dsw-alias-fill-l2);
}
.dsh-quota-cardHead { display: flex; align-items: center; gap: 8px; }
.dsh-quota-providerName {
  color: var(--dsw-alias-label-primary); font-size: 13px; font-weight: 600;
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1;
}
.dsh-quota-message { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; word-break: break-all; }
.dsh-quota-balanceRow { display: flex; align-items: baseline; gap: 8px; }
.dsh-quota-balanceTotal {
  color: var(--dsw-alias-label-primary); font-size: 18px; font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.dsh-quota-balanceCurrency { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dsh-quota-balanceParts { color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; }
.dsh-quota-usageRow { display: flex; flex-direction: column; gap: 3px; }
.dsh-quota-usageHead { display: flex; align-items: center; gap: 8px; font-size: 12px; line-height: 18px; }
.dsh-quota-usageLabel { color: var(--dsw-alias-label-secondary); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-quota-usageValue { color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; flex: none; }
.dsh-quota-barTrack {
  height: 4px; border-radius: 2px; overflow: hidden;
  background: var(--dsw-alias-border-l2);
}
.dsh-quota-barFill { height: 100%; border-radius: 2px; transition: width 0.3s; }
.dsh-quota-barFill--ok { background: #22a06b; }
.dsh-quota-barFill--warn { background: #e2b93b; }
.dsh-quota-barFill--danger { background: #d94f4f; }
.dsh-quota-usageReset { color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; }
.dsh-quota-foot {
  display: flex; align-items: center; gap: 8px; padding: 6px 4px 2px;
  border-top: 1px solid var(--dsw-alias-border-l2);
}
.dsh-quota-footLabel { color: var(--dsw-alias-label-tertiary); font-size: 11px; }
.dsh-quota-select {
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; background: 0;
  color: var(--dsw-alias-label-secondary); font-size: 11px; padding: 2px 4px; cursor: pointer;
}
.dsh-quota-updated { color: var(--dsw-alias-label-tertiary); font-size: 11px; margin-left: auto; }
`

const TAG_ID = 'dsh-provider-quota/panel.css'

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
  tag.dataset.plugin = 'dsh-provider-quota'
  tag.dataset.pluginCss = TAG_ID
  tag.textContent = CSS
  document.head.appendChild(tag)
}
