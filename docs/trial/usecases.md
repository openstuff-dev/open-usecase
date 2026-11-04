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
it with the trial, which keeps using `npm run -w apps/server trial:setup`.

### UC-6: A person sets up a team

Status: proposed, not built in the trial (the user's decision, 2026-11-04)

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
2026-11-04. To be built after the gate.

Status: proposed, not built

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

"Area" is the word the user kept. To be built after the gate.

Status: proposed, not built

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
