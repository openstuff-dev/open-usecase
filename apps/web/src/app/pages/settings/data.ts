import { ChangeDetectionStrategy, Component, inject, input, signal } from '@angular/core';
import { Button, Callout, FileInput, SectionHeader, SettingCard, SettingCardBody, Toaster } from '@openstuff-dev/ui-angular';
import { Api, errorText } from '../../core/api';

/** Everything in this team as one file, and back again. */
@Component({
  selector: 'app-data',
  imports: [Button, Callout, FileInput, SectionHeader, SettingCard, SettingCardBody],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'stack' },
  template: `
    <header
      os-section-header
      title="Export and import"
      description="Your data is yours. Keep a copy, or move it to another server. Keys and passwords are never in the file: an import makes new ones."
    ></header>

    <section
      os-setting-card
      title="Export"
      description="One file with your projects, use cases, revisions, comments and history. It never holds a token or a password."
    >
      <div os-setting-card-body>
        <div>
          <a os-button variant="primary" [href]="base + '/export'" download>Download export</a>
        </div>
      </div>
    </section>

    <section
      os-setting-card
      title="Import"
      description="You can import it into a team that has no projects yet."
    >
      <div os-setting-card-body>
        <input
          type="file"
          os-file-input
          accept="application/json,.json"
          aria-label="Export file"
          (change)="importFile($event)"
        />
        @if (error(); as error) {
          <os-callout tone="danger" title="Nothing was imported">{{ error }}</os-callout>
        }
      </div>
    </section>
  `,
})
export class Data {
  readonly team = input.required<string>();
  private readonly api = inject(Api);
  private readonly toaster = inject(Toaster);
  protected readonly error = signal<string | null>(null);

  protected get base(): string {
    return `/api/t/${this.team()}`;
  }

  protected async importFile(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    input.value = '';
    this.error.set(null);
    let data: unknown;
    try {
      data = JSON.parse(await file.text());
    } catch {
      this.error.set('That file isn’t an OpenUsecase export.');
      return;
    }
    try {
      await this.api.post(`${this.base}/import`, data);
      this.toaster.show('Imported.', { tone: 'success' });
    } catch (error) {
      this.error.set(errorText(error));
    }
  }
}
