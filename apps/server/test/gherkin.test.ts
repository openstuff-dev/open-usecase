import { describe, expect, it } from 'vitest';
import { parseCatalogueFile } from '../src/domain/catalogue-file.js';
import { JUnitError, readJUnit } from '../src/domain/junit.js';
import {
  assignScenarioTags,
  GherkinError,
  parseUseCase,
  splitForReview,
} from '../src/domain/gherkin.js';

const valid = `Feature: Change the colour

  Scenario: Change it
    Given I am on the settings page
    When I change the primary colour
    Then the app uses the new colour

  @wip
  Scenario: Refuse a bad colour
    When I enter a value that isn't a colour
    Then I see an error
`;

describe('Gherkin validation', () => {
  it('UC-1/S1 tags scenarios that have no tag, keeping the text standard', () => {
    const result = assignScenarioTags(valid, 'en', new Set(), 1);
    expect(result.scenarios.map((s) => s.number)).toEqual([1, 2]);
    expect(result.nextNumber).toBe(3);
    expect(result.gherkin).toContain('  @S1\n  Scenario: Change it');
    expect(result.gherkin).toContain('  @wip\n  @S2\n  Scenario: Refuse a bad colour');
    expect(parseUseCase(result.gherkin, 'en').map((s) => s.number)).toEqual([1, 2]);
  });

  it.each([
    ['text that is not Gherkin', 'Just some words about a colour.'],
    ['a step outside a scenario', 'Feature: X\n  Given a step with no scenario\n  Nonsense here'],
    ['a feature with no scenario', 'Feature: Nothing in here'],
    ['no feature at all', '# only a comment'],
  ])('UC-1/S2 refuses %s, saying what is wrong', (_name, text) => {
    expect(() => parseUseCase(text, 'en')).toThrow(GherkinError);
  });

  it('UC-1/S2 says which line does not parse', () => {
    expect(() => parseUseCase('Feature: X\n  Scenario: Y\n    Given a\n  Bad line', 'en')).toThrow(/\(4:3\)/);
  });

  it('UC-1/S2 refuses another language than the project has', () => {
    const french = '# language: fr\nFonctionnalité: X\n  Scénario: Y\n    Soit a';
    expect(() => parseUseCase(french, 'en')).toThrow(/"en"/);
  });

  it('UC-1/S2 refuses a tag the server did not assign', () => {
    const text = 'Feature: X\n  @S7\n  Scenario: Y\n    Given a';
    expect(() => assignScenarioTags(text, 'en', new Set(), 1)).toThrow(/@S7/);
  });

  it('UC-1/S2 refuses one tag on two scenarios, and two tags on one', () => {
    const twice = 'Feature: X\n  @S1\n  Scenario: Y\n    Given a\n  @S1\n  Scenario: Z\n    Given b';
    expect(() => assignScenarioTags(twice, 'en', new Set([1]), 2)).toThrow(/more than one/);
    const both = 'Feature: X\n  @S1 @S2\n  Scenario: Y\n    Given a';
    expect(() => assignScenarioTags(both, 'en', new Set([1, 2]), 3)).toThrow(/more than one/);
  });

  it('UC-2/S3 keeps the ID of a kept tag and gives a new scenario a new number', () => {
    const text = 'Feature: X\n  Scenario: New meaning\n    Given a\n  @S2\n  Scenario: Reworded\n    Given b';
    const result = assignScenarioTags(text, 'en', new Set([1, 2]), 3);
    expect(result.scenarios.map((s) => [s.name, s.number])).toEqual([
      ['New meaning', 3],
      ['Reworded', 2],
    ]);
    expect(result.nextNumber).toBe(4);
  });

  it('UC-2/S1 shows a tag and a comment above a scenario, and leaves out only the ID', () => {
    const { scenarios } = splitForReview(
      'Feature: F\n\n  # Agreed with support.\n  @S1 @manual\n  Scenario: One\n    Given a\n',
      'en',
    );
    expect(scenarios[0]?.blocks).toMatchObject([
      { kind: 'comment', text: 'Agreed with support.' },
      { kind: 'tag', text: '@manual' },
      { kind: 'step', text: 'a' },
    ]);
  });

  it('UC-2/S1 shows a Rule with the scenario it opens, not inside the one before', () => {
    const { scenarios } = splitForReview(
      'Feature: F\n\n  @S1\n  Scenario: One\n    Given a\n\n  Rule: Only admins\n\n    @S2\n    Scenario: Two\n      Given b\n',
      'en',
    );
    expect(scenarios[0]?.blocks).toMatchObject([{ kind: 'step', text: 'a' }]);
    expect(scenarios[1]?.blocks).toMatchObject([
      { kind: 'heading', keyword: 'Rule', text: 'Only admins' },
      { kind: 'step', text: 'b' },
    ]);
  });

  it('UC-2/S1 keeps doc strings and tables whole, and every line of them shows', () => {
    const { scenarios } = splitForReview(
      [
        'Feature: F',
        '  Scenario: One',
        '    Then I get:',
        '      """',
        '      # not a comment',
        '      | not a table |',
        '      """',
        '    And these:',
        '      | a \\| b | c |',
      ].join('\n'),
      'en',
    );
    expect(scenarios[0]?.blocks).toMatchObject([
      { kind: 'step', type: 'then', phase: 'then' },
      { kind: 'doc', text: '# not a comment\n| not a table |' },
      { kind: 'step', type: 'and', phase: 'then' },
      { kind: 'table', rows: [['a | b', 'c']] },
    ]);
  });

  it('UC-2/S1 reads steps in the project language', () => {
    const { preamble, scenarios } = splitForReview(
      '# language: nl\nFunctionaliteit: F\n  Scenario: Een\n    Gegeven a\n    En b\n    Als c\n    Dan d\n',
      'nl',
    );
    expect(preamble).toMatchObject([
      { kind: 'comment' },
      { kind: 'heading', keyword: 'Functionaliteit', text: 'F' },
    ]);
    expect(scenarios[0]?.blocks).toMatchObject([
      { keyword: 'Gegeven', phase: 'given' },
      { keyword: 'En', type: 'and', phase: 'given' },
      { keyword: 'Als', phase: 'when' },
      { keyword: 'Dan', phase: 'then' },
    ]);
  });
});

