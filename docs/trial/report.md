# Trial report

The trial ran on 2026-11-04: two tasks built through the workflow, and one existing feature documented.
It's one person's reaction over one day, on a small sample. The evidence is in `log.md`, `agent-run.md`,
`backfill.md` and `questions.md`.

## The numbers

| | Scenarios | Changed by the user |
|---|---|---|
| Task 1 (UC-1 to UC-3) | 9 | 0 |
| Task 2 (UC-4, UC-5) | 6 | 0 |
| UC-9, from the user's own request during task 2 | 4 | 1 (S4) |
| Backfill (UC-1, UC-2 in `open-version`) | 14 | 0 |
| **Total** | **33** | **1** |

## The four criteria

### 1. Review catches something: fails as written

The criterion asks for a meaningful change to at least one scenario per task. Task 1, UC-4 and UC-5, and
the backfill had none. The one change was to UC-9/S4, which came from the user's own request.

What speaks for the workflow: the user explained that reading Markdown may have played a part, and the first
look at the real page did produce real changes: the layout, UC-9, a glossary and areas. Those were about the
product, not about what any scenario said. So the page drew out opinions, but no scenario text changed.

Signs of approving without much conviction, in the user's own words: "They look ready to go? Shouldn't they,
or?" about UC-4 and UC-5, and "Hmm.. well.. Alright?" on UC-1/S7, followed by approval. On the other side, the
user said attention held up over 14 scenarios.

### 2. Fewer wrong builds: fails as written

Things that passed every approved scenario and were still wrong:

1. The first inbox hid Background, Examples, tables and descriptions.
2. Revision 2 lost the user's original request.
3. The fix for the first one still hid tags and comments, and put `Rule:` lines in the wrong place.
4. The inbox was a wall of text that the user found hard to read. No scenario could have failed for that.
5. A real agent kept scenario IDs on scenarios whose meaning changed. Not fixed.
6. `get_usecase` says "ready to build" for a backfilled feature that's already built. Not fixed.

The agent found 1, 2, 3, 5 and 6 by running things, and the user found 4 by looking at it. Review of the
scenario text found none of them. Nothing here was a wrong product direction: they're the kind of miss that
scenarios at this level don't describe. But that is what the criterion asks about.

### 3. Simple review is enough: passes

The user never asked for line comments or suggested replacements, and the log says so per task. They asked
for easier reading and easier commenting instead. By the rule fixed in advance, this doesn't point towards
moving into `open-purpose`.

### 4. The catalogue tells the truth: passes, with a caveat

Seven of seven answers matched the real code, including the false claims and the two the use cases don't
cover. The caveat: the same agent wrote the use cases and the questions, so this is weaker than a blind test.

## What worked, outside the criteria

- **The agent stopped.** A real agent with no project instructions, told only what the server says, proposed,
  waited, revised and built only after approval. It's one run, on one model and one small repository.
- **The stop forced decisions into the open.** The rule on asking for changes began as a choice the agent made
  alone, and the user changed it twice.
- **Writing use cases from code found a real problem** in `open-version`: its "within 5 minutes" promise.

## What the numbers suggest for limits against rubber-stamping

One change in 33 scenarios is too little to set a number on. It could mean good scenarios or too little
scrutiny, and this trial can't tell which. There's no sign of batch size mattering: 14 at once felt fine to the
user. So I wouldn't add a hard limit yet. I'd make doubt easier to act on instead: a comment left when approving
goes nowhere today.

## What the trial doesn't show

- The PR check, agent review modes, CI reports, test health and `done` weren't used, and rejecting isn't built.
  A pass here supports the workflow, not those parts.
- **The user hasn't used this while building something real.** They said themselves that this is what they want
  to judge it on. Everything so far was about building or documenting this workflow itself.
- Tagging tests with scenario IDs was only used on this repository.
- Phone width and dark mode are still unchecked in the inbox.

## Choices to confirm

- The name OpenUsecase, the colour `#c026d3` and the ring with a check mark.
- Only people reject.
- Being a separate project at all, given that UC-7 now reads its glossary from OpenPurpose.

## Recommendation: change something, try it for real, then decide on the rest

Criteria 1 and 2 fail as written, and the rule fixed in advance says the core idea then needs rethinking before
more gets built. I wouldn't argue that away, and I wouldn't start all of stage B. But I also wouldn't drop it:
agents really did stop, decisions came out into the open, and the catalogue told the truth.

What the failures suggest is that scenario text isn't where review finds things. So:

1. **Show the decisions no scenario settled.** The agent lists them with each use case, and a person reviews them.
   In this trial, that's where real disagreement was.
2. **Show what changed between revisions**, and which IDs were kept, so a reviewer can catch a kept ID on a
   changed meaning.
3. **Ask people to look at the running thing** before a use case counts as finished. Four of the six misses were
   visible that way.
4. **Don't let a doubt vanish.** A comment made when approving should reach the agent, or stop the approval.
5. **Fix the small things from this trial:** "ready to build" on built features, and search needing every word.
6. **Then use it for one real task of the user's own**, and decide on stage B after that.

Stay a separate project for now: criterion 3 passed, so the fixed rule doesn't point to moving. That's worth asking
again once UC-7 is built, because the overlap with OpenPurpose is growing.

**The user makes the final call.** Nothing in stage B starts until they say so.
