// Which photos and files belong to which item — data/Attached.kt, the same: each one stays with the
// items the model said it belongs to (by its number; "true" was all of them). A capture "has an image"
// when its record says so (media), wherever the file is. Pure.

const outcomes = (c) => {
  try {
    const v = JSON.parse(c.outcomes ?? '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

const holdsPhoto = (o, part) => o.action !== 'deleted' && (o.photos === true || (o.pics ?? []).includes(part));
const holdsFile = (o, part) => o.action !== 'deleted' && (o.files === true || (o.docs ?? []).includes(part));
export const hasImage = (c) => c.source === 'photo' && !!(c.media?.image || c.media?.thumb);
export const hasFile = (c) => c.source === 'file' && !!c.media?.file;

export function homesOf(photo, byId) {
  if (photo.partOf != null) {
    const owner = byId.get(photo.partOf);
    return new Set(owner ? outcomes(owner).filter((o) => holdsPhoto(o, photo.id)).map((o) => o.entryId) : []);
  }
  if (photo.source !== 'photo') return new Set();
  return new Set(outcomes(photo).filter((o) => o.action !== 'deleted' && (!(o.pics ?? []).length || (o.pics ?? []).includes(photo.id))).map((o) => o.entryId));
}

export function photosOf(entryId, captures) {
  const byId = new Map(captures.map((c) => [c.id, c]));
  return captures.filter((c) => hasImage(c) && homesOf(c, byId).has(entryId)).sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
}

export function filesOf(entryId, captures) {
  const byId = new Map(captures.map((c) => [c.id, c]));
  return captures.filter((f) => {
    if (!hasFile(f)) return false;
    const from = f.partOf != null ? byId.get(f.partOf) : f;
    return from ? outcomes(from).some((o) => holdsFile(o, f.id) && o.entryId === entryId) : false;
  }).sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
}

/** The photos that live inside a note or something sensitive: out of the gallery and the day's diary. */
export function keptInside(captures, entries) {
  const kept = new Set(entries.filter((e) => e.kind === 'note' || e.sensitive).map((e) => e.id));
  if (!kept.size) return new Set();
  const byId = new Map(captures.map((c) => [c.id, c]));
  return new Set(captures.filter((c) => hasImage(c) && [...homesOf(c, byId)].some((h) => kept.has(h))).map((c) => c.id));
}

/** The sounds kept with an item (a melody she recorded): the captures that made or changed it, with their sound. */
export function soundsOf(entryId, captures) {
  return captures.filter((c) => c.sound === 1 && c.media?.audio && outcomes(c).some((o) => o.entryId === entryId && o.action !== 'deleted'));
}
