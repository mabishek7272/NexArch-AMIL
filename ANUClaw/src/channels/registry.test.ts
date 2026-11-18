/** F15: adapters whose advertised behaviour is not implemented must not start unless a developer explicitly opts in. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { built, mkChannel } = vi.hoisted(() => {
  const built: string[] = [];
  const mkChannel = (name: string) => class { name = name; constructor() { built.push(name); } async start() {} async stop() {} async sendMessage() {} };
  return { built, mkChannel };
});
vi.mock('../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../config', () => ({
  config: { channels: {
    telegram: { token: 'tg' }, discord: { token: '' }, slack: { botToken: '' }, feishu: { appId: 'app' }, dingtalk: { clientId: 'cid' }, email: { clientId: '' }, signal: { phoneNumber: '' },
    matrix: { accessToken: '' }, irc: { server: '' }, nostr: { privateKey: 'nsec-test' }, web: { enabled: false }, imessage: { enabled: false }, qq: { enabled: false }, whatsapp: { enabled: false },
  } },
}));
vi.mock('./telegram/channel', () => ({ TelegramChannel: mkChannel('telegram') }));
vi.mock('./discord/channel', () => ({ DiscordChannel: mkChannel('discord') }));
vi.mock('./slack/channel', () => ({ SlackChannel: mkChannel('slack') }));
vi.mock('./feishu/channel', () => ({ FeishuChannel: mkChannel('feishu') }));
vi.mock('./dingtalk/channel', () => ({ DingTalkChannel: mkChannel('dingtalk') }));
vi.mock('./email/channel', () => ({ EmailChannel: mkChannel('email') }));
vi.mock('./signal/channel', () => ({ SignalChannel: mkChannel('signal') }));
vi.mock('./matrix/channel', () => ({ MatrixChannel: mkChannel('matrix') }));
vi.mock('./irc/channel', () => ({ IRCChannel: mkChannel('irc') }));
vi.mock('./nostr/channel', () => ({ NostrChannel: mkChannel('nostr') }));
vi.mock('./local-web/channel', () => ({ LocalWebChannel: mkChannel('web') }));

import { bootChannels, INCOMPLETE_CHANNELS } from './registry';

describe('incomplete channel adapters (F15)', () => {
  beforeEach(() => { built.length = 0; delete process.env.ANUCLAW_ALLOW_INCOMPLETE_CHANNELS; });
  afterEach(() => { delete process.env.ANUCLAW_ALLOW_INCOMPLETE_CHANNELS; });

  it('lists exactly the adapters known to be incomplete, each with a stated reason', () => {
    expect(Object.keys(INCOMPLETE_CHANNELS).sort()).toEqual(['dingtalk', 'feishu', 'nostr']);
    for (const reason of Object.values(INCOMPLETE_CHANNELS)) expect(reason.length).toBeGreaterThan(20);
  });
  it('configured credentials are NOT enough: incomplete adapters are not constructed, complete ones are', async () => {
    await bootChannels();
    expect(built).toEqual(['telegram']);
  });
  it('an explicit developer override starts them', async () => {
    process.env.ANUCLAW_ALLOW_INCOMPLETE_CHANNELS = 'true';
    await bootChannels();
    expect(built.sort()).toEqual(['dingtalk', 'feishu', 'nostr', 'telegram']);
  });
  it('any value other than the literal "true" does not enable them', async () => {
    for (const v of ['1', 'yes', 'TRUE', '']) { built.length = 0; process.env.ANUCLAW_ALLOW_INCOMPLETE_CHANNELS = v; await bootChannels(); expect(built).toEqual(['telegram']); }
  });
});
