# WikiSpeedrun

Race from one Wikipedia article to another using only the in-article links. Play solo or with friends in a shared room — no signup, no downloads, no ads.

**Live**: [wikispeedrun.io](https://wikispeedrun.io)

## Modes

- **Classic**: first to click from article A to article B wins.
- **Tri**: visit three target articles in any order.

Both modes support English and Simplified Chinese Wikipedia.

## Run locally

```bash
npm install
npm start
# open http://localhost:3000
```

Requires Node 18+. No external services; Wikipedia is called directly.

## How it works

- **Server**: plain Node `http` module. No framework, no dependencies. Real-time updates via Server-Sent Events.
- **Client**: single HTML file. Fetches Wikipedia HTML via `action=parse` and strips navboxes/references/editsections before rendering.
- **Puzzle pool**: pre-generated from Wikipedia's pageview API. Start/target articles are well-known enough to be solvable but not trivially one-hop connected.
- **Distance cache**: at game start, the server pre-computes the 1/2/3-hop neighborhood of the destination so the "distance to target" badge updates without a round-trip per click.

## Pool generation

The puzzle pool lives in `data/puzzlePool.{en,zh}.json`. To regenerate:

```bash
npm run generate-pool         # full pass
npm run generate-pool:fast    # fewer articles, for local testing
```

## License

[MIT](LICENSE)
