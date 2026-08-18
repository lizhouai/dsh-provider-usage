/**
 * Panel stylesheet, injected once per page. Follows the shipped plugins'
 * convention of a `<style data-plugin-css>` tag and design-token colors.
 */
const CSS = `
.dsh-quota-root { position: relative; }
.dsh-quota-trigger {
  min-height: 28px; cursor: pointer; background: 0; border: 0; border-radius: 6px;
  align-items: center; gap: 4px; padding: 3px 6px;
  font-size: 12px; line-height: 18px; display: inline-flex;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-quota-trigger:hover, .dsh-quota-trigger:focus-visible { color: var(--dsw-alias-label-secondary); }
.dsh-quota-triggerIcon { flex: none; display: inline-flex; }
.dsh-quota-errorDot {
  width: 6px; height: 6px; border-radius: 50%; background: #d94f4f; flex: none;
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

/** Inject the panel stylesheet once; idempotent under HMR re-evaluation. */
export function ensureStyles(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector('style[data-plugin-css=' + JSON.stringify(TAG_ID) + ']') !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-provider-quota'
  tag.dataset.pluginCss = TAG_ID
  tag.textContent = CSS
  document.head.appendChild(tag)
}
