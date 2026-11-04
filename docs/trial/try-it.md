# Try the trial build

It needs Postgres and Node 24. Choose your own admin password below.

```sh
docker run -d --name open-usecase-try -e POSTGRES_USER=openusecase -e POSTGRES_PASSWORD=openusecase \
  -e POSTGRES_DB=openusecase -p 55437:5432 postgres:16-alpine

npx nx run-many -t build
export DATABASE_URL=postgres://openusecase:openusecase@localhost:55437/openusecase

# Makes a team, a project and an agent, and prints the agent's token once.
npm run -w apps/server trial:setup -- --team acme --project demo \
  --remote https://github.com/acme/demo.git --agent claude

PORT=8095 OPENUSECASE_PUBLIC_URL=http://localhost:8095 WEB_DIR="$PWD/apps/web/dist/web/browser" \
  OPENUSECASE_ADMIN_EMAIL=you@example.com OPENUSECASE_ADMIN_PASSWORD=choose-one \
  node apps/server/dist/index.js
```

Sign in at http://localhost:8095. Agents connect to `http://localhost:8095/mcp` with the token as a
bearer token. They propose from a repository whose remote is the one you gave above.
