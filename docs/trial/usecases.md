# Trial use cases

Written before any code. Nothing is built until the user approves it. Status is noted under each use
case. Phase 6 imports this file into the catalogue, keeping the IDs.

## Task 1: an agent proposes, a person reviews

### UC-1: An agent proposes a use case

Status: approved by the user, 2026-11-04

```gherkin
Feature: An agent proposes a use case

  @S1
  Scenario: A valid proposal reaches the inbox
    Given I am an agent with a token for a team
    When I propose a use case with a title and valid Gherkin
    Then I get its use case and scenario IDs
    And its status is "proposed"
    And it appears in that team's inbox

  @S2
  Scenario: Gherkin that doesn't parse is refused
    Given I am an agent with a token for a team
    When I propose a use case whose text isn't valid Gherkin
    Then the proposal is refused with a message that says what's wrong
    And nothing appears in the inbox

  @S3
  Scenario: A proposal without a valid token is refused
    Given I don't have a valid token
    When I propose a use case
    Then the proposal is refused
    And nothing appears in any inbox
```

### UC-2: A person reviews a proposal

Status: approved by the user, 2026-11-04

```gherkin
Feature: A person reviews a proposal

  @S1
  Scenario: Approve a proposal
    Given I am signed in as a member of the team
    And a proposed use case is in the inbox
    When I approve it
    Then its status is "approved"
    And it leaves the inbox

  @S2
  Scenario: Ask for changes, with a comment on one scenario
    Given I am signed in as a member of the team
    And a proposed use case is in the inbox
    When I comment on one of its scenarios and ask for changes
    Then its status is "changes requested"
    And the comment shows on that scenario

  @S3
  Scenario: The agent revises after a change request
    Given a use case has the status "changes requested"
    When the agent that proposed it sends new Gherkin with what changed
    Then its status is "proposed"
    And it is back in the inbox with the new text
    And the earlier comments can still be read
```

### UC-3: Teams and permissions stay apart

Status: approved by the user, 2026-11-04

```gherkin
Feature: Teams and permissions stay apart

  @S1
  Scenario: A person can't see another team's use cases
    Given I am signed in as a member of one team
    And another team has a proposed use case
    When I open my inbox, or ask for that team's inbox directly
    Then I don't see the other team's use case

  @S2
  Scenario: An agent can't act on another team's use case
    Given I am an agent with a token for one team
    And another team has a use case
    When I revise or comment on it
    Then I am told it wasn't found
    And it doesn't change

  @S3
  Scenario: An agent can't manage tokens or permissions
    Given I am an agent with a token
    When I try to create or revoke a token, or change permissions, even my own
    Then I am refused with a 403
    And nothing changes
```

## Task 2: an agent reads the approved version

### UC-4: An agent reads a use case

Status: approved by the user in the inbox, 2026-11-04. No text changed

```gherkin
Feature: An agent reads a use case

  @S1
  Scenario: Read an approved use case
    Given a use case has been approved
    When I fetch it as an agent in that team
    Then I get its status and the approved text
    And I am told it's ready to build

  @S2
  Scenario: A use case still waiting isn't ready
    Given a use case is waiting for review
    When I fetch it as an agent in that team
    Then I get its status and its text
    And I am told clearly not to build it yet

  @S3
  Scenario: Read what a reviewer asked for
    Given a person asked for changes, with a comment on one scenario
    When I fetch it as an agent in that team
    Then I am told not to build it, and to revise it first
    And I can see the comment and which scenario it's on

  @S4
  Scenario: Find use cases by what they're about
    Given a team has use cases with different statuses
    When I search for words from one of them, optionally for one status
    Then I get the matching use cases of my team, each with its ID and status
    And I get none from another team
```

### UC-5: An agent waits for approval

These are proven by running a real agent, not by automated tests.

Status: approved by the user, 2026-11-04. No text changed

```gherkin
Feature: An agent waits for approval

  @S1
  Scenario: End the turn after proposing
    Given I am an agent connected to OpenUsecase
    And my task changes behaviour a user can see
    When I propose a use case and it isn't approved on arrival
    Then I end my turn and tell the user it's waiting
    And I don't keep checking its status
    And I don't start building

  @S2
  Scenario: Pick the work up when the user returns
    Given I proposed a use case and ended my turn
    When the user comes back
    Then I fetch its status
    And I build only if it's approved
    And if changes were requested, I revise it first
```

## Found while building task 1

Uncovered behaviour, asked under the "always ask" rule. The user decided on 2026-11-04 not to build
it with the trial. It was built in stage B.

### UC-6: A person sets up a team

Status: proposed, built

