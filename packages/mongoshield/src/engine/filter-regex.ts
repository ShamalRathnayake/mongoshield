/**
 * Bounding the cost of user regexes in `find` filters (src/engine/filter.ts).
 *
 * The filter evaluator runs `$regex` on JavaScript's backtracking engine, in the same
 * thread as everything else. A pattern such as `^(.+)+X$` takes time exponential in
 * the length of the string it is tried on (4.5 s for 27 characters, doubling with each
 * one), and nothing can interrupt it: not a timeout, not an abort signal. MongoDB's
 * own PCRE engine has a backtracking limit; JavaScript's has none.
 *
 * Exponential time needs a repeated group that can match the same text in more than
 * one way, so the engine retries every split after a failure. So patterns are checked
 * before they are compiled, and refused when they are:
 *
 *   - longer than {@link MAX_REGEX_PATTERN_LENGTH} characters; or
 *   - "nested quantifiers": a repeated group (`(…)*`, `(…)+`, `(…){2,}`) whose body
 *     itself repeats without bound (`*`, `+`, `{n,}`), the shape behind almost every
 *     catastrophic case (`(a+)+`, `(.*a){20}`, `(\w+\s?)*$`). One shape is let
 *     through because it is unambiguous (see {@link isDelimitedIteration}): a body
 *     that ends with a required literal character nothing else in the body can match,
 *     such as `([a-z0-9]+\.)+` or `(\w+-)+`. Every repetition then ends at the next
 *     such character, so the text splits into repetitions in exactly one way; or
 *   - an unbounded repeated group whose alternatives overlap: one plain word is a
 *     prefix of another (`(a|aa)+`), or other alternatives can start with the same
 *     character (`(a|[ab])*`). Such a group splits a run of `a`s in exponentially
 *     many ways (see {@link alternativesOverlap}).
 *
 * Normal patterns (`^ada@`, `\.(jpe?g|png)$`, `(foo|bar)+`, `^[A-Z]{2}\d{4,}$`) are
 * unaffected and keep MongoDB's meaning. The check parses just enough of the pattern
 * (groups, alternatives, character classes, escapes, quantifiers) to tell those
 * shapes apart; it never throws, and a pattern it cannot make sense of is left to
 * the RegExp constructor to reject. Where it cannot tell what an atom matches (a
 * backreference, `\p{…}`), it errs towards the old rule: refuse a nested quantifier,
 * and do not refuse an alternation.
 */

/**
 * The longest pattern a filter may use. Real search patterns are short; a cap keeps
 * the polynomial cases (many `.*` in a row) bounded as well.
 */
export const MAX_REGEX_PATTERN_LENGTH = 1024;

/**
 * Explains why `pattern` is too expensive to run, or returns `undefined` when it is fine.
 * `pattern` is the JavaScript form (after the PCRE translation in filter.ts).
 */
