export const STYLE = `
.cursorSubscription{display:flex;flex-direction:column;gap:10px;max-width:720px;color:var(--dsw-alias-label-primary);container-type:inline-size}
.cursorSubscription h2,.cursorSubscription h3,.cursorSubscription p{margin:0}
.cursorSubscriptionHead{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.cursorSubscription h2{font-size:16px;line-height:24px;font-weight:500}
.cursorSubscription h3{font-size:14px;line-height:22px;font-weight:500}
.cursorSubscriptionCard{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:14px 16px;display:flex;flex-direction:column;gap:12px}
.cursorSubscriptionAccountRow{display:flex;align-items:center;justify-content:space-between;gap:12px}
.cursorSubscriptionStatus{display:flex;align-items:center;gap:8px;font-size:14px;line-height:22px;font-weight:500;min-width:0;flex-wrap:wrap}
.cursorSubscriptionDot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-dimmed)}
.cursorSubscriptionDot[data-state=connected]{background:var(--dsw-alias-state-success-primary)}
.cursorSubscriptionDot[data-state=disconnected]{background:var(--dsw-alias-state-error-primary)}
.cursorSubscriptionActions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.cursorSubscriptionFlow{display:flex;flex-direction:column;gap:10px;padding:12px 14px;border-radius:10px;background:var(--dsw-alias-bg-module-platform)}
.cursorSubscriptionFlow p{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.cursorSubscriptionError{font-size:13px;line-height:20px;color:var(--dsw-alias-state-error-primary)}
.cursorSubscriptionNote{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.cursorSubscriptionFreshness{font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary)}
.cursorSubscriptionSectionHead{display:flex;align-items:center;justify-content:space-between;gap:12px}
.cursorSubscriptionSectionTitle{display:flex;flex:1;min-width:0;flex-direction:column;gap:2px}
.cursorSubscriptionRefresh{flex:0 0 auto;min-width:72px;width:max-content;white-space:nowrap!important;word-break:keep-all!important;overflow-wrap:normal!important;writing-mode:horizontal-tb!important}
.cursorSubscriptionRefresh *{white-space:nowrap!important;word-break:keep-all!important;writing-mode:horizontal-tb!important}
.cursorSubscriptionEmpty{padding:18px;border:1px dashed var(--dsw-alias-border-l3);border-radius:10px;text-align:center;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
.cursorSubscriptionUsageRow{display:flex;flex-direction:column;gap:6px}
.cursorSubscriptionUsageTop{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
.cursorSubscriptionUsageLabel{flex:1;min-width:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.cursorSubscriptionUsageTop strong{font:600 16px/22px ui-monospace,SFMono-Regular,Consolas,monospace;font-variant-numeric:tabular-nums}
.cursorSubscriptionUsageRow progress{width:100%;height:6px;border:0;border-radius:999px;overflow:hidden;background:var(--dsw-alias-border-l3);accent-color:var(--dsw-alias-brand-primary,#3964fe);-webkit-appearance:none;appearance:none}
.cursorSubscriptionUsageRow progress::-webkit-progress-bar{background:var(--dsw-alias-border-l3);border-radius:999px}
.cursorSubscriptionUsageRow progress::-webkit-progress-value{background:var(--dsw-alias-brand-primary,#3964fe);border-radius:999px}
.cursorSubscriptionUsageRow progress::-moz-progress-bar{background:var(--dsw-alias-brand-primary,#3964fe);border-radius:999px}
.cursorSubscriptionCredential{font:500 12px/18px ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--dsw-alias-label-secondary);max-width:min(280px,100%);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cursorSubscriptionUsageFoot{display:flex;justify-content:space-between;align-items:baseline;gap:10px;font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary)}
.cursorSubscriptionUsageFootRight{margin-left:auto;text-align:right}
.cursorSubscriptionApiKey{display:flex;flex-direction:column;gap:8px}
.cursorSubscriptionApiKeyRow{display:flex;gap:8px;align-items:center}
.cursorSubscriptionApiKeyInput{box-sizing:border-box;flex:1;min-width:0;height:34px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);padding:6px 9px;color:var(--dsw-alias-label-primary);font:13px/20px ui-monospace,SFMono-Regular,Consolas,monospace;outline:none}
.cursorSubscriptionApiKeyInput:focus{border-color:var(--dsw-alias-brand-primary,#3964fe);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-brand-primary,#3964fe) 18%,transparent)}
.cursorSubscriptionApiKeyInput:disabled{opacity:.6}
.cursorSubscriptionUsageGroup{display:flex;flex-direction:column;gap:10px;padding-top:4px}
.cursorSubscriptionUsageGroupHead{font-size:12px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-secondary)}
.cursorSubscriptionUsageSplit{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;padding-top:2px}
.cursorSubscriptionMetaRow{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary)}
.cursorSubscriptionModels{display:flex;flex-direction:column;gap:8px}
.cursorSubscriptionModelChips{display:flex;flex-wrap:wrap;gap:6px}
.cursorSubscriptionModelChip{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-module-platform);padding:3px 8px;font:500 12px/18px ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--dsw-alias-label-secondary);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cursorSubscriptionSettingsGrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.cursorSubscriptionField{display:flex;flex-direction:column;gap:5px;min-width:0}
.cursorSubscriptionFieldWide{grid-column:1/-1}
.cursorSubscriptionField label{font-size:12px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-secondary)}
.cursorSubscriptionField input{box-sizing:border-box;width:100%;height:34px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);padding:6px 9px;color:var(--dsw-alias-label-primary);font:13px/20px ui-monospace,SFMono-Regular,Consolas,monospace;outline:none}
.cursorSubscriptionField input:focus{border-color:var(--dsw-alias-brand-primary,#3964fe);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-brand-primary,#3964fe) 18%,transparent)}
.cursorSubscriptionField input:disabled{opacity:.6}
.cursorSubscriptionFieldHint{font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary)}
.cursorSubscriptionSettingsFoot{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.cursorSubscriptionSuccess{font-size:12px;line-height:18px;color:var(--dsw-alias-state-success-primary)}
@container (max-width:520px){.cursorSubscriptionSettingsGrid{grid-template-columns:1fr}.cursorSubscriptionFieldWide{grid-column:auto}.cursorSubscriptionUsageSplit{grid-template-columns:1fr}}
`;
