'use strict';
// lib/heardRules.js - the fixed readings of a sentence, cut out of lib/talk.js
// (2026-10-25, cleanup round 5 #41: talk.js sat 3 lines under its size ceiling).
// Is it a yes or a no, a promise of work, a claim that something started, a
// question that offers an action. Pure functions of the text: no state, no model.
// Moved verbatim; talk.js requires them back under the same names.
// ── acting ──────────────────────────────────────────────────────────────────
// A confirmation is read HERE, not by the model: "dale" is not a sentence that
// needs interpreting, and a model asked to interpret it can decide that "no,
// mejor no" means yes. Cheap, deterministic, and it costs no GPU turn.
// JS's \b does not know that "í" is a letter, so /^(sí)\b/ never matched the
// one word this exists for: he said "sí", it asked again, he said "te dije que
// sí", and the model answered "abriendo..." having opened nothing. END is a
// boundary that knows Spanish, and a short sentence may carry the yes anywhere
// ("te dije que si", "bueno dale").
//
// And a person does not answer a yes/no question with a yes. He answers "que si
// que si bro", and then "si si si si si si si si": the old test capped an answer
// at four words, so EMPHASIS — the most human thing in a spoken yes — was
// exactly what stopped it counting, and he was asked the same question three
// times in a row. Repetition is not ambiguity. So the sentence is flattened, the
// words that carry no decision are dropped, and what is left decides.
const NOISE = new Set(('que bro loco che boludo capo amigo man hombre eso te lo le les dije digo pues '
    + 'o sea ya bueno entonces asi ahi mira por a de del la el los las un una y').split(' '));
const YES_W = /^(si+|sip|sep|dale|dele|obvio|claro|ok|okey|okay|listo|hacelo|hazlo|mandale|mandalo|abrila|abrilas|abrilo|cerrala|cerralas|confirmo|confirmado|correcto|adelante|afirmativo|va|vamos|vale|perfecto|exacto|joya|barbaro|procede|proceda|procedele|segui|avanza|avanzale|metele|arranca|arrancale|ejecuta|ejecutalo|lanzala|lanzalo|andale|hacela)$/;
const NO_W = /^(no+|nop|nope|nunca|cancela|cancelalo|cancelala|dejalo|deja|dejala|olvidalo|para|pare|negativo|tampoco)$/;

function words(t) {
    const s = String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9\s]+/g, ' ')
        // the two-word ones, flattened before anything is thrown away
        .replace(/\bde una\b/g, 'si').replace(/\bpor supuesto\b/g, 'si')
        .replace(/\bni ahi\b/g, 'no').replace(/\bmejor no\b/g, 'no').replace(/\bpara nada\b/g, 'no');
    return s.split(/\s+/).filter(w => w && !NOISE.has(w));
}

function decide(t) {
    const w = words(t);
    if (!w.length) return null;
    const yes = w.filter(x => YES_W.test(x)).length;
    const no = w.filter(x => NO_W.test(x)).length;
    if (!yes && !no) return null;
    // Everything he said was a yes (or a no), however many times he said it.
    if (yes && !no && yes === w.length) return 'yes';
    if (no && !yes && no === w.length) return 'no';
    // Mixed, or buried in a longer sentence: only a SHORT answer counts, and the
    // opening word decides it. "no veo que hayas abierto la sesion" opens with a
    // no and is a complaint, not a cancellation.
    if (w.length > 4) return null;
    if (NO_W.test(w[0])) return 'no';
    if (YES_W.test(w[0])) return no ? 'no' : 'yes';   // "claro que no" is a no
    return null;
}

// "voy a revisar", "dejame ver", "ahora lo abro" - an announcement of work.
const PROMISES = { test: (s) => /^(ok[,. ]+|dale[,. ]+|listo[,. ]+|entendido[,. ]+|perfecto[,. ]+)?(voy a|ahora (voy|lo|la|le)|dejame|ya (lo|la|le) (reviso|abro|mando|hago|pido))\b/i.test(String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim()) };
// "ya esta en marcha", "ya lo lance", "le pedi a Opus" - said with no action behind it.
// "le acabo de decir que lo suba" / "ya se lo dije" (2026-10-05): a send claimed
// with no ACCION behind it, and he had to say "no veo que se lo hayas dicho".
const CLAIMS_STARTED = { test: (s) => /\b(en marcha|ya (esta|lo|la|le|las|los) ?(lan[zc]|arran[cq]|ped|mand|corr|abr)\w*|ya (arran[cq]|lan[zc]|empe[zc]|abr)\w*|le ped[i] a (opus|sonnet|haiku)|lo estoy (lanzando|armando|corriendo)|espero (a )?que \S+ (respond|contest)\w*|acabo de (decir|mandar|pedir|pasar|preguntar|enviar|escribir)\w*|ya (se )?(lo|la|le|les) (dij|mand|ped|pregunt|pas|escrib|envi)\w*)/i.test(String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')) };
// "Le escribo a la sesion daily-tasks que... dale?" with no ACCION behind it
// (Tesla review #4). The promise guard skips anything with a question mark, so
// his yes had nothing pending to say yes TO. A yes-question that announces an
// action of its own needs the action attached, like any confirmation.
const ASKS_TO_ACT = { test: (s) => {
    const t = String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
    // An OFFER with no question mark is the same thing (Tesla review #10: "Puedo
    // hacerlo con la PC ... buscando a Eminem y dandole play." -> his "si" -> the
    // gate asked AGAIN, two yeses for one song).
    if (/\b(puedo hacerlo|lo puedo hacer|lo podria hacer|podria hacerlo|puedo (buscar|abrir|poner|hacer|mandar|escribir|leer|mover)\w*|si queres,? (lo|la|te|le) \w+)\b/.test(t)) return true;
    // A question that offers TWO things ("...a marketing-seo, o que se lo pida a
    // Opus?") or no thing at all ("¿queres que le pase algo?") has no one action
    // to attach; nudged, it came back as an apology for nothing (review #14).
    const q = t.slice(t.lastIndexOf('¿') + 1);
    if (/,\s*o (que|a|al|si|le|lo|la|se)\b/.test(q) || /\b(algo|alguna cosa)\b/.test(q)) return false;
    return /\?\s*$/.test(t) && /\b(le (escribo|mando|digo|paso|pido|pregunto|apruebo)|le voy a (pedir|mandar|decir|escribir|pasar|preguntar)|te (abro|mando|armo|paso)|(abro|cierro|corro|lanzo|apruebo|rechazo) (una|la|el|las|los)|lo (mando|abro|corro)|quer[e]?s que (le|les|lo|la) (diga|mande|escriba|pase|pida|pregunte|apruebe|abra|cierre|frene))\b/.test(t);
} };
// What survives the retry (review #14). A QUESTION claims nothing: when the retry
// brings no action, the question stays as it was (19:01, "¿Querés que le pase algo
// a la sesión?" -> "Tenés razón, me equivoqué ... Leon dijo sólo 'hola güera'").
// A promise with no action is a lie, so the honest retry replaces it.
function afterNudge(first, second) {
    if (!second) return first;
    if (second.action) return second;
    if (/\?\s*$/.test(String(first && first.say || '').trim())) return first;
    return second;
}
const NO = { test: (t) => decide(t) === 'no' };
const YES = { test: (t) => decide(t) === 'yes' };

module.exports = { words, decide, PROMISES, CLAIMS_STARTED, ASKS_TO_ACT, afterNudge, NO, YES };
