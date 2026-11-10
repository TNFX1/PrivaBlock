// The popup's quill row: one quill per blocked request on the page, starting a new row after ROW.
export const ROW = 23;

/** Quills in the current row for n blocked requests; a multiple of ROW shows a full row, not an empty one. */
export function quillCount(n) {
  return n > 0 ? ((n - 1) % ROW) + 1 : 0;
}

/** Fixed height (11..26) and lean (0.35..0.75) for quill i, so the row looks the same on every redraw. */
export function quillShape(i) {
  const x = Math.imul(i + 1, 2654435761) >>> 0;
  return { h: 11 + ((x >>> 8) % 16), lean: 0.35 + ((x >>> 16) % 41) / 100 };
}
