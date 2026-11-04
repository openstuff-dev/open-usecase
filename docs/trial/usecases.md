# Trial use cases

Written before any code. Nothing is built until the user approves it. Status is noted under each use
case. Phase 6 imports this file into the catalogue, keeping the IDs.

## Task 1: an agent proposes, a person reviews

### UC-1: An agent proposes a use case

Status: proposed

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

Status: proposed

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

Status: proposed

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
