type SearchableEvent = {
  id: string;
  properties: {
    place: string; originalPlace?: string; eventAliases?: string;
    catalogAgency?: string; catalogNote?: string;
  };
};

const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase('zh-CN');

export function createEventSearch(query: string) {
  // Chinese names and reviewed aliases are searched together with original
  // USGS names and IDs. Spaces or '+' allow combinations such as "2024 花莲".
  const terms = normalize(query).trim().split(/[\s+,，、]+/u).filter(Boolean);
  return (event: SearchableEvent) => {
    if (!terms.length) return true;
    const corpus = normalize([
      event.properties.place, event.properties.originalPlace, event.properties.eventAliases,
      event.id, event.properties.catalogAgency, event.properties.catalogNote,
    ].filter(Boolean).join(' '));
    return terms.every(term => corpus.includes(term));
  };
}
