import { inject } from '@angular/core';
import { type CanActivateFn, Router, type Routes } from '@angular/router';
import { Session } from './core/session';
import { SignIn } from './pages/sign-in';
import { Start } from './pages/start';
import { Shell } from './shell';

const signedIn: CanActivateFn = async (_route, state) => {
  const session = inject(Session);
  const router = inject(Router);
  const me = session.me() ?? (await session.load());
  return me ? true : router.createUrlTree(['/sign-in'], { queryParams: { next: state.url } });
};

export const routes: Routes = [
  { path: 'sign-in', component: SignIn, title: 'Sign in · OpenUsecase' },
  {
    path: '',
    component: Shell,
    canActivate: [signedIn],
    children: [
      { path: '', component: Start, title: 'OpenUsecase' },
      {
        path: 't/:team',
        children: [
          { path: '', pathMatch: 'full', redirectTo: 'inbox' },
          {
            path: 'inbox',
            loadComponent: () => import('./pages/inbox').then((m) => m.InboxPage),
            title: 'Inbox · OpenUsecase',
          },
          {
            path: 'catalogue',
            loadComponent: () => import('./pages/catalogue').then((m) => m.CataloguePage),
            title: 'Catalogue · OpenUsecase',
          },
          {
            path: 'usecases/:id',
            loadComponent: () => import('./pages/use-case').then((m) => m.UseCasePage),
            title: 'Use case · OpenUsecase',
          },
          { path: 'settings', pathMatch: 'full', redirectTo: 'settings/account' },
          {
            path: 'settings/:tab',
            loadComponent: () => import('./pages/settings/settings').then((m) => m.SettingsPage),
            title: 'Settings · OpenUsecase',
          },
        ],
      },
      { path: 'settings', pathMatch: 'full', redirectTo: 'settings/account' },
      {
        path: 'settings/:tab',
        loadComponent: () => import('./pages/settings/settings').then((m) => m.SettingsPage),
        title: 'Settings · OpenUsecase',
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
