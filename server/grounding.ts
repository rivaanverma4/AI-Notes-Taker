/**
 * Deterministic transcript grounding.
 *
 * Local language models occasionally add plausible textbook facts that the
 * lecturer never said. Prompting alone does not reliably prevent this, so every
 * generated note is checked against the transcript with a fast, offline
 * token-level test. Sentences (or trailing clauses) that contain content words
 * absent from the transcript are removed before the notes are saved.
 *
 * The filter is intentionally conservative: it only removes material, never
 * rewrites it, and it keeps generic academic language so ordinary paraphrases
 * survive. Proper nouns are matched with a small edit distance to tolerate
 * speech-recognition spelling differences (for example Ingenhousz/Ingenhaus).
 */

const STOPWORDS = new Set(
  `
  a an the and or but if then than that this these those of in on at to for from by
  with without into over under about as is are was were be been being it its their
  there here we you i he she they them our your my me us do does did done have has
  had having can could should would may might must will shall not no nor so such very
  more most less least also just only even both each other some any all own same too
  now up out off again further once during before after above below between through
  because while where when who whom which what why how
  today yesterday tomorrow
  add adds added adding allow allows allowed appear appears appeared apply applies
  applied argue argues argued ask asks asked become becomes became begin begins began
  call calls called change changes changed come comes came compare compares compared
  complete completes completed consider considers considered continue continues
  continued cover covers covered create creates created define defines defined
  describe describes described develop develops developed differ differs differed
  discuss discusses discussed distinguish distinguishes distinguished
  demonstrate demonstrates demonstrated demonstrating draw draws drew
  examine examines examined explain explains explained explore explores explored
  express expresses expressed feel feels felt find finds found focus focuses focused
  follow follows followed get gets got give gives gave go goes went grow grows grew
  happen happens happened help helps helped highlight highlights highlighted hold
  holds held identify identifies identified illustrate illustrates illustrated imply
  implies implied include includes included indicate indicates indicated introduce
  introduces introduced involve involves involved keep keeps kept know knows knew lead
  leads led learn learns learned let lets like likes list lists listed look looks
  looked make makes made mean means meant mention mentions mentioned move moves moved
  need needs needed note notes noted notice notices noticed obtain obtains obtained
  occur occurs occurred offer offers offered organize organizes organized outline
  outlines outlined perform performs performed place places placed point points
  pointed present presents presented provide provides provided put puts raise raises
  raised refer refers referred relate relates related remain remains remained
  remember remembers remembered require requires required result results resulted say
  says said see sees saw seem seems seemed select selects selected serve serves served
  set sets show shows showed shown state states stated study studies studied suggest
  suggests suggested take takes took talk talks talked tell tells told think thinks
  thought turn turns turned understand understands understood use uses used want wants
  wanted work works worked write writes wrote
  addition additionally advantage alternative amount analysis approach area aspect
  assumption attention basis body brief case cause central certain characteristic
  clear clearly common commonly comparison conclusion condition consequence
  considerable consist context contrast course data detail detailed difference
  different difficult directly discussion effect emphasis entire especially essential
  evidence fact factor feature final finally following form fundamental general
  generally given good great group idea importance important including individual
  information instance interest interesting key kind known large later lecture main
  mainly major manner material matter meaning method minor moment nature necessary
  new next number obvious often one overall particular particularly part perhaps
  place point possible practical precise primarily primary principle probably problem
  process proper properly purpose question quite rather reason recent recently
  reference regard regular related relationship relevant result review role same
  second section sense several short significance significant similar simple simply
  situation small specific stage standard study subject substantial sufficient
  summary support sure term thing time topic total type typical typically
  understanding unit useful usual value various view way whole within
  method methods convert converts converted converting
  `.split(/\s+/),
);

const CLAUSE_SEPARATOR =
  /(\s*,\s*|\s*;\s*|\s+and\s+|\s+but\s+|\s+or\s+|\s+while\s+|\s+which\s+|\s+that\s+|\s+where\s+|\s+within\s+|\s+inside\s+|\s+of\s+|\s+in\s+|\s+from\s+|\s+for\s+|\s+with\s+|\s+to\s+|\s+by\s+|\s+as\s+)/i;

interface GroundingContext {
  tokens: Set<string>;
  cache: Map<string, boolean>;
}

export interface GroundingResult {
  markdown: string;
  removedSentences: number;
  removedLines: number;
}