```gherkin
Feature: A person sets up a team

  @S1
  Scenario: Add a project and its repository
    Given I am an admin of a team
    When I add a project with a git remote
    Then agents using that remote propose use cases into that project

  @S2
  Scenario: Give an agent a token
    Given I am an admin of a team
    When I add an agent
    Then I see its token once, and can't see it again

  @S3
  Scenario: Revoke a token
    Given an agent has a token
    When I revoke it as an admin of the team
    Then the agent can no longer use it

  @S4
  Scenario: Add a team and its members
    Given I am a server admin
    When I add a team and a member
    Then that member can sign in and sees the team's inbox
```

## Found while reviewing task 2 in the inbox

Asked for by the user on 2026-11-04. Not built. The user decides whether they are built in the trial
or after the gate.

### UC-7: Use cases keep to the OpenPurpose glossary

The glossary lives in OpenPurpose, and only applies once a team has added that integration. New terms
are proposed and approved in OpenPurpose, as they are today. The server can't tell whether a word is
an undefined term, so keeping to the list is a writing rule that agents follow and reviewers check.
This reopens the settled decision that neither server calls the other; the user decided that on
2026-11-04.

Status: proposed, built

```gherkin
Feature: Use cases keep to the OpenPurpose glossary

  @S1
  Scenario: An agent is told to keep to the terms
    Given my team has added the OpenPurpose integration
    When I prepare to propose a use case
    Then I am told to use only the project's approved terms
    And to propose a new term in OpenPurpose if none fits

  @S2
  Scenario: Terms stand out in the inbox
    Given my team has added the OpenPurpose integration
    And a use case uses approved terms
    When I review it in the inbox
    Then I see at the top which terms it uses
    And each term is marked in the scenarios
    And I can read its definition without leaving the page

  @S3
  Scenario: A team without the integration
    Given my team hasn't added the OpenPurpose integration
    When I review a use case in the inbox
    Then I see it without any marked terms
    And everything else works the same

  @S4
  Scenario: OpenPurpose can't be reached
    Given my team has added the OpenPurpose integration
    And OpenPurpose can't be reached
    When I review a use case in the inbox
    Then I can still read and decide on it
    And I am told that terms aren't marked right now
```

### UC-8: Use cases are grouped by area

"Area" is the word the user kept.

Status: proposed, built

```gherkin
Feature: Use cases are grouped by area

  @S1
  Scenario: An agent files a use case under an area
    Given the project has areas such as "Billing" and "Settings"
    When I propose a use case under one of them
    Then the inbox shows it under that area

  @S2
  Scenario: A proposal without an area is refused
    Given the project has areas
    When I propose a use case without an area, or with one that doesn't exist
    Then the proposal is refused
    And I am told which areas exist

  @S3
  Scenario: An agent needs a new area
    Given no area fits the use case
    When I propose the use case with a new area
    Then the person reviewing it sees that the area is new
    And approving the use case also adds the area

  @S4
  Scenario: A person moves a use case to another area
    Given a use case is under the wrong area
    When I move it to another area
    Then it shows under the new area
    And its ID and approval don't change
```

### UC-9: A person reads every scenario before deciding

Changes how UC-2 works. S2 and S3 are checked in the inbox, because the server can't tell what someone
has read. S4 is enforced by the server.

Status: approved by the user, 2026-11-04, after they changed S4: they first asked that asking for
changes need a comment, then that it always be possible and ask what should change in a dialog.

```gherkin
Feature: A person reads every scenario before deciding

  @S1
  Scenario: Read one scenario at a time
    Given a use case with several scenarios is in the inbox
    When I open it
    Then I see its first scenario
    And I can go to the next and the previous one

  @S2
  Scenario: Approving waits until the last scenario
    Given I haven't reached the last scenario
    When I look at the decision
    Then I can't approve yet, and I am told why
    And once I reach the last scenario, I can approve

  @S3
  Scenario: A new revision is read again
    Given I read revision 1 and asked for changes
    When the agent sends revision 2
    Then I start again at the first scenario
    And I have to reach the last one again to approve

  @S4
  Scenario: Asking for changes says what should change
    Given a use case is in the inbox
    When I ask for changes
    Then I am asked to type what should change
    And I can't send it without any text
    And the agent gets what I typed and my comments on the scenarios
```

## Stage B: the rest of the product

The user chose to build the rest of the product on 2026-11-04, and to judge it by using it on a product
they know. These use cases weren't reviewed before building. They are listed as proposed so they can be
reviewed afterwards in the real inbox.

### UC-10: A person rejects a use case

Status: proposed, built

