import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { applyVerifiedEventName, verifiedNames } from '../src/lib/event-names.ts';
import { createEventSearch } from '../src/lib/event-search.ts';

const cases = [
  ['usp000g650', ['汶川', '四川 汶川', '2008+汶川']],
  ['us20002926', ['尼泊尔', '廓尔喀', '加德满都', '尼泊爾']],
  ['us7000i59t', ['泸定', '四川 泸定']],
  ['us1000778i', ['凯库拉', '新西兰 凯库拉']],
  ['us20005iis', ['熊本', '日本 熊本']],
  ['usb000gcdd', ['芦山', '雅安']],
  ['us6000jllz', ['土耳其 帕扎尔哲克']],
  ['us6000m0xl', ['能登', '能登半岛']],
  ['us7000m9g4', ['花莲', '花蓮', '2024 花莲', '台湾+花莲', 'ＵＳ７０００Ｍ９Ｇ４']],
  ['us2000h8ty', ['北海道', '胆振', '厚真']],
  ['usp000e12e', ['克什米尔', '巴基斯坦', '2005 克什米尔']],
];
for (const [id, queries] of cases) {
  const entry = verifiedNames[id];
  const candidatePaths = process.argv[2] ? [join(process.argv[2], `${id}.json`), join(process.argv[2], 'historical_details', `${id}.json`)] : [];
  const fixture = candidatePaths.find(existsSync);
  const raw = fixture ? JSON.parse(readFileSync(fixture, 'utf8')) : {id, properties: {place: 'Original USGS location', time: Date.parse(entry.day)}};
  const event = applyVerifiedEventName(raw);
  for (const query of queries) assert.ok(createEventSearch(query)(event), `${id}: ${query}`);
  assert.ok(createEventSearch(id.toUpperCase())(event));
  assert.ok(createEventSearch('  ')(event));
  assert.equal(createEventSearch('不存在的地震')(event), false);
  console.log(`${id}: ${queries.join(' / ')}`);
}
const wenchuan = applyVerifiedEventName({id: 'usp000g650', properties: {place: 'Original place', time: Date.parse('2008-05-12')}});
assert.equal(createEventSearch('2008 尼泊尔')(wenchuan), false);
assert.ok(createEventSearch('original PLACE')(wenchuan));
const wrongDate = applyVerifiedEventName({id: 'us7000m9g4', properties: {place: 'Different event', time: Date.parse('2024-04-03')}});
assert.equal(createEventSearch('花莲')(wrongDate), false);
console.log('Chinese, aliases, combined keywords, original names and IDs passed.');