function normalizeToken(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[\u2019']s$/, "")
    .replace(/[^a-z0-9-]/g, "");
}

function stem(word: string): string {
  let value = word;
  for (const suffix of ["ingly", "edly", "ing", "ed", "ly", "es", "s"]) {
    if (value.length > suffix.length + 3 && value.endsWith(suffix)) {
      value = value.slice(0, -suffix.length);
      break;
    }
  }
  return value;
}

function tokenize(text: string): string[] {
  const matches = text.match(/[A-Za-z0-9][A-Za-z0-9'\u2019-]*/g) ?? [];
  return matches.map(normalizeToken).filter(Boolean);
}

function stripMath(text: string): string {
  return text
    .replace(/\\\[[\s\S]*?\\\]/g, " ")
    .replace(/\\\([\s\S]*?\\\)/g, " ")
    .replace(/\$\$[\s\S]*?\$\$/g, " ")
    .replace(/\$[^$]*\$/g, " ")
    .replace(/`[^`]*`/g, " ");
}

const MATH_SPAN =
  /\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|\$\$[\s\S]*?\$\$|\$[^$\n]*\$/g;

/**
 * Hide math spans while grounding prose. Otherwise removing an unsupported
 * parenthetical can eat a chunk of a formula and leave a dangling backslash.
 */
function maskMath(text: string): { masked: string; spans: string[] } {
  const spans: string[] = [];
  const masked = text.replace(MATH_SPAN, (match) => {
    const token = `\u0000${spans.length}\u0000`;
    spans.push(match);
    return token;
  });
  return { masked, spans };
}

function unmaskMath(text: string, spans: string[]): string {
  return text.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => {
    return spans[Number(index)] ?? "";
  });
}

function significantTokens(text: string): string[] {
  return tokenize(stripMath(text)).filter(
    (token) => token.length >= 2 && !STOPWORDS.has(token),
  );
}

function levenshtein(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const previous = new Array<number>(b.length + 1);
  const current = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) previous[j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    let rowMinimum = current[0];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, substitution);
      rowMinimum = Math.min(rowMinimum, current[j]);
    }
    if (rowMinimum > max) return max + 1;
    for (let j = 0; j <= b.length; j += 1) previous[j] = current[j];
  }
  return previous[b.length];
}

function matchesTranscript(word: string, context: GroundingContext): boolean {
  const variants = new Set([word, stem(word)]);
  const digitless = word.replace(/^\d+/, "");
  if (digitless && digitless !== word) variants.add(digitless);
  const compound = word.includes("-");

  for (const variant of variants) {
    if (context.tokens.has(variant)) return true;
  }

  // Hyphenated compounds are checked part-by-part by the caller. Prefix and
  // fuzzy matching on the compound itself would confuse light-dependent with
  // light-independent, so only exact matches are trusted here.
  if (compound) return false;

  for (const variant of variants) {
    if (variant.length < 4) continue;
    for (const known of context.tokens) {
      if (known.length < 4) continue;
      if (known.startsWith(variant) || variant.startsWith(known)) return true;
    }
  }

  for (const variant of variants) {
    if (variant.length < 6) continue;
    const maxDistance = variant.length >= 9 ? 2 : 1;
    for (const known of context.tokens) {
      if (known.length < 4) continue;
      if (known[0] !== variant[0]) continue;
      const lengthDelta = Math.abs(known.length - variant.length);
      if (lengthDelta > maxDistance) continue;
      // A two-edit match is only trusted for near-identical spellings.
      if (maxDistance === 2 && lengthDelta > 1) continue;
      if (levenshtein(variant, known, maxDistance) <= maxDistance) return true;
    }
  }

  return false;
}

function isSupportedToken(token: string, context: GroundingContext): boolean {
  const cached = context.cache.get(token);
  if (cached !== undefined) return cached;

  let supported: boolean;
  if (token.includes("-")) {
    const parts = token.split("-").filter(Boolean);
    supported =
      matchesTranscript(token, context) ||
      (parts.length > 1 &&
        parts.every((part) => part.length < 2 || matchesTranscript(part, context)));
  } else {
    supported = matchesTranscript(token, context);
  }

  context.cache.set(token, supported);
  return supported;
}

function isSupportedText(text: string, context: GroundingContext): boolean {
  return significantTokens(text).every((token) =>
    isSupportedToken(token, context),
  );
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"“(\[])/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

interface Clause {
  text: string;
  separator: string;
}

function splitClauses(text: string): Clause[] {
  const parts = text.split(CLAUSE_SEPARATOR);
  const clauses: Clause[] = [];
  for (let index = 0; index < parts.length; index += 2) {
    clauses.push({
      text: parts[index] ?? "",
      separator: index === 0 ? "" : (parts[index - 1] ?? " "),
    });
  }
  return clauses;
}

function tidy(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([,;:])\1+/g, "$1")
    .trim();
}

/**
 * Keep the longest supported prefix of a sentence. This removes unsupported
 * trailing phrases such as "within chloroplasts" without deleting the
 * supported part of the same bullet.
 */
function groundSentence(
  sentence: string,
  context: GroundingContext,
  minSignificant = 2,
): string | null {
  const { masked, spans } = maskMath(sentence.trim());
  let text = masked;
  if (!text) return null;
  const hadTerminalPunctuation = /[.!?]$/.test(text);

  // Remove parenthetical asides that introduce unsupported material. Math is
  // masked, so parentheses inside LaTeX are never touched.
  text = text.replace(/\s*\(([^()]*)\)/g, (match, inner: string) =>
    isSupportedText(inner, context) ? match : "",
  );
  text = tidy(text);

  if (!text) return null;
  if (isSupportedText(text, context)) return unmaskMath(text, spans);

  const clauses = splitClauses(text);
  let prefixEnd = 0;
  let prefixSignificant = 0;

  for (const clause of clauses) {
    if (!isSupportedText(clause.text, context)) break;
    prefixEnd += 1;
    prefixSignificant += significantTokens(clause.text).length;
  }

  if (prefixEnd === 0 || prefixSignificant < minSignificant) return null;

  let result = "";
  for (let index = 0; index < prefixEnd; index += 1) {
    const clause = clauses[index];
    result +=
      index === 0
        ? clause.text.trim()
        : `${clause.separator}${clause.text.trim()}`;
  }

  result = tidy(result)
    .replace(/[\s,;:]+(?:and|but|or|of|in|with|for|to|from|by|as)$/i, "")
    .trim();

  if (significantTokens(result).length < minSignificant) return null;

  // A prefix cut in the middle of a list or clause often leaves a fragment
  // such as "The process where sunlight, water." Drop it rather than saving
  // an unreadable half-sentence.
  if (prefixEnd < clauses.length) {
    if (/[,;:]$/.test(result)) return null;
    const lastWord = result.split(/\s+/).at(-1)?.toLowerCase() ?? "";
    if (
      [
        "the",
        "a",
        "an",
        "of",
        "in",
        "on",
        "with",
        "and",
        "or",
        "where",
        "which",
        "that",
        "to",
        "for",
        "from",
        "by",
        "as",
        "is",
        "are",
        "was",
        "were",
      ].includes(lastWord)
    ) {
      return null;
    }
    if (prefixSignificant < 4) return null;
  }

  if (hadTerminalPunctuation && !/[.!?]$/.test(result)) result += ".";
  return unmaskMath(result, spans);
}

function sectionKey(heading: string): string {
  return heading
    .replace(/^#+\s*/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

interface DisplayMath {
  close: string;
  closesOnLine: boolean;
}

/** Detect display math that may start in the middle of a line. */
function displayMathOnLine(line: string): DisplayMath | null {
  const bracket = line.indexOf("\\[");
  const dollar = line.indexOf("$$");
  if (bracket === -1 && dollar === -1) return null;
  const close =
    bracket !== -1 && (dollar === -1 || bracket < dollar) ? "\\]" : "$$";
  const start = close === "\\]" ? bracket : dollar;
  return { close, closesOnLine: line.slice(start + 2).includes(close) };
}

/**
 * Keep a heading but drop parenthetical glosses the lecturer never said, such
 * as "Dark Reactions (or Carbon Fixation Stage)".
 */
function groundHeading(line: string, context: GroundingContext): string {
  const match = line.match(/^(#{1,6}\s+)(.*)$/);
  if (!match) return line;
  let text = match[2].replace(/\s*\(([^()]*)\)/g, (whole, inner: string) => {
    if (/^\d{1,2}:\d{2}(?::\d{2})?$/.test(inner.trim())) return whole;
    return isSupportedText(inner, context) ? whole : "";
  });
  text = tidy(text).replace(/[\s,;:–—-]+$/, "").trim();
  return text ? `${match[1]}${text}` : "";
}

/** Keep the first occurrence of each H2 section. */
function dedupeSections(markdown: string): string {
  const lines = markdown.split("\n");
  const output: string[] = [];
  const seen = new Set<string>();
  let skipping = false;

  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+)$/);
    if (h2) {
      const key = sectionKey(h2[1]);
      if (seen.has(key)) {
        skipping = true;
        continue;
      }
      seen.add(key);
      skipping = false;
      output.push(line);
      continue;
    }

    if (/^#\s+/.test(line)) {
      skipping = false;
      output.push(line);
      continue;
    }

    if (!skipping) output.push(line);
  }

  return output.join("\n");
}

/** Remove headings whose section ended up with no prose. */
function removeEmptySections(markdown: string): string {
  const lines = markdown.split("\n");
  const blocks: Array<{ heading: string | null; lines: string[] }> = [];
  let current: { heading: string | null; lines: string[] } = {
    heading: null,
    lines: [],
  };

  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      blocks.push(current);
      current = { heading: line, lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  blocks.push(current);

  const kept = blocks.filter((block) => {
    if (!block.heading) return true;
    return block.lines.some(
      (line) => line.trim().length > 0 && !/^#{1,6}\s+/.test(line.trim()),
    );
  });

  const text = kept
    .map((block) =>
      block.heading ? [block.heading, ...block.lines].join("\n") : block.lines.join("\n"),
    )
    .join("\n");

  return removeEmptyHeadings(text);
}

/** Remove H3/H4 headings left with no content beneath them. */
function removeEmptyHeadings(markdown: string): string {
  const lines = markdown.split("\n");
  const output: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const heading = line.match(/^(#{1,6})\s+/);
    if (heading) {
      let next = index + 1;
      while (next < lines.length && !lines[next].trim()) next += 1;
      if (next >= lines.length) continue;
      const nextHeading = lines[next].match(/^(#{1,6})\s+/);
      if (nextHeading && nextHeading[1].length <= heading[1].length) continue;
    }
    output.push(line);
  }

  return output.join("\n");
}

/** Drop repeated bullet content, keeping the first occurrence. */
function dedupeBullets(markdown: string): string {
  const lines = markdown.split("\n");
  const output: string[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    const bullet = line.match(/^\s*(?:[-*+]|\d+\.)\s+(.+)$/);
    if (bullet) {
      const key = bullet[1]
        .toLowerCase()
        .replace(/[*_`]/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (seen.has(key)) continue;
      seen.add(key);
    }
    output.push(line);
  }

  return output.join("\n");
}

