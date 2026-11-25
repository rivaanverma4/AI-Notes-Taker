import type { TranscriptSegment } from "../shared/types";
import { formatTimestamp } from "./db";

export const SYSTEM_PROMPT = `You are an expert academic note-taker for university lectures. You convert lecture transcripts into complete, accurate, well-organized study notes.

NON-NEGOTIABLE RULES:
1. The transcript is your ONLY source of information. Do not use prior knowledge, even for well-known terms.
2. Never add details, definitions, explanations, causes, mechanisms, acronyms, examples, or consequences that were not explicitly spoken. If the lecturer only names a term, do not define it from general knowledge.
3. A definition may be written only when the lecturer actually states what the term means. Otherwise, list the term without inventing a definition.
4. Preserve important explanations, examples, statistics, names, dates, formulas, and relationships that are actually discussed. Completeness matters more than brevity, but accuracy matters most.
5. Do not copy the transcript verbatim. Explain and organize the material clearly using only the lecturer's content.
6. If the transcript is garbled or a term is genuinely unclear, mark it as [unclear] and add it to the review questions. Never guess.
7. Do not duplicate the same information in multiple sections.
8. When in doubt, leave it out. A shorter accurate note is better than a longer invented one.
9. Output GitHub-flavored Markdown only. No preamble, commentary, or code fences.
10. Start with exactly one H1 title.
11. Never include raw transcript excerpts, speaker labels, or timestamped transcript lines such as "[12:34] the lecturer said...". A timestamp may appear only as a short inline reference like "(12:34)" beside a topic or fact.
12. Never add sections called "Additional Information", "Additional Notes", "Transcript", or similar meta sections. Do not quote long passages.
13. Write every formula in LaTeX on one line. Never split a formula across lines or bullets, and never leave a dangling backslash. Explain a symbol only if the lecturer explained it.
14. Do not add parenthetical glosses or alternate names to headings unless the lecturer actually used them.

Use this structure, omitting sections that genuinely have no content:
# Descriptive Lecture Title
## Overview
A concise 2–5 sentence overview of the lecture's purpose and scope, using only what was said.
## Main Topics
### Topic name
Detailed notes with bullet points, explanations, and examples that were actually discussed.
### Subtopic
...
## Key Definitions
- **Term** — definition exactly as the lecture explained it. Omit terms the lecturer did not define.
## Formulas & Equations
- Formula in LaTeX when applicable, followed by what each symbol means and when it is used — only if the lecture stated this.
## Important Names, Dates & Events
- Name/date/event and why it matters, only when discussed.
## Connections & Relationships
- How concepts relate to, depend on, or differ from each other, only when the lecture stated the relationship.
## Questions to Review
- Gaps, ambiguities, or questions a student should revisit.

Include [mm:ss] timestamps for major topics and key facts when timestamps are present in the transcript. Keep the notes detailed enough to study from without replaying the lecture.`;

function timestamped(segments: TranscriptSegment[]): string {
  return segments
    .map((segment) => `[${formatTimestamp(segment.start_ms)}] ${segment.text}`)
    .join("\n");
}

function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[Transcript truncated for context length. Preserve the notes already written for earlier material.]`;
}

export function buildInitialNotesPrompt(transcript: string): string {
  return `Create comprehensive lecture notes from the transcript below.

Requirements:
- Capture every important concept and explanation.
- Include definitions, examples, statistics, names, dates, formulas, and relationships that are actually discussed.
- Use short paragraphs, bullet points, and numbered lists where they improve clarity.
- Do not invent anything or use outside knowledge.
- Do not simply copy the transcript.
- Do not include raw transcript lines, speaker labels, or a "Transcript"/"Additional Information" section.
- Keep each formula on one line in LaTeX; do not split formulas or leave dangling backslashes.

Transcript:
---
${clip(transcript, 46_000)}
---`;
}

export function buildUpdateNotesPrompt(
  existingNotes: string,
  newTranscript: string,
  title: string,
): string {
  return `You are maintaining live lecture notes. Integrate the new transcript material into the existing notes.

CURRENT NOTES:
---
${existingNotes}
---

NEW TRANSCRIPT:
---
${clip(newTranscript, 10_000)}
---

Instructions:
- Return the COMPLETE updated notes, starting with the single H1 title.
- Preserve all important details and explanations already in the notes. Do not shorten existing sections.
- Merge new information into the most relevant existing sections when it adds context.
- If the lecturer clearly changes topic, add a new section at the appropriate place.
- Remove accidental duplication, but never remove substantive detail.
- Keep the current title unless the new material clearly justifies a better one. Current title: "${title}".
- Use [mm:ss] timestamps where they help.
- Do not add outside knowledge or invent facts. Mark genuinely unclear material as [unclear].
- Output Markdown only, with no commentary or code fences.`;
}

export function buildFinalNotesPrompt(
  existingNotes: string,
  transcript: string,
  title: string,
): string {
  const notesBlock = existingNotes.trim()
    ? `CURRENT COMPLETE NOTES:\n---\n${existingNotes}\n---`
    : `CURRENT NOTES: (none yet)`;
  return `Produce the final, polished study notes for this lecture.

${notesBlock}

FULL LECTURE TRANSCRIPT (for verification and any details not yet integrated):
---
${clip(transcript, 42_000)}
---

Instructions:
- Return a single complete Markdown document starting with one H1 title.
- Preserve every important fact, explanation, example, definition, formula, name, date, statistic, and relationship.
- Improve organization and readability. Do not over-summarize.
- Integrate any transcript material that is missing from the current notes.
- Keep the title concise and descriptive. Current title: "${title}".
- Include [mm:ss] timestamps for major sections where available.
- Add a short Overview and Questions to Review section.
- Use ONLY information from the transcript. Do not add outside knowledge. Mark unclear material as [unclear].
- Do not include raw transcript excerpts, speaker labels, or lines beginning with a timestamp. Timestamps are references only, not content.
- Do not add "Additional Information", "Transcript", or other meta sections.
- Keep each formula on one line in LaTeX. Never split a formula across lines or leave a dangling backslash.
- Output Markdown only. No preamble, commentary, or code fences.`;
}

export function cleanGeneratedMarkdown(raw: string, fallbackTitle: string): string {
  let text = raw.trim();
  text = text.replace(/^```(?:markdown|md)?\s*/i, "").replace(/\s*```$/i, "");
  text = text.replace(/^Here (?:are|is)[^\n]*\n+/i, "").trim();

  const firstHeading = text.search(/^#{1,2}\s+/m);
  if (firstHeading > 0) text = text.slice(firstHeading).trim();

  if (!/^#\s+/m.test(text)) {
    text = `# ${fallbackTitle}\n\n${text}`;
  } else if (!/^#\s+/m.test(text.split("\n")[0] ?? "")) {
    // A leading H2 before the title is acceptable only if we can find an H1.
    const match = text.match(/^#\s+(.+)$/m);
    if (match) {
      const before = text.slice(0, text.indexOf(match[0])).trim();
      text = `# ${match[1].trim()}\n\n${before ? `${before}\n\n` : ""}${text
        .slice(text.indexOf(match[0]) + match[0].length)
        .trim()}`;
    }
  }

  return text.trim();
}

export function extractTitle(markdown: string): string | null {
  const match = markdown.match(/^#\s+(.+)$/m);
  if (!match) return null;
  return match[1]
    .replace(/\*\*/g, "")
    .replace(/[*_`]/g, "")
    .trim()
    .slice(0, 180);
}