```gherkin
Feature: A person rejects a use case

  @S1
  Scenario: Reject with a reason
    Given a use case is in the inbox
    When I reject it and say why
    Then its status is "rejected" and it leaves the inbox
    And it stays visible and searchable, with the reason

  @S2
  Scenario: A rejection needs a reason
    Given a use case is in the inbox
    When I try to reject it without saying why
    Then I can't, and it stays in the inbox

  @S3
  Scenario: A rejected use case can't be revised
    Given a use case was rejected
    When its agent tries to revise it
    Then it is refused, and told to propose a new one if it's still needed

  @S4
  Scenario: Only people reject and retire
    Given I am an agent
    When I try to reject or retire a use case
    Then I can't, whatever my review mode
```

### UC-11: Changing a done use case

Status: proposed, built

```gherkin
Feature: Changing a done use case

  @S1
  Scenario: A change goes through approval while the live version stays in force
    Given a use case is done
    When an agent sends a new revision
    Then a person reviews it in the inbox
    And the use case still reads "done", and says the live revision stays in force
    And an agent reading it gets both texts
```

### UC-12: Retiring a use case

Status: proposed, built

```gherkin
Feature: Retiring a use case

  @S1
  Scenario: An agent files a retirement
    Given a use case is done
    When an agent asks to retire it, and says why
    Then it stays done
    And it appears in the inbox with the reason

  @S2
  Scenario: A person retires it
    Given a use case is done
    When I retire it and say why
    Then its status is "retired"
    And agents can still read it, and are told not to build it again

  @S3
  Scenario: A person keeps it
    Given an agent asked to retire a use case
    When I decide to keep it
    Then the request goes away and it stays done

  @S4
  Scenario: IDs are never reused
    Given a use case was rejected or retired
    When an agent proposes a new use case
    Then the new one gets a new number
```

### UC-13: A doubt doesn't get lost when approving

The user left "Hmm.. well.. Alright?" on a scenario and approved, not knowing that approving ended the
review.

Status: proposed, built

```gherkin
Feature: A doubt doesn't get lost when approving

  @S1
  Scenario: Comments reach the agent
    Given I left a comment on a revision and approved it
    When the agent reads the use case
    Then it sees the comment
    And it is told to raise it with the user before building

  @S2
  Scenario: No comments, no prompt
    Given I approved a revision without comments
    When the agent reads the use case
    Then it isn't told to raise anything
```

### UC-14: Agent review modes

Status: proposed, built

```gherkin
Feature: Agent review modes

  @S1
  Scenario: A person approves by default
    Given an agent has the mode "a person approves"
    When it proposes a use case
    Then a person reviews it in the inbox
    And a reviewer agent can't approve it

  @S2
  Scenario: A reviewer agent approves
    Given an agent has the mode "a reviewer agent approves"
    When it proposes a use case and a different agent with reviewer rights approves it
    Then it is approved
    And the use case records that an agent approved it

  @S3
  Scenario: A reviewer needs the user's request
    Given an agent has the mode "a reviewer agent approves"
    When it proposes without the user's request word for word
    Then the proposal is refused

  @S4
  Scenario: No approving your own work
    Given an agent wrote any revision of a use case
    When it tries to review that use case
    Then it is refused, even if another agent's revision came in between

  @S5
  Scenario: Reviewing needs rights and reasons
    Given an agent without reviewer rights
    When it tries to review
    Then it is refused
    And a reviewer asking for changes has to say what should change

  @S6
  Scenario: Approved on arrival
    Given an agent has the mode "approved on arrival"
    When it proposes a use case
    Then it is approved without review
    And the record says nobody checked it
    And the agent is told this doesn't widen its task

  @S7
  Scenario: Retiring always needs a person
    Given an agent has the mode "approved on arrival"
    When it asks to retire a done use case
    Then it stays done until a person decides

  @S8
  Scenario: An agent can't change its own mode
    Given I am an agent
    When I try to change my review mode
    Then I am refused with a 403
```

### UC-15: CI reports what the tests prove

Status: proposed, built

```gherkin
Feature: CI reports what the tests prove

  @S1
  Scenario: A report makes scenarios pass
    Given tests carry scenario IDs in their names
    When CI uploads their JUnit report from the default branch
    Then those scenarios read "passing"
    And the file isn't kept

  @S2
  Scenario: A repeat report adds no history
    Given CI uploaded a report
    When it uploads the same results again
    Then no new history appears

  @S3
  Scenario: A deleted or skipped test proves nothing
    Given a scenario had a passing test
    When the next report no longer has it, or it was skipped
    Then the scenario reads "no evidence"

  @S4
  Scenario: One failing repository makes it fail
    Given a scenario has tests in two repositories
    When one of them fails
    Then the scenario reads "failing"

  @S5
  Scenario: Suites stay apart
    Given unit and e2e reports come from separate jobs
    When each uploads
    Then neither overwrites the other

  @S6
  Scenario: Other branches don't count
    Given a report comes from a branch other than the default
    When CI uploads it
    Then it is refused with a clear message

  @S7
  Scenario: Stale IDs don't fail the upload
    Given a test names an unknown or retired ID
    When CI uploads the report
    Then it is accepted, and the answer lists the ID

  @S8
  Scenario: Only CI uploads
    Given I have an agent's token, or no token
    When I try to upload a report
    Then I am refused
    And a CI token can't do anything else

  @S9
  Scenario: Large reports stay fast
    Given a report has hundreds of tests
    When CI uploads it
    Then it takes the same few database round trips
```

