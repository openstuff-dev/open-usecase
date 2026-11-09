import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import type { Catalogue, CatalogueItem, Health, UseCaseStatus } from '@open-usecase/contracts';
import {
  Badge,
  Callout,
  Control,
  EmptyState,
  Field,
  onReturn,
  PageHeader,
  Skeleton,
  slowLoading,
} from '@openstuff-dev/ui-angular';
import { Api, errorText } from '../core/api';
import { iconCatalogue } from '../shared/icons';
import { HEALTH_LABELS, HEALTH_TONES, STATUS_LABELS, STATUS_TONES } from '../shared/labels';

/** Every use case in the team: what the product does, and how well that's backed up. */
@Component({
  selector: 'app-catalogue',
  imports: [
    FormsModule,
    RouterLink,
    Badge,
    Callout,
    Control,
    EmptyState,
    Field,
    PageHeader,
    Skeleton,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'stack' },
  template: `
    <header
      os-page-header
      title="Catalogue"
      description="What the product does, and how well each part is backed up."
    ></header>

    @if (error(); as error) {
      <os-callout tone="danger" title="The catalogue didn’t load">{{ error }}</os-callout>
    }

    @if (items(); as items) {
      @if (items.length) {
        <form class="filters">
          <os-field label="Search">
            <input
              os-input
              type="search"
              name="words"
              [ngModel]="words()"
              (ngModelChange)="words.set($event)"
            />
          </os-field>
          @if (projects().length > 1) {
            <os-field label="Project">
              <select
                os-select
                name="project"
                [ngModel]="project()"
                (ngModelChange)="project.set($event)"
              >
                <option value="">All</option>
                @for (entry of projects(); track entry.slug) {
                  <option [value]="entry.slug">{{ entry.name }}</option>
                }
              </select>
            </os-field>
          }
          @if (areas().length) {
            <os-field label="Area">
              <select os-select name="area" [ngModel]="area()" (ngModelChange)="area.set($event)">
                <option value="">All</option>
                @for (entry of areas(); track entry) {
                  <option [value]="entry">{{ entry }}</option>
                }
              </select>
            </os-field>
          }
          <os-field label="Status">
            <select
              os-select
              name="status"
              [ngModel]="status()"
              (ngModelChange)="status.set($event)"
            >
              <option value="">All</option>
              @for (entry of statuses; track entry) {
                <option [value]="entry">{{ statusLabels[entry] }}</option>
              }
            </select>
          </os-field>
          <os-field label="Health">
            <select
              os-select
              name="health"
              [ngModel]="health()"
              (ngModelChange)="health.set($event)"
            >
              <option value="">All</option>
              @for (entry of healths; track entry) {
                <option [value]="entry">{{ healthLabels[entry] }}</option>
              }
            </select>
          </os-field>
          <label class="check">
            <input
              type="checkbox"
              name="unchecked"
              [ngModel]="unchecked()"
              (ngModelChange)="unchecked.set($event)"
            />
            No human has checked this
          </label>
        </form>

        <ul class="list">
          @for (item of shown(); track item.id) {
            <li>
              <a [routerLink]="['/t', team(), 'usecases', item.id]">
                <span class="ref">{{ item.ref }}</span>
                <span class="title">
                  {{ item.title }}
                  @if (projects().length > 1 || item.area) {
                    <small>
                      @if (projects().length > 1) {
                        {{ item.project.name }}
                      }
                      @if (projects().length > 1 && item.area) {
                        ·
                      }
                      {{ item.area }}
                    </small>
                  }
                </span>
                <span class="badges">
                  @if (item.pending) {
                    <small>Waiting for review</small>
                  }
                  <span os-badge [tone]="statusTones[item.status]">{{
                    statusLabels[item.status]
                  }}</span>
                  <span os-badge [tone]="healthTones[item.health]">{{
                    healthLabels[item.health]
                  }}</span>
                </span>
              </a>
            </li>
          } @empty {
            <li class="none">Nothing matches these filters.</li>
          }
        </ul>
      } @else {
        <os-empty-state title="No use cases yet" [icon]="icon" [level]="2">
          When an agent proposes a use case, it shows up here and stays here.
        </os-empty-state>
      }
    } @else if (loading.slow()) {
      <div aria-busy="true"><os-skeleton [lines]="8" /></div>
    }
  `,
  styles: `
    .filters {
      display: flex;
      flex-wrap: wrap;
      gap: var(--os-space-3);
      align-items: flex-end;
    }

    .filters os-field {
      flex: 1 1 10rem;
    }

    .check {
      display: flex;
      gap: var(--os-space-2);
      align-items: center;
      min-block-size: 2.25rem;
      font-size: var(--os-text-sm);
    }

    .list {
      margin: 0;
      padding: 0;
      overflow: hidden;
      border: 1px var(--os-border-style) var(--os-border-default);
      border-radius: var(--os-radius-lg);
      list-style: none;
    }

    li + li {
      border-block-start: 1px var(--os-border-style) var(--os-border-default);
    }

    a {
      display: flex;
      flex-wrap: wrap;
      gap: var(--os-space-2) var(--os-space-3);
      align-items: center;
      padding: var(--os-space-3) var(--os-space-4);
      color: var(--os-fg-default);
      text-decoration: none;
    }

    a:hover {
      background: var(--os-bg-hover);
    }

    .ref {
      inline-size: 4.5rem;
      color: var(--os-fg-muted);
      font-size: var(--os-text-sm);
      font-variant-numeric: tabular-nums;
    }

    .title {
      flex: 1 1 14rem;
      font-weight: var(--os-font-weight-medium);
      text-wrap: pretty;
    }

    small {
      color: var(--os-fg-muted);
      font-size: var(--os-text-xs);
      font-weight: var(--os-font-weight-regular);
    }

    .title small {
      display: block;
    }

    .badges {
      display: flex;
      flex-wrap: wrap;
      gap: var(--os-space-2);
      align-items: center;
    }

    .none {
      padding: var(--os-space-4);
      color: var(--os-fg-muted);
      font-size: var(--os-text-sm);
    }
  `,
})
export class CataloguePage {
  private readonly api = inject(Api);
  readonly team = input.required<string>();
  protected readonly items = signal<CatalogueItem[] | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly loading = slowLoading();
  protected readonly icon = iconCatalogue;
  protected readonly statusLabels = STATUS_LABELS;
  protected readonly healthLabels = HEALTH_LABELS;
  protected readonly statusTones = STATUS_TONES;
  protected readonly healthTones = HEALTH_TONES;
  protected readonly statuses = Object.keys(STATUS_LABELS) as UseCaseStatus[];
  protected readonly healths = Object.keys(HEALTH_LABELS) as Health[];
  protected readonly words = signal('');
  protected readonly project = signal('');
  protected readonly area = signal('');
  protected readonly status = signal('');
  protected readonly health = signal('');
  protected readonly unchecked = signal(false);
  private latest = 0;

