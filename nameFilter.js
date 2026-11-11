'use strict';
// Player-name cleaning and a light profanity filter.
//
// Names show up in lobbies, on every player's race bar, in the results and on
// the public daily leaderboard, so the server cleans each one on the way in.
// A name that trips the filter is replaced by the caller's fallback ("Player",
// "Anonymous") rather than rejected, so nobody is blocked from playing.
//
// Two lists, to avoid the "Scunthorpe problem" (blocking innocent names):
//   SEVERE  - blocked anywhere inside the name, after de-obfuscation. Only
//             words that have no innocent use as part of a longer word.
//   WORDS   - blocked only as a whole word ("Dick Tracy" stays fine, and so
//             does "Cassidy" or "Scunthorpe").
// De-obfuscation: lower-case, strip accents, map look-alike digits/symbols
// (n1gg3r, $h1t, @ss), and collapse separators and repeated letters
// (f.u.c.k, fuuuck).

const SEVERE = ['nigger', 'nigga', 'faggot', 'fuck', 'hitler'];
const WORDS = new Set([
  'shit', 'bitch', 'whore', 'slut', 'fag', 'tranny', 'kike', 'chink', 'spic',
  'retard', 'retarded', 'nazi', 'rapist', 'rape', 'pussy', 'cock', 'penis',
  'vagina', 'dildo', 'asshole', 'porn', 'cum', 'jizz', 'twat', 'wank', 'wanker',
  'cunt', 'dyke', 'coon', 'gook', 'paki', 'negro', 'bastard',
]);

// "nigger" -> /ni g{2,} e r/ : each run of a letter may be longer, not shorter.
const SEVERE_RES = SEVERE.map(w => new RegExp(w.replace(/(.)\1*/g, (run, c) => `${c}{${run.length},}`)));

const LOOKALIKE = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '@': 'a', '$': 's', '!': 'i', '|': 'i', '+': 't' };

function deobfuscate(s) {
  return s
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[0134578@$!|+]/g, c => LOOKALIKE[c]);
}
// Letters only, each run of a repeated letter squeezed to one ("fuuuck" -> "fuck").
function squeeze(s) {
  return s.replace(/[^a-z]/g, '').replace(/(.)\1+/g, '$1');
}

function isOffensiveName(name) {
  const d = deobfuscate(String(name));
  // Whole words, as typed (split on anything that isn't a letter or digit).
  for (const tok of d.split(/[^a-z]+/)) {
    if (!tok) continue;
    if (WORDS.has(tok) || WORDS.has(squeeze(tok))) return true;
  }
  // Letters spaced out or punctuated ("f u c k", "s.h.i.t"): the whole name,
  // squeezed, is a listed word.
  const all = squeeze(d);
  if (WORDS.has(all)) return true;
  // Severe words anywhere in the letters, with any letter allowed to repeat
  // ("fuuuck", "niggga") but never fewer times than the word has it: squeezing
  // would turn "nigger" into "niger", which is a country.
  const raw = d.replace(/[^a-z]/g, '');
  return SEVERE_RES.some(re => re.test(raw));
}

// Trim, drop control / zero-width / bidirectional-override characters (they can
// hide text or flip the name's direction), collapse whitespace, cut to maxLen,
// and swap in `fallback` when nothing is left or the filter trips.
function cleanPlayerName(raw, fallback = 'Player', maxLen = 20) {
  let name = String(raw == null ? '' : raw)
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤⁦-⁩﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen)
    .trim();
  if (!name || isOffensiveName(name)) return fallback;
  return name;
}

module.exports = { cleanPlayerName, isOffensiveName };