### UC-16: A use case goes live

Status: proposed, built

```gherkin
Feature: A use case goes live

  @S1
  Scenario: Claimed and proven
    Given an agent merged an approved use case and claimed it done
    When the next report shows every scenario passing
    Then it reads "done" and "passing"

  @S2
  Scenario: A regression
    Given a use case is done
    When its test fails
    Then it reads "done" and "failing"

  @S3
  Scenario: Tests alone aren't enough
    Given an approved use case with passing tests
    When nobody claimed it
    Then it stays approved

  @S4
  Scenario: A new revision needs its own claim and all its scenarios
    Given a done use case has a newer approved revision
    When reports show only the old scenarios passing
    Then the old revision stays live until the new one is claimed and fully proven

  @S5
  Scenario: Only approved work can be claimed
    Given a use case isn't approved
    When an agent claims it done
    Then it is refused

  @S6
  Scenario: Filtering by health and approval
    Given use cases with different health and approval records
    When an agent searches with those filters
    Then it gets only the matching ones
```

### UC-17: The PR check

Status: proposed, built

```gherkin
Feature: The PR check

  @S1
  Scenario: Nothing named
    Given a PR body names no use cases and gives no reason
    When the check runs
    Then it fails and says what to write

  @S2
  Scenario: A visible exemption
    Given a PR body says "No use case" and why
    When the check runs
    Then it passes and shows the reason

  @S3
  Scenario: An unapproved use case
    Given a PR names a use case that isn't approved
    When the check runs
    Then it fails

  @S4
  Scenario: A scenario with no test
    Given a PR names an approved use case
    And one of its scenarios has no tagged test that ran
    When the check runs
    Then it fails and names the scenario

  @S5
  Scenario: Proven in another repository
    Given a scenario's test only lives in another repository of the project
    When the check runs
    Then it counts, and the answer says so

  @S6
  Scenario: Everything proven
    Given every scenario of an approved use case has a tagged test
    When the check runs
    Then it passes, and stores nothing

  @S7
  Scenario: Unknown use cases and tokens
    Given a PR names a use case that doesn't exist, or the token isn't CI's
    When the check runs
    Then it fails or is refused
```

### UC-18: The catalogue

Status: proposed, built

```gherkin
Feature: The catalogue

  @S1
  Scenario: See everything the product does
    Given a team has use cases
    When I open the catalogue
    Then I see each with its status, its health and how it was approved
    And I can filter, including by "no human has checked this"

  @S2
  Scenario: Teams stay apart
    Given another team has use cases
    When I open my catalogue, or ask for one of theirs directly
    Then I don't see them

  @S3
  Scenario: One use case in full
    Given a use case has tests and an approval
    When I open it
    Then I see its scenarios with their evidence, its revisions and its history

  @S4
  Scenario: A newer revision on the way
    Given a done use case has a newer revision
    When I open it
    Then I see the live text, and that a newer revision is waiting
```

### UC-19: Checking by hand

Status: proposed, built

```gherkin
Feature: Checking by hand

  @S1
  Scenario: A person checks a scenario
    Given a scenario can't reasonably be automated
    When I say I checked it, and what I did
    Then it counts as evidence
    And it is always labelled as manual

  @S2
  Scenario: Only people, and with a note
    Given I try to record a check without a note, or with an agent's token
    Then I am refused

  @S3
  Scenario: Going live on hand checks
    Given a use case is claimed done
    When every scenario is passing or checked by hand
    Then it goes live

  @S4
  Scenario: A new meaning starts over
    Given a scenario was checked by hand
    When its meaning changes, so it gets a new number
    Then the new scenario has no check

  @S5
  Scenario: Finding what nothing proves
    Given some scenarios have no evidence
    When an agent asks which
    Then it gets them by ID, to write tests from
```

### UC-20: A team takes its data with it

Status: proposed, built

```gherkin
Feature: A team takes its data with it

  @S1
  Scenario: Export
    Given I am an admin of a team
    When I export it
    Then I get one file with its projects, use cases, revisions, comments and history
    And it never holds a token or a password

  @S2
  Scenario: Import
    Given I have an export and an empty team
    When I import it
    Then the use cases are back with their IDs and approval records
    And importing into a team that has projects is refused
```

