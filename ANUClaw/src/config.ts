import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

dotenv.config();

export type ModelProvider =
  | 'anthropic'
  | 'openrouter'
  | 'openai-compatible'
  | 'openai-codex'
  | 'ollama';

export type MemoryMode = 'dual' | 'file-only' | 'sqlite-only';
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface LLMConfig {
  provider: ModelProvider;
  anthropicApiKey?: string;
  openrouterApiKey?: string;
  openrouterBaseUrl?: string;
  openrouterModel?: string;
  openrouterReasoningEffort: ReasoningEffort;
  openaiCompatibleApiKey?: string;
  openaiCompatibleBaseUrl?: string;
  openaiCompatibleModel?: string;
  openaiCodexModel?: string;
  ollamaBaseUrl?: string;
  ollamaModel?: string;
}

export interface ChannelConfig {
  telegram: { enabled: boolean; token: string; trigger: string };
  discord: { enabled: boolean; token: string; clientId: string; guildId: string };
  slack: { enabled: boolean; botToken: string; appToken: string; signingSecret: string };
  feishu: { enabled: boolean; appId: string; appSecret: string; verificationToken: string };
  dingtalk: { enabled: boolean; clientId: string; clientSecret: string };
  email: { enabled: boolean; clientId: string; clientSecret: string; refreshToken: string; address: string };
  signal: { enabled: boolean; cliPath: string; phoneNumber: string };
  matrix: { enabled: boolean; homeserverUrl: string; userId: string; accessToken: string; roomId: string };
  imessage: { enabled: boolean; handle: string };
  irc: { enabled: boolean; server: string; port: number; nick: string; channel: string };
  nostr: { enabled: boolean; privateKey: string; relay: string };
  qq: { enabled: boolean; websocketUrl: string; accessToken: string };
  whatsapp: { enabled: boolean; sessionDir: string };
  web: { enabled: boolean; host: string; port: number; password: string };
}

export interface AgentConfig {
  triggerPattern: string;
  maxSessionMessages: number;
  containerTimeoutMs: number;
  containerImage: string;
  workspaceDir: string;
  groupsDir: string;
}

export interface Config {
  llm: LLMConfig;
  channels: ChannelConfig;
  agent: AgentConfig;
  hooksEnabled: boolean;
  memoryMode: MemoryMode;
  memoryCompactionThreshold: number;
  soulPath: string;
  whisper: { enabled: boolean; backend: 'openai-api' | 'local-whisper'; apiKey: string; modelPath: string };
  dbPath: string;
  pg: {
    host: string;
    port: number;
    user: string;
    pass: string;
    dbName: string;
  };
  logLevel: string;
  logFile: string;
}

function bool(val: string | undefined, def = false): boolean {
  if (val === undefined) return def;
  return val.toLowerCase() === 'true' || val === '1';
}

function str(val: string | undefined, def = ''): string {
  return val ?? def;
}

function num(val: string | undefined, def: number): number {
  const n = parseInt(val ?? '', 10);
  return isNaN(n) ? def : n;
}

