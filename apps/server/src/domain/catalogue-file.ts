/** One use case in a Markdown file such as docs/trial/usecases.md. */
export interface FileUseCase {
  number: number;
  title: string;
  approved: boolean;
  gherkin: string;
}

const HEADING = /^#{2,3} UC-(\d+): (.+)$/gm;

/**
 * Reads a catalogue file: a `UC-4: title` heading, a `Status:` line and a Gherkin block. Anything
 * not approved by the user is imported as proposed, so a person still reviews it.
 */
export function parseCatalogueFile(text: string): FileUseCase[] {
  const headings = [...text.matchAll(HEADING)];
  return headings.flatMap((heading, i) => {
    const body = text.slice(heading.index, headings[i + 1]?.index ?? text.length);
    const gherkin = /```gherkin\n([\s\S]*?)```/.exec(body)?.[1];
    if (!gherkin) return [];
    const status = /^Status: (.*)$/m.exec(body)?.[0] ?? '';
    return [
      {
        number: Number(heading[1]),
        title: heading[2],
        approved: status.startsWith('Status: approved'),
        gherkin,
      },
    ];
  });
}
