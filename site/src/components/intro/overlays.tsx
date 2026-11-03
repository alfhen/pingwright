import { placeNotifications, wastedLine } from '../../lib/intro-data.ts';
import { SYSTEM_FONT } from './desktop.tsx';

export function Notifications({ shown }: { shown: number }) {
  return (
    <>
      {placeNotifications(shown).map((m, i) => (
        <div
          key={i}
          data-intro-notification
          style={`position:absolute;z-index:${m.stacked ? 5 : 4};left:${m.x};top:${m.y};--r:${m.rotate};width:330px;animation:intro-toast-in .3s cubic-bezier(.2,.8,.2,1) both;background:rgba(246,246,248,.86);backdrop-filter:blur(30px) saturate(180%);color:#1d1d1f;border-radius:18px;padding:12px 13px;box-shadow:0 14px 34px -8px rgba(0,0,0,.45),0 0 0 1px rgba(0,0,0,.06);display:flex;gap:10px;font-family:${SYSTEM_FONT};pointer-events:none`}
        >
          <span style={`width:32px;height:32px;border-radius:50%;flex:none;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:13px;background:${m.color}`}>
            {m.initial}
          </span>
          <div style="display:flex;flex-direction:column;gap:2px;min-width:0">
            <div style="font-size:12px;display:flex;justify-content:space-between;gap:8px">
              <span>
                <b>{m.who}</b> <span style="color:#888">· {m.role}</span>
              </span>
              <span style="color:#999">{m.channel}</span>
            </div>
            <div style="font-size:13px;line-height:1.35">{m.text}</div>
          </div>
        </div>
      ))}
    </>
  );
}

export function Wasted() {
  const line = wastedLine();
  return (
    <>
      <div style="position:absolute;inset:0;background:radial-gradient(ellipse at center,rgba(0,0,0,.05),rgba(0,0,0,.65));pointer-events:none"></div>
      <div style="position:absolute;left:0;right:0;top:50%;height:260px;margin-top:-130px;background:linear-gradient(transparent,rgba(0,0,0,.84) 18%,rgba(0,0,0,.84) 82%,transparent);backdrop-filter:blur(6px);animation:intro-band-in .5s .2s cubic-bezier(.2,.8,.2,1) both;display:flex;flex-direction:column;align-items:center;justify-content:center">
        <div
          data-intro-wasted
          style="margin-bottom:6px;font-family:Anton,Impact,sans-serif;font-size:clamp(72px,11vw,150px);line-height:1;color:oklch(0.62 0.22 25);text-shadow:3px 3px 0 #000,-1px -1px 0 #000,0 0 40px rgba(0,0,0,.6);animation:intro-wasted-in 1.1s .35s cubic-bezier(.2,.8,.2,1) both"
        >
          wasted
        </div>
        <div data-intro-wasted-time style="font:500 28px/1.2 'Geist Mono',monospace;color:#FFFFFF;font-variant-numeric:tabular-nums;letter-spacing:-0.01em;text-align:center;animation:intro-line-in .4s .9s both">
          <span style="font-weight:600">{line.time}</span>
          {line.rest}
        </div>
        <div data-intro-wasted-finding style="font:500 21px/1.3 Geist,sans-serif;color:#F4CFC6;text-align:center;animation:intro-line-in .4s 1.5s both">{line.finding}</div>
      </div>
    </>
  );
}