describe('the catalogue file', () => {
  it('reads use cases with their numbers, titles and whether a person approved them', () => {
    const useCases = parseCatalogueFile(
      [
        '# Trial',
        '### UC-4: Read it',
        'Status: approved by the user',
        '```gherkin',
        'Feature: Read it',
        '  @S1',
        '  Scenario: A',
        '    Given b',
        '```',
        '## UC-9: Later',
        'Status: proposed, not built',
        '```gherkin',
        'Feature: Later',
        '```',
        '### UC-10: Has no Gherkin',
        'Status: approved',
      ].join('\n'),
    );
    expect(useCases).toMatchObject([
      { number: 4, title: 'Read it', approved: true },
      { number: 9, title: 'Later', approved: false },
    ]);
    expect(useCases[0]?.gherkin).toContain('@S1');
  });
});

describe('reading JUnit', () => {
  it('UC-15/S1 finds IDs in a test name or class, once per ID, with the result', () => {
    const tests = readJUnit(`<testsuites><testsuite name="a">
      <testcase name="UC-1/S2 works, see also UC-1/S2 and UC-3/S1"/>
      <testcase classname="UC-4/S1 suite" name="fails"><failure/></testcase>
      <testcase name="UC-5/S1 ignored"><skipped/></testcase>
      <testcase name="no id"/>
      <testsuite name="nested"><testcase name="UC-6/S9 errors"><error/></testcase></testsuite>
    </testsuite></testsuites>`);
    expect(tests.map((t) => [t.useCase, t.scenario, t.result])).toEqual([
      [1, 2, 'passed'],
      [3, 1, 'passed'],
      [4, 1, 'failed'],
      [5, 1, 'skipped'],
      [6, 9, 'failed'],
    ]);
  });

  it('UC-15/S1 reads a file with one testsuite and no wrapper', () => {
    expect(readJUnit('<testsuite><testcase name="UC-1/S1 a"/></testsuite>')).toHaveLength(1);
  });

  it('UC-15/S8 refuses what is not JUnit, and does not expand entities', () => {
    expect(() => readJUnit('<html/>')).toThrow(JUnitError);
    expect(() => readJUnit('not xml')).toThrow(JUnitError);
    const bomb = '<!DOCTYPE t [<!ENTITY a "UC-1/S1">]><testsuite><testcase name="&a;"/></testsuite>';
    expect(readJUnit(bomb)).toEqual([]);
  });
});
