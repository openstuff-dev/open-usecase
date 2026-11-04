import { describe, expect, it } from 'vitest';
import { assignScenarioTags, GherkinError, parseUseCase } from '../src/domain/gherkin.js';

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
});
