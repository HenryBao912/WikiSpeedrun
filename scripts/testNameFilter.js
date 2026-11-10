#!/usr/bin/env node
// Name filter tests - run: node scripts/testNameFilter.js
const { cleanPlayerName, isOffensiveName } = require('../nameFilter');
let pass = 0, fail = 0;
const ok = (label, cond) => { console.log((cond ? '  ✅ ' : '  ❌ ') + label); cond ? pass++ : fail++; };

// Names that must pass untouched (the Scunthorpe problem, real names, normal handles).
const clean = ['Henry', 'Ava', 'Scunthorpe', 'Cassidy', 'Dick Tracy', 'Niger', 'Nigeria', 'Nigam', 'Shiitake', 'Assassin',
  'Sussex', 'Hancock', 'Peacock', 'Cocktail', 'Analyst', 'Therapist', 'Mishit', 'Grape', 'Drape', 'Cumberland', 'Document',
  'Penistone', 'xX_Speedrunner_Xx', 'Wiki Wizard', 'José', 'Zoë', '李雷', 'Мария', 'Pat-Pat', 'Class of 2027', 'Mr. Rapp',
  'Spicy', 'Kiker', 'Chin', 'Coonrad', 'Bastion', 'Dyker', 'Cocker'];
for (const n of clean) ok(`allowed: ${n}`, !isOffensiveName(n) && cleanPlayerName(n, 'FB') === n);

// Names that must be caught, including obfuscated ones.
const bad = ['fuck', 'FUCK', 'fuuuuck', 'f.u.c.k', 'f u c k', 'phuck'.replace('ph', 'f'), 'motherfucker', 'Sh1t', '$h!t', 'b1tch', 'BITCH',
  'x bitch x', 'n1gg3r', 'nigger', 'niggga', 'f4gg0t', 'hitler', 'Heil Hitler', 'adolf_hitler99',
  'c u n t', 'cunt', 'wh0re', 'sl.ut', 'nazi', 'P0rn', 'dildo', 'asshole', 'a$$hole'];
for (const n of bad) ok(`blocked: ${n}`, isOffensiveName(n) && cleanPlayerName(n, 'FB') === 'FB');

// Cleaning
ok('empty -> fallback', cleanPlayerName('', 'Player') === 'Player' && cleanPlayerName(null, 'Player') === 'Player' && cleanPlayerName(undefined, 'Anonymous') === 'Anonymous');
ok('whitespace -> fallback', cleanPlayerName('    ', 'Player') === 'Player');
ok('trims and collapses spaces', cleanPlayerName('  Ben   the   Fast ') === 'Ben the Fast');
ok('cut to 20', cleanPlayerName('A'.repeat(50)) === 'A'.repeat(20));
ok('zero-width and bidi characters removed', cleanPlayerName('Be​n‮') === 'Ben');
ok('control characters removed', cleanPlayerName('Be\u0000n\n') === 'Ben');
ok('zero-width inside a bad word is still caught', cleanPlayerName('fu​ck', 'FB') === 'FB');
ok('non-string input is safe', cleanPlayerName({ a: 1 }, 'FB') === '[object Object]' || cleanPlayerName({ a: 1 }, 'FB') === 'FB');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
