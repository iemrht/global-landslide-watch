// The archived USGS products for Wenchuan and Gorkha identify jessee_2017 as
// their preferred landslide model, with units "Proportion of area affected".
// Their info.json cites the 2018 paper.
const MODEL_FAMILIES = ['jessee_2018', 'jessee_2017'] as const;

export function selectLandslideFiles<T>(contents?: Record<string, T>) {
  if (!contents) return undefined;
  for (const modelId of MODEL_FAMILIES) {
    // Explicit names exclude standard deviation, beta/sigma, alternate models
    // and liquefaction. Select both formats from one family, never mix years.
    const tifKey = [`${modelId}_model.tif`, `${modelId}.tif`].find(key => contents[key]);
    const pngKey = [`${modelId}.png`, `${modelId}_model.png`].find(key => contents[key]);
    if (!tifKey && !pngKey) continue;
    return {
      modelId, tifKey, pngKey,
      tif: tifKey ? contents[tifKey] : undefined,
      png: pngKey ? contents[pngKey] : undefined,
    };
  }
  return undefined;
}
