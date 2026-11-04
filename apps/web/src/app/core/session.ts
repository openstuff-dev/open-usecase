import { Injectable, computed, inject, signal } from '@angular/core';
import type { Me, Role } from '@open-usecase/contracts';
import { Api } from './api';

/** Who is signed in, and what they may do in the team they're looking at. */
@Injectable({ providedIn: 'root' })
export class Session {
  private readonly api = inject(Api);
  readonly me = signal<Me | null>(null);
  /** The team in the URL. Set by the shell. */
  readonly team = signal<string | null>(null);

  readonly membership = computed(() => {
    const slug = this.team();
    return this.me()?.teams.find((t) => t.slug === slug) ?? null;
  });

  readonly role = computed<Role | null>(() => this.membership()?.role ?? null);

  readonly isAdmin = computed(() => this.role() === 'admin');

  /** Loads the account; null when nobody is signed in. */
  async load(): Promise<Me | null> {
    try {
      const me = await this.api.get<Me>('/api/me');
      this.me.set(me);
      return me;
    } catch {
      this.me.set(null);
      return null;
    }
  }

  async signIn(email: string, password: string): Promise<void> {
    await this.api.post('/api/session', { email, password });
    await this.load();
  }

  async signOut(): Promise<void> {
    await this.api.delete('/api/session');
    this.api.clear();
    this.me.set(null);
  }
}
