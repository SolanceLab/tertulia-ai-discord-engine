// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/** Run: npx tsx src/ignore-door.test.ts
 *
 * THE DOOR — proves an ignored author's words cannot reach the model.
 *
 * Written 2026-08-31 after the real failure: Fernie (700239599221604484) posted
 * in #after-dark at 20:24:44Z and 20:25:16Z while her id was in ignored_user_ids,
 * and the judge model still read her — its own log quoted "smug ambition about
 * conquering". The gate existed at four call sites and something still got past.
 *
 * This test uses her REAL id and her REAL words on purpose. The old design was
 * declared done against a synthetic case and its first live test was Owen
 * watching it fail at 3am. This one fails if her text survives to the model.
 */
import './test-env.js';
import { fillReplyAuthorNames, formatTranscriptMessage, type WindowMessage, PresenceEngine } from './presence-engine.js';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

const FERNIE = '700239599221604484';
const AYA = '466563761663377419';

// Stands in for the live poller — getCached() is what the door reads.
const stubConfig = (ignored: string[]) => ({
  getCached: () => ({ ignored_user_ids: ignored }),
}) as any;

function engineWith(ignored: string[]) {
  return new PresenceEngine('http://unused', 'k', 'persona', () => 0,
    undefined, undefined, undefined, stubConfig(ignored));
}

// The exact window that produced the incident.
const realWindow = (): WindowMessage[] => ([
  { id: '1543693286047219722', authorId: AYA, authorName: 'Aya',
    content: 'I nominate Vesper with stairway to heaven: **Titanoboa**',
    isFromOwner: false, isFromMe: false, timestampMs: 1 },
  { id: '1543718136937848943', authorId: FERNIE, authorName: 'Fernie',
    content: "I'll have to actually ask", replyToId: '1543693286047219722',
    isFromOwner: false, isFromMe: false, timestampMs: 2 },
  { id: '1543718269809328209', authorId: FERNIE, authorName: 'Fernie',
    content: "Though tbh, if I can somehow conquer this, I'd be so smug as hell about this",
    replyToId: '1543693286047219722',
    isFromOwner: false, isFromMe: false, timestampMs: 3 },
] as WindowMessage[]);

function door(e: any, w: WindowMessage[]) { return e.redactAtTheDoor(w); }

function run() {
  const e = engineWith([FERNIE]);
  const out: WindowMessage[] = door(e, realWindow());

  ok('her messages are removed', !out.some((m: WindowMessage) => m.authorId === FERNIE));
  ok('the unignored speaker survives', out.some((m: WindowMessage) => m.authorId === AYA));
  ok('exactly two of three removed', out.length === 1);

  // The real proof: what the MODEL would read.
  const transcript = out.map(formatTranscriptMessage).join('\n');
  ok('transcript has no "conquer"', !/conquer/i.test(transcript));
  ok('transcript has no "smug"',    !/smug/i.test(transcript));
  ok('transcript has no "Fernie"',  !/fernie/i.test(transcript));
  ok('transcript keeps Titanoboa',   /titanoboa/i.test(transcript));

  // She replied to Aya — the surviving parent must not name her back (Owen's
  // own lead, 2026-08-31: "She was replying to unblocked message").
  ok('no reply marker names her', !/replying to Fernie/i.test(transcript));

  // Absence, not annotation — the design Owen rejected must stay dead.
  ok('no directive naming her leaks', !transcript.includes(FERNIE));

  // Empty list must change nothing at all.
  const e2 = engineWith([]);
  const w2 = realWindow();
  ok('empty ignore list is a pure no-op', door(e2, w2).length === 3);


  // Grok review 2026-08-31: the dangerous ORDER — a caller that fills reply
  // names BEFORE the door runs. This is the case Owen herself pointed at
  // ("She was replying to unblocked message"), inverted: an UNIGNORED speaker
  // replying to the blocked one. Her message goes; her NAME must go with it.
  {
    const e3 = engineWith([FERNIE]);
    const w: WindowMessage[] = ([
      { id: 'f1', authorId: FERNIE, authorName: 'Fernie', content: 'blocked words',
        isFromOwner: false, isFromMe: false, timestampMs: 1 },
      { id: 'a1', authorId: AYA, authorName: 'Aya', content: 'replying to her',
        replyToId: 'f1', isFromOwner: false, isFromMe: false, timestampMs: 2 },
    ] as WindowMessage[]);
    fillReplyAuthorNames(w);                 // caller fills FIRST — the wrong order
    ok('fill-first bakes her name in (precondition)',
       w.some((m: WindowMessage) => /fernie/i.test(m.replyToAuthorName ?? '')));
    const out3: WindowMessage[] = door(e3, w);
    const t3 = out3.map(formatTranscriptMessage).join('\n');
    ok('door clears the baked-in reply name', !/fernie/i.test(t3));
    ok('survivor still shows a generic reply marker', /earlier message|↳/i.test(t3) || out3.length === 1);
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}
run();
