// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/** Run: npx tsx src/ignore-door.test.ts
 *
 * THE DOOR — proves an ignored author's words cannot reach the model.
 *
 * Written after a real failure: an ignored author's messages reached the judge model even though
 * the gate existed at four call sites. This test fails if an ignored author's text, name or id
 * survives anywhere into what the model sees, including a reply marker naming them.
 */
import './test-env.js';
import { fillReplyAuthorNames, formatTranscriptMessage, type WindowMessage, PresenceEngine } from './presence-engine.js';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

const AYA = '700000000000000555';
const IGNORED_AUTHOR = '700000000000000777';

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
  { id: '700000000000000101', authorId: AYA, authorName: 'Aya',
    content: 'I nominate the blue one: **Titanoboa**',
    isFromOwner: false, isFromMe: false, timestampMs: 1 },
  { id: '700000000000000102', authorId: IGNORED_AUTHOR, authorName: 'Rook',
    content: "I'll have to check first", replyToId: '700000000000000101',
    isFromOwner: false, isFromMe: false, timestampMs: 2 },
  { id: '700000000000000103', authorId: IGNORED_AUTHOR, authorName: 'Rook',
    content: "Honestly, if I pull this off I'll be unbearable about it",
    replyToId: '700000000000000101',
    isFromOwner: false, isFromMe: false, timestampMs: 3 },
] as WindowMessage[]);

function door(e: any, w: WindowMessage[]) { return e.redactAtTheDoor(w); }

function run() {
  const e = engineWith([IGNORED_AUTHOR]);
  const out: WindowMessage[] = door(e, realWindow());

  ok('her messages are removed', !out.some((m: WindowMessage) => m.authorId === IGNORED_AUTHOR));
  ok('the unignored speaker survives', out.some((m: WindowMessage) => m.authorId === AYA));
  ok('exactly two of three removed', out.length === 1);

  // The real proof: what the MODEL would read.
  const transcript = out.map(formatTranscriptMessage).join('\n');
  ok('transcript has no "conquer"', !/conquer/i.test(transcript));
  ok('transcript has no "unbearable"',    !/unbearable/i.test(transcript));
  ok('transcript has no "Rook"',  !/rook/i.test(transcript));
  ok('transcript keeps Titanoboa',   /titanoboa/i.test(transcript));

  // She replied to Aya — the surviving parent must not name her back (Owen's
  // own lead, 2026-08-31: "She was replying to unblocked message").
  ok('no reply marker names her', !/replying to Rook/i.test(transcript));

  // Absence, not annotation — the design Owen rejected must stay dead.
  ok('no directive naming her leaks', !transcript.includes(IGNORED_AUTHOR));

  // Empty list must change nothing at all.
  const e2 = engineWith([]);
  const w2 = realWindow();
  ok('empty ignore list is a pure no-op', door(e2, w2).length === 3);


  // Grok review 2026-08-31: the dangerous ORDER — a caller that fills reply
  // names BEFORE the door runs. This is the case Owen herself pointed at
  // ("She was replying to unblocked message"), inverted: an UNIGNORED speaker
  // replying to the blocked one. Her message goes; her NAME must go with it.
  {
    const e3 = engineWith([IGNORED_AUTHOR]);
    const w: WindowMessage[] = ([
      { id: 'f1', authorId: IGNORED_AUTHOR, authorName: 'Rook', content: 'blocked words',
        isFromOwner: false, isFromMe: false, timestampMs: 1 },
      { id: 'a1', authorId: AYA, authorName: 'Aya', content: 'replying to her',
        replyToId: 'f1', isFromOwner: false, isFromMe: false, timestampMs: 2 },
    ] as WindowMessage[]);
    fillReplyAuthorNames(w);                 // caller fills FIRST — the wrong order
    ok('fill-first bakes her name in (precondition)',
       w.some((m: WindowMessage) => /rook/i.test(m.replyToAuthorName ?? '')));
    const out3: WindowMessage[] = door(e3, w);
    const t3 = out3.map(formatTranscriptMessage).join('\n');
    ok('door clears the baked-in reply name', !/rook/i.test(t3));
    ok('survivor still shows a generic reply marker', /earlier message|↳/i.test(t3) || out3.length === 1);
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}
run();
