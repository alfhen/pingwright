import { mailList } from '../../lib/intro-data.ts';
import { SYSTEM_FONT } from './desktop.tsx';

interface MailWindowProps {
  asking: boolean;
  shown: number;
  unread: number;
  onReply: () => void;
  onSkip: () => void;
}

const folder = 'margin:0 8px;padding:5px 8px;color:rgba(0,0,0,.75)';

export function MailWindow({ asking, shown, unread, onReply, onSkip }: MailWindowProps) {
  return (
    <div
      style={`position:absolute;left:5%;top:48px;bottom:84px;width:min(1000px,82%);background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 0 0 .5px rgba(0,0,0,.25),0 30px 70px -10px rgba(0,0,0,.45);display:flex;color:#1d1d1f;transition:transform .6s,filter .6s;transform:${asking ? 'none' : 'translate(-2%,-1%) scale(.97)'};filter:${asking ? 'none' : 'brightness(.85)'}`}
    >
      <div style="width:190px;flex:none;padding:8px;position:relative;display:flex;flex-direction:column">
        <div style="position:absolute;inset:8px;border-radius:12px;background:rgba(210,225,245,.55);border:.5px solid rgba(255,255,255,.6)"></div>
        <div style="position:relative;display:flex;flex-direction:column;gap:2px;padding:10px 0;font-size:13px">
          <div style="display:flex;gap:8px;padding:2px 12px 14px">
            <span style="width:12px;height:12px;border-radius:50%;background:#ff736a"></span>
            <span style="width:12px;height:12px;border-radius:50%;background:#febc2e"></span>
            <span style="width:12px;height:12px;border-radius:50%;background:#19c332"></span>
          </div>
          <span style="padding:4px 14px;font-size:11px;font-weight:700;color:rgba(0,0,0,.45)">Favourites</span>
          <span style="margin:0 8px;padding:5px 8px;border-radius:7px;background:rgba(0,0,0,.08);font-weight:600;display:flex;justify-content:space-between">
            Inbox <span style="color:rgba(0,0,0,.5);font-weight:500">{unread}</span>
          </span>
          <span style={folder}>Flagged</span>
          <span style={folder}>Sent</span>
          <span style={folder}>Drafts</span>
          <span style={folder}>Archive</span>
        </div>
      </div>
      <div style="width:290px;flex:none;border-right:1px solid #EBEBEB;display:flex;flex-direction:column;overflow:hidden">
        <div style="padding:16px 16px 10px;display:flex;flex-direction:column;gap:2px">
          <b style="font-size:17px">Inbox</b>
          <span style="font-size:11.5px;color:#8a8a8e">{unread} unread</span>
        </div>
        {mailList(shown).map((m, i) => (
          <div
            key={`${m.subject}-${i}`}
            data-intro-mail
            style={`margin:0 8px;padding:10px 10px;border-radius:9px;display:flex;flex-direction:column;gap:2px;background:${m.open ? '#007AFF' : 'transparent'};color:${m.open ? '#fff' : '#1d1d1f'};animation:${m.arrived ? 'intro-toast-in .3s both' : 'none'}`}
          >
            <div style="display:flex;justify-content:space-between;font-size:13px">
              <span style={`font-weight:${m.unread ? 700 : 400};display:flex;align-items:center;gap:6px`}>
                <span style={`width:7px;height:7px;border-radius:50%;background:${m.open ? '#fff' : m.arrived ? '#007AFF' : 'transparent'}`}></span>
                {m.from}
              </span>
              <span style="font-size:11.5px;opacity:.6">{m.time}</span>
            </div>
            <div style={`font-size:12.5px;font-weight:${m.unread ? 700 : 400};white-space:nowrap;overflow:hidden;text-overflow:ellipsis`}>{m.subject}</div>
            <div style="font-size:12px;opacity:.6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{m.preview}</div>
          </div>
        ))}
      </div>
      <div style="flex:1;display:flex;flex-direction:column;min-height:0;min-width:0">
        <div style="flex:1;min-height:0;overflow:auto;padding:26px 30px;display:flex;flex-direction:column;gap:14px">
          <div style="font-size:22px;font-weight:700;letter-spacing:-0.01em">Quick favour? Meta numbers + consent</div>
          <div style="display:flex;align-items:center;gap:10px;font-size:13px;padding-bottom:12px;border-bottom:1px solid #EFEFEF">
            <span style="width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:600;background:linear-gradient(#9AA4B2,#6B7584)">MH</span>
            <div style="display:flex;flex-direction:column">
              <b>Mads Holm</b>
              <span style="color:#8a8a8e">To: You · Cc: Sofie Lund</span>
            </div>
            <span style="margin-left:auto;color:#8a8a8e;font-size:12px">16:47</span>
          </div>
          <div style="font-size:15px;line-height:1.6;color:#1d1d1f;display:flex;flex-direction:column;gap:12px;max-width:560px">
            <span>Hey,</span>
            <span>
              Sorry to bother you. Meta numbers fell off a cliff after Tuesday's publish, and Sofie says we've had complaints that Meta fires before people answer the cookie banner.
            </span>
            <span>
              Could you take a quick look in the tag manager? <b>Should only take 5 minutes.</b>
            </span>
            <span>
              Thanks!
              <br />
              Mads
            </span>
          </div>
        </div>
        {asking && (
          <div style="display:flex;flex-wrap:wrap;gap:10px;padding:12px 30px;border-top:1px solid #EFEFEF;background:#FAFAFA;animation:intro-ask-in .5s .6s both">
            <button
              type="button"
              onClick={onReply}
              style={`font:600 14px ${SYSTEM_FONT};background:#007AFF;color:#fff;border:0;border-radius:8px;padding:9px 16px;cursor:pointer;box-shadow:0 0 0 4px rgba(0,122,255,.2)`}
            >
              ↩ Reply: "Sure, I'll take a look"
            </button>
            <button
              type="button"
              onClick={onSkip}
              style={`font:500 14px ${SYSTEM_FONT};background:#fff;color:#1d1d1f;border:.5px solid rgba(0,0,0,.2);border-radius:8px;padding:9px 14px;cursor:pointer`}
            >
              Not my job (skip)
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
