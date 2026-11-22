# Three-character project tags

## Summary

No external standard governs three-letter repository, branch, mailbox, and issue
prefixes. These are a local identifier namespace. Do not adopt ISO, aviation,
currency, or catalogue abbreviations for this purpose. They assign codes within
their own controlled domains; they do not provide a general abbreviation
algorithm.

Ranked recommendation:

1. Use a checked-in local registry and the existing consonant/word-boundary
   style. Assign `pbo` to Politburo.
2. Use a deterministic registry check for uniqueness and reserved codes. The
   registry, rather than a linguistic rule, is the mechanical source of truth.
3. Do not use `pol` for Politburo. It is ISO 3166-1 alpha-3 for Poland.
4. Do not use `plb` unless the Personal Locator Beacon association is wanted.

Recommended tags are `pbo`, `rwl`, `kgm`, `rdn`, `rml`, and `tyr`.

## What published systems actually do

### Formal standards

* **ISO 4 / LTWA — a true ISO standard.** ISO 4 standardises abbreviated
  *journal titles*. Its rules use the ISSN International Standard Serial Number
  Centre's controlled List of Title Word Abbreviations (LTWA), generally
  omitting articles and applying an approved abbreviation to each title word.
  It is not a three-character code system and does not apply to project names.
  ISO's description is at https://www.iso.org/standard/3569.html and the
  ISSN LTWA service is at https://www.issn.org/services/online-services/ltwa/.
  The public LTWA download/service available during this research did not
  yield machine-readable entries for **politburo**, **political**, or
  **bureau**. Exact current LTWA entries are therefore **unverified**. Do not
  infer an LTWA abbreviation from ordinary spelling.

* **ISO 3166 alpha-3 — a true ISO standard.** It assigns three letters to
  countries and territories, not names in general. `POL` is Poland's
  alpha-3 code. ISO describes the country-code standard at
  https://www.iso.org/iso-3166-country-codes.html.

* **ISO 639-3 — a true ISO standard.** It assigns three letters to
  individual languages. The ISO 639 code tables are published through the
  Library of Congress at https://www.loc.gov/standards/iso639-2/php/code_list.php.
  Its codes are assigned identifiers, not abbreviations made from a name.

* **ISO 4217 — a true ISO standard.** It assigns three-letter currency codes.
  The first two letters usually identify the country and the last letter the
  currency, but that is a currency convention, not a reusable shortening
  rule. See https://www.iso.org/iso-4217-currency-codes.html.

* **IATA and ICAO — controlled industry code systems.** IATA airport location
  identifiers are three letters and are centrally assigned; the IATA directory
  is at https://www.iata.org/en/publications/directories/code-search/.
  ICAO location indicators are normally four characters, so ICAO is not a
  model for a three-character project tag. ICAO's publications catalogue is
  at https://www.icao.int/publications/Pages/default.aspx.

* **Library cataloguing (AACR2/RDA) — cataloguing rules, not a code standard.**
  RDA records names and preferred titles under controlled description rules.
  It does not prescribe three-character project identifiers. The Library of
  Congress RDA policy statements are at https://www.loc.gov/aba/rda/.

### Widely used conventions, not general standards

* **Stock tickers.** Exchanges assign symbols in their own namespaces.
  Length and formation vary by exchange and issuer. Nasdaq's symbol search
  demonstrates that these are market identifiers, not a universal naming
  rule: https://www.nasdaq.com/market-activity/stocks/screener.

* **Jira project keys.** Jira uses a project key plus a number for issue
  identifiers. Atlassian documents administrator-configured key rules, not a
  universal three-letter abbreviation algorithm:
  https://support.atlassian.com/jira-cloud-administration/docs/configure-project-keys/.
  The product's suggested/generated key behaviour is product UI behaviour,
  not a published standard. Its precise current generation algorithm is
  **unverified** here.

* **Linear team keys.** Linear issue identifiers use the team key. The key is
  a team-level product identifier, not a standards-based abbreviation. Linear
  team documentation is at https://linear.app/docs/teams. Exact current
  automatic-key generation behaviour is **unverified**.

* **GitHub and GitLab.** They use repository names and URL paths/slugs. They
  do not require a three-letter project-key convention. GitHub's repository
  creation documentation is https://docs.github.com/en/repositories/creating-and-managing-repositories/creating-a-new-repository;
  GitLab's project documentation is
  https://docs.gitlab.com/user/project/working_with_projects/.

* **US Navy/NATO disemvowelling.** No authoritative Navy or NATO publication
  was found that makes “remove vowels” a general acronym-generation rule.
  Military glossaries standardise already assigned abbreviations. Treat
  claimed “Navy” or “NATO” disemvowelling rules as **unverified convention**,
  not a standard.

* **Beads.** Beads uses a prefix before an issue number, but no authoritative
  Beads naming rule requiring three letters or defining how to derive one was
  found. The current project repository is
  https://github.com/gastownhall/beads. Any project-specific prefix policy is
  local configuration/convention.

## Evidence-based design constraints

