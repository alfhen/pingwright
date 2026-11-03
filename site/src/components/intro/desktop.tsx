import { battery, deskClock } from '../../lib/intro-data.ts';

export const SYSTEM_FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Helvetica Neue',sans-serif";

interface MenuBarProps {
  app: string;
  unread: number;
  shown: number;
  onSkip: () => void;
  skipHidden?: boolean;
}

const SKIP_STYLE = `font:600 12px ${SYSTEM_FONT};background:rgba(255,255,255,.28);color:#fff;border:0;border-radius:999px;padding:3px 10px;cursor:pointer;flex:none`;

export function SkipButton({ onSkip, style = '' }: { onSkip: () => void; style?: string }) {
  return (
    <button type="button" onClick={onSkip} style={SKIP_STYLE + ';' + style}>
      Skip intro →
    </button>
  );
}

export function MenuBar({ app, unread, shown, onSkip, skipHidden }: MenuBarProps) {
  return (
    <div style="position:absolute;left:0;right:0;top:0;height:28px;background:rgba(255,255,255,.22);backdrop-filter:blur(30px) saturate(180%);color:#fff;display:flex;align-items:center;gap:20px;padding:0 16px;font-size:13px;z-index:3;text-shadow:0 1px 2px rgba(0,0,0,.15)">
      <span style="width:12px;height:12px;border-radius:50%;background:#fff;display:inline-block;flex:none"></span>
      <span style="display:flex;gap:20px;min-width:0;overflow:hidden;white-space:nowrap">
        <b style="font-weight:700">{app}</b>
        <span>File</span>
        <span>Edit</span>
        <span>View</span>
        <span>Window</span>
        <span>Help</span>
      </span>
      <span style="margin-left:auto;display:flex;align-items:center;gap:6px;flex:none">
        ✉{' '}
        <b data-intro-unread style="background:#FF3B30;color:#fff;border-radius:999px;padding:0 6px;font-size:11px;line-height:16px;text-shadow:none">
          {unread}
        </b>
      </span>
      <span style="width:22px;height:11px;border:1px solid rgba(255,255,255,.9);border-radius:3px;position:relative;display:inline-block;flex:none">
        <span style={`position:absolute;left:1px;top:1px;bottom:1px;width:${battery(shown)};background:#fff;border-radius:1px`}></span>
      </span>
      <span style="font-variant-numeric:tabular-nums;flex:none">{deskClock(shown)}</span>
      <SkipButton onSkip={onSkip} style={skipHidden ? 'visibility:hidden' : ''} />
    </div>
  );
}

const tile = 'width:46px;height:46px;border-radius:12px';

export function Dock({ browserOpen }: { browserOpen: boolean }) {
  return (
    <div
      aria-hidden="true"
      style="position:absolute;left:50%;bottom:8px;transform:translateX(-50%);z-index:3;display:flex;gap:8px;align-items:flex-end;padding:7px 9px;border-radius:22px;background:rgba(255,255,255,.22);backdrop-filter:blur(30px) saturate(180%);border:.5px solid rgba(255,255,255,.4);box-shadow:0 10px 30px rgba(0,0,0,.2)"
    >
      <span style={`${tile};background:linear-gradient(#8FD3FF,#2D8CFF)`}></span>
      <span style="display:flex;flex-direction:column;align-items:center;gap:3px">
        <span style={`${tile};background:linear-gradient(#6EC1FF,#1A6BE0);display:flex;align-items:center;justify-content:center;color:#fff;font-size:22px`}>✉</span>
        <span style="width:4px;height:4px;border-radius:50%;background:rgba(255,255,255,.9)"></span>
      </span>
      <span style="display:flex;flex-direction:column;align-items:center;gap:3px">
        <span style={`${tile};background:#fff;display:flex;align-items:center;justify-content:center`}>
          <span style="width:28px;height:28px;border-radius:50%;border:6px solid #4A90E2;box-sizing:border-box;box-shadow:inset 0 0 0 3px #fff"></span>
        </span>
        <span style={`width:4px;height:4px;border-radius:50%;background:${browserOpen ? 'rgba(255,255,255,.9)' : 'transparent'}`}></span>
      </span>
      <span style={`${tile};background:linear-gradient(#5AD167,#22A13A)`}></span>
      <span style={`${tile};background:linear-gradient(#FFD54F,#F5A623)`}></span>
      <span style="width:1px;height:40px;background:rgba(255,255,255,.4);margin:0 2px"></span>
      <span style={`${tile};background:rgba(255,255,255,.35)`}></span>
    </div>
  );
}
