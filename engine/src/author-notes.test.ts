// Tertúlia — Copyright (c) 2026 House of Solance. PolyForm Noncommercial 1.0.0. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/** Run: npx tsx src/author-notes.test.ts — "Who's here": the hooks file's authorNotes, keyed by id and shown name. */
import './test-env.js';
import { authorNoteKey, type AuthorInfo, setHooks } from './hooks.js';
import { authorsOf, AuthorNotes } from './presence/author-notes.js';
import { PresenceEngine } from './presence-engine.js';
import type { WindowMessage } from './presence-engine.js';
import { DEFAULTS } from './presence-config.js';
import { authorFlagsOf } from './presence/window.js';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}`); }
}

const BOT = '700000000000000009', MARA = '700000000000000001', IVO = '700000000000000002', HOOK = '700000000000000050', MUTED = '700000000000000003';
let n = 0;
const wm = (authorId: string, authorName: string, over: Partial<WindowMessage> = {}): WindowMessage => ({
  id: String(++n), authorId, authorName, authorUsername: authorName.toLowerCase().replace(/\s+/g, ''), content: 'hi', isFromOwner: false, isFromMe: false, timestampMs: 1_760_000_000_000 + n * 1000, ...over,
});

const errs: string[] = [];
const origWrite = process.stderr.write.bind(process.stderr);
const quiet = (on: boolean) => { (process.stderr as any).write = on ? ((s: any) => { errs.push(String(s)); return true; }) : origWrite; };

(async () => {
  try {
    // ── which authors are asked about ──
    const window = [
      wm(MARA, 'Mara'), wm(MARA, 'Mara'),
      wm(BOT, 'Botname', { isFromMe: true }),
      wm(HOOK, 'Aria', { isWebhook: true, isBot: true, authorUsername: 'tupperbox' }),
      wm(HOOK, 'Bell', { isWebhook: true, isBot: true, authorUsername: 'tupperbox' }),
      wm(MUTED, 'Muted'),
      wm(IVO, 'Ivo'),
    ];
    const asked = authorsOf(window, [MUTED]).map((a) => a.info);
    ok('authors: distinct id + shown name, the bot itself and an ignored person left out', asked.map(authorNoteKey).join() === [`${MARA}|Mara`, `${HOOK}|Aria`, `${HOOK}|Bell`, `${IVO}|Ivo`].join());
    ok('authors: a webhook post carries isWebhook, isBot and the persona name', asked[1].isWebhook === true && asked[1].isBot === true && asked[1].shownName === 'Aria' && asked[1].id === HOOK && asked[1].username === 'tupperbox');
    ok('authors: a member carries isWebhook false', asked[0].isWebhook === false && asked[0].isBot === false && asked[0].username === 'mara');
    ok('flags come from the Discord message', JSON.stringify(authorFlagsOf({ author: { bot: true }, webhookId: '5' })) === JSON.stringify({ isBot: true, isWebhook: true }) && JSON.stringify(authorFlagsOf({ author: {} })) === JSON.stringify({ isBot: false, isWebhook: false }));

    // ── the block ──
    let calls: AuthorInfo[][] = [];
    const notes: Record<string, string> = {
      [`${MARA}|Mara`]: 'she/her, in Lisbon\nlocal time 14:05',
      [`${HOOK}|Aria`]: 'a persona of Sam',
      [`${IVO}|Ivo`]: 'x'.repeat(900),
    };
    setHooks({ authorNotes: (authors) => { calls.push(authors); return notes; } });
    let t = 1_000_000;
    const an = new AuthorNotes(() => t, 60_000);
    const block = await an.blockFor(window, [MUTED]);
    ok('the hook is called once with exactly the present authors', calls.length === 1 && calls[0].map(authorNoteKey).join() === asked.map(authorNoteKey).join());
    ok('the ignored author is never passed to the hook', !calls[0].some((a) => a.id === MUTED));
    const lines = block.split('\n');
    ok('one line per person that has a note, labelled as the transcript labels them', lines.length === 3 && lines[0] === 'Mara (@mara · 700000000000000001): she/her, in Lisbon local time 14:05' && lines[1].startsWith('Aria (@tupperbox · 700000000000000050): a persona of Sam'));
    ok('a note is one line and capped', lines[2].length < 460 && !lines[2].includes('\n'));
    ok('a person with no note gets no line', !block.includes('Bell'));
    await an.blockFor(window, [MUTED]);
    ok('cached per id + shown name: a second window inside the TTL does not call the hook again', calls.length === 1);
    t += 61_000;
    await an.blockFor(window, [MUTED]);
    ok('after the TTL the hook is asked again', calls.length === 2);
    t += 1;
    const sameIdNewName = [wm(HOOK, 'Cleo', { isWebhook: true, isBot: true })];
    await an.blockFor(sameIdNewName, []);
    ok('the same id with a new shown name is a new key and is asked about', calls.length === 3 && calls[2].length === 1 && calls[2][0].shownName === 'Cleo');

    // ── absent and throwing providers ──
    setHooks(null);
    ok('absent provider: no section', (await new AuthorNotes().blockFor(window, [])) === '');
    setHooks({ authorNotes: () => { throw new Error('layer down'); } });
    errs.length = 0; quiet(true);
    const a1 = await new AuthorNotes().blockFor(window, []);
    const a2 = await new AuthorNotes().blockFor(window, []);
    quiet(false);
    ok('throwing provider: no section, logged once', a1 === '' && a2 === '' && errs.filter((e) => /authorNotes threw/.test(e)).length === 1);
    setHooks({ authorNotes: async () => { throw new Error('async down'); } });
    errs.length = 0; quiet(true);
    const a3 = await new AuthorNotes().blockFor(window, []);
    quiet(false);
    ok('rejecting provider: no section', a3 === '');
    setHooks({ authorNotes: () => 'nonsense' as any });
    ok('a provider that answers with a non-object: no section', (await new AuthorNotes().blockFor(window, [])) === '');

    // ── in the prompts ──
    const captured: string[] = [];
    const engine = new PresenceEngine('http://model-service.invalid', 'k', 'PERSONA', () => 1_760_000_100_000, undefined, undefined, undefined, { get: async () => ({ ...DEFAULTS, ignored_user_ids: [MUTED] }), getCached: () => ({ ...DEFAULTS, ignored_user_ids: [MUTED] }) } as any);
    engine.setModelProvider({
      singleModel: true, identity: { engine: 't', model: 't' },
      async complete(_t: any, system: string) { captured.push(system); return { ok: true, text: JSON.stringify({ speak: false, reason: 'x', message: null }), engine: 't', model: 't' }; },
      async prepare() { return null; }, async postComplete() { throw new Error('unused'); },
    } as any);
    engine.setSelfId(BOT);
    let asked2: AuthorInfo[] = [];
    setHooks({ authorNotes: (authors) => { asked2 = authors; return { [`${MARA}|Mara`]: 'NOTE-MARA', [`${MUTED}|Muted`]: 'NOTE-MUTED' }; } });
    const win = () => [wm(MARA, 'Mara', { content: 'first' }), wm(MUTED, 'Muted', { content: 'secret line' }), wm(BOT, 'Botname', { isFromMe: true, content: 'earlier' }), wm(IVO, 'Ivo', { content: 'last' })];
    await engine.judge('700000000000000103', 'room', win(), undefined, [], 'balanced');
    ok('judge prompt: a Who\'s here section with the labelled note', /Who's here[^\n]*\nMara \(@mara · 700000000000000001\): NOTE-MARA/.test(captured[0] ?? ''));
    ok('judge prompt: the ignored person is neither asked about nor named', !asked2.some((a) => a.id === MUTED) && !/NOTE-MUTED|Muted|secret line/.test(captured[0] ?? ''));
    captured.length = 0;
    const engine2 = new PresenceEngine('http://model-service.invalid', 'k', 'PERSONA', () => 1_760_000_100_000, undefined, undefined, undefined, { get: async () => ({ ...DEFAULTS }) } as any);
    engine2.setModelProvider((engine as any).modelProvider);
    engine2.setSelfId(BOT);
    await engine2.respond('room', win(), undefined, false, [], undefined, 'last');
    ok('respond prompt: the same section', /Who's here[^\n]*\nMara \(@mara · 700000000000000001\): NOTE-MARA/.test(captured[0] ?? ''));
    captured.length = 0;
    setHooks(null);
    await engine2.respond('room', win(), undefined, false, [], undefined, 'last');
    ok('absent provider: the section is left out of the prompt', !/Who's here/.test(captured[0] ?? ''));
    captured.length = 0;
    setHooks({ authorNotes: () => { throw new Error('x'); } });
    const engine3 = new PresenceEngine('http://model-service.invalid', 'k', 'PERSONA', () => 1_760_000_100_000, undefined, undefined, undefined, { get: async () => ({ ...DEFAULTS }) } as any);
    engine3.setModelProvider((engine as any).modelProvider);
    engine3.setSelfId(BOT);
    quiet(true); await engine3.respond('room', win(), { peopleNotes: 'FROM-CALLER' } as any, false, [], undefined, 'last'); quiet(false);
    ok('throwing provider: the prompt is built without it, the caller\'s own peopleNotes still shown', /FROM-CALLER/.test(captured[0] ?? '') && !/NOTE-MARA/.test(captured[0] ?? ''));
  } finally {
    quiet(false);
    setHooks(null);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
