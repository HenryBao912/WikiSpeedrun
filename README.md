# WikiSpeedrun

Race from one Wikipedia article to another using only the in-article links. Play solo or with friends in a shared room — no signup, no downloads, no ads.

**Live**: [wikispeedrun.io](https://wikispeedrun.io)

![WikiSpeedrun demo](docs_hero.gif)

## Modes

- **Classic**: first to click from article A to article B wins.
- **Tri**: visit three target articles in any order.
- **Marathon** *(new in v1.0.0)*: time-boxed chains — 3 / 5 / 8 / 12 minute runs. One target at a time; reach it and a new one appears. Score by efficiency (fewer clicks = more points) with completion bonuses at 5 / 10 / 15 targets.

All modes support English and Simplified Chinese Wikipedia.

## Run locally

```bash
npm install
npm start
# open http://localhost:3000
```

Requires Node 20+. No external services; Wikipedia is called directly.

## How it works

- **Server**: plain Node `http` module. No framework, no dependencies. Real-time updates via Server-Sent Events.
- **Client**: single HTML file. Fetches Wikipedia HTML via `action=parse` and strips navboxes/references/editsections before rendering.
- **Puzzle pool**: pre-generated from Wikipedia's pageview API. Start/target articles are well-known enough to be solvable but not trivially one-hop connected.
- **Distance cache**: at game start, the server pre-computes the 1/2/3-hop neighborhood of the destination so the "distance to target" badge updates without a round-trip per click.

## Configuration

Environment variables (all optional):

- `PORT` — HTTP port (default `3000`).
- `ENFORCE_MOVE_LEGALITY` — server-side anti-cheat. Each navigation is only
  accepted if the target is a real outgoing link of the player's current page
  (fails *open* on any Wikipedia error so a real click is never wrongly
  blocked). Enabled by default. Set to `false` for **shadow mode**: would-be
  rejections are logged (`navigate_rejected` with `enforced:false`) but not
  blocked — useful for monitoring on live traffic before/while enforcing.

## Pool generation

The puzzle pool lives in `data/puzzlePool.{en,zh}.json`. To regenerate:

```bash
npm run generate-pool         # full pass
npm run generate-pool:fast    # fewer articles, for local testing
```

## Support

If the game is fun, tips keep it running (hosting + the occasional Wikipedia API cap): [ko-fi.com/wikispeedrunio](https://ko-fi.com/wikispeedrunio).

## License

[MIT](LICENSE)
