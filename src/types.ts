import type {
  AnySelectMenuInteraction,
  AutocompleteInteraction,
  ButtonInteraction,
  ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
  Guild,
  ModalSubmitInteraction,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';
import type { BotConfig } from './config.js';
import type { DB } from './db.js';

export type LogKind = 'mod' | 'messages' | 'members' | 'security' | 'server';

export interface Ctx {
  client: Client<true>;
  db: DB;
  config: BotConfig;
  log(guild: Guild, kind: LogKind, entry: EmbedBuilder): Promise<void>;
  enabled(guildId: string, moduleId: string): boolean;
}

export type ComponentInteraction = ButtonInteraction | AnySelectMenuInteraction | ModalSubmitInteraction;

export interface Module {
  id: string;
  name: string;
  description: string;
  defaultOn: boolean;
  required?: boolean;
  schema?: string;
  commands?: RESTPostAPIChatInputApplicationCommandsJSONBody[];
  handle?: Record<string, (i: ChatInputCommandInteraction<'cached'>, ctx: Ctx) => Promise<unknown>>;
  autocomplete?: Record<string, (i: AutocompleteInteraction<'cached'>, ctx: Ctx) => Promise<unknown>>;
  // keyed by the first part of the custom id, e.g. "gw" for "gw:enter:12"
  components?: Record<string, (i: ComponentInteraction, args: string[], ctx: Ctx) => Promise<unknown>>;
  init?(ctx: Ctx): void;
  tick?(ctx: Ctx): Promise<void>;
}
