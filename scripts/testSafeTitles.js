#!/usr/bin/env node
// Safe mode title filter tests - run: node scripts/testSafeTitles.js
const { isExplicitTitle, DENY_RE } = require('../safeTitles');
let pass = 0, fail = 0;
const ok = (label, cond) => { console.log((cond ? '  ✅ ' : '  ❌ ') + label); cond ? pass++ : fail++; };

// Allowed in Safe mode: ordinary articles, words that only contain a listed one,
// and real crime/history titles the pool generator drops but a classroom can play.
for (const t of ['Pizza', 'Moon', 'Essex', 'Middlesex', 'Sussex', 'Wessex', 'Sextant', 'Sexton', 'Analysis', 'Pennsylvania',
  'Scunthorpe', 'Cassidy', 'Napoleon', 'Rapeseed', 'Grape', 'Therapist', 'Nuclear_weapon', 'World_War_II', 'Attack_on_Titan',
  'September_11_attacks', 'Pearl_Harbor', 'Murder_on_the_Orient_Express', 'Cannibal_Corpse'.replace('_Corpse', ' Island'),
  'Anne_Frank', 'Holocaust', 'Slavery', 'Hiroshima', 'Human_body', 'Reproduction', 'Puberty', 'Biology'])
  ok(`allowed: ${t}`, !isExplicitTitle(t));

// Blocked: matched as whole words, underscores or spaces, any case.
for (const t of ['Sexual_intercourse', 'Human_sexuality', 'Pornography', 'Pornhub', 'OnlyFans', 'Hentai', 'Nude', 'Fetish', 'BDSM',
  'Suicide', 'Suicide_methods', 'Self-harm', 'Rape', 'Prostitution', 'Strip_club', 'Sex_toy', 'Sex_Pistols', 'Torture', 'Incest', 'sexual intercourse', 'PORN'])
  ok(`blocked: ${t}`, isExplicitTitle(t));

// The generator's own list is the explicit list plus the crime titles.
ok('generator denylist still blocks crime titles', DENY_RE.test('Murder of Someone') && DENY_RE.test('Dnepropetrovsk maniacs') && DENY_RE.test('September 11 attacks'));
ok('…and everything Safe mode blocks', ['Pornography', 'Suicide', 'Rape'].every(t => DENY_RE.test(t)));
ok('non-strings are safe', !isExplicitTitle(null) && !isExplicitTitle(undefined) && !isExplicitTitle(''));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
