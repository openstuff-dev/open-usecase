# Trial log

One row per task, written at the time and not afterwards.

| Task | Scenarios proposed | Changed or rejected by the user, and why | What the review caught | Wanted line comments or suggestions? | Work outside the scenarios | Passed all scenarios but still wrong? |
|---|---|---|---|---|---|---|
| 1: an agent proposes, a person reviews | 9 (UC-1 to UC-3), split because the task was over about 7 | None changed or rejected. The user asked whether "team" meant tenant, then kept "team" and approved as written | No change to any scenario's behaviour. The question showed that a term from the brief had never been the user's decision. Three points the agent flagged (no reject yet, any member can review, revising by a different agent not specified) stood without comment | No | Built without a scenario, all needed to run the approved ones: the sign-in page; HTTP routes for tokens and permissions, so UC-3/S3 has something to refuse; a setup script instead of setup screens (asked as UC-6); Docker settings. Decisions no scenario settled: a different agent can't revise, and revising only works while changes are requested | Yes, twice, both caught by the agent while running the app and fixed, not by the user. The first inbox passed all nine scenarios but hid Background, Examples, tables and descriptions, so a person could approve text they never saw. Revision 2 also lost the user's original request. Both now have tests. The scenarios said "in the inbox with the new text" and that didn't catch it |

