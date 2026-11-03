import { ACCOUNT_NAME, BROWSER_TABS, CONTAINER_HOST, TAGS, timeSpent } from '../../lib/intro-data.ts';
import { SYSTEM_FONT } from './desktop.tsx';

interface TagManagerProps {
  shaking: boolean;
  shown: number;
  selected: number;
  onSelect: (index: number) => void;
  previewOpen: boolean;
  attempt: number;
  onPreview: () => void;
  onCancelPreview: () => void;
  onRetryPreview: () => void;
}

const columns = 'display:grid;grid-template-columns:minmax(0,2.2fr) minmax(0,1fr) minmax(0,1.6fr) 90px';
const navItem = 'padding:8px 18px';

export function TagManagerWindow(props: TagManagerProps) {
  const { shaking, shown, selected, onSelect, previewOpen, attempt, onPreview, onCancelPreview, onRetryPreview } = props;
  const tag = TAGS[selected] ?? TAGS[0]!;
  return (
    <div
      data-intro-browser
      style="position:absolute;left:8%;top:62px;right:3%;bottom:76px;border-radius:12px;overflow:hidden;box-shadow:0 0 0 .5px rgba(0,0,0,.4),0 40px 90px -20px rgba(0,0,0,.6);display:flex;flex-direction:column;background:#35363a;animation:intro-ask-in .45s cubic-bezier(.2,.8,.2,1) both"
    >
      <div
        data-intro-shake={shaking ? '' : undefined}
        style={`animation:${shaking ? 'intro-shake .25s linear infinite' : 'none'};display:flex;flex-direction:column;flex:1;min-height:0;position:relative`}
      >
        <div style="height:42px;flex:none;background:#202124;display:flex;align-items:flex-end;padding-right:8px">
          <div style="display:flex;gap:8px;padding:0 14px;align-self:center">
            <span style="width:12px;height:12px;border-radius:50%;background:#ff5f57"></span>
            <span style="width:12px;height:12px;border-radius:50%;background:#febc2e"></span>
            <span style="width:12px;height:12px;border-radius:50%;background:#28c840"></span>
          </div>
          {BROWSER_TABS.map((t) => (
            <div
              key={t.title}
              style={`height:34px;padding:0 12px;display:flex;align-items:center;gap:8px;border-radius:8px 8px 0 0;min-width:0;max-width:210px;flex:1;font:12px ${SYSTEM_FONT};background:${t.active ? '#35363a' : 'transparent'};color:${t.active ? '#e8eaed' : '#9aa0a6'}`}
            >
              <span style={`width:14px;height:14px;border-radius:${t.radius};background:${t.icon};flex:none`}></span>
              <span style="flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{t.title}</span>
              <span style="opacity:.6">×</span>
            </div>
          ))}
          <span style="color:#9aa0a6;font-size:18px;padding:0 10px 6px">+</span>
        </div>
        <div style={`height:38px;flex:none;background:#35363a;display:flex;align-items:center;gap:6px;padding:0 10px;color:#9aa0a6;font:14px ${SYSTEM_FONT}`}>
          <span>←</span>
          <span>→</span>
          <span>↻</span>
          <div style="flex:1;height:28px;border-radius:14px;background:#282a2d;display:flex;align-items:center;gap:8px;padding:0 14px;margin:0 6px;color:#e8eaed;font-size:13px;white-space:nowrap;overflow:hidden">
            <span style="font-size:11px;color:#9aa0a6">🔒︎</span>tagmangler.example.com
            <span style="color:#9aa0a6">/accounts/600213/containers/11872/workspaces/47/tags</span>
          </div>
          <span style="width:22px;height:22px;border-radius:50%;background:#8AB4F8;color:#202124;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center">Y</span>
        </div>
        <div style="flex:1;min-height:0;background:#fff;display:flex;flex-direction:column;font-family:Arial,Helvetica,sans-serif;color:#202124;position:relative">
          <div style="height:56px;flex:none;display:flex;align-items:center;gap:18px;padding:0 18px;border-bottom:1px solid #DADCE0">
            <span style="display:flex;align-items:center;gap:10px;font-size:18px;color:#3c4043">
              <span style="width:22px;height:22px;transform:rotate(45deg);border-radius:4px;background:#5F6B7A;display:inline-block"></span>
              TagMangler
            </span>
            <span style="display:flex;flex-direction:column;font-size:11px;color:#5f6368;padding-left:14px;border-left:1px solid #DADCE0">
              All accounts › {ACCOUNT_NAME}
              <b style="font-size:14px;color:#202124;font-weight:500">{CONTAINER_HOST} ▾</b>
            </span>
            <span style="margin-left:auto;display:flex;flex-direction:column;align-items:flex-end;font-size:11px;color:#5f6368">
              Workspace changes: <b style="color:#C5221F;font-size:14px">213</b>
            </span>
            <button
              type="button"
              onClick={onPreview}
              style="font:500 14px Arial,sans-serif;background:#fff;color:#5F6B7A;border:1px solid #DADCE0;border-radius:4px;padding:8px 16px;cursor:pointer"
            >
              Preview
            </button>
            <button type="button" style="font:500 14px Arial,sans-serif;background:#5F6B7A;color:#fff;border:0;border-radius:4px;padding:9px 18px">
              Submit
            </button>
          </div>
          <div style="background:#FEF7E0;border-bottom:1px solid #F9E6A6;padding:7px 18px;font-size:12px;color:#5C4A00;flex:none;display:flex;gap:10px">
            ⚠ Your preview session expired. Some features have moved. <u>Learn more</u>
            <span style="margin-left:auto;color:#5f6368">
              Time on this "5 minute" ticket: <b data-intro-time style="color:#C5221F">{timeSpent(shown)}</b>
            </span>
          </div>
          <div style="flex:1;display:flex;min-height:0">
            <div style="width:200px;flex:none;padding:12px 0;display:flex;flex-direction:column;gap:2px;font-size:14px;color:#3c4043;border-right:1px solid #DADCE0">
              <span style="padding:4px 18px 10px;font-size:11px;color:#5f6368">
                CURRENT WORKSPACE
                <br />
                <b style="font-size:13px;color:#202124;font-weight:500">Default Workspace (47) ▾</b>
              </span>
              <span style={navItem}>Overview</span>
              <span style="padding:8px 18px;background:#EDEFF2;color:#202124;font-weight:bold;border-radius:0 18px 18px 0;margin-right:10px">Tags</span>
              <span style={navItem}>Triggers</span>
              <span style={navItem}>Variables</span>
              <span style={navItem}>Folders</span>
              <span style={navItem}>Templates</span>
            </div>
            <div style="flex:1;display:flex;flex-direction:column;min-width:0;padding:14px 18px;gap:10px;background:#F8F9FA">
              <div style="display:flex;align-items:center;justify-content:space-between">
                <b style="font-size:16px;font-weight:500">Tags</b>
                <span style="font-size:13px;color:#5f6368">🔍︎ Search · 147 tags</span>
              </div>
              <div style="flex:1;min-height:0;background:#fff;border:1px solid #DADCE0;border-radius:6px;overflow:hidden;display:flex;flex-direction:column">
                <div style={`${columns};padding:10px 14px;border-bottom:1px solid #DADCE0;font-size:12px;color:#5f6368;font-weight:bold`}>
                  <span>Name ↑</span>
                  <span>Type</span>
                  <span>Firing Triggers</span>
                  <span>Last Edited</span>
                </div>
                <div style="flex:1;overflow:hidden">
                  {TAGS.map((t, i) => (
                    <button
                      key={t.name}
                      type="button"
                      aria-pressed={i === selected}
                      onClick={() => onSelect(i)}
                      style={`${columns};width:100%;box-sizing:border-box;text-align:left;font:inherit;color:inherit;border:0;padding:8px 14px;border-bottom:1px solid #F1F3F4;cursor:pointer;font-size:13px;background:${i === selected ? '#E8F0FE' : '#fff'}`}
                    >
                      <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#3B5B8C">{t.name}</span>
                      <span style="color:#5f6368">{t.type}</span>
                      <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#5f6368">{t.trig}</span>
                      <span style="color:#80868b">{t.ago}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div style="width:260px;flex:none;border-left:1px solid #DADCE0;padding:16px;display:flex;flex-direction:column;gap:10px;font-size:13px">
              <div data-intro-selected style="font-size:15px;color:#3B5B8C">{tag.name}</div>
              <div style="display:grid;grid-template-columns:auto 1fr;gap:6px 10px;font-size:12px">
                <span style="color:#5f6368">Fires on</span>
                <span>{tag.trig}</span>
                <span style="color:#5f6368">Consent</span>
                <span style="color:#C5221F">{tag.consent}</span>
              </div>
              <div style="font-size:12px;color:#5f6368;font-style:italic">{tag.note}</div>
            </div>
          </div>
          {previewOpen && (
            <div style="position:absolute;inset:0;background:rgba(32,33,36,.4);display:flex;align-items:center;justify-content:center">
              <div
                role="alertdialog"
                aria-label="Connecting to preview…"
                style="width:380px;background:#fff;border-radius:8px;box-shadow:0 12px 32px rgba(0,0,0,.3);padding:22px;display:flex;flex-direction:column;gap:14px"
              >
                <div style="display:flex;align-items:center;gap:12px;font-size:16px">
                  <span style="width:18px;height:18px;border:3px solid #E8EAED;border-top-color:#5F6B7A;border-radius:50%;animation:intro-spin .8s linear infinite;display:inline-block"></span>
                  Connecting to preview…
                </div>
                <div data-intro-attempt style="color:#5f6368;line-height:1.5;font-size:13px">
                  Attempt {attempt + 3} of ∞. Check third-party cookies, the extension, the account you're signed in with, and the phase of the moon.
                </div>
                <div style="display:flex;justify-content:flex-end;gap:8px">
                  <button
                    type="button"
                    onClick={onCancelPreview}
                    style="font:500 14px Arial,sans-serif;background:#fff;color:#5F6B7A;border:0;padding:8px 12px;cursor:pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={onRetryPreview}
                    style="font:500 14px Arial,sans-serif;background:#5F6B7A;color:#fff;border:0;border-radius:4px;padding:8px 14px;cursor:pointer"
                  >
                    Try again
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
