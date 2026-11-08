import { type ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import {
  provideRouter,
  withComponentInputBinding,
  withRouterConfig,
  withViewTransitions,
} from '@angular/router';
import { provideTheme } from '@openstuff-dev/ui-angular';
import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(
      routes,
      withComponentInputBinding(),
      // Pages under /t/:team get `team` as an input.
      withRouterConfig({ paramsInheritanceStrategy: 'always' }),
      // Short cross-fades between pages; none with reduced motion (see styles.css).
      withViewTransitions({ skipInitialTransition: true }),
    ),
    provideTheme({ storageKey: 'open-usecase-theme' }),
  ],
};
