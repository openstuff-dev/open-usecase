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
