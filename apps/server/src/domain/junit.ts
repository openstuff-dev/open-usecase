import { XMLParser } from 'fast-xml-parser';

export type TestResult = 'passed' | 'failed' | 'skipped';

export interface TaggedTest {
  /** `UC-142`, with the scenario number apart. */
  useCase: number;
  scenario: number;
  name: string;
  result: TestResult;
}

export class JUnitError extends Error {}

const TAG = /\bUC-(\d+)\/S(\d+)\b/g;

interface Node {
  '@_name'?: string;
  '@_classname'?: string;
  failure?: unknown;
  error?: unknown;
  skipped?: unknown;
  testcase?: Node | Node[];
  testsuite?: Node | Node[];
  testsuites?: Node;
}

const list = <T>(value: T | T[] | undefined): T[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

function* testCases(node: Node): Generator<Node> {
  yield* list(node.testcase);
  for (const suite of list(node.testsuite)) yield* testCases(suite);
  // An empty <testsuites/> parses as an empty string.
  if (typeof node.testsuites === 'object') yield* testCases(node.testsuites);
}

/**
 * Every test that carries a scenario ID in its name or class, once per ID it carries. Other tests
 * aren't evidence for anything, so they're left out. Entities aren't expanded, so a hostile report
 * can't make the parser blow up.
 */
export function readJUnit(xml: string): TaggedTest[] {
  let root: Node;
  try {
    root = new XMLParser({
      ignoreAttributes: false,
      processEntities: false,
      parseTagValue: false,
      parseAttributeValue: false,
    }).parse(xml) as Node;
  } catch (error) {
    throw new JUnitError(`That isn't valid JUnit XML. ${(error as Error).message}`, { cause: error });
  }
  if (!('testsuites' in root) && !('testsuite' in root)) {
    throw new JUnitError('That isn’t JUnit XML: it has no testsuite or testsuites element.');
  }
  const tests: TaggedTest[] = [];
  for (const test of testCases(root)) {
    const name = test['@_name'] ?? '';
    const label = `${test['@_classname'] ?? ''} ${name}`;
    const result: TestResult =
      test.failure !== undefined || test.error !== undefined
        ? 'failed'
        : test.skipped !== undefined
          ? 'skipped'
          : 'passed';
    const seen = new Set<string>();
    for (const match of label.matchAll(TAG)) {
      if (seen.has(match[0])) continue;
      seen.add(match[0]);
      tests.push({ useCase: Number(match[1]), scenario: Number(match[2]), name, result });
    }
  }
  return tests;
}