  protected readonly projects = computed(() => {
    const seen = new Map((this.items() ?? []).map((i) => [i.project.slug, i.project]));
    return [...seen.values()];
  });

  protected readonly areas = computed(() =>
    [...new Set((this.items() ?? []).flatMap((i) => (i.area ? [i.area] : [])))].sort(),
  );

  protected readonly shown = computed(() => {
    const words = this.words().trim().toLowerCase();
    return (this.items() ?? []).filter(
      (item) =>
        (!words || `${item.ref} ${item.title}`.toLowerCase().includes(words)) &&
        (!this.project() || item.project.slug === this.project()) &&
        (!this.area() || item.area === this.area()) &&
        (!this.status() || item.status === this.status()) &&
        (!this.health() || item.health === this.health()) &&
        // Approved by a reviewer agent or on arrival: no person has looked at it.
        (!this.unchecked() || (item.approval !== null && item.approval !== 'human')),
    );
  });

  constructor() {
    effect(() => {
      this.items.set(null);
      void this.load(this.team());
    });
    inject(DestroyRef).onDestroy(onReturn(() => void this.load(this.team())));
  }

  private async load(team: string): Promise<void> {
    const load = ++this.latest;
    try {
      const catalogue = await this.loading.track(
        this.api.get<Catalogue>(`/api/t/${team}/catalogue`, {
          onFresh: (fresh) => {
            if (load === this.latest) this.items.set(fresh.items);
          },
        }),
      );
      if (load !== this.latest) return;
      this.items.set(catalogue.items);
      this.error.set(null);
    } catch (error) {
      if (load === this.latest) this.error.set(errorText(error));
    }
  }
}
