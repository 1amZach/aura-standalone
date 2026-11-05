import type { Module } from '../types.js';
import { coreModule, setRegistry } from './core.js';
import { loggingModule } from './logging.js';
import { moderationModule } from './moderation.js';
import { automodModule } from './automod.js';
import { securityModule } from './security.js';
import { verificationModule } from './verification.js';
import { welcomeModule } from './welcome.js';
import { rolesModule } from './roles.js';
import { ticketsModule } from './tickets.js';
import { levelsModule } from './levels.js';
import { giveawaysModule } from './giveaways.js';
import { pollsModule } from './polls.js';
import { suggestionsModule } from './suggestions.js';

export const modules: Module[] = [
  coreModule,
  loggingModule,
  moderationModule,
  automodModule,
  securityModule,
  verificationModule,
  welcomeModule,
  rolesModule,
  ticketsModule,
  levelsModule,
  giveawaysModule,
  pollsModule,
  suggestionsModule,
];

setRegistry(modules);
