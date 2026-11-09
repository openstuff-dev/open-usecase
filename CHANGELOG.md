# Changelog

Each release is a Docker image at `ghcr.io/openstuff-dev/open-usecase:<version>`.
Migrations run when the new version starts and only move forward, so back up first.

## 0.2.0

Migrations `006_server_integrations` and `007_server_integrations_shape` add the server's
connections table. Back up first.

### Web app

- The team's settings are tabs: Account (with a password change), Appearance, Connect an agent,
  Projects, Members, Agents and CI, Integrations and Export and import, plus Teams for server
  admins. Every member has Settings. The old address takes you to Account. A new agent token opens
  in a dialog you can't miss.
- New on Integrations: server admins paste a connection string from OpenVersion or OpenAnnounce and
  see straight away whether it works and how to fix it. The OpenPurpose glossary link moved here.
- With OpenVersion connected, open tabs offer to reload when a new version is live.
- With OpenAnnounce connected, messages show for the team and role someone is in. The card lists the
  groups to create in OpenAnnounce.
- Moved onto `@openstuff-dev/ui` and `ui-angular` 0.1.8.

### Server

- With an OpenVersion deploy token saved, the server publishes its own version on start.
- New settings: `OPENUSECASE_FETCH_ALLOW` lets a connection reach listed private addresses.
  `OPENUSECASE_OPENVERSION_*` and `OPENUSECASE_OPENANNOUNCE_*` set a connection from the
  environment, and its card becomes read only. Changing `OPENUSECASE_SECRET_KEY` means entering the
  saved keys again.
- Saved connection secrets never leave the server: not in the admin list, not in a team export.

### Image

- The image carries its own version in the server and the web app (`VERSION` build arg). The
  release workflow runs again: it had stopped on a function GitHub Actions doesn't have.

## 0.1.1

No migrations.

- The browser tab now shows OpenUsecase's real mark, the OpenStuff ring with its glyph, instead of a plain coloured square.
- Moved onto `@openstuff-dev/ui` and `ui-angular` 0.1.6.

## 0.1.0

The first release with a published image.
