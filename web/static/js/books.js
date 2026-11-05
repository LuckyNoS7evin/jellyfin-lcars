// A book's series: the other volumes, in volume order. Jellyfin has no series item for books, so
// a series is the folder the volume is in. When that folder holds several series (or the
// volumes sit loose in the library), the volumes are the ones with the same series tag.

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Volume number first (ComicInfo's Number), then the name with numbers in number order. */
export const byVolume = (a, b) =>
  (a.IndexNumber ?? Infinity) - (b.IndexNumber ?? Infinity) || collator.compare(a.SortName || a.Name, b.SortName || b.Name);

/**
 * {name, folder (the series folder, or null when the volumes are loose in the library), books
 * (the volumes, in order, this one included)}, or null when the book isn't part of a series.
 */
export async function bookSeries(api, book, { signal } = {}) {
  if (!book?.ParentId) return null;
  const parent = await api.item(book.ParentId);
  const inFolder = parent.Type === 'Folder';
  // Loose in the library: only the series tag says what goes with it.
  if (!inFolder && !book.SeriesName) return null;
  const r = await api.items({ parentId: parent.Id, recursive: !inFolder, includeItemTypes: 'Book', limit: 10000 }, { signal });
  let books = r.Items;
  // A folder of one series, tagged or not, is the series; a mixed one is split by tag.
  const tags = new Set(books.map(b => b.SeriesName).filter(Boolean));
  if (book.SeriesName && (!inFolder || tags.size > 1)) books = books.filter(b => b.SeriesName === book.SeriesName);
  if (books.length < 2 && !inFolder) return null;
  books.sort(byVolume);
  return { name: book.SeriesName || parent.Name, folder: inFolder ? parent : null, books };
}

/** The volume after this one, or null. */
export function nextVolume(series, book) {
  const i = series?.books.findIndex(b => b.Id === book.Id) ?? -1;
  return i >= 0 ? series.books[i + 1] || null : null;
}

/** In a series: the volume in progress, or else the first unread one, or null when all are read. */
export function upNext(books) {
  return books.find(b => !b.UserData?.Played && b.UserData?.PlaybackPositionTicks > 0)
    || books.find(b => !b.UserData?.Played) || null;
}
