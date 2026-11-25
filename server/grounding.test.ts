import { describe, expect, it } from "vitest";
import { groundNotes } from "./grounding";

const TRANSCRIPT = `Today we discuss photosynthesis. Plants use sunlight, water, and carbon dioxide to produce glucose and oxygen.
The light reactions happen in the thylakoid membrane. The Calvin cycle happens in the stroma.
The overall equation is six CO2 plus six H2O yields glucose and six O2.
Jan Ingenhousz showed in 1779 that sunlight is required. A variegated leaf has green and white patches.`;

describe("groundNotes", () => {
  it("removes unsupported facts but keeps supported material", () => {
    const result = groundNotes(
      `# Photosynthesis

## Main Topics
- The Calvin cycle happens in the stroma.
- ATP and NADPH are produced by the electron transport chain.
- A variegated leaf has green and white patches.
`,
      TRANSCRIPT,
    );

    expect(result.markdown).toContain("Calvin cycle happens in the stroma");
    expect(result.markdown).toContain("variegated leaf");
    expect(result.markdown).not.toContain("ATP");
    expect(result.markdown).not.toContain("NADPH");
    expect(result.markdown).not.toContain("electron transport chain");
  });

  it("preserves inline formulas instead of leaving dangling backslashes", () => {
    const result = groundNotes(
      `# Photosynthesis

## Formulas & Equations
- **Overall equation**: \\(6 CO_2 + 6 H_2O \\rightarrow C_6H_{12}O_6 + 6 O_2\\) (with energy released)
`,
      TRANSCRIPT,
    );

    expect(result.markdown).toContain("6 CO_2 + 6 H_2O");
    expect(result.markdown).toContain("C_6H_{12}O_6 + 6 O_2");
    expect(result.markdown).not.toMatch(/\\\s*\./);
  });

  it("drops unsupported parentheticals from headings", () => {
    const result = groundNotes(
      `# Photosynthesis

## Dark Reactions (or Carbon Fixation Stage)
- The Calvin cycle happens in the stroma.
`,
      TRANSCRIPT,
    );

    expect(result.markdown).toContain("## Dark Reactions");
    expect(result.markdown).not.toContain("Carbon Fixation Stage");
  });

  it("keeps display math that starts mid-line and spans lines", () => {
    const result = groundNotes(
      `# Photosynthesis

## Formulas & Equations
- The lecturer wrote \\[
6 CO_2 + 6 H_2O \\rightarrow C_6H_{12}O_6 + 6 O_2
\\] on the board.
`,
      TRANSCRIPT,
    );

    expect(result.markdown).toContain("\\[");
    expect(result.markdown).toContain("6 CO_2 + 6 H_2O");
    expect(result.markdown).toContain("\\]");
    expect(result.markdown).not.toMatch(/\\\s*$/m);
  });

  it("removes raw timestamped transcript lines", () => {
    const result = groundNotes(
      `# Photosynthesis

## Notes
- [00:12] Today we discuss photosynthesis.
- The Calvin cycle happens in the stroma.
`,
      TRANSCRIPT,
    );

    expect(result.markdown).not.toContain("[00:12]");
    expect(result.markdown).toContain("Calvin cycle happens in the stroma");
  });
});
