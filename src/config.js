import 'dotenv/config';

function required(name) {
  const val = process.env[name];
  if (!val) {
    console.error(`[config] Missing required env var: ${name}. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  return val;
}

let discordIdMap = {};
try {
  discordIdMap = JSON.parse(process.env.DISCORD_ID_MAP || '{}');
} catch (e) {
  console.warn('[config] DISCORD_ID_MAP is not valid JSON, ignoring it.');
}

export const config = {
  apiKey: required('TORN_API_KEY'),
  ownFactionId: required('OWN_FACTION_ID'),
  enemyFactionId: process.env.ENEMY_FACTION_ID || null,
  webhookEnemy: required('DISCORD_WEBHOOK_ENEMY'),
  webhookAlly: required('DISCORD_WEBHOOK_ALLY'),
  enemyRoleId: process.env.DISCORD_ENEMY_ROLE_ID || null,
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 10000),
  warnWindowSeconds: Number(process.env.WARN_WINDOW_SECONDS || 60),
  discordIdMap,
};