export function regexCostProblem(pattern: string): string | undefined {
  if (pattern.length > MAX_REGEX_PATTERN_LENGTH) {
    return `the regular expression is ${pattern.length} characters long; at most ${MAX_REGEX_PATTERN_LENGTH} are allowed`;
  }
  const parsed = new PatternParser(pattern).parse();
  const problem = findProblem(parsed);
  if (problem === "nested") {
    return `the regular expression /${pattern}/ repeats a group that itself repeats (such as (a+)+ or (.*x)*), which can take practically forever to run; rewrite it without the nested repetition, or end the repeated group with a character its repeated parts cannot match (such as ([a-z]+\\.)+)`;
  }
  if (problem === "alternation") {
    return `the regular expression /${pattern}/ repeats a group whose alternatives can match the same text (such as (a|aa)+ or (a|[ab])*), which can take practically forever to run; rewrite the alternatives so that none can start where another does`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The parsed pattern
// ---------------------------------------------------------------------------

/**
 * Which characters an atom matches. `undefined` in a {@link CharacterAtom} means
 * "cannot tell" (a backreference, a Unicode property): callers then assume the worst
 * for their own question.
 */
type CharacterTest = (character: string) => boolean;

/** An atom that consumes exactly one character: a literal, `.`, `\d`, `[a-z]`, … */
interface CharacterAtom {
  readonly kind: "character";
  /** The character itself for a plain or escaped literal (`a`, `\.`), else undefined. */
  readonly literal: string | undefined;
  /** What it matches; undefined when that cannot be told (see CharacterTest). */
  readonly matches: CharacterTest | undefined;
}

/** A zero-width assertion: `^`, `$`, `\b`, `\B`. Consumes nothing. */
interface AssertionAtom {
  readonly kind: "assertion";
}

/** A group (`(…)`, `(?:…)`, `(?<name>…)`, or a lookaround) with its alternatives. */
interface GroupAtom {
  readonly kind: "group";
  readonly alternatives: readonly Sequence[];
  /** `(?=…)`, `(?!…)`, `(?<=…)`, `(?<!…)`: zero-width, but its body still runs. */
  readonly lookaround: boolean;
}

type Atom = CharacterAtom | AssertionAtom | GroupAtom;

/** An atom with the quantifier after it (`{ min: 1, max: 1 }` when there is none). */
interface Item {
  readonly atom: Atom;
  readonly quantifier: Quantifier;
}

/** One alternative of a group (or of the whole pattern): items matched in order. */
type Sequence = readonly Item[];

/** What a quantifier allows. */
interface Quantifier {
  /** Fewest repetitions (0 for `?`, `*`, `{0,n}`). */
  readonly min: number;
  /** Most repetitions; `undefined` for no upper bound (`*`, `+`, `{n,}`). */
  readonly max: number | undefined;
}

/** No quantifier: the atom is matched exactly once. */
const ONCE: Quantifier = { min: 1, max: 1 };

/** True for `*`, `+`, `{n,}`. */
function isUnbounded(quantifier: Quantifier): boolean {
  return quantifier.max === undefined;
}

/** True when the atom may be matched more than once (`*`, `+`, `{2}`, `{1,5}`). */
function repeats(quantifier: Quantifier): boolean {
  return quantifier.max === undefined || quantifier.max > 1;
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

/** Which rule a pattern breaks, if any. */
type Problem = "nested" | "alternation";

/** The first problem anywhere in the pattern (the whole pattern is one group). */
function findProblem(alternatives: readonly Sequence[]): Problem | undefined {
  for (const sequence of alternatives) {
    for (const item of sequence) {
      if (item.atom.kind !== "group") continue;
      const problem = groupProblem(item.atom, item.quantifier);
      if (problem !== undefined) return problem;
    }
  }
  return undefined;
}

/** The problem of one group (and of the groups inside it). */
function groupProblem(group: GroupAtom, quantifier: Quantifier): Problem | undefined {
  if (repeats(quantifier) && containsUnboundedRepeat(group) && !isDelimitedIteration(group)) {
    return "nested";
  }
  if (isUnbounded(quantifier) && alternativesOverlap(group)) return "alternation";
  return findProblem(group.alternatives);
}

/** True when something inside the group repeats without bound (at any depth). */
function containsUnboundedRepeat(group: GroupAtom): boolean {
  for (const sequence of group.alternatives) {
    for (const item of sequence) {
      if (isUnbounded(item.quantifier)) return true;
      if (item.atom.kind === "group" && containsUnboundedRepeat(item.atom)) return true;
    }
  }
  return false;
}

/**
 * True for a group body that splits any text into repetitions in exactly one way:
 * one alternative, made of single-character atoms only (no nested groups), whose
 * last character-consuming item is a literal matched exactly once (the delimiter,
 * `\.` in `([a-z0-9]+\.)+`) that no other item of the body can match.
 *
 * Each repetition then contains exactly one delimiter, at its end, so the k-th
 * repetition ends at the k-th delimiter in the text: no split for the engine to
 * retry. Atoms whose characters are unknown count as able to match the delimiter.
 */
function isDelimitedIteration(group: GroupAtom): boolean {
  if (group.lookaround || group.alternatives.length !== 1) return false;
  const body = group.alternatives[0] ?? [];
  const consuming: { readonly atom: CharacterAtom; readonly quantifier: Quantifier }[] = [];
  for (const item of body) {
    if (item.atom.kind === "group") return false;
    if (item.atom.kind === "character")
      consuming.push({ atom: item.atom, quantifier: item.quantifier });
  }
  const last = consuming[consuming.length - 1];
  if (last === undefined) return false;
  const delimiter = last.atom.literal;
  if (delimiter === undefined || last.quantifier.min !== 1 || last.quantifier.max !== 1) {
    return false;
  }
  for (const { atom } of consuming.slice(0, -1)) {
    if (atom.matches === undefined || matchesIgnoringCase(atom.matches, delimiter)) return false;
  }
  return true;
}

/**
 * True when two alternatives of the group can match the same text in more than one
 * way when repeated (`(a|aa)+`, `(a|[ab])*`):
 * - two plain words (`(ab|ac)`) clash only when one is a prefix of the other, since
 *   a set of words none of which starts another splits any text in one way at most;
 * - any other two alternatives clash when they can start with the same character.
 * Only alternatives whose possible first characters are all known take part: an
 * alternative starting with a nested group, a lookaround or an unknown atom is left
 * out rather than refused.
 */
function alternativesOverlap(group: GroupAtom): boolean {
  if (group.lookaround || group.alternatives.length < 2) return false;
  const starts: { readonly word: string | undefined; readonly first: CharacterTest[] }[] = [];
  for (const sequence of group.alternatives) {
    const first = firstCharacters(sequence);
    if (first !== undefined && first.length > 0)
      starts.push({ word: literalWord(sequence), first });
  }
  for (let left = 0; left < starts.length; left += 1) {
    for (let right = left + 1; right < starts.length; right += 1) {
      const one = starts[left];
      const other = starts[right];
      if (one === undefined || other === undefined) continue;
      const clash =
        one.word !== undefined && other.word !== undefined
          ? isPrefixIgnoringCase(one.word, other.word)
          : testsOverlap(one.first, other.first);
      if (clash) return true;
    }
  }
  return false;
}

/** The text of an alternative made only of literals matched once (`abc`), else undefined. */
function literalWord(sequence: Sequence): string | undefined {
  let word = "";
  for (const item of sequence) {
    const { atom, quantifier } = item;
    if (atom.kind !== "character" || atom.literal === undefined) return undefined;
    if (quantifier.min !== 1 || quantifier.max !== 1) return undefined;
    word += atom.literal;
  }
  return word;
}

/** True when one of the two words starts with the other, in any case. */
function isPrefixIgnoringCase(one: string, other: string): boolean {
  const left = one.toLowerCase();
  const right = other.toLowerCase();
  return left.startsWith(right) || right.startsWith(left);
}

/**
 * What the first character of a match of `sequence` can be: the tests of its leading
 * atoms, up to and including the first one that is required (min ≥ 1). `undefined`
 * when one of them is a group or an unknown atom.
 */
function firstCharacters(sequence: Sequence): CharacterTest[] | undefined {
  const tests: CharacterTest[] = [];
  for (const item of sequence) {
    if (item.atom.kind === "assertion") continue;
    if (item.atom.kind === "group" || item.atom.matches === undefined) return undefined;
    tests.push(item.atom.matches);
    if (item.quantifier.min >= 1) break;
  }
  return tests;
}

/**
 * Characters tried when asking whether two character tests can match the same
 * character: all of ASCII, plus a few others that negated classes and `.` match
 * (Latin-1, a no-break space, CJK, an emoji's first code unit, the line separator).
 * A heuristic: it is exact for the literals and ASCII classes real patterns use.
 */
const OVERLAP_SAMPLES: readonly string[] = [
  ...Array.from({ length: 128 }, (_, code) => String.fromCharCode(code)),
  "\u00e9", // é
  "\u00df", // ß
  "\u00a0",
  "\u4e2d", // a CJK ideograph
  "\ud83d",
  "\u2028",
];

/** True when some sample character matches a test of `left` and a test of `right`. */
function testsOverlap(left: readonly CharacterTest[], right: readonly CharacterTest[]): boolean {
  for (const sample of OVERLAP_SAMPLES) {
    const inLeft = left.some((test) => matchesIgnoringCase(test, sample));
    if (inLeft && right.some((test) => matchesIgnoringCase(test, sample))) return true;
  }
  return false;
}

/**
 * Whether `test` matches `character` in either case. The check does not know the
 * regex's flags, so it assumes `i` may be set; that only makes it more careful.
 */
function matchesIgnoringCase(test: CharacterTest, character: string): boolean {
  return test(character) || test(character.toLowerCase()) || test(character.toUpperCase());
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** `.` without the `s` flag: anything but a line terminator. */
const ANY_BUT_NEWLINE: CharacterTest = (character) => !/[\n\r\u2028\u2029]/.test(character);

/** The class escapes `\d`, `\w`, `\s` and their negations. */
const CLASS_ESCAPES: Readonly<Record<string, CharacterTest>> = {
  d: (character) => /\d/.test(character),
  D: (character) => /\D/.test(character),
  w: (character) => /\w/.test(character),
  W: (character) => /\W/.test(character),
  s: (character) => /\s/.test(character),
  S: (character) => /\S/.test(character),
};

/** Single-character control escapes: `\n` is a newline, and so on. */
const CONTROL_ESCAPES: Readonly<Record<string, string>> = {
  n: "\n",
  r: "\r",
  t: "\t",
  f: "\f",
  v: "\v",
  "0": "\0",
};

/** `{n}`, `{n,}` or `{n,m}` with their numbers. */
const BRACES = /^\{(\d+)(,(\d*))?\}/;

/** One character of a character class, or a class escape inside it. */
type ClassPart =
  | { readonly kind: "char"; readonly code: number }
  | { readonly kind: "test"; readonly test: CharacterTest }
  | { readonly kind: "unknown" };

/**
 * A small recursive-descent parser for the parts of the regex syntax the checks need.
 * It is forgiving: an unmatched `)` is skipped, an unclosed group or class ends at the
 * end of the pattern, and an unknown escape becomes an unknown atom.
 */
class PatternParser {
  /** The pattern being parsed. */
  private readonly pattern: string;
  /** Where parsing continues. */
  private index = 0;

  constructor(pattern: string) {
    this.pattern = pattern;
  }

  /** The whole pattern, as the alternatives of an implicit outer group. */
  parse(): readonly Sequence[] {
    const alternatives = this.alternatives();
    // A stray `)` at the top level: skip it and keep going (the RegExp constructor
    // reports the pattern as invalid later).
    while (this.index < this.pattern.length) {
      this.index += 1;
      alternatives.push(...this.alternatives());
    }
    return alternatives;
  }

  /** Alternatives separated by `|`, up to a `)` or the end of the pattern. */
  private alternatives(): Sequence[] {
    const alternatives: Sequence[] = [this.sequence()];
    while (this.pattern[this.index] === "|") {
      this.index += 1;
      alternatives.push(this.sequence());
    }
    return alternatives;
  }

  /** Items up to a `|`, a `)` or the end of the pattern. */
  private sequence(): Item[] {
    const items: Item[] = [];
    while (this.index < this.pattern.length) {
      const character = this.pattern[this.index];
      if (character === "|" || character === ")") break;
      const atom = this.atom();
      items.push({ atom, quantifier: this.quantifier() });
    }
    return items;
  }

  /** One atom, starting at the current position. */
  private atom(): Atom {
    const character = this.pattern[this.index] ?? "";
    if (character === "(") return this.group();
    if (character === "[") return this.characterClass();
    if (character === "\\") return this.escape();
    this.index += 1;
    if (character === "^" || character === "$") return { kind: "assertion" };
    if (character === ".")
      return { kind: "character", literal: undefined, matches: ANY_BUT_NEWLINE };
    return literalAtom(character);
  }

  /** A group, from its `(` to just after its `)`. */
  private group(): GroupAtom {
    this.index += 1;
    let lookaround = false;
    if (this.pattern[this.index] === "?") {
      const next = this.pattern[this.index + 1];
      const afterNext = this.pattern[this.index + 2];
      if (next === "=" || next === "!") {
        lookaround = true;
        this.index += 2;
      } else if (next === "<" && (afterNext === "=" || afterNext === "!")) {
        lookaround = true;
        this.index += 3;
      } else if (next === "<") {
        // A named group: skip `?<name>`.
        const close = this.pattern.indexOf(">", this.index);
        this.index = close === -1 ? this.pattern.length : close + 1;
      } else {
        // `(?:` and anything else after `(?`: skip the `?` and its marker.
        this.index += 2;
      }
    }
    const alternatives = this.alternatives();
    if (this.pattern[this.index] === ")") this.index += 1;
    return { kind: "group", alternatives, lookaround };
  }

  /** An escape outside a class: `\d`, `\.`, `\n`, `\b`, a backreference, … */
  private escape(): Atom {
    const escaped = this.pattern[this.index + 1] ?? "";
    this.index += 2;
    const classTest = CLASS_ESCAPES[escaped];
    if (classTest !== undefined)
      return { kind: "character", literal: undefined, matches: classTest };
    if (escaped === "b" || escaped === "B") return { kind: "assertion" };
    const control = CONTROL_ESCAPES[escaped];
    if (control !== undefined) return literalAtom(control);
    const code = this.hexEscape(escaped);
    if (code !== undefined) return literalAtom(String.fromCharCode(code));
    // `\.`, `\-`, `\(`, …: the character itself.
    if (escaped !== "" && !/[0-9A-Za-z]/.test(escaped)) return literalAtom(escaped);
    // Backreferences, `\p{…}`, `\cX`, `\k<name>`: consumes something, but what is unknown.
    return { kind: "character", literal: undefined, matches: undefined };
  }

  /**
   * The code of a `\xHH` or `\uHHHH` escape whose letter (`x`/`u`) was just read, and
   * moves past its digits; `undefined` (nothing read) when it is not one.
   */
  private hexEscape(letter: string): number | undefined {
    const length = letter === "x" ? 2 : letter === "u" ? 4 : 0;
    if (length === 0) return undefined;
    const digits = this.pattern.slice(this.index, this.index + length);
    if (digits.length !== length || !/^[0-9A-Fa-f]+$/.test(digits)) return undefined;
    this.index += length;
    return Number.parseInt(digits, 16);
  }

  /** A character class, from its `[` to just after its `]`. */
  private characterClass(): CharacterAtom {
    this.index += 1;
    const negated = this.pattern[this.index] === "^";
    if (negated) this.index += 1;
    const parts: ClassPart[] = [];
    const ranges: [number, number][] = [];
    // A `]` right after `[` or `[^` is a literal in PCRE.
    if (this.pattern[this.index] === "]") {
      parts.push({ kind: "char", code: "]".charCodeAt(0) });
      this.index += 1;
    }
    while (this.index < this.pattern.length && this.pattern[this.index] !== "]") {
      const part = this.classPart();
      const isRange =
        part.kind === "char" &&
        this.pattern[this.index] === "-" &&
        this.index + 1 < this.pattern.length &&
        this.pattern[this.index + 1] !== "]";
      if (!isRange) {
        parts.push(part);
        continue;
      }
      this.index += 1;
      const end = this.classPart();
      if (end.kind === "char") {
        ranges.push([part.code, end.code]);
      } else {
        // `[a-\d]`: the `-` is a literal next to both sides.
        parts.push(part, { kind: "char", code: "-".charCodeAt(0) }, end);
      }
    }
    if (this.pattern[this.index] === "]") this.index += 1;
    if (parts.some((part) => part.kind === "unknown")) {
      return { kind: "character", literal: undefined, matches: undefined };
    }
    const matches: CharacterTest = (character) => {
      const code = character.charCodeAt(0);
      const inClass =
        ranges.some(([low, high]) => code >= low && code <= high) ||
        parts.some((part) =>
          part.kind === "char" ? part.code === code : part.kind === "test" && part.test(character),
        );
      return negated ? !inClass : inClass;
    };
    return { kind: "character", literal: undefined, matches };
  }

  /** One member of a character class: a character, an escape, or a class escape. */
  private classPart(): ClassPart {
    const character = this.pattern[this.index] ?? "";
    this.index += 1;
    if (character !== "\\") return { kind: "char", code: character.charCodeAt(0) };
    const escaped = this.pattern[this.index] ?? "";
    this.index += 1;
    const classTest = CLASS_ESCAPES[escaped];
    if (classTest !== undefined) return { kind: "test", test: classTest };
    // Inside a class `\b` is a backspace.
    if (escaped === "b") return { kind: "char", code: 8 };
    const control = CONTROL_ESCAPES[escaped];
    if (control !== undefined) return { kind: "char", code: control.charCodeAt(0) };
    const code = this.hexEscape(escaped);
    if (code !== undefined) return { kind: "char", code };
    if (escaped !== "" && !/[0-9A-Za-z]/.test(escaped)) {
      return { kind: "char", code: escaped.charCodeAt(0) };
    }
    return { kind: "unknown" };
  }

  /** The quantifier at the current position (ONCE when there is none). */
  private quantifier(): Quantifier {
    const character = this.pattern[this.index];
    let result: Quantifier | undefined;
    if (character === "*") result = { min: 0, max: undefined };
    else if (character === "+") result = { min: 1, max: undefined };
    else if (character === "?") result = { min: 0, max: 1 };
    if (result !== undefined) {
      this.index += 1;
    } else if (character === "{") {
      const braces = BRACES.exec(this.pattern.slice(this.index, this.index + 32));
      if (braces === null) return ONCE; // a literal `{`, read as the next atom
      const min = Number(braces[1]);
      const hasComma = braces[2] !== undefined;
      const maxText = hasComma ? braces[3] : braces[1];
      result = { min, max: maxText === "" || maxText === undefined ? undefined : Number(maxText) };
      this.index += braces[0].length;
    } else {
      return ONCE;
    }
    // A trailing `?` (lazy) or `+` (possessive in PCRE) changes nothing here.
    const modifier = this.pattern[this.index];
    if (modifier === "?" || modifier === "+") this.index += 1;
    return result;
  }
}

/** A literal character atom (`a`, or `.` from `\.`). */
function literalAtom(character: string): CharacterAtom {
  return { kind: "character", literal: character, matches: (other) => other === character };
}
