import test from 'node:test';
import assert from 'node:assert/strict';
import { mentionNames, mentionRegex, recentLines, catchUpText } from '../src/catchup.js';
import { mergeWords } from '../src/refine.js';

test('mentionRegex matches the first name as a whole word, not substrings', () => {
  const re = mentionRegex(mentionNames('Rishabh Singhal', ['Rish']));
  assert.ok(re.test('Rishabh can you share the deck?')); assert.ok(re.test('thanks, rishabh.')); assert.ok(re.test('hey Rish'));
  assert.ok(!re.test('Singhalese cuisine')); assert.equal(mentionRegex(mentionNames('You')), null);
});

test('recentLines keeps only the last N minutes', () => {
  const lines = [{ t: 0, tEnd: 5 }, { t: 100, tEnd: 105 }, { t: 400, tEnd: 410 }];
  assert.deepEqual(recentLines(lines, 5).map((l) => l.t), [400]); assert.deepEqual(recentLines(lines, 6).map((l) => l.t), [100, 400]);
  assert.match(catchUpText({ summary: ['a'], asked: 'send deck', topic: 'budget', from: 100, to: 410 }), /For you: send deck/);
});

test('mergeWords takes speakers from the live lines and falls back sensibly', () => {
  const live = [{ t: 0, tEnd: 4, speaker: 'Me', chn: 0 }, { t: 5, tEnd: 9, speaker: 'Priya', chn: 1 }, { t: 10, tEnd: 12, speaker: 'Anil', chn: 1 }];
  const words = [{ chn: 0, w: 'Hello', s: 0.5, e: 0.9 }, { chn: 0, w: 'team', s: 1, e: 1.4 },
    { chn: 1, w: 'Hi', s: 5.2, e: 5.4 }, { chn: 1, w: 'there', s: 5.5, e: 5.9 }, { chn: 1, w: 'ok', s: 10.2, e: 10.4 }, { chn: 1, w: 'later', s: 30, e: 30.3 }];
  const out = mergeWords(words, live, { fallback: () => 'Remote' });
  assert.deepEqual(out.map((l) => [l.speaker, l.text]), [['Me', 'Hello team'], ['Priya', 'Hi there'], ['Anil', 'ok'], ['Anil', 'later']]);
  assert.equal(mergeWords([{ chn: 1, w: 'x', s: 1, e: 2 }], [], { fallback: (c) => `chn${c}` })[0].speaker, 'chn1');
});

import { resolveTemplate, mySpeechShare } from '../src/summarize/auto.js';
import { listTemplates } from '../src/summarize/template.js';

test('template auto: only you speaking -> voice-note, otherwise general-meeting, explicit names untouched', () => {
  const solo = [{ speaker: 'Me', text: 'remember to call the bank tomorrow' }];
  const call = [{ speaker: 'Me', text: 'hello there' }, { speaker: 'Priya', text: 'hi we need to talk about the budget today' }];
  assert.equal(resolveTemplate('auto', { lines: solo, me: 'Me' }), 'voice-note');
  assert.equal(resolveTemplate('auto', { lines: call, me: 'Me' }), 'general-meeting');
  assert.equal(resolveTemplate('auto', { lines: [], me: 'Me' }), 'general-meeting');
  assert.equal(resolveTemplate('standup', { lines: solo, me: 'Me' }), 'standup');
  assert.ok(mySpeechShare(call, 'Me') < 0.5); assert.ok(listTemplates().includes('voice-note'));
});
