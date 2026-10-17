import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { selectLandslideFiles } from '../src/lib/ground-failure.ts';

const file = key => ({ url: `https://earthquake.usgs.gov/product/example/${key}` });
const contents = keys => Object.fromEntries(keys.map(key => [key, file(key)]));
const archived = contents(['jessee_2017_std.tif', 'jessee_2017_model.tif', 'jessee_2017.png', 'nowicki_2014_global_model.tif', 'zhu_2017_general_model.tif']);
const legacy = selectLandslideFiles(archived);
assert.equal(legacy.modelId, 'jessee_2017');
assert.equal(legacy.tif, archived['jessee_2017_model.tif']);
assert.equal(legacy.png, archived['jessee_2017.png']);

const modern = contents(['jessee_2018_model.tif', 'jessee_2018.png', 'jessee_2018_beta_sigma.tif']);
assert.equal(selectLandslideFiles({ ...archived, ...modern }).tif, modern['jessee_2018_model.tif']);

// A missing format must not silently fall back to a different model year.
assert.equal(selectLandslideFiles({ ...archived, ...contents(['jessee_2018_model.tif']) }).png, undefined);
assert.equal(selectLandslideFiles({ ...archived, ...contents(['jessee_2018.png']) }).tif, undefined);
assert.equal(selectLandslideFiles(contents(['jessee_2017.png'])).tif, undefined);
assert.equal(selectLandslideFiles(contents(['jessee_2018_std.tif', 'jessee_2017_model.tif'])).modelId, 'jessee_2017');
assert.equal(selectLandslideFiles(contents([
  'jessee_2017_std.tif', 'jessee_2018_beta_sigma.tif', 'jessee_2018_model_max.tif',
  'jessee_2018_population.png', 'jessee_2018_unc.png', 'nowicki_2014_global_model.tif',
  'godt_2008_model.tif', 'zhu_2017_general.png',
])), undefined);
assert.equal(selectLandslideFiles(), undefined);
assert.equal(selectLandslideFiles({}), undefined);

// Optional read-only verification against downloaded, unmodified ComCat JSON.
if (process.argv[2]) {
  for (const [id, expected] of [['usp000g650', 'jessee_2017'], ['us20002926', 'jessee_2017'], ['us7000i59t', 'jessee_2018']]) {
    const detail = JSON.parse(readFileSync(join(process.argv[2], `${id}.json`), 'utf8'));
    const product = detail.properties.products['ground-failure'].filter(p => p.status !== 'DELETE')
      .sort((a, b) => (b.preferredWeight ?? 0) - (a.preferredWeight ?? 0))[0];
    const selected = selectLandslideFiles(product.contents);
    assert.equal(selected.modelId, expected);
    assert.equal(selected.pngKey, product.properties['landslide-overlay']);
    assert.ok(selected.tif?.url.startsWith('https://earthquake.usgs.gov/product/ground-failure/'));
    console.log(`${id}: ${selected.tifKey} + ${selected.pngKey}`);
  }
}
console.log('Ground Failure compatibility checks passed.');
