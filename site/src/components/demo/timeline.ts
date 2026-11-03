import type { DemoHit, DemoScenario } from '../../lib/demo-data.ts';

export const SEND_AT = 1450;
export const OFF = 2800;
export const END = 5600;
export const RATE = 0.16;
export const TICK = 80;
export const REPLY_AT = OFF + END + 700;

const SPIN = ['·', '✢', '✳', '✶', '✻', '✽'];

export const replyEnd = (sc: DemoScenario) => REPLY_AT + sc.reply.join('').length / RATE;
export const totalOf = (scenarios: DemoScenario[]) => REPLY_AT + Math.max(...scenarios.map((s) => s.reply.join('').length)) / RATE + 7600;

export interface Frame {
  idle: boolean;
  T: number;
  t: number;
  inputText: string;
  inputCursor: boolean;
  showUserMsg: boolean;
  working: boolean;
  spinGlyph: string;
  spinWord: string;
  spinSecs: number;
  footerHint: string;
  showPlan: boolean;
  showTool: boolean;
  toolDone: boolean;
  toolBlink: boolean;
  showToolOut: boolean;
  reply: string[];
  showReply: boolean;
  showSend: boolean;
  sendAnswer: string;
  showSent: boolean;
  showThanks: boolean;
  path: string;
  pageVisible: boolean;
  bannerVisible: boolean;
  pressing: 'accept' | 'reject' | null;
  epoch: string;
  hits: DemoHit[];
  showVerdict: boolean;
}

/** The whole demo at clock `T`. `armed` is false until the visitor first asks. */
export function frameAt(sc: DemoScenario, T: number, armed: boolean, userPrompt: string): Frame {
  const t = T - OFF;
  const answered = sc.answer !== null && t >= sc.answer.at;
  const end = replyEnd(sc);
  let left = Math.floor(Math.max(0, T - REPLY_AT) * RATE);
  const reply = sc.reply
    .map((p) => {
      const text = p.slice(0, Math.max(0, left));
      left -= p.length;
      return text;
    })
    .filter(Boolean);
  const path = sc.pages.filter((p) => p.at <= Math.max(t, sc.pages[0]?.at ?? 0)).at(-1)?.path ?? '/';
  return {
    idle: !armed,
    T,
    t,
    inputText: armed && T < 1500 ? userPrompt : '',
    inputCursor: !armed || T >= 1500,
    showUserMsg: armed && T >= 1500,
    working: armed && T >= 1500 && T < REPLY_AT,
    spinGlyph: SPIN[Math.floor(T / 160) % SPIN.length]!,
    spinWord: T < OFF ? 'Thinking' : t <= END ? 'Running tagreeve' : 'Reading the summary',
    spinSecs: Math.max(0, Math.floor((T - 1500) / 1000)),
    footerHint: !armed ? 'waiting for your question' : T >= 1500 && T < REPLY_AT ? 'stub mode · no hits leave this machine' : 'auto-accept: off',
    showPlan: armed && T > 1800,
    showTool: armed && T > OFF - 300,
    toolDone: t > END,
    toolBlink: Math.floor(T / 400) % 2 === 1,
    showToolOut: t > END,
    reply,
    showReply: armed && T > REPLY_AT,
    showSend: armed && T > end + 400,
    sendAnswer: T > end + 1100 ? 'y' : '',
    showSent: armed && T > end + 1400,
    showThanks: armed && T > end + 2300 && T < end + 7300,
    path,
    pageVisible: t > 1250,
    bannerVisible: t > 1600 && !answered,
    pressing: sc.answer && t >= sc.answer.at - 300 && t < sc.answer.at ? sc.answer.action : null,
    epoch: answered ? sc.answer!.epoch : 'undecided',
    hits: armed ? sc.hits.filter((h) => h.at <= t).sort((a, b) => a.at - b.at).reverse() : [],
    showVerdict: armed && t > END,
  };
}
