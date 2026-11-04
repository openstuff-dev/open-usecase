import { AstBuilder, GherkinClassicTokenMatcher, Parser } from '@cucumber/gherkin';
import { IdGenerator } from '@cucumber/messages';

/** The text isn't acceptable. `message` says why, for the agent that sent it. */
export class GherkinError extends Error {}

export interface ParsedScenario {
  /** The number from its `@S2` tag; null until the server assigns one. */
  number: number | null;
  name: string;
  steps: string[];
  /** 1-based line of the `Scenario:` keyword. */
  line: number;
  /** 1-based column of the `Scenario:` keyword. */
  column: number;
  /** 1-based line where it starts, counting its tags. */
  firstLine: number;
}

const SCENARIO_TAG = /^@S(\d+)$/;

/** Parses standard Gherkin in the project's language. Throws GherkinError if it isn't valid. */
export function parseUseCase(text: string, language: string): ParsedScenario[] {
  const parser = new Parser(
    new AstBuilder(IdGenerator.uuid()),
    new GherkinClassicTokenMatcher(language),
  );
  let feature;
  try {
    feature = parser.parse(text).feature;
  } catch (error) {
    throw new GherkinError(`The Gherkin doesn't parse. ${(error as Error).message}`, {
      cause: error,
    });
  }
  if (!feature) throw new GherkinError('The Gherkin has no Feature.');
  if (feature.language !== language) {
    throw new GherkinError(
      `This project's use cases are in "${language}", but this text is in "${feature.language}".`,
    );
  }
  const refuseScenarioTag = (tags: readonly { name: string }[], where: string) => {
    const tag = tags.find((t) => SCENARIO_TAG.test(t.name));
    if (tag) throw new GherkinError(`${tag.name} is on a ${where}. Put it on one Scenario.`);
  };
  refuseScenarioTag(feature.tags, 'Feature');

  const scenarios: ParsedScenario[] = [];
  for (const child of feature.children) {
    const inside = child.rule ? child.rule.children : [child];
    if (child.rule) refuseScenarioTag(child.rule.tags, 'Rule');
    for (const { scenario } of inside) {
      if (!scenario) continue;
      const numbers = scenario.tags.flatMap((t) => {
        const match = SCENARIO_TAG.exec(t.name);
        return match ? [Number(match[1])] : [];
      });
      if (numbers.length > 1) {
        throw new GherkinError(`"${scenario.name}" has more than one scenario tag. Keep one.`);
      }
      scenarios.push({
        number: numbers[0] ?? null,
        name: scenario.name,
        steps: scenario.steps.map((step) => `${step.keyword}${step.text}`),
        line: scenario.location.line,
        column: scenario.location.column ?? 1,
        firstLine: Math.min(scenario.location.line, ...scenario.tags.map((t) => t.location.line)),
      });
    }
  }
  if (scenarios.length === 0) throw new GherkinError('The Gherkin has no Scenario.');
  return scenarios;
}

export interface TaggedUseCase {
  /** The text with an `@S<n>` tag on every scenario. */
  gherkin: string;
  scenarios: (ParsedScenario & { number: number })[];
  /** The number the next new scenario gets. */
  nextNumber: number;
}

/**
 * Gives every scenario without a tag the next free number, and refuses any tag this use case was
 * never given. A scenario whose meaning changed leaves its tag off, so it gets a new number and an
 * old test can't appear to prove it.
 */
export function assignScenarioTags(
  text: string,
  language: string,
  known: ReadonlySet<number>,
  firstFree: number,
): TaggedUseCase {
  const parsed = parseUseCase(text, language);
  const seen = new Set<number>();
  for (const scenario of parsed) {
    if (scenario.number === null) continue;
    if (!known.has(scenario.number)) {
      throw new GherkinError(
        `@S${scenario.number} on "${scenario.name}" wasn't assigned to this use case. ` +
        'Leave the tag off and the server assigns one.',
      );
    }
    if (seen.has(scenario.number)) {
      throw new GherkinError(`@S${scenario.number} is on more than one scenario. Keep it on one.`);
    }
    seen.add(scenario.number);
  }

  let next = firstFree;
  const lines = text.split('\n');
  const scenarios = parsed.map((scenario) => ({
    ...scenario,
    number: scenario.number ?? next++,
  }));
  // From the bottom up, so inserting a line doesn't move the ones still to do.
  for (let i = parsed.length - 1; i >= 0; i--) {
    const { number, line, column } = parsed[i];
    if (number !== null) continue;
    lines.splice(line - 1, 0, `${' '.repeat(column - 1)}@S${String(scenarios[i]?.number)}`);
  }
  return { gherkin: lines.join('\n'), scenarios, nextNumber: next };
}

/** Removes the indent the lines share, and blank lines at the end. */
function dedent(lines: string[]): string {
  const used = lines.filter((line) => line.trim());
  const indent = Math.min(...used.map((line) => line.length - line.trimStart().length));
  return lines
    .map((line) => line.slice(indent))
    .join('\n')
    .trimEnd();
}

export interface ReviewText {
  /** Everything before the first scenario: the Feature line, its description, any Background. */
  preamble: string;
  scenarios: { number: number; name: string; text: string }[];
}

/**
 * Splits the Gherkin for a reviewer, so that every line is shown: a Background, an Examples table
 * or a description counts as much as a step, and nobody should approve text they didn't see. Only
 * the scenario tags are left out, because the ID is shown next to the scenario.
 */
export function splitForReview(gherkin: string, language: string): ReviewText {
  const parsed = parseUseCase(gherkin, language);
  const lines = gherkin.split('\n');
  return {
    preamble: dedent(lines.slice(0, (parsed[0]?.firstLine ?? 1) - 1)),
    scenarios: parsed.map((scenario, i) => {
      const next = parsed[i + 1]?.firstLine ?? lines.length + 1;
      return {
        number: scenario.number ?? 0,
        name: scenario.name,
        text: dedent(lines.slice(scenario.line - 1, next - 1)),
      };
    }),
  };
}
