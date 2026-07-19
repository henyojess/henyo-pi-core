# Evidence Collection Patterns

This reference provides concrete patterns for collecting and storing evidence during deep research.

## Pattern 1: Structured Evidence Cards

For each significant finding, create a structured card:

```markdown
# Evidence Card: <Identifier>

## Claim
<The specific claim this evidence supports>

## Source
- **Title:** <title>
- **URL:** <url>
- **Author:** <author/organization>
- **Date:** <publish date>
- **Accessed:** <today's date>

## Content
> <Direct quote or precise summary, 1-3 sentences>

## Relevance
<Why this source matters for the research question>

## Trust Signal
- **Domain authority:** High / Medium / Low
- **Author expertise:** Expert / Journalist / Enthusiast
- **Citation count:** <if applicable>
- **Cross-verified by:** <other sources confirming>

## Notes
<Any caveats, context, or limitations about this evidence>
```

## Pattern 2: Evidence Database (CSV-friendly)

When collecting quantitative data, use tabular format:

```markdown
| Source | Claim | Evidence | Confidence | Notes |
|--------|-------|----------|------------|-------|
| [1] | Market size $50B in 2025 | Statista report, 2025 | High | Direct quote |
| [2] | Market growing 15% YoY | Gartner, Q1 2025 | Medium | Projection estimate |
```

## Pattern 3: Search Query Log

Track what was searched and what was found:

```markdown
# Search Log

## Round 1: Initial Discovery
- Query: `"[query]"`
  - Source [1]: <title> — <url> — <key finding>
  - Source [2]: <title> — <url> — <key finding>
- Query: `"[query]"`
  - Source [3]: ...

## Round 2: Follow-up
- Query: `"[query]"`
  - Source [4]: ...

## Round 3: Verification
- Query: `"[query]"`
  - Source [5]: ...
  - Source [6]: ...
```

## Pattern 4: Source Credibility Matrix

For evaluating source quality:

```markdown
## Source Credibility Assessment

### Tier 1: Primary/Expert Sources
- Academic papers (peer-reviewed)
- Official company filings (10-K, earnings reports)
- Government publications (gov domains)
- Original data from authoritative organizations

### Tier 2: Secondary/Analysis Sources
- Reputable news outlets (Reuters, AP, Bloomberg)
- Established industry publications
- Conference presentations from known experts
- Well-cited technical blog posts

### Tier 3: Tertiary/Community Sources
- Social media (LinkedIn, X/Twitter) from experts
- Industry forums (Stack Overflow, Hacker News)
- User-generated content (Reddit, Medium)
- Company press releases (self-promotional)

### Tier 4: Low Credibility
- Unknown blogs with no byline
- Forums without expertise indicators
- Outdated content (>5 years for fast-moving topics)
- Sources with clear conflicts of interest
```

## Pattern 5: Cross-Verification Matrix

For claims requiring multiple sources:

```markdown
# Cross-Verification: <Claim>

| Source | Confirms? | Details | Date |
|--------|-----------|---------|------|
| [1] | ✅ | <what it says> | 2025-06-01 |
| [2] | ✅ | <what it says> | 2025-05-15 |
| [3] | ❌ | <contradicts with: ...> | 2025-04-20 |
| [4] | ⚠️ | <partial/ambiguous> | 2025-06-10 |

**Verdict:** Consensus / Divided / Unverified
**Confidence:** High / Medium / Low
**Date of assessment:** <today>
```

## Practical Tips

1. **Capture immediately** — Don't trust memory. Save source, URL, and key quote as soon as you read it.
2. **Save the exact quote** — Paraphrasing too early introduces errors.
3. **Note the date** — Information expires; always record when content was published and when you accessed it.
4. **Record both supporting and contradictory evidence** — Omitting contradictions is a common source of report bias.
5. **Log failed searches** — If a search returned nothing useful, record that too. It helps identify dead ends and informs the next search strategy.