interface OpenRouterFileConfig {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

/** Load the operator-supplied local settings without logging the API key. */
function loadOpenRouterFile(): OpenRouterFileConfig {
  const filePath = path.resolve(str(process.env.OPENROUTER_CONFIG_FILE, './openrouter.md'));
  if (!fs.existsSync(filePath)) return {};

  const parsed: OpenRouterFileConfig = {};
  for (const sourceLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = sourceLine.trim().replace(/,$/, '');
    if (line.toLowerCase().startsWith('model-')) {
      parsed.model = line.slice('model-'.length).trim();
      continue;
    }
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/);
    if (!match) continue;

    const key = match[1].toLowerCase();
    const value = match[2].trim().replace(/^['"]|['"]$/g, '');
    if (['api', 'key', 'api_key', 'openrouter_api_key'].includes(key)) parsed.apiKey = value;
    if (['model', 'openrouter_model'].includes(key)) parsed.model = value;
    if (['base_url', 'openrouter_base_url'].includes(key)) parsed.baseUrl = value;
  }
  return parsed;
}

function reasoningEffort(val: string | undefined, def: ReasoningEffort): ReasoningEffort {
  const supported: ReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];
  return supported.includes(val as ReasoningEffort) ? (val as ReasoningEffort) : def;
}

const openRouterFile = loadOpenRouterFile();

export const config: Config = {
  llm: {
    provider: (str(process.env.MODEL_PROVIDER, openRouterFile.apiKey ? 'openrouter' : 'anthropic')) as ModelProvider,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    openrouterApiKey: process.env.OPENROUTER_API_KEY ?? openRouterFile.apiKey,
    openrouterBaseUrl: str(process.env.OPENROUTER_BASE_URL ?? openRouterFile.baseUrl, 'https://openrouter.ai/api/v1'),
    openrouterModel: str(process.env.OPENROUTER_MODEL ?? openRouterFile.model, 'anthropic/claude-sonnet-4-6'),
    openrouterReasoningEffort: reasoningEffort(process.env.OPENROUTER_REASONING_EFFORT, 'medium'),
    openaiCompatibleApiKey: process.env.OPENAI_COMPATIBLE_API_KEY,
    openaiCompatibleBaseUrl: process.env.OPENAI_COMPATIBLE_BASE_URL,
    openaiCompatibleModel: process.env.OPENAI_COMPATIBLE_MODEL,
    openaiCodexModel: str(process.env.OPENAI_CODEX_MODEL, 'gpt-4o'),
    ollamaBaseUrl: str(process.env.OLLAMA_BASE_URL, 'http://localhost:11434'),
    ollamaModel: str(process.env.OLLAMA_MODEL, 'llama3'),
  },

  channels: {
    telegram: {
      enabled: bool(process.env.TELEGRAM_BOT_TOKEN ? 'true' : 'false'),
      token: str(process.env.TELEGRAM_BOT_TOKEN),
      trigger: str(process.env.TELEGRAM_TRIGGER, '@ANUClaw'),
    },
    discord: {
      enabled: bool(process.env.DISCORD_BOT_TOKEN ? 'true' : 'false'),
      token: str(process.env.DISCORD_BOT_TOKEN),
      clientId: str(process.env.DISCORD_CLIENT_ID),
      guildId: str(process.env.DISCORD_GUILD_ID),
    },
    slack: {
      enabled: bool(process.env.SLACK_BOT_TOKEN ? 'true' : 'false'),
      botToken: str(process.env.SLACK_BOT_TOKEN),
      appToken: str(process.env.SLACK_APP_TOKEN),
      signingSecret: str(process.env.SLACK_SIGNING_SECRET),
    },
    feishu: {
      enabled: bool(process.env.FEISHU_APP_ID ? 'true' : 'false'),
      appId: str(process.env.FEISHU_APP_ID),
      appSecret: str(process.env.FEISHU_APP_SECRET),
      verificationToken: str(process.env.FEISHU_VERIFICATION_TOKEN),
    },
    dingtalk: {
      enabled: bool(process.env.DINGTALK_CLIENT_ID ? 'true' : 'false'),
      clientId: str(process.env.DINGTALK_CLIENT_ID),
      clientSecret: str(process.env.DINGTALK_CLIENT_SECRET),
    },
    email: {
      enabled: bool(process.env.GMAIL_CLIENT_ID ? 'true' : 'false'),
      clientId: str(process.env.GMAIL_CLIENT_ID),
      clientSecret: str(process.env.GMAIL_CLIENT_SECRET),
      refreshToken: str(process.env.GMAIL_REFRESH_TOKEN),
      address: str(process.env.GMAIL_ADDRESS),
    },
    signal: {
      enabled: bool(process.env.SIGNAL_PHONE_NUMBER ? 'true' : 'false'),
      cliPath: str(process.env.SIGNAL_CLI_PATH, '/usr/local/bin/signal-cli'),
      phoneNumber: str(process.env.SIGNAL_PHONE_NUMBER),
    },
    matrix: {
      enabled: bool(process.env.MATRIX_ACCESS_TOKEN ? 'true' : 'false'),
      homeserverUrl: str(process.env.MATRIX_HOMESERVER_URL, 'https://matrix.org'),
      userId: str(process.env.MATRIX_USER_ID),
      accessToken: str(process.env.MATRIX_ACCESS_TOKEN),
      roomId: str(process.env.MATRIX_ROOM_ID),
    },
    imessage: {
      enabled: bool(process.env.IMESSAGE_ENABLED, false),
      handle: str(process.env.IMESSAGE_HANDLE),
    },
    irc: {
      enabled: bool(process.env.IRC_SERVER ? 'true' : 'false'),
      server: str(process.env.IRC_SERVER, 'irc.libera.chat'),
      port: num(process.env.IRC_PORT, 6697),
      nick: str(process.env.IRC_NICK, 'ANUClaw'),
      channel: str(process.env.IRC_CHANNEL, '#anuclaw'),
    },
    nostr: {
      enabled: bool(process.env.NOSTR_PRIVATE_KEY ? 'true' : 'false'),
      privateKey: str(process.env.NOSTR_PRIVATE_KEY),
      relay: str(process.env.NOSTR_RELAY, 'wss://relay.damus.io'),
    },
    qq: {
      enabled: bool(process.env.QQ_WEBSOCKET_URL ? 'true' : 'false'),
      websocketUrl: str(process.env.QQ_WEBSOCKET_URL, 'ws://localhost:3001'),
      accessToken: str(process.env.QQ_ACCESS_TOKEN),
    },
    whatsapp: {
      enabled: bool(process.env.WHATSAPP_ENABLED, true),
      sessionDir: str(process.env.WHATSAPP_SESSION_DIR, '.whatsapp-auth'),
    },
    web: {
      enabled: bool(process.env.WEB_ENABLED, true),
      host: str(process.env.WEB_HOST, '127.0.0.1'),
      port: num(process.env.WEB_PORT, 3721),
      password: str(process.env.WEB_PASSWORD),
    },
  },

  agent: {
    triggerPattern: str(process.env.TRIGGER_PATTERN, '@ANUClaw'),
    maxSessionMessages: num(process.env.MAX_SESSION_MESSAGES, 80),
    containerTimeoutMs: num(process.env.CONTAINER_TIMEOUT_MS, 300000),
    containerImage: str(process.env.CONTAINER_IMAGE, 'anuclaw-agent:latest'),
    workspaceDir: path.resolve(str(process.env.WORKSPACE_DIR, './workspace')),
    groupsDir: path.resolve(str(process.env.GROUPS_DIR, './groups')),
  },

  hooksEnabled: bool(process.env.HOOKS_ENABLED, true),
  memoryMode: (str(process.env.MEMORY_MODE, 'dual')) as MemoryMode,
  memoryCompactionThreshold: num(process.env.MEMORY_COMPACTION_THRESHOLD, 80),
  soulPath: path.resolve(str(process.env.SOUL_PATH, './SOUL.md')),

  whisper: {
    enabled: bool(process.env.WHISPER_ENABLED, false),
    backend: (str(process.env.WHISPER_BACKEND, 'openai-api')) as 'openai-api' | 'local-whisper',
    apiKey: str(process.env.WHISPER_API_KEY),
    modelPath: str(process.env.WHISPER_MODEL_PATH, './models/ggml-base.bin'),
  },

  dbPath: path.resolve(str(process.env.DB_PATH, './anuclaw.db')),
  pg: {
    host: str(process.env.PG_HOST, 'localhost'),
    port: num(process.env.PG_PORT, 5432),
    user: str(process.env.PG_USER, 'postgres'),
    pass: str(process.env.PG_PASSWORD, 'postgres'),
    dbName: str(process.env.PG_DATABASE, 'anuclaw'),
  },
  logLevel: str(process.env.LOG_LEVEL, 'info'),
  logFile: str(process.env.LOG_FILE, './logs/anuclaw.log'),
};
