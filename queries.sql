-- WikiSpeedrun — real-user analytics queries against the `events` table.
-- The table is the unblockable source of truth (first-party, ad-blocker-proof):
--   * 'page_view'  — every page load, incl. bouncers who never start a game
--   * 'visit'      — every game session (fired when the realtime SSE stream opens)
--   * 'game_started' / 'game_over' / 'navigate' / 'navigate_rejected' — engagement
-- So DAU over ALL events ≈ true daily users; restrict to event='page_view' for a
-- pure page-load headcount, or event in ('visit','game_started') for engaged users.
-- visitor_id = one browser over time; player_id = one game session. "day"
-- buckets are UTC — wrap ts in `(ts AT TIME ZONE 'America/Los_Angeles')` for local.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Daily Active Users — distinct visitors per day.
-- ─────────────────────────────────────────────────────────────────────────
select
  date_trunc('day', ts) as day,
  count(distinct visitor_id) as dau
from events
group by 1
order by 1;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. New vs returning visitors per day.
--    returning = this visitor was first seen on an EARLIER day.
-- ─────────────────────────────────────────────────────────────────────────
with first_seen as (
  select visitor_id, min(date_trunc('day', ts)) as first_day
  from events
  group by visitor_id
),
active_days as (                       -- one row per (visitor, day) they were active
  select distinct visitor_id, date_trunc('day', ts) as day
  from events
)
select
  a.day,
  count(*) filter (where a.day = f.first_day) as new_visitors,
  count(*) filter (where a.day > f.first_day) as returning_visitors,
  count(*)                                     as total_active
from active_days a
join first_seen f using (visitor_id)
group by a.day
order by a.day;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. Day-1 retention — of each day's NEW visitors, how many returned the
--    very next day. retained_d1 / new_visitors = D1 retention rate.
-- ─────────────────────────────────────────────────────────────────────────
with first_seen as (
  select visitor_id, min(date_trunc('day', ts)) as cohort_day
  from events
  group by visitor_id
),
active_days as (
  select distinct visitor_id, date_trunc('day', ts) as day
  from events
)
select
  f.cohort_day,
  count(distinct f.visitor_id)                               as new_visitors,
  count(distinct a.visitor_id)                               as retained_d1,
  round(
    100.0 * count(distinct a.visitor_id)
          / nullif(count(distinct f.visitor_id), 0),
    1
  ) as d1_retention_pct
from first_seen f
left join active_days a
  on a.visitor_id = f.visitor_id
 and a.day = f.cohort_day + interval '1 day'
group by f.cohort_day
order by f.cohort_day;

-- ─────────────────────────────────────────────────────────────────────────
-- Bonus: the GA4 undercount, quantified. Compare distinct human visitors to
-- distinct sessions, and see games-per-visitor — useful to size how badly the
-- client-only GA tag was undercounting.
-- ─────────────────────────────────────────────────────────────────────────
select
  date_trunc('day', ts) as day,
  count(distinct visitor_id)                                        as visitors,
  count(distinct player_id)                                         as sessions,
  count(*) filter (where event = 'game_started')                   as games_started,
  count(*) filter (where event = 'game_over')                      as games_finished
from events
group by 1
order by 1;

-- ─────────────────────────────────────────────────────────────────────────
-- 4. Acquisition → engagement funnel, distinct visitors per stage per day.
--    Where do people drop off: landed, started a session, played, finished?
-- ─────────────────────────────────────────────────────────────────────────
select
  date_trunc('day', ts) as day,
  count(distinct visitor_id) filter (where event = 'page_view')    as landed,
  count(distinct visitor_id) filter (where event = 'visit')        as opened_session,
  count(distinct visitor_id) filter (where event = 'game_started') as started_game,
  count(distinct visitor_id) filter (where event = 'game_over')    as finished_game
from events
group by 1
order by 1;

-- ─────────────────────────────────────────────────────────────────────────
-- 5. Stickiness (DAU / MAU) — the classic "is the product habit-forming?"
--    ratio, computed over a trailing 30-day window per day. ~0.2+ is healthy.
-- ─────────────────────────────────────────────────────────────────────────
with days as (
  select distinct date_trunc('day', ts)::date as day from events
)
select
  d.day,
  (select count(distinct visitor_id) from events
     where date_trunc('day', ts)::date = d.day)                              as dau,
  (select count(distinct visitor_id) from events
     where ts >= d.day - interval '29 days' and ts < d.day + interval '1 day') as mau_30d,
  round(
    (select count(distinct visitor_id)::numeric from events
       where date_trunc('day', ts)::date = d.day)
    / nullif((select count(distinct visitor_id) from events
       where ts >= d.day - interval '29 days' and ts < d.day + interval '1 day'), 0),
    3
  ) as stickiness
from days d
order by d.day;

-- ─────────────────────────────────────────────────────────────────────────
-- GA4 side (no SQL — do this in the GA4 UI):
--   * Canonical event count = filter to delivery = 'server'. Those server-side
--     hits fire for EVERY user (blocked or not); delivery = 'client' fires only
--     for non-blocked users, so treat it purely as the engagement signal.
--     Build a comparison/segment on the `delivery` event-scoped custom dimension.
--   * Bots are already filtered server-side (see isBotUA in server.js), so these
--     events and the server-side GA4 hits are human-only. GA4's own client tag
--     still needs GA4 Admin > Data Settings > "Exclude known bots" enabled.
-- ─────────────────────────────────────────────────────────────────────────
