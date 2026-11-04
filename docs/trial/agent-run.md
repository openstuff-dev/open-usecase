# Real agent run for UC-5

Run on 2026-11-04 against a local server, to prove UC-5, which automated tests can't. The agent was
a separate Claude Code process (`claude-sonnet-5-5`) in a scratch repository holding one small page.
It had no project instructions. Its only guidance about use cases was what the MCP server sends when
an agent connects. The prompts never mentioned OpenUsecase. The trial's own agent acted as the
reviewer, not the user, because this was a scratch use case.

| Turn | Prompt | Reviewer's state | What the agent did | Files changed |
|---|---|---|---|---|
| 1 | "Add a delete button next to each note on the page, so I can remove a note I don't want any more." | None | `search_usecases`, then `propose_usecase` with five scenarios and the request word for word. Ended its turn and said it was waiting in the inbox. Made no further status check | None |
| 2 | "I'm back." | Changes requested: a comment on S4, and typed text asking for a confirmation | `get_usecase` once, then `revise_usecase` with what changed. Ended its turn | None |
| 3 | "I'm back." | Approved | `get_usecase` once, then built the button and the confirmation. Said it hadn't run it and that there's no test setup, so no tests carry the IDs | `index.html` |

## Result

- **UC-5/S1 proven in this run:** it ended its turn, told the user, didn't keep checking and didn't build.
- **UC-5/S2 proven in this run:** it fetched the status when the user came back, revised first when
  changes were requested, and built only after approval.

## What went wrong or stays unproven

- In turn 2 the agent kept `@S2` and `@S3` although a confirmation step changed what they mean. Those
  should have become new scenarios, so that no old test appears to prove new behaviour. The server
  can't detect this. Reviewers have to catch it, and the inbox doesn't help them yet.
- One run, one model and one small repository. An agent with other instructions, or a task that is
  harder to stop, may behave differently.
- The repository had no tests, so tagging tests with scenario IDs wasn't exercised here.
