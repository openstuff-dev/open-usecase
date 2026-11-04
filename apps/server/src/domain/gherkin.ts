import { AstBuilder, dialects, GherkinClassicTokenMatcher, Parser } from '@cucumber/gherkin';
import { IdGenerator } from '@cucumber/messages';
import type { GherkinBlock, StepPhase } from '@open-usecase/contracts';

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
  /** 1-based line of the `Rule:` it opens, counting that rule's tags. Null if it opens none. */
  ruleLine: number | null;
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
    let ruleLine = child.rule
      ? Math.min(child.rule.location.line, ...child.rule.tags.map((t) => t.location.line))
      : null;
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
        ruleLine,
      });
      ruleLine = null;
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

const HEADINGS = [
  'feature',
  'rule',
  'background',
  'scenario',
  'scenarioOutline',
  'examples',
] as const;
const STEPS = ['given', 'when', 'then', 'and', 'but'] as const;
const PHASES: readonly string[] = ['given', 'when', 'then'];

/** `|` splits a table's cells unless it's escaped, as `\\|` is. */
function tableRow(line: string): string[] {
  return line
    .slice(1, line.endsWith('|') ? -1 : undefined)
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

/** Reads lines of Gherkin in the project's language. Every line with text gets a block. */
function toBlocks(lines: readonly string[], language: string): GherkinBlock[] {
  const dialect = dialects[language];
  const blocks: GherkinBlock[] = [];
  let phase: StepPhase | null = null;

  const heading = (line: string) => {
    for (const key of HEADINGS) {
      for (const word of dialect[key]) {
        if (line.startsWith(`${word}:`)) {
          return { keyword: word, text: line.slice(word.length + 1).trim() };
        }
      }
    }
    return null;
  };
  const step = (line: string) => {
    let found: { key: (typeof STEPS)[number] | 'star'; word: string } | null = null;
    for (const key of STEPS) {
      for (const word of dialect[key]) {
        if (line.startsWith(word) && word.length > (found?.word.length ?? 0)) {
          found = { key: word.trim() === '*' ? 'star' : key, word };
        }
      }
    }
    return found;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('"""') || line.startsWith('```')) {
      const fence = line.slice(0, 3);
      const indent = raw.length - raw.trimStart().length;
      const body: string[] = [];
      for (i++; i < lines.length && !(lines[i] ?? '').trim().startsWith(fence); i++) {
        body.push((lines[i] ?? '').slice(indent));
      }
      blocks.push({ kind: 'doc', text: body.join('\n') });
    } else if (line.startsWith('|')) {
      const last = blocks.at(-1);
      if (last?.kind === 'table') last.rows.push(tableRow(line));
      else blocks.push({ kind: 'table', rows: [tableRow(line)] });
    } else if (line.startsWith('#')) {
      blocks.push({ kind: 'comment', text: line.slice(1).trim() });
    } else if (line.startsWith('@')) {
      // The ID is shown next to the scenario. Any other tag means something, so it stays.
      const tags = line.split(/\s+/).filter((tag) => !SCENARIO_TAG.test(tag));
      if (tags.length) blocks.push({ kind: 'tag', text: tags.join(' ') });
    } else {
      const head = heading(line);
      const found = head ? null : step(line);
      if (head) {
        phase = null;
        blocks.push({ kind: 'heading', ...head });
      } else if (found) {
        if (PHASES.includes(found.key)) phase = found.key as StepPhase;
        blocks.push({
          kind: 'step',
          type: found.key,
          phase,
          keyword: found.word.trim(),
          text: line.slice(found.word.length).trim(),
        });
      } else {
        blocks.push({ kind: 'text', text: line });
      }
    }
  }
  return blocks;
}

export interface ReviewText {
  /** Everything before the first scenario: the Feature line, its description, any Background. */
  preamble: GherkinBlock[];
  scenarios: { number: number; name: string; blocks: GherkinBlock[] }[];
}

/**
 * Splits the Gherkin for a reviewer, so that every line is shown: a Background, an Examples table,
 * a tag or a comment counts as much as a step, and nobody should approve text they didn't see.
 * Only the scenario's own line and its ID tag are left out, because both are shown next to it.
 */
export function splitForReview(gherkin: string, language: string): ReviewText {
  const parsed = parseUseCase(gherkin, language);
  const lines = gherkin.split('\n');
  // A scenario starts at the Rule it opens or its tags, and at any comments right above those.
  const starts = parsed.map((scenario) => {
    let start = scenario.ruleLine ?? scenario.firstLine;
    for (let at = start - 1; at >= 1; at--) {
      const line = (lines[at - 1] ?? '').trim();
      if (line.startsWith('#')) start = at;
      else if (line) break;
    }
    return start;
  });
  return {
    preamble: toBlocks(lines.slice(0, (starts[0] ?? 1) - 1), language),
    scenarios: parsed.map((scenario, i) => {
      const end = (starts[i + 1] ?? lines.length + 1) - 1;
      return {
        number: scenario.number ?? 0,
        name: scenario.name,
        blocks: [
          ...toBlocks(lines.slice((starts[i] ?? 1) - 1, scenario.line - 1), language),
          ...toBlocks(lines.slice(scenario.line, end), language),
        ],
      };
    }),
  };
}
