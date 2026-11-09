# OpenUsecase

Use cases that agents propose, people approve and tests prove.

Project page: https://usecase.openstuff.dev

Coding agents often build something that works but isn't what you wanted, and then write tests that
prove it works. With OpenUsecase, an agent first writes down the behaviour it will build, as Gherkin.
You read it and approve it, or say what should change. Tests carry the scenario's ID, so anyone can see
what proves what. The use cases stay as a catalogue of what your product really does.

```gherkin
Feature: Change the primary colour

  @S2
  Scenario: Reject an invalid colour
    Given I am on the settings page
    When I enter a value that isn't a colour
    Then I see an error
    And the app keeps the current colour
```

A test named `UC-142/S2 rejects an invalid colour` proves that scenario. When a use case is merged and
every scenario is proven, it reads `done · passing`. When its test later breaks, it reads
`done · failing`.

## Who does what

- **Agents** propose and revise use cases over MCP, and build only what's approved. While they wait, they
  end their turn instead of polling. They can never change what they may do, not even for themselves.
- **People** read one scenario at a time in the inbox, then approve, ask for changes or reject. Only
  people reject and retire.
- **CI** uploads test results from the default branch, and checks pull requests.
- **Server admins** add teams, each kept apart from the others with Postgres row-level security.
- **Admins** of a team add projects, repositories, members, agents and tokens in Settings.

## Try it

```sh
cp .env.example .env
docker compose up --build
```

Open http://localhost:8080. Sign in as `admin@example.com`, with the password shown once in the server
log (`docker compose logs app`), or the one you set as `OPENUSECASE_ADMIN_PASSWORD`. Add a team. In
**Settings**, add a project with your repository's git remote, and an agent. Keep its token.

## Connect an agent

OpenUsecase is an MCP server at `/mcp`. For Claude Code:

```sh
claude mcp add --transport http openusecase http://localhost:8080/mcp \
  --header "Authorization: Bearer uc_your_token"
```

The server tells an agent the workflow when it connects, so it needs no further instructions. Ask it for
something a user can see, and it proposes a use case and stops. Approve it in the inbox and tell the agent
you're back.

| Tool | What it does |
|---|---|
| `search_usecases` | Finds use cases by their words, with filters for status, health and how they were approved |
| `get_usecase` | Status, health, text, comments and evidence, and whether to build it |
| `propose_usecase` | Proposes a use case. The server assigns the IDs |
| `revise_usecase` | New text after a change request, or to change a done use case |
| `comment_on_usecase` | Replies to review feedback |
| `review_usecase` | Reviewer agents only: approve or ask for changes |
| `request_retirement` | Files a retirement in the inbox for a person |
| `claim_done` | Says an approved use case was merged |
| `list_without_evidence` | Scenarios nothing proves, to write tests from |
| `list_areas`, `list_terms` | The project's areas, and its terms from OpenPurpose |

### Review modes

An admin sets one mode per agent in Settings. Every use case records how it was approved, and the
catalogue can filter for "no human has checked this".

| Mode | What it does |
|---|---|
| A person approves (default) | It waits in the inbox |
| A reviewer agent approves | A different agent with reviewer rights must approve. The proposal needs the user's request word for word |
| Approved on arrival | No review. It doesn't let an agent widen its task |

**What the server can and can't prove.** It can prove that the token approving a use case isn't the token
that wrote any revision of it. It can't see who holds a token. A sub-agent normally uses its parent's
token, so it counts as the parent. For a real second opinion, run the reviewer in CI with its own token
that the proposing agent can't read. Retiring a done use case always needs a person.

## Add it to CI

Add a **CI** token in Settings, and copy [the sample workflow](docs/github-actions-usecases.yml).

```sh
npx @openstuff-dev/usecase report --suite e2e results.xml   # on the default branch
npx @openstuff-dev/usecase check --pr-body body.md results.xml   # on a pull request
```

- `report` uploads JUnit XML. OpenUsecase reads it, updates each scenario's result and throws the file
  away. History gets a row only when a scenario's health changes.
- `check` fails unless the PR body names approved use cases, as `Use cases: UC-142, UC-150`, or says why
  there are none, as `No use case: <reason>`, and every scenario has a tagged test. A test in another
  repository of the project counts too. Exemptions are self-declared but visible, and a reviewer still has
  to catch extra work inside a pull request with a valid ID.

| Health | Rule |
|---|---|
| `failing` | Any tagged test failed in any repository's latest report |
| `passing` | A tagged test ran and none failed, or a person checked it by hand |
| `no evidence` | No tagged test ran. A skipped test doesn't count |

A use case goes live after an agent calls `claim_done` and the next report shows every scenario passing.

## Settings

Set these in the environment, or in `.env` with Docker. Each has a default.

