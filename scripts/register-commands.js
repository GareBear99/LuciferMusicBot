// Register Lucifer's slash commands with Discord.
//
// DO NOT RUN this until the Discord application exists (Gary creates it in
// the Developer Portal) and the credentials are set. It needs:
//   DISCORD_TOKEN         bot token (wrangler secret / env, never in the repo)
//   DISCORD_APPLICATION_ID  application id
//
// Usage:
//   DISCORD_TOKEN=... DISCORD_APPLICATION_ID=... node scripts/register-commands.js
//   DISCORD_TOKEN=... DISCORD_APPLICATION_ID=... node scripts/register-commands.js --global
//   DISCORD_TOKEN=... DISCORD_APPLICATION_ID=... node scripts/register-commands.js --guild <guildId>
//
// --global registers for every server the bot is in (propagates in up to
// 1 hour). --guild registers instantly in one server — use that for testing.
// With no flag, this script registers to the guild in DISCORD_GUILD_ID if
// set, otherwise prints the commands and exits WITHOUT registering (dry run).
//
// This script is code only. It has never been run against Discord: there is
// no application, no token, and no server yet.

import { COMMANDS } from '../src/commands.js';

const DISCORD_API = 'https://discord.com/api/v10';

const token = process.env.DISCORD_TOKEN;
const applicationId = process.env.DISCORD_APPLICATION_ID;
const guildFlag = process.argv.indexOf('--guild');
const guildId = guildFlag >= 0 ? process.argv[guildFlag + 1] : process.env.DISCORD_GUILD_ID;
const globalFlag = process.argv.includes('--global');

if (!token || !applicationId) {
  console.log('Lucifer slash commands (dry run — no token/application id set, nothing registered):');
  for (const cmd of COMMANDS) {
    console.log(`  /${cmd.name} — ${cmd.description}`);
  }
  console.log('\nTo register, set DISCORD_TOKEN and DISCORD_APPLICATION_ID, then run:');
  console.log('  node scripts/register-commands.js --guild <guildId>   # instant, one server');
  console.log('  node scripts/register-commands.js --global            # all servers, up to 1h to propagate');
  process.exit(0);
}

if (!guildId && !globalFlag) {
  console.log('No target: pass --guild <guildId> (instant) or --global (all servers).');
  console.log('Dry run — commands that would be registered:');
  for (const cmd of COMMANDS) console.log(`  /${cmd.name} — ${cmd.description}`);
  process.exit(0);
}

const url = guildId
  ? `${DISCORD_API}/applications/${applicationId}/guilds/${guildId}/commands`
  : `${DISCORD_API}/applications/${applicationId}/commands`;

const res = await fetch(url, {
  method: 'PUT',
  headers: {
    Authorization: `Bot ${token}`,
    'Content-Type': 'application/json',
    'User-Agent': 'DiscordBot (LuciferMusicBot, 0.1.0)',
  },
  body: JSON.stringify(COMMANDS),
});

const json = await res.json().catch(() => null);
if (!res.ok) {
  console.error(`Registration failed (${res.status}):`, JSON.stringify(json));
  process.exit(1);
}
console.log(
  `Registered ${Array.isArray(json) ? json.length : 0} commands ${guildId ? `in guild ${guildId}` : 'globally'}.`,
);
for (const cmd of json || []) console.log(`  /${cmd.name} (${cmd.id})`);
