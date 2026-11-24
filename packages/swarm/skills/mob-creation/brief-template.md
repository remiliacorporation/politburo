# Mob brief

- Mob ID: <<mob_id>>
- Class: <<class>>
- Repo: <<repo_coordinate>>
- Branch: <<branch>>

## Dispatch envelope

- party: <<party>>
- repo: <<repo>>
- work_id: <<work_id>>
- attempt: <<attempt>>
- tier: <<tier>>
- parent: <<parent>>
- session: <<session>>
- trace: <<trace>>

## Acceptable outcomes
<!-- politburo-outcomes:v1 -->
- [ ] kind: pull_request
      repo: <<outcome_repo>>
      base: <<base>>
      state: <<pr_state>>
      checks: <<required_checks>>
      evidence: <<pr_evidence>>
- [ ] kind: report
      location: <<report_location>>
      required_sections: [<<required_sections>>]
      evidence: <<report_evidence>>

## Verification
- completion_rule: <<completion_rule>>
- reviewer: <<reviewer>>
- on_no_match: <<on_no_match>>

## Goal

<<goal>>

## Check

<<check>>

Record gate evidence for the exact revision and attempt. Give commands and
results for checks run, and name any check you did not run.

## Invariants

<<invariants>>

## Review rules

Follow the `policy` skill. Keep nonblocking findings as follow-ups.

## Final message

Report the mob ID, work ID and attempt, outcome or blocker, exact head or
artifact digest, evidence reference, checks and review verdict, and follow-ups.
Say whether any work is unpushed or any sprite or claim is still active.
