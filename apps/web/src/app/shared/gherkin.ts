import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { Comment, GherkinBlock, StepPhase } from '@open-usecase/contracts';

/** A run of Gherkin: the steps of one phase together, or what stands between them. */
interface Stanza {
  phase: StepPhase | null;
  /** The keyword that opens the phase, in the project's language. */
  label: string | null;
  blocks: GherkinBlock[];
}

function stanzas(blocks: readonly GherkinBlock[]): Stanza[] {
  const result: Stanza[] = [];
  let open: StepPhase | null = null;
  for (const block of blocks) {
    if (block.kind === 'heading') open = null;
    if (block.kind === 'step') open = block.phase;
    const last = result.at(-1);
    if (last?.phase === open) {
      last.blocks.push(block);
    } else {
      const label = block.kind === 'step' && open ? block.keyword : null;
      result.push({ phase: open, label, blocks: [block] });
    }
  }
  return result;
}

/** Sets `"values"` and `<placeholders>` apart from the sentence around them. */
function textParts(text: string): { text: string; value: boolean }[] {
  return text
    .split(/("[^"]*"|<[^>]+>)/)
    .filter(Boolean)
    .map((part) => ({ text: part, value: /^("|<)/.test(part) }));
}

/** Gherkin to read, not to parse: Given, When and Then each get their own block. */
@Component({
  selector: 'app-gherkin',
  imports: [NgTemplateOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-template #sentence let-text>
      @for (part of parts(text); track $index) {
        @if (part.value) {
          <code>{{ part.text }}</code>
        } @else {
          <span>{{ part.text }}</span>
        }
      }
    </ng-template>

    <ng-template #render let-blocks>
      @for (block of blocks; track $index) {
        @switch (block.kind) {
          @case ('heading') {
            <h4>{{ block.keyword }}{{ block.text ? ': ' + block.text : '' }}</h4>
          }
          @case ('step') {
            <p>
              @if (block.type === 'but') {
                <strong>{{ block.keyword }} </strong>
              }
              <ng-container
                [ngTemplateOutlet]="sentence"
                [ngTemplateOutletContext]="{ $implicit: block.text }"
              />
            </p>
          }
          @case ('table') {
            <div class="table">
              <table>
                <thead>
                  <tr>
                    @for (cell of block.rows[0]; track $index) {
                      <th scope="col">{{ cell }}</th>
                    }
                  </tr>
                </thead>
                <tbody>
                  @for (row of block.rows.slice(1); track $index) {
                    <tr>
                      @for (cell of row; track $index) {
                        <td>{{ cell }}</td>
                      }
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
          @case ('doc') {
            <pre>{{ block.text }}</pre>
          }
          @case ('tag') {
            <p class="quiet">{{ block.text }}</p>
          }
          @case ('comment') {
            <p class="quiet"># {{ block.text }}</p>
          }
          @case ('text') {
            <p class="muted">{{ block.text }}</p>
          }
        }
      }
    </ng-template>

    @for (stanza of stanzas(); track $index) {
      @if (stanza.label) {
        <section class="stanza" [class.then]="stanza.phase === 'then'">
          <div class="label">{{ stanza.label }}</div>
          <div class="lines">
            <ng-container
              [ngTemplateOutlet]="render"
              [ngTemplateOutletContext]="{ $implicit: stanza.blocks }"
            />
          </div>
        </section>
      } @else {
        <div class="lines">
          <ng-container
            [ngTemplateOutlet]="render"
            [ngTemplateOutletContext]="{ $implicit: stanza.blocks }"
          />
        </div>
      }
    }
  `,
  styles: `
    :host {
      display: grid;
      gap: var(--os-space-5);
      max-inline-size: 44rem;
      font-size: var(--os-text-base);
      line-height: 1.6;
    }

    .stanza {
      display: grid;
      grid-template-columns: 4.5rem minmax(0, 1fr);
      gap: var(--os-space-3);
    }

    .label {
      color: var(--os-fg-muted);
      font-size: var(--os-text-sm);
      font-weight: var(--os-font-weight-semibold);
      line-height: 1.85;
    }

    .then .label {
      color: var(--os-brand-text);
    }

    .stanza + .stanza,
    .stanza + .lines {
      padding-block-start: var(--os-space-4);
      border-block-start: 1px var(--os-border-style) var(--os-border-default);
    }

    .lines {
      display: grid;
      gap: var(--os-space-2);
      min-inline-size: 0;
    }

    p {
      margin: 0;
      text-wrap: pretty;
    }

    strong {
      font-weight: var(--os-font-weight-semibold);
    }

    .muted {
      color: var(--os-fg-light);
    }

    .quiet {
      color: var(--os-fg-muted);
      font-family: var(--os-font-mono);
      font-size: var(--os-text-xs);
    }

    code {
      padding-inline: 0.3em;
      border-radius: var(--os-radius-sm);
      background: var(--os-bg-surface-200);
      font-family: var(--os-font-mono);
      font-size: 0.88em;
    }

    h4 {
      margin: var(--os-space-2) 0 0;
      font-size: var(--os-text-sm);
      font-weight: var(--os-font-weight-semibold);
    }

    pre {
      margin: var(--os-space-1) 0;
      padding: var(--os-space-3);
      overflow-x: auto;
      border-radius: var(--os-radius-md);
      background: var(--os-bg-surface-200);
      font-family: var(--os-font-mono);
      font-size: var(--os-text-sm);
      white-space: pre-wrap;
    }

    .table {
      overflow-x: auto;
    }

    table {
      border-collapse: collapse;
      font-size: var(--os-text-sm);
    }

    th,
    td {
      padding: var(--os-space-1) var(--os-space-3);
      border: 1px var(--os-border-style) var(--os-border-default);
      text-align: start;
    }

    th {
      background: var(--os-bg-surface-200);
      font-weight: var(--os-font-weight-semibold);
    }
  `,
})
export class Gherkin {
  readonly blocks = input.required<GherkinBlock[]>();
  protected readonly stanzas = computed(() => stanzas(this.blocks()));
  protected readonly parts = textParts;
}

/** Comments in the order they were written, as a person reads them. */
@Component({
  selector: 'app-comments',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ul>
      @for (comment of comments(); track comment.id) {
        <li>
          <strong>{{ comment.author }}</strong>
          <small>on revision {{ comment.revision }}</small>
          <p>{{ comment.body }}</p>
        </li>
      }
    </ul>
  `,
  styles: `
    ul {
      display: grid;
      gap: var(--os-space-2);
      margin: 0;
      padding: 0;
      list-style: none;
    }

    li {
      max-inline-size: 44rem;
      padding: var(--os-space-2) var(--os-space-3);
      border-radius: var(--os-radius-md);
      background: var(--os-bg-surface-200);
      font-size: var(--os-text-sm);
    }

    small {
      margin-inline-start: var(--os-space-1);
      color: var(--os-fg-muted);
      font-size: var(--os-text-xs);
    }

    p {
      margin: var(--os-space-1) 0 0;
      white-space: pre-wrap;
      text-wrap: pretty;
    }
  `,
})
export class Comments {
  readonly comments = input.required<Comment[]>();
}
