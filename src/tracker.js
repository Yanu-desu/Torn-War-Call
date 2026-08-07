import { config } from './config.js';
import { getFactionMembers } from './tornApi.js';
import { sendDiscordAlert, buildEnemyEmbed, buildAllyEmbed } from './discord.js';

// Tracks which `until` timestamp we already alerted for, per user.
// Prevents spamming the same hospital stay every poll cycle.
// Map<userId, until>
const notifiedEnemy = new Map();
const notifiedAlly = new Map();

/**
 * Checks one faction's roster and fires alerts for anyone entering the
 * "about to leave hospital" window who hasn't already been notified
 * for this specific hospital stay.
 */
async function checkFaction({ factionId, side }) {
  const members = await getFactionMembers(factionId);
  const now = Math.floor(Date.now() / 1000);
  const notified = side === 'enemy' ? notifiedEnemy : notifiedAlly;

  for (const member of members) {
    const inHospital = member.state === 'Hospital' && member.until > now;

    if (!inHospital) {
      // Left hospital (or was never in it) — clear so the next stay re-arms.
      notified.delete(member.id);
      continue;
    }

    const secondsLeft = member.until - now;
    const alreadyNotifiedThisStay = notified.get(member.id) === member.until;

    if (secondsLeft <= config.warnWindowSeconds && !alreadyNotifiedThisStay) {
      notified.set(member.id, member.until);
      await fireAlert(side, member, secondsLeft);
    }
  }
}

async function fireAlert(side, member, secondsLeft) {
  if (side === 'enemy') {
    const mention = config.enemyRoleId ? `<@&${config.enemyRoleId}>` : '';
    await sendDiscordAlert(config.webhookEnemy, {
      content: `${mention} Target incoming: **${member.name}**`,
      embed: buildEnemyEmbed(member, secondsLeft),
    });
    console.log(`[alert] ENEMY ${member.name} [${member.id}] -> ${secondsLeft}s`);
  } else {
    const discordId = config.discordIdMap[String(member.id)];
    const mention = discordId ? `<@${discordId}>` : `**${member.name}**`;
    await sendDiscordAlert(config.webhookAlly, {
      content: `${mention} you're almost out — heads up.`,
      embed: buildAllyEmbed(member, secondsLeft),
    });
    console.log(`[alert] ALLY ${member.name} [${member.id}] -> ${secondsLeft}s`);
  }
}

export async function pollOnce({ ownFactionId, enemyFactionId }) {
  const results = await Promise.allSettled([
    checkFaction({ factionId: ownFactionId, side: 'ally' }),
    enemyFactionId
      ? checkFaction({ factionId: enemyFactionId, side: 'enemy' })
      : Promise.resolve(),
  ]);

  for (const r of results) {
    if (r.status === 'rejected') {
      console.error('[tracker] poll error:', r.reason?.message || r.reason);
    }
  }
}
