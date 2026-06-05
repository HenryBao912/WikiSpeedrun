#!/usr/bin/env node
// One-off check that our GA4 Measurement Protocol payload is valid BEFORE
// trusting live data. Hits the debug endpoint (/debug/mp/collect), which never
// records a hit but returns validationMessages describing any problems.
// An empty validationMessages array == the hit is valid.
//
// Usage:
//   GA_MEASUREMENT_ID=G-XXXX GA_API_SECRET=xxxx node scripts/ga4-validate.js
//
// Get the API secret from: GA4 Admin > Data Streams > [stream] >
// Measurement Protocol API secrets.

const GA_MEASUREMENT_ID = process.env.GA_MEASUREMENT_ID || '';
const GA_API_SECRET = process.env.GA_API_SECRET || '';

if (!GA_MEASUREMENT_ID || !GA_API_SECRET) {
  console.error('Missing env. Set GA_MEASUREMENT_ID and GA_API_SECRET, e.g.:');
  console.error('  GA_MEASUREMENT_ID=G-XXXX GA_API_SECRET=xxxx node scripts/ga4-validate.js');
  process.exit(1);
}

if (typeof fetch !== 'function') {
  console.error('global fetch missing — use Node 18+ (this app targets >=20).');
  process.exit(1);
}

// Mirror the exact shape server.js sends: the two easy-to-miss requirements are
// engagement_time_msec (or GA4 won't count the user) and a stable client_id.
const sampleEvents = [
  { name: 'page_view', params: { engagement_time_msec: 100, delivery: 'server' } },
  { name: 'visit', params: { engagement_time_msec: 100, delivery: 'server' } },
  { name: 'game_started', params: { engagement_time_msec: 100, delivery: 'server', mode: 'classic', lang: 'en', session_id: 'debug-session' } },
  { name: 'game_over', params: { engagement_time_msec: 100, delivery: 'server', mode: 'classic', won: true, session_id: 'debug-session' } },
];

const body = JSON.stringify({
  client_id: '1234567890.1234567890', // stable, GA-client-id shape
  events: sampleEvents,
});

const url = `https://www.google-analytics.com/debug/mp/collect?measurement_id=${encodeURIComponent(GA_MEASUREMENT_ID)}&api_secret=${encodeURIComponent(GA_API_SECRET)}`;

(async () => {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const json = await res.json().catch(() => ({}));
    const msgs = json.validationMessages || [];
    console.log(`HTTP ${res.status}`);
    console.log(JSON.stringify(json, null, 2));
    if (msgs.length === 0) {
      console.log('\n✅ Valid — zero validationMessages. Safe to use the live /mp/collect endpoint.');
      process.exit(0);
    } else {
      console.log(`\n❌ ${msgs.length} validation message(s) above — fix before trusting live data.`);
      process.exit(2);
    }
  } catch (e) {
    console.error('Request failed:', e.message);
    process.exit(1);
  }
})();
