# Backfill: open-version's hard refresh and rollback

Written from the code and tests in `open-version` at commit `86a9de1`, and cross-checked with the
OpenPurpose section on `decide`. No code in `open-version` changed. IDs are per project, so these are
`UC-1` and `UC-2` in the project `open-version`. No tests carry these IDs yet, so they can't count as
proven.

## UC-1: A hard refresh reloads every open tab

Status: proposed

```gherkin
Feature: A hard refresh reloads every open tab
  Every open tab of one environment reloads once, without a new release. Teams use it when what's
  running in open tabs has to go. Written from the code, and no test carries these IDs yet.

  Scenario: Send a hard refresh from the dashboard
    Given I am a developer or an admin of the team
    When I send a hard refresh for an environment
    And I confirm the warning that unsaved work may be lost
    Then every open tab of that environment reloads once
    And tabs of other environments don't reload
    And no new release is created

  Scenario: Send a hard refresh from CI
    Given I have the deploy token of an environment
    When I send a hard refresh with the CLI or the API
    Then every open tab of that environment reloads once
    And no new release is created

  Scenario: A viewer can't send one
    Given I am a viewer of the team
    When I try to send a hard refresh
    Then I am refused
    And no tab reloads

  Scenario: A tab learns about it when it next checks
    Given a hard refresh was sent after my tab opened
    When my tab next checks
    Then it learns about the hard refresh
    And a visible tab checks every 5 minutes by default, when it's shown again, and when it comes back online
    But a tab in the background doesn't check on the timer

  Scenario: A tab reloads at a safe moment
    Given my tab has learned about a hard refresh and is visible
    Then it shows a banner counting down 30 seconds, with "Reload now"
    And it reloads when the countdown ends, when I navigate, or when the tab goes to the background, whichever comes first

  Scenario: A tab opened afterwards doesn't reload
    Given a hard refresh was sent before I opened my tab
    When my tab checks for the first time
    Then it doesn't reload for that hard refresh

  Scenario: A tab never reloads twice for the same thing
    Given my tab reloaded for a hard release
    And the old files are still being served, so it still runs the old version
    When it checks again
    Then it doesn't reload again
    And it asks me to reload instead
```

## UC-2: A rollback makes an older release live again

Status: proposed

```gherkin
Feature: A rollback makes an older release live again
  A person makes an earlier release live from the dashboard, and open tabs follow it. Written from
  the code, and no test carries these IDs yet.

  Scenario: Roll back to an older release
    Given 1.5.0 is live and 1.4.0 was published earlier
    And I am a developer or an admin of the team
    When I make 1.4.0 live from the dashboard and confirm
    Then 1.4.0 is live
    And open tabs running 1.5.0 reload at a safe moment, without asking

  Scenario: A rollback shows in the history
    Given I rolled back to 1.4.0
    When I look at the release history
    Then a new entry marked as a rollback says "Made 1.4.0 live again."
    And 1.5.0 is still in the history

  Scenario: What's new shows the notes of the older release
    Given I rolled back to 1.4.0, which was published with notes
    When a tab offers "What's new"
    Then it opens the notes from when 1.4.0 was published

  Scenario: A release that's already live can't be made live
    Given 1.4.0 is live
    When I make 1.4.0 live
    Then I am told it's already live
    And nothing changes

  Scenario: Go forward again
    Given I rolled back from 1.5.0 to 1.4.0
    When I make 1.5.0 live from the dashboard
    Then 1.5.0 is live
    And open tabs running 1.4.0 reload at a safe moment, without asking
    And the history marks this as a rollback too

  Scenario: Publishing after a rollback
    Given I rolled back from 1.5.0 to 1.4.0
    When CI publishes 1.5.0 again
    Then it is refused because 1.5.0 was already published
    And when CI publishes 1.5.1 instead, it goes live

  Scenario: Only a person who may publish can roll back
    Given 1.5.0 is live
    When a viewer tries to make an older release live
    Then the viewer is refused
    And when CI publishes a version lower than 1.5.0, it is refused and told to use the dashboard
```
