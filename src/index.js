import { config } from './config.js';
import { getActiveRankedWar } from './tornApi.js';
import { pollOnce } from './tracker.js';

let enemyFactionId = config.enemyFactionId;
let running = true;
let consecutiveErrors = 0;

async function resolveEnemyFaction() {
  if (config.enemyFactionId) return; // manually pinned, don't override

  try {
    const war = await getActiveRankedWar(config.ownFactionId);
    if (war) {
      if (war.enemyFactionId !== enemyFactionId) {
        console.log(`[war] Active war detected vs ${war.enemyFactionName} [${war.enemyFactionId}]`);
      }
      enemyFactionId = war.enemyFactionId;
    } else {
      if (enemyFactionId) console.log('[war] No active ranked war — enemy tracking paused.');
      enemyFactionId = null;
    }
  } catch (e) {
    console.error('[war] failed to check war status:', e.message);
  }
}

async function loop() {
  while (running) {
    try {
      await resolveEnemyFaction();
      await pollOnce({ ownFactionId: config.ownFactionId, enemyFactionId });
      consecutiveErrors = 0;
    } catch (e) {
      consecutiveErrors++;
      console.error('[loop] unexpected error:', e.message);
    }

    // Back off if Torn is rate-limiting/erroring us repeatedly, instead of
    // hammering the API into a longer ban window.
    const backoff = Math.min(consecutiveErrors * 5000, 60000);
    await sleep(config.pollIntervalMs + backoff);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

process.on('SIGINT', () => {
  console.log('\n[shutdown] stopping cleanly...');
  running = false;
  process.exit(0);
});

console.log(`[start] Torn War Call — own faction ${config.ownFactionId}, warn window ${config.warnWindowSeconds}s, poll every ${config.pollIntervalMs}ms`);
loop();
