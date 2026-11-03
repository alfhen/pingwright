import { useEffect, useRef, useState } from 'preact/hooks';
import type { DemoData, Line, ScenarioKey, Tone } from '../../lib/demo-data.ts';
import { frameAt, SEND_AT, TICK, totalOf } from './timeline.ts';

const MINT = 'var(--ad-mint)';
const FAIL = 'var(--ad-fail)';
const TERM_TONE: Record<Tone, string> = { fg: 'var(--code-ink)', dim: 'var(--ad-muted)', faint: '#5B6865', mint: MINT, fail: FAIL, warn: 'var(--ad-warn)' };

interface Props {
  data: DemoData;
}

function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export default function AgentDemo({ data }: Props) {
  const total = totalOf(data.scenarios);
  const [key, setKey] = useState<ScenarioKey>('reject');
  const [armed, setArmed] = useState(false);
  const [T, setT] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  useEffect(() => () => clearInterval(timer.current), []);

  const start = () => {
    clearInterval(timer.current);
    setArmed(true);
    if (reducedMotion()) {
      setT(total);
      return;
    }
    setT(SEND_AT);
    timer.current = setInterval(() => {
      setT((now) => {
        if (now >= total) {
          clearInterval(timer.current);
          return now;
        }
        return now + TICK;
      });
    }, TICK);
  };

  const pick = (next: ScenarioKey) => {
    setKey(next);
    if (armed) start();
  };

  const sc = data.scenarios.find((s) => s.key === key)!;
  const f = frameAt(sc, T, armed, data.userPrompt);
  const host = `https://${data.storyHost}`;
  const epochColor = f.epoch === 'denied' ? 'var(--fail)' : f.epoch === 'granted' ? 'var(--mint)' : 'var(--warn)';

  return (
    <div class="ad-card" data-demo="root">
      <div class="ad-toolbar">
        <span>agent tests a visitor who</span>
        <div class="ad-picker" role="group" aria-label="Visitor">
          {data.scenarios.map((s) => (
            <button type="button" key={s.key} aria-pressed={s.key === key} data-demo-pick={s.key} onClick={() => pick(s.key)}>
              {s.label}
            </button>
          ))}
        </div>
        <span class="ad-clock" data-demo="clock">
          t = {(Math.min(T, total) / 1000).toFixed(1)}s
        </span>
        <button type="button" class="ad-replay" data-demo="replay" onClick={start}>
          ↺ replay
        </button>
      </div>
      <div class="ad-grid">
        {f.showThanks && (
          <div class="ad-thanks" data-demo="thanks" role="status">
            <span class="ad-avatar">M</span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
              <div style={{ fontSize: '12px', display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
                <span>
                  <b>Mads</b> <span style={{ color: '#888' }}>· Performance</span>
                </span>
                <span style={{ color: '#999' }}>now</span>
              </div>
              <div style={{ fontSize: '13px', lineHeight: 1.35 }}>Wait, that took a minute?? Sending it to Sofie. Thank you!</div>
            </div>
          </div>
        )}
        {f.idle && (
          <div class="ad-idle" data-demo="idle">
            <div class="ad-ask">
              <span style={{ fontSize: '11px', color: 'var(--ad-muted)' }}>~/northwind — your coding agent</span>
              <div style={{ display: 'flex', gap: '10px', fontSize: '14px', lineHeight: 1.55 }}>
                <span style={{ color: 'var(--term-dim)' }}>&gt;</span>
                <span style={{ flex: 1 }}>{data.userPrompt}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
                <span style={{ fontSize: '11.5px', color: 'var(--ad-muted)' }}>Mads's question. The agent will run Tagreeve to answer it.</span>
                <button type="button" class="ad-ask-button" data-demo="ask" onClick={start}>
                  Ask the agent ⏎
                </button>
              </div>
            </div>
          </div>
        )}
        <div class="ad-term">
          <div class="ad-term-bar">
            <span class="ad-dot" />
            <span class="ad-dot" />
            <span class="ad-dot" />
            <span style={{ flex: 1, textAlign: 'center' }}>~/northwind — agent</span>
          </div>
          <div class="ad-scroll">
            <div class="ad-fade" />
            <div class="ad-log">
              <div style={{ border: '1px solid var(--term-frame)', borderRadius: '6px', padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: '2px', color: 'var(--term-dim)' }}>
                <span style={{ color: '#E6E6E2' }}>Coding agent</span>
                <span>cwd: ~/northwind</span>
                <span>tools: Bash, Read, Edit</span>
              </div>
              {f.showUserMsg && (
                <div class="ad-in" style={{ display: 'flex', gap: '8px', color: 'var(--term-dim)' }}>
                  <span>&gt;</span>
                  <span style={{ whiteSpace: 'pre-wrap' }}>{data.userPrompt}</span>
                </div>
              )}
              {f.showPlan && (
                <div class="ad-in" style={{ display: 'flex', gap: '8px' }} data-demo="plan">
                  <span style={{ color: '#E6E6E2' }}>●</span>
                  <span class="ad-prose">{sc.plan}</span>
                </div>
              )}
              {f.showTool && (
                <div class="ad-in" style={{ display: 'flex', flexDirection: 'column', gap: '1px' }} data-demo="tool">
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <span style={{ color: f.toolDone ? (sc.exitCode ? FAIL : MINT) : f.toolBlink ? 'var(--code-ink)' : '#5B6865' }}>●</span>
                    <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                      <b style={{ fontWeight: 600, color: '#E6E6E2' }}>Bash</b>
                      <span style={{ color: 'var(--term-dim)' }}>
                        (tagreeve run tagreeve/{sc.file} --site {host})
                      </span>
                    </span>
                  </div>
                  {(f.showToolOut ? sc.toolOut : [{ text: f.t > 0 ? 'running… chromium · stub mode' : 'starting…', tone: 'dim' } satisfies Line]).map((o, i) => (
                    <div key={i} style={{ display: 'flex', gap: '6px', paddingLeft: '4px' }}>
                      <span style={{ color: '#5C5F64', width: '12px', flex: 'none' }}>{i === 0 ? '⎿' : ''}</span>
                      <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: TERM_TONE[o.tone] }}>{o.text}</span>
                    </div>
                  ))}
                </div>
              )}
              {f.showReply && (
                <div class="ad-in" style={{ display: 'flex', gap: '8px' }} data-demo="reply">
                  <span style={{ color: '#E6E6E2' }}>●</span>
                  <div class="ad-prose" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {f.reply.map((p, i) => (
                      <span key={i} style={{ whiteSpace: 'pre-wrap' }}>
                        {p}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {f.showSend && (
                <div class="ad-in" style={{ display: 'flex', flexDirection: 'column', gap: '1px' }} data-demo="send">
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <span style={{ color: '#E6E6E2' }}>●</span>
                    <span style={{ fontFamily: 'var(--font-sans)', fontSize: '13px', color: '#E6E6E2' }}>
                      Want me to reply to Mads with this? <span class="ad-mono" style={{ color: '#6C6F74', fontSize: '11.5px' }}>(y/n)</span>{' '}
                      <span class="ad-mono" style={{ color: MINT }}>
                        {f.sendAnswer}
                      </span>
                    </span>
                  </div>
                  {f.showSent && (
                    <div class="ad-in" style={{ display: 'flex', gap: '6px', paddingLeft: '4px' }} data-demo="sent">
                      <span style={{ color: '#5C5F64', width: '12px' }}>⎿</span>
                      <span style={{ color: MINT }}>✓ Sent to Mads · cc Sofie (Legal) · evidence attached</span>
                    </div>
                  )}
                </div>
              )}
              {f.working && (
                <div style={{ display: 'flex', gap: '8px', color: 'var(--term-spinner)' }}>
                  <span>{f.spinGlyph}</span>
                  <span>
                    {f.spinWord}… <span style={{ color: '#6C6F74' }}>({f.spinSecs}s · esc to interrupt)</span>
                  </span>
                </div>
              )}
            </div>
          </div>
          <div style={{ flex: 'none', padding: '6px 14px 10px' }}>
            <div class="ad-input">
              <span style={{ color: 'var(--term-dim)' }}>&gt;</span>
              <span style={{ whiteSpace: 'pre-wrap', flex: 1 }}>
                {f.inputText}
                {f.inputCursor && <span class="ad-cursor" />}
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 2px 0', fontSize: '10.5px', color: '#6C6F74' }}>
              <span>? for shortcuts</span>
              <span>{f.footerHint}</span>
            </div>
          </div>
        </div>
        <div class="ad-browser">
          <div class="ad-small">
            <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'var(--line)' }} />
            <span class="ad-url">
              {data.storyHost}
              {f.path}
            </span>
          </div>
          <div class="ad-page" style={{ opacity: f.pageVisible ? 1 : 0.25 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span class="ad-bar" style={{ width: '70px', height: '10px' }} />
              <span class="ad-bar" style={{ width: '90px', height: '10px' }} />
            </div>
            <div class="ad-shot">product shot</div>
            <span class="ad-bar" style={{ width: '60%', height: '12px' }} />
            <span class="ad-bar" style={{ width: '35%', height: '10px' }} />
            <span class="ad-bar" style={{ width: '110px', height: '30px', borderRadius: '6px' }} />
            <div
              class="ad-banner"
              data-demo="banner"
              aria-hidden={!f.bannerVisible}
              style={{ transform: f.bannerVisible ? 'none' : 'translateY(130%)', opacity: f.bannerVisible ? 1 : 0 }}
            >
              <span style={{ fontSize: '13px', fontWeight: 600 }}>We use cookies</span>
              <span style={{ fontSize: '11.5px', color: 'var(--muted)', lineHeight: 1.4 }}>For analytics and ads. You can change this later.</span>
              <div style={{ display: 'flex', gap: '6px' }}>
                <span
                  class="ad-choice"
                  style={f.pressing === 'reject' ? { background: 'var(--ink)', color: 'var(--bg)' } : { background: 'transparent', color: 'var(--ink)' }}
                >
                  Reject
                </span>
                <span
                  class="ad-choice"
                  style={f.pressing === 'accept' ? { background: 'var(--mint)', color: 'var(--onmint)' } : { background: 'var(--bg2)', color: 'var(--ink)' }}
                >
                  Accept
                </span>
              </div>
            </div>
          </div>
          <div class="ad-small" style={{ justifyContent: 'space-between' }}>
            <span>chromium · stub mode</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              epoch{' '}
              <b style={{ color: epochColor, fontWeight: 600 }} data-demo="epoch">
                {f.epoch}
              </b>
            </span>
          </div>
        </div>
        <div class="ad-hits">
          <div class="ad-small" style={{ justifyContent: 'space-between' }}>
            <span>CAPTURED HITS</span>
            <span data-demo="hit-count">{f.hits.length} recorded · 0 sent</span>
          </div>
          {f.idle && (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '8px', textAlign: 'center', color: 'var(--muted)', fontSize: '13px', lineHeight: 1.5, padding: '0 12px' }}>
              <span>Hits will land here as the visitor browses.</span>
            </div>
          )}
          <div class="ad-hit-list">
            {f.hits.map((h) => (
              <div key={h.id} class="ad-hit" data-demo="hit" data-fail={h.fail || undefined}>
                <span style={{ color: 'var(--muted)' }}>{(h.at / 1000).toFixed(1)}s</span>
                <span style={{ fontWeight: 600 }}>{h.vendor}</span>
                <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{h.event}</span>
                <span class="ad-tag" data-tone={h.tag}>
                  {h.tag}
                </span>
              </div>
            ))}
          </div>
          {f.showVerdict && (
            <div class="ad-verdict" data-demo="verdict" data-pass={sc.exitCode === 0 || undefined}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '8px' }}>
                <b style={{ fontSize: '22px', letterSpacing: '-0.03em', color: sc.exitCode ? 'var(--fail)' : 'var(--mint)' }}>{sc.verdict.title}</b>
                <span class="ad-mono" style={{ fontWeight: 500, fontSize: '12px', color: 'var(--muted)', whiteSpace: 'nowrap', flex: 'none' }}>
                  {sc.verdict.exit}
                </span>
              </div>
              <span style={{ fontSize: '13.5px', lineHeight: 1.45, color: 'var(--ink)' }}>{sc.verdict.body}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