| Setting | Default | What it does |
|---|---|---|
| `PORT` | `8080` | Port to listen on |
| `HOST` | `0.0.0.0` | Address to listen on |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug` or `trace` |
| `DATABASE_URL` | `postgres://openusecase:openusecase@localhost:5432/openusecase` | The Postgres database. Compose sets it from `POSTGRES_PASSWORD` |
| `POSTGRES_PASSWORD` | `openusecase` | The database password compose sets up. Change it before you put this on a network |
| `WEB_DIR` | none | The built web app to serve. The Docker image sets it |
| `OPENUSECASE_PUBLIC_URL` | `http://localhost:8080` | Where people reach it. Cookies are marked secure when it starts with `https://` |
| `OPENUSECASE_ADMIN_EMAIL` | `admin@example.com` | The first admin |
| `OPENUSECASE_ADMIN_PASSWORD` | none | Their password. Without it, one is made and logged once |
| `OPENUSECASE_SESSION_DAYS` | `30` | How long someone stays signed in |
| `OPENUSECASE_TRUST_PROXY` | none | Behind a reverse proxy: `true`, or the proxy's addresses |
| `OPENUSECASE_REPORT_MAX_BYTES` | `20971520` | The largest test report CI may upload |
| `OPENUSECASE_SECRET_KEY` | none | Encrypts the OpenPurpose token and the connection secrets. Without it, a key is made and kept in the database |
| `OPENUSECASE_FETCH` | `public` | `private` lets this server call internal addresses, such as an OpenPurpose on your network |
| `OPENUSECASE_FETCH_ALLOW` | none | With `private`: only these hosts, comma-separated |
| `OPENUSECASE_OPENVERSION_URL` | none | The server-wide OpenVersion address. Set it, with the two below, and the Integrations tab shows it read-only |
| `OPENUSECASE_OPENVERSION_PUBLIC_KEY` | none | The OpenVersion public key (`pk_…`) for the same connection |
| `OPENUSECASE_OPENVERSION_DEPLOY_TOKEN` | none | Lets this server test the connection, and publish its own version (`VERSION`, set by the image build) on start. An older image never rolls the live version back. Keep it secret |
| `OPENUSECASE_OPENANNOUNCE_URL` | none | The server-wide OpenAnnounce address. Set it, with the public key, and the Integrations tab shows it read-only |
| `OPENUSECASE_OPENANNOUNCE_PUBLIC_KEY` | none | That OpenAnnounce system's public key |
| `OPENUSECASE_OPENANNOUNCE_SIGNING_SECRET` | none | Signs each person's token, so messages can be aimed at a team or role. For this server only, never in browser code |
| `VERSION` | `unknown` | Set by the image build from the release tag. At `unknown` (a local build), nothing is published |

## Your glossary

Link [OpenPurpose](https://purpose.openstuff.dev) in Settings, and agents are told to keep to its terms and
to propose new ones there. The inbox marks terms and shows their definitions. Without the link, everything
else works the same.

## Your data

An admin can export everything a team has as one file in Settings, and import it into a team with no
projects. It never holds a token or a password. Agents get new tokens, and CI's next report brings the
current test results back.

## Security

- Teams are kept apart by Postgres row-level security, so a query that forgets its filter can't leak.
- Tokens are stored as SHA-256 hashes and shown once. The OpenPurpose token is encrypted with AES-256-GCM.
- A bearer token never counts as a person. Agents and CI can't manage tokens, members or permissions, not
  even their own, and get a 403 when they try.
- This server only calls public addresses by default, so a URL someone enters can't reach into your network.

## Develop

```sh
npm install
docker run -d --name open-usecase-db -e POSTGRES_USER=openusecase -e POSTGRES_PASSWORD=openusecase \
  -e POSTGRES_DB=openusecase_test -p 55436:5432 postgres:16-alpine
npx nx serve web        # http://localhost:4200
npx nx dev server       # the API on http://localhost:8080; the web app sends /api there
```

Before you push, run what CI runs:

```sh
TEST_DATABASE_URL=postgres://openusecase:openusecase@localhost:55436/openusecase_test \
  npx nx run-many -t lint stylelint typecheck test build
```

Test names carry their scenario's ID: this project uses itself. The use cases are in
[`docs/trial/usecases.md`](docs/trial/usecases.md), and the trial that shaped them is in
[`docs/trial/report.md`](docs/trial/report.md).

## Layout

| Folder | What's in it |
|---|---|
| `apps/server` | The API, the MCP server and the migrations |
| `apps/web` | The Angular web app |
| `packages/contracts` | The types the server and web app share |
| `packages/usecase` | The `openusecase` CLI, published as `@openstuff-dev/usecase` |
| `docs` | The trial's records, and the sample CI workflow |

## License

MIT