/**
 * Remove unsupported content from generated notes.
 *
 * @param markdown Generated Markdown notes.
 * @param transcript Full lecture transcript, optionally timestamped.
 */
export function groundNotes(
  markdown: string,
  transcript: string,
): GroundingResult {
  const context: GroundingContext = {
    tokens: new Set<string>(),
    cache: new Map(),
  };
  for (const token of tokenize(transcript)) {
    context.tokens.add(token);
    const digitless = token.replace(/^\d+/, "");
    if (digitless && digitless !== token) context.tokens.add(digitless);
  }

  const lines = markdown.split("\n");
  const output: string[] = [];
  let removedSentences = 0;
  let removedLines = 0;
  let mathClose: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    if (mathClose) {
      output.push(line);
      if (trimmed.includes(mathClose)) mathClose = null;
      continue;
    }

    const displayMath = displayMathOnLine(line);
    if (displayMath) {
      // Preserve formulas exactly as generated, including display math that
      // starts mid-line. Grounding the surrounding prose is less important
      // than never corrupting an equation.
      output.push(line);
      if (!displayMath.closesOnLine) mathClose = displayMath.close;
      continue;
    }

    if (!trimmed || /^[-*_]{3,}$/.test(trimmed)) {
      output.push(line);
      continue;
    }

    if (/^#{1,6}\s+/.test(trimmed)) {
      const heading = groundHeading(line, context);
      if (heading) output.push(heading);
      else removedLines += 1;
      continue;
    }

    // Generated notes must not contain raw timestamped transcript lines.
    if (/^\s*(?:[-*+]\s+)?\[\d{1,2}:\d{2}(?::\d{2})?\]\s+/.test(trimmed)) {
      removedLines += 1;
      continue;
    }

    const bullet = line.match(/^(\s*(?:[-*+]|\d+\.)\s+)/);
    const prefix = bullet?.[1] ?? "";
    let body = prefix ? line.slice(prefix.length) : line;

    let label = "";
    const labelMatch = body.match(/^(\*\*[^*]+\*\*:\s*)/);
    if (labelMatch) {
      const labelTokens = significantTokens(labelMatch[1]);
      if (labelTokens.some((token) => !isSupportedToken(token, context))) {
        removedLines += 1;
        continue;
      }
      label = labelMatch[1];
      body = body.slice(label.length);
    }

    const kept: string[] = [];
    for (const sentence of splitSentences(body)) {
      const grounded = groundSentence(sentence, context, label ? 1 : 2);
      if (grounded === null) {
        removedSentences += 1;
        continue;
      }
      kept.push(grounded);
    }

    if (kept.length === 0) {
      if (body.trim()) removedLines += 1;
      continue;
    }

    output.push(prefix + label + kept.join(" "));
  }

  let result = output.join("\n").replace(/\n{3,}/g, "\n\n");
  result = dedupeSections(result);
  result = dedupeBullets(result);
  result = removeEmptySections(result);

  return {
    markdown: result.trim(),
    removedSentences,
    removedLines,
  };
}
