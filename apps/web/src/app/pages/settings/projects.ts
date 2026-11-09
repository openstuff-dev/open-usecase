import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  type ElementRef,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { ProjectSettings, TeamSettings } from '@open-usecase/contracts';
import {
  Button,
  Callout,
  ConfirmDialog,
  Control,
  EmptyState,
  Field,
  SectionHeader,
  SettingCard,
  SettingCardFooter,
  Skeleton,
} from '@openstuff-dev/ui-angular';
import { Api, errorText } from '../../core/api';
import { IdempotencyKey } from '../../core/idempotency';
import { onReturn, slowLoading } from '../../core/loading';

/** Projects, and the repositories agents propose from. */
@Component({
  selector: 'app-projects',
  imports: [
    FormsModule,
    Button,
    Callout,
    Control,
    EmptyState,
    Field,
    SectionHeader,
    SettingCard,
    SettingCardFooter,
    Skeleton,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'stack' },
  template: `
    <header
      os-section-header
      title="Projects"
      description="Agents propose from a repository, and its git remote says which project it’s for."
    ></header>

    @if (loadError(); as error) {
      <os-callout tone="danger" title="The projects didn’t load">{{ error }}</os-callout>
    }
    @if (error(); as error) {
      <os-callout tone="danger" title="That didn’t work">{{ error }}</os-callout>
    }

    @if (settings(); as settings) {
      @for (project of settings.projects; track project.id) {
        <section
          os-setting-card
          [title]="project.name"
          [description]="'Language: ' + project.language"
        >
          <ul class="repos">
            @for (repository of project.repositories; track repository.id) {
              <li>
                <span
                  >{{ repository.remote }} <small>{{ repository.defaultBranch }}</small></span
                >
                <button
                  os-button
                  size="sm"
                  variant="ghost"
                  tone="danger"
                  type="button"
                  (click)="removeRepository(repository.id, repository.remote)"
                >
                  Remove<span class="os-visually-hidden"> {{ repository.remote }}</span>
                </button>
              </li>
            }
          </ul>
          <form class="inline" (ngSubmit)="addRepository(project)">
            <os-field
              [label]="'Add a repository to ' + project.name"
              hint="Its git remote, such as git@github.com:acme/shop.git"
            >
              <input
                os-input
                [name]="'remote-' + project.id"
                required
                [ngModel]="repositoryDraft(project)"
                (ngModelChange)="setRepositoryDraft(project, $event)"
              />
            </os-field>
            <button os-button type="submit" [disabled]="!repositoryDraft(project).trim()">
              Add repository
            </button>
          </form>
        </section>
      } @empty {
        <os-empty-state title="No projects yet">
          <p>
            Add the repository your agents work in, such as
            <code>git&#64;github.com:acme/shop.git</code>. Its git remote tells OpenUsecase which
            project a proposal is for.
          </p>
          <div><button os-button type="button" (click)="focusName()">Add project</button></div>
        </os-empty-state>
      }

      <form os-setting-card title="New project" (ngSubmit)="addProject()">
        <div class="fields">
          <os-field label="Project name">
            <input
              #projectNameInput
              os-input
              name="projectName"
              required
              [(ngModel)]="projectName"
            />
          </os-field>
          <os-field label="Git remote" hint="Such as git@github.com:acme/shop.git">
            <input os-input name="projectRemote" required [(ngModel)]="projectRemote" />
          </os-field>
          <os-field label="Gherkin language" hint="A code such as en or nl">
            <input os-input name="projectLanguage" required [(ngModel)]="projectLanguage" />
          </os-field>
        </div>
        <div os-setting-card-footer>
          <button
            os-button
            variant="primary"
            type="submit"
            [disabled]="!projectName.trim() || !projectRemote.trim()"
          >
            Add project
          </button>
        </div>
      </form>
    } @else if (loading.slow()) {
      <os-skeleton [lines]="6" />
    }
  `,
  styles: `
    .repos {
      display: grid;
      gap: var(--os-space-1);
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .repos li {
      display: flex;
      flex-wrap: wrap;
      gap: var(--os-space-2);
      align-items: center;
      justify-content: space-between;
      font-size: var(--os-text-sm);
    }

    small {
      color: var(--os-fg-muted);
    }

    .inline,
    .fields {
      display: flex;
      flex-wrap: wrap;
      gap: var(--os-space-3);
      align-items: flex-end;
    }
  `,
})
export class Projects {
  readonly team = input.required<string>();
  private readonly api = inject(Api);
  private readonly confirm = inject(ConfirmDialog);
  protected readonly settings = signal<TeamSettings | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly loadError = signal<string | null>(null);
  protected readonly loading = slowLoading();
  private readonly nameInput = viewChild<ElementRef<HTMLInputElement>>('projectNameInput');
  protected projectName = '';
  protected projectRemote = '';
  protected projectLanguage = 'en';
  private readonly repositoryDrafts = signal(new Map<string, string>());
  private readonly key = new IdempotencyKey();

  protected focusName(): void {
    this.nameInput()?.nativeElement.focus();
  }

  constructor() {
    effect(() => {
      void this.load(this.team());
    });
    inject(DestroyRef).onDestroy(onReturn(() => void this.load(this.team())));
  }

  private get base(): string {
    return `/api/t/${this.team()}`;
  }

  protected repositoryDraft(project: ProjectSettings): string {
    return this.repositoryDrafts().get(project.id) ?? '';
  }

  protected setRepositoryDraft(project: ProjectSettings, text: string): void {
    this.repositoryDrafts.update((all) => new Map(all).set(project.id, text));
  }

  protected async addProject(): Promise<void> {
    const done = await this.change(() =>
      this.api.post(
        `${this.base}/projects`,
        { name: this.projectName, remote: this.projectRemote, language: this.projectLanguage },
        this.key.value,
      ),
    );
    if (done) {
      this.projectName = '';
      this.projectRemote = '';
    }
  }

  protected async addRepository(project: ProjectSettings): Promise<void> {
    const done = await this.change(() =>
      this.api.post(
        `${this.base}/projects/${project.id}/repositories`,
        { remote: this.repositoryDraft(project) },
        this.key.value,
      ),
    );
    if (done) this.setRepositoryDraft(project, '');
  }

  protected async removeRepository(id: string, remote: string): Promise<void> {
    const ok = await this.confirm.confirm({
      title: `Remove ${remote}?`,
      message: 'Agents and CI can’t use this repository until it’s added again. Use cases stay.',
      confirmLabel: 'Remove repository',
      danger: true,
    });
    if (ok) await this.change(() => this.api.delete(`${this.base}/repositories/${id}`));
  }

  private async load(team: string): Promise<void> {
    this.loadError.set(null);
    try {
      const settings = await this.loading.track(
        this.api.get<TeamSettings>(`/api/t/${team}/settings`, {
          onFresh: (fresh) => {
            if (team === this.team()) this.settings.set(fresh);
          },
        }),
      );
      if (team === this.team()) this.settings.set(settings);
    } catch (error) {
      if (team === this.team()) this.loadError.set(errorText(error));
    }
  }

  /** Runs a change, shows what went wrong if it fails, and loads the page again. */
  private async change<T>(run: () => Promise<T>): Promise<T | null> {
    this.error.set(null);
    try {
      const result = await run();
      this.key.renew();
      void this.load(this.team());
      return result;
    } catch (error) {
      this.error.set(errorText(error));
      return null;
    }
  }
}
