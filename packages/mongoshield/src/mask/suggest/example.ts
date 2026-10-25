/**
 * Examples for reports that show what a field holds WITHOUT showing the data.
 *
 * A finding is more convincing with an example ("email: ada.costa@corp.com"), but the
 * whole point of the scan is that this data must not be copied around, and reports
 * end up in terminals, CI logs and pull requests. So an example is the value's SHAPE:
 *
 *   ada.costa@corp.com     → xxx.xxxxx@xxxx.xxx
 *   +44 20 7946 0958       → +## ## #### ####
 *   Seán O'Brien           → Xxxx X'Xxxxxx
 *   eyJhbGciOi…            → [secret, 164 characters]
 *
 * Letters become `x`/`X`, digits `#`; punctuation and single spaces stay, because they
 * carry the format (and nothing personal). Long values are cut at 32 characters.
 * Secrets show only their length: even the shape of a key narrows a brute force.
 */

/** Longest example shown; longer shapes end in "…". */
const MAX_EXAMPLE_LENGTH = 32;

/** The shape of a text (see the file header). */
export function maskedShape(text: string): string {
  let shape = "";
  let length = 0;
  for (const character of text.replace(/\s+/g, " ").trim()) {
    if (length === MAX_EXAMPLE_LENGTH) return `${shape}…`;
    shape += shapeOf(character);
    length += 1;
  }
  return shape;
}

/** One character's shape: `X` / `x` for letters (any script), `#` for digits and numerals. */
function shapeOf(character: string): string {
  if (/\p{N}/u.test(character)) return "#";
  if (/\p{Lu}/u.test(character)) return "X";
  if (/\p{L}/u.test(character)) return "x";
  return character;
}

/** The example of a secret: its length only. */
export function maskedSecret(text: string): string {
  return `[secret, ${[...text].length} characters]`;
}

/** The example of a free text: the shape of the email or phone found in it, in context dots. */
export function maskedExcerpt(match: string): string {
  return `…${maskedShape(match)}…`;
}

/** The example of a date: the shape of its ISO date (`####-##-##`), never the date. */
export function maskedDate(): string {
  return "####-##-##";
}

/** The example of a GeoJSON geometry: its type (`Point`) and the shape of a coordinate. */
export function maskedGeometry(type: string): string {
  return `${type} [##.####, ##.####]`;
}

/** The example of a number: the shape of its digits (`##.####`, `-###.##`). */
export function maskedNumber(value: number): string {
  return maskedShape(String(value));
}
