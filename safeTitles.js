'use strict';
// Title lists shared by the server's Safe mode and the pool generator.
//
// EXPLICIT: sexual content, explicit sites, self-harm and graphic violence.
//   Safe mode (the host's classroom toggle) blocks these as a start or target,
//   and as a link a player may follow.
// CRIME: real crime articles ("Murder of X", "X massacre"). The pool generator
//   keeps these out of the curated pool too, but Safe mode lets them through:
//   they are everyday history and news ("September 11 attacks").
//
// A keyword list on titles is a best effort. It does not read article text, so
// an innocent-looking title can still lead to a mature page. The titles are
// matched as whole words ("Essex" and "Sussex" are fine), case-insensitively.
const EXPLICIT = 'sex|sexual|sexuality|intercourse|penis|vagina|vulva|clitoris|testicles?|scrotum|anus|genitals?|ejaculation|erection|hentai|porn|pornography|pornographic|pornstar|erotic|erotica|nude|nudity|masturbation|orgasm|fetish|bdsm|incest|strip club|strippers?|prostitution|prostitutes?|brothel|sex workers?|suicide|self-harm|rape|xnxx|xvideos|pornhub|xhamster|onlyfans|brazzers|mofos|twistys|brasileirinhas|cam4|fanvue|chaturbate|stripchat|livejasmin|redtube|youporn|spankbang|bangbros|naughty america|reality kings|gang ?bang|bukkake|creampie|milf|dildo|vibrators?|sex toys?|torture|beheading|snuff|necrophilia|pedophilia|paedophilia|cannibalism|rule 34';
const CRIME = 'maniacs?|massacres?|serial killers?|murders? of|killings? of|mass shooting|school shooting|disappearance of|attacks';

const EXPLICIT_RE = new RegExp(`\\b(${EXPLICIT})\\b`, 'i');
// Everything the pool generator keeps out of the curated pool.
const DENY_RE = new RegExp(`\\b(${EXPLICIT}|${CRIME})\\b`, 'i');

function isExplicitTitle(title) {
  return EXPLICIT_RE.test(String(title || '').replace(/_/g, ' '));
}

module.exports = { EXPLICIT_RE, DENY_RE, isExplicitTitle };