There is no verified research result that ranks *three-character software
prefixes* as consonant skeletons, initials, or truncations. Claims that one is
inherently more memorable should therefore not be presented as settled
evidence.

Two narrower conclusions are sound:

* A short code is easier to use when it has a stable one-to-one mapping.
  This follows directly from the controlled-assignment designs of ISO, IATA,
  and issue trackers above. Uniqueness inside the namespace matters more than
  resemblance to an external code.
* Pronounceability and familiar chunks can help verbal recall, but they can
  also import an unintended meaning. Memory research treats phonological
  coding as a component of short-term memory; it does not validate a
  particular tag algorithm. See Baddeley, “Working memory,”
  https://doi.org/10.1126/science.1736359. This is supporting background, not
  direct evidence for the tags below.

Use collision checks at two levels:

1. **Hard collision:** no duplicate in the organisation's tag registry.
2. **Soft collision:** reject a code with a strong meaning in the team's
   normal domains: country/currency codes, an important product, an offensive
   term, or an operationally confusing existing code. Do not attempt to avoid
   every airport, language, ticker, and acronym. With only 17,576 lowercase
   triples, that goal is impossible in practice.

## Politburo candidates

| Rank | Code | Assessment |
|---|---|---|
| 1 | `pbo` | Best local mnemonic: **P**olit**B**ur**O** / “Polit-buro”. It is not a standard abbreviation. IATA assigns `PBO` in its airport namespace; that is a weak conflict for this internal use. Check the current assignment in IATA's code search: https://www.iata.org/en/publications/directories/code-search/. |
| 2 | `plb` | Good consonant shape, but `PLB` is the established abbreviation for a personal locator beacon. NOAA uses that term at https://www.sarsat.noaa.gov/406beacon.html. |
| 3 | `ptb` | Reasonably distinctive, but PTB is Germany's national metrology institute, Physikalisch-Technische Bundesanstalt: https://www.ptb.de/cms/en.html. |
| 4 | `pol` | Most obvious truncation, but a strong collision: ISO 3166-1 alpha-3 for Poland. |
| 5 | `plo` | Strong political association with the Palestine Liberation Organization. The UN's observer description uses that name: https://www.un.org/unispal/data-collection/palestine-liberation-organization/. |

`pbo` wins because it remains recognisable to a reader of the project name,
matches the team's existing style better than literal truncation, and has no
high-salience conflict in ordinary software work. It should not be described
as ISO-, IATA-, or LTWA-derived.

## Recommended local rule

The request for a fully mechanical *linguistic* rule has no satisfactory
answer. Names such as `Remilytics`, `Tigeryard`, and `Politburo` have ambiguous
word boundaries. A rule that invents those boundaries will produce arbitrary
results. Standards solve this by assigning codes from a registry.

Use this mechanical policy instead:

1. Maintain a versioned `project-tags` registry mapping canonical repository
   name to exactly three lowercase ASCII letters.
2. For a new project, generate a candidate from the intended visible word
   boundaries and salient consonants. Prefer a three-letter, speakable form.
   Preserve each meaningful word/component where possible.
3. Reject a duplicate or reserved soft collision. Pick the next approved
   candidate and record it. Never silently recompute old tags after a rename.
4. Use the registry value verbatim in mailboxes, issue IDs, branches, and
   session titles.

This is mechanical in all uses and stable over time. Candidate selection is a
small human naming decision, as it is in the formal code systems.

For future names, split spaces, hyphens, and intentional CamelCase boundaries.
For two-word names, start with the two initials and add a salient consonant
from the distinguishing word. For names sharing a prefix such as `Remi-`,
make the post-`Remi` component visible (`rdn` versus `rml`) rather than
creating ambiguous `rem` tags. For a one-word coined name, use a distinctive
consonant skeleton rather than its first three letters when that preserves
recognition.

## Applied registry

| Project | Tag | Rationale and conflict check |
|---|---|---|
| Politburo | `pbo` | Recommended above. IATA namespace collision only; acceptable for local use. |
| Remilia World | `rwl` | `R`emilia + `W`orld + distinguishing `l`. No high-salience conflict found; **unverified** against exhaustive external acronym databases. |
| Kagami | `kgm` | Consonant skeleton. No high-salience conflict found; **unverified** exhaustively. |
| RemiDarkNET | `rdn` | Existing component initials. `RDN` is also a computing term (“recursive DNS server”/related DNS usage), so document it but it is acceptable in this local namespace. IETF DNS terminology is published at https://www.rfc-editor.org/rfc/rfc8499. |
| Remilytics | `rml` | Existing recognisable skeleton. `RML` has several niche meanings; no high-salience conflict found; **unverified** exhaustively. |
| Tigeryard | `tyr` | `T`iger + `Y`ard + distinguishing `r`. `TYR` is the gene symbol for tyrosinase in NCBI Gene: https://www.ncbi.nlm.nih.gov/gene/7299. This is a niche collision and acceptable unless the team works in genomics. |

The registry has six unique entries and preserves the useful existing `rdn`
and `rml` forms. It replaces the short legacy forms `rw`, `kg`, `pb`, and `ty`
with exactly three characters.
