# "Isn't it true that...?" questions

Drafted by the trial's agent on 2026-11-04, at the user's request, and committed before the review so
they can't be fitted to it. The handoff asks for at least one false claim and one the use cases don't
cover. Which is which isn't marked here. All are about `open-version`.

1. Isn't it true that a hard refresh reloads open tabs without publishing a new version?
2. Isn't it true that rolling back to an older version doesn't reload open tabs?
3. Isn't it true that after rolling back from 1.5.0 to 1.4.0, CI can publish 1.5.0 again?
4. Isn't it true that a viewer can't send a hard refresh?
5. Isn't it true that a rollback also posts its release notes to OpenAnnounce?
6. Isn't it true that a tab in the background reloads within 5 minutes of a hard refresh?
7. Isn't it true that a person can cancel a forced reload once its countdown has started?

## How they get answered

After the user's review, a separate agent answers them. It gets only the `get_usecase` and
`search_usecases` tools, and no access to `open-version`'s code. Each answer uses the three-part form:
covered and passing, covered but weak, or not covered. Then each answer is checked against the real
code and tests, and every match or mismatch is recorded here.

## Results

Answered on 2026-11-04 by a separate Claude Code process (`claude-sonnet-5-5`) that could only use the
two read tools. The trial's agent then checked each answer against `open-version` at commit `86a9de1`.
No scenario has tests carrying its ID, so nothing could be "covered and passing".

| # | Answer from the use cases | The real code and tests | Match? |
|---|---|---|---|
| 1 | Yes, but weak. UC-1/S1 and S2 | `hardRefresh` only raises the epoch (`apps/server/src/model.ts:148`). `decide` forces a reload when the epoch rises. Tests: `api.test.ts:196`, `decide.test.ts:19` | Yes |
| 2 | False, but weak. UC-2/S1 | A rollback is recorded as hard (`model.ts:139`), so `decide` forces a reload. Tests: `api.test.ts:204`, `client.test.ts:300` | Yes |
| 3 | False, but weak. UC-2/S6 | Refused as "already published" (`model.ts:89`). Test: `api.test.ts:214` | Yes |
| 4 | Yes, but weak. UC-1/S3 | The route needs `WRITERS`. Test: `api.test.ts:124` | Yes |
| 5 | Not covered | The claim is false: a rollback inserts nothing into the outbox (`model.ts:136-143`). No test says so. "Not covered" was the honest answer | Yes |
| 6 | False, but weak. UC-1/S4 | Hidden tabs skip the timer (`client.ts:208`). Test: `client.test.ts:156` | Yes |
| 7 | Not covered, implied you can't | The banner offers only "Reload now" (`update/index.ts:243`). An app can cancel with `ov-update-forced` (`client.test.ts`), but a person can't | Yes |

**Seven of seven match.**

## What this doesn't show

- The same agent wrote the use cases and the questions after reading the same code. Question 6 is about
  something that agent had already noticed, and had written into UC-1/S4. The answering agent was
  independent, but the material it answered from wasn't a blind test.
- Search needs every word to match. "countdown cancel forced reload" found nothing, although UC-1/S5 is
  about the countdown. The agent had already read both use cases, so it wasn't misled. An agent that stops
  at "no match" would wrongly say "not covered".
- Both use cases carry the text "ready to build" when read, although this feature was built long ago.

## Found along the way

- The hard refresh dialog promises "within 5 minutes" and the CLI "within a few minutes", but a background
  tab doesn't check until it's shown again. Reported as a finding on `open-version` (`e1bfd693`). This is
  a real product problem, and writing the use cases from the code is how it was found.

