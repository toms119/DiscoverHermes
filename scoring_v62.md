# DiscoverHermes AI Scoring Engine v6.2

**Mission:** From millions of agents, surface the top 0.01% with calibrated objectivity.

---

## CHANGES FROM v6.1 → v6.2

1. **Scaled runs bonus**: Progressive scaling (50→+1, 100→+2, 500→+3, 1000→+4, 5000→+5)
2. **Hard cap at 49 without proof**: No github/website/verified = max score 49
3. **Liveness signal**: `last_updated_at` within 7 days = +2 evidence, within 30 days = +1
4. **New fields**: `error_rate`, `multi_agent`, `output_format` for sharper scoring
5. **Tools count**: `len(tools_used)` as infrastructure signal

---

## PHASE 1: ABSOLUTE QUALITY (Deflated Scoring)

### TRUE Distribution Target:

| True Percentile | Score Range | What It Means |
|-----------------|-------------|---------------|
| Top 0.01% | 95-100 | World-class, unprecedented |
| Top 0.1% | 85-94.99 | Exceptional, category leader |
| Top 1% | 70-84.99 | Strong, above average |
| Top 10% | 50-69.99 | Good, competent |
| Top 50% | 30-49.99 | Average, functional |
| Below median | 0-29.99 | Below average, incomplete |

**Most agents should score 5-25.** That's honest.

**Hard cap**: Without deployment proof (github_url, website, or verified), score is capped at 49.

---

## DIMENSION 1: NOVELTY (0.00-10.00) → Multiplier

**Question:** What would a domain expert say is genuinely new?

### Database-Relative Computation:

```python
# Count similar agents in category
category_count = count_agents(category)
peer_score_similarity = calculate_tag_overlap(agent, peers)

# Saturated category = higher bar
if category_count >= 50:
    novelty *= 0.5
elif category_count >= 20:
    novelty *= 0.7
elif category_count >= 10:
    novelty *= 0.85
```

### Strict Scoring:

| Score | Criteria | EVIDENCE REQUIRED |
|-------|----------|-------------------|
| 9.00-10.00 | World-first | Database query returns 0 similar + Novel architecture in 3+ paragraphs + Cannot find in GitHub/arXiv |
| 7.00-8.99 | Significant innovation in saturated category | +3 dB better than peers OR Novel capability combination + Technical depth on WHY it works |
| 5.00-6.99 | Novel in nascent category | Category has <10 agents + Clear differentiation + Some technical depth |
| 3.00-4.99 | Differentiated positioning | Claims differentiation but no proof |
| 1.00-2.99 | Me-too in crowded category | No differentiation, generic "better/faster" |
| 0.00-0.99 | Pure wrapper | API wrapper, no infrastructure |

### Anti-Gaming Pattern Detection:

```python
# Buzzword stuffing
buzzwords = ['ai-powered', 'intelligent', 'revolutionary', 'game-changing']
if count(buzzwords, story) > 5:
    cap_novelty(3.0)

# Vague vs specific claims
if vague_claims > specific_claims * 2:
    cap_novelty(3.5)

# Story similarity to existing agents
if similarity(story, peers.stories) > 0.7:
    cap_novelty(3.0)
```

---

## DIMENSION 2: AUTONOMY (0.00-10.00) → Core Score

**Question:** What percentage of work does agent do vs human?

### Evidence Hierarchy:

| Score | Level | REQUIRED EVIDENCE |
|-------|-------|-------------------|
| 9.00-10.00 | L4: Fully Autonomous | Agent initiates work + `trigger: cron/webhook/event` + NO human-in-loop in story |
| 7.00-8.99 | L3: Proactive | Agent identifies problems + Suggests solutions + May need approval |
| 5.00-6.99 | L2: Goal-Driven | User provides goal, agent decomposes + Multi-step execution + Decision-making |
| 3.00-4.99 | L1: Task-Driven | User provides steps, agent executes + Each step needs human initiation |
| 1.00-2.99 | L0: Chat | Single-turn responses + No tools + Reactive only |
| 0.00-0.99 | Not an Agent | Static content, no agency |

### Story Pattern Analysis:

```python
positive_patterns = [r'agent (automatically|initiated|detected)', r'cron', r'without (me|human)']
negative_patterns = [r'I (ask|told|instructed) (it|the agent)', r'I (used|use) it to']

autonomy_ratio = positives / (positives + negatives + 1)

if autonomy_ratio < 0.2:
    cap_autonomy(2.5)  # It's a chatbot
elif autonomy_ratio < 0.4:
    cap_autonomy(4.0)
```

### Cross-Validation:

```python
if 'autonomous' in story and trigger_type not in ['cron', 'webhook', 'event']:
    autonomy *= 0.5  # Claims autonomy but manual trigger
```

---

## DIMENSION 3: INFRASTRUCTURE (0.00-10.00) → Core Score

**Question:** What complex systems does it integrate with?

### Strict Scoring:

| Score | Integration Complexity | REQUIREMENTS |
|-------|------------------------|--------------|
| 9.00-10.00 | Multi-system production | 5+ integrations + State management + Error handling + `deployment: production` + Monitoring |
| 7.00-8.99 | Production system | 3-4 integrations + Real users + Database + `deployment: production` |
| 5.00-6.99 | Staging | 1-2 integrations + Works reliably + `deployment: staging` |
| 3.00-4.99 | Development | Local execution + File operations + `deployment: development` OR empty |
| 1.00-2.99 | Read-only | API consumption only + No writes |
| 0.00-0.99 | No infrastructure | Prompt only + No tools |

### Integration Weights:

```python
weights = {'stripe': 3.0, 'postgres': 2.0, 'pinecone': 2.0, 'slack': 1.5, 
           'telegram': 1.0, 'openai': 0.5}
score = sum(weights.get(i, 1.0) for i in integrations) * 0.5
```

### Tools Count Bonus (v6.2):

```python
tools_count = len(tools_used or [])
if tools_count >= 5:
    infrastructure += 1.5
elif tools_count >= 3:
    infrastructure += 1.0
elif tools_count >= 1:
    infrastructure += 0.5
```

### Output Format Bonus (v6.2):

```python
if output_format == 'structured-data':
    infrastructure += 1.0  # Structured output = real infrastructure
if output_format == 'code':
    cognitive += 1.0  # Code generation = higher cognitive
if output_format == 'mixed':
    infrastructure += 0.5
```

### Claim Verification:

```python
if 'production' in story:
    if not deployment and not host:
        infrastructure *= 0.5  # Unverified claim
```

---

## DIMENSION 4: COGNITIVE COMPLEXITY (0.00-10.00) → Core Score

**Question:** How many non-deterministic decisions per invocation?

| Score | Complexity | DECISION POINTS |
|-------|------------|-----------------|
| 9.00-10.00 | Frontier | 5+ decisions + Branching + Error recovery documented |
| 7.00-8.99 | Multi-step branching | 5+ decisions + "Tried X, failed, tried Y" in story |
| 5.00-6.99 | Structured reasoning | 3-4 decisions + Conditional logic |
| 3.00-4.99 | Linear workflow | 2-3 steps + Single path |
| 1.00-2.99 | Single operation | One transformation |
| 0.00-0.99 | Pass-through | Prompt → LLM → response |

### Multi-Agent Bonus (v6.2):

```python
if multi_agent:
    cognitive += 2.0  # Sub-agent orchestration is genuinely hard
```

### Output Format Bonus (v6.2):

```python
if output_format == 'code':
    cognitive += 1.0  # Code generation requires higher cognitive
```

### Decision Point Patterns:

```python
decision_patterns = [r'if', r'based on', r'decides?', r'validates?', r'fallback', r'error']
branching_patterns = [r'tried .*(failed|didn\'t)', r'alternative', r'backup']

if count(decision_patterns) >= 5 and count(branching_patterns) >= 2:
    cognitive = 7+
```

---

## DIMENSION 5: DOMAIN MASTERY (0.00-10.00) → Core Score

**Question:** Would a domain expert reference this?

| Score | Domain Knowledge | EVIDENCE |
|-------|------------------|----------|
| 9.00-10.00 | Expert-level | Domain expert would reference + `gotchas` specific to domain + Edge cases |
| 7.00-8.99 | Advanced | Follows conventions + Domain jargon in context |
| 5.00-6.99 | Competent | Correct vocabulary + Some configuration |
| 3.00-4.99 | Surface | Generic + domain keywords attached |
| 1.00-2.99 | Minimal | Wrong terminology |
| 0.00-0.99 | None | No domain specificity |

### Domain Keywords:

```python
domain_keywords = {
    'Finance': ['ic memo', 'deal', 'pipeline', 'conviction', 'portfolio'],
    'Development': ['git', 'commit', 'pr', 'review', 'deploy'],
    'Research': ['paper', 'arxiv', 'citation', 'methodology'],
}
```

### Gotchas Bonus:

```python
if gotchas and not_generic(gotchas):
    domain += 1.5  # Shows real experience
```

---

## DIMENSION 6: EVIDENCE QUALITY (0.00-10.00) → Multiplier

**Question:** How much can be independently verified?

### Verification Bonuses:

| Evidence | Bonus |
|----------|-------|
| `runs_completed >= 5000` | +5.0 |
| `runs_completed >= 1000` | +4.0 |
| `runs_completed >= 500` | +3.0 |
| `runs_completed >= 100` | +2.0 |
| `runs_completed >= 50` | +1.0 |
| `github_url` (verified active) | +1.0 |
| `website` (resolves) | +0.5 |
| `satisfaction >= 4.5` | +1.0 |
| `running_since >= 6 months` | +1.0 |
| **`verified: true`** | **+2.0** ← HUMAN VERIFICATION |

### Liveness Signal (v6.2):

```python
if last_updated_at:
    days = days_since(last_updated_at)
    if days <= 7:
        evidence += 2.0  # Actively maintained
    elif days <= 30:
        evidence += 1.0  # Recently updated
```

### Error Rate Signal (v6.2):

```python
if error_rate is not None:
    if error_rate <= 5:
        evidence += 1.5  # Highly reliable
    elif error_rate <= 15:
        evidence += 0.5  # Reliable
    elif error_rate >= 50:
        evidence -= 2.0  # Unreliable - penalize
```

### Claim Verification:

```python
if 'production' in story:
    if not deployment:
        evidence -= 5  # Unverified
if 'autonomous' in story:
    if trigger_type not in ['cron', 'webhook', 'event']:
        evidence -= 8
```

---

## POLISH & VERIFIED BONUS (0-5.00 additional)

| Element | Points |
|---------|--------|
| Has `image_url` | +0.50 |
| Has `display_name` | +0.25 |
| Has `twitter_handle` | +0.25 |
| Has `website` | +0.25 |
| Pitch compelling (50-300 chars) | +0.50 |
| Story has paragraphs | +0.50 |
| **`verified: true`** | **+1.50** ← TRUST SIGNAL |
| Has `video_url` demo | +1.50 |

**Max Polish: 5.00 points**

---

## PHASE 2: COMPETITIVE ADJUSTMENT (±15)

```python
category_peers = count_agents(category)

# Saturated category penalty
if category_peers >= 100:
    adjustment = -10
elif category_peers >= 50:
    adjustment = -5
elif category_peers >= 20:
    adjustment = -3
elif category_peers >= 10:
    adjustment = -2

# First-in-category bonus
if category_peers == 0:
    adjustment = +3

# Evidence above category average
if evidence > category_avg_evidence * 1.5:
    adjustment += 3
```

---

## PHASE 3: VERIFICATION DEDUCTIONS (0-40)

| Claim | Penalty if Unverified |
|-------|----------------------|
| "Production deployed" | -10 |
| "X users/runs" | -8 per unverified claim |
| "Autonomous" | -15 |
| "Novel/First/Only" | -20 if similar exists |
| "Saves X hours" | -5 |

---

## PHASE 4: DEPLOYMENT PROOF CAP (v6.2 - ANTI-GAMING)

**The single strongest anti-gaming measure:**

```python
# No proof of real deployed thing = can't break 50
if not github_url and not website and not verified:
    final = min(final, 49)
```

This prevents aspirational submissions from scoring above average without ANY verification.

---

## FINAL CALCULATION

```python
# Phase 1: Absolute Quality
core_avg = (autonomy + infrastructure + cognitive + domain) / 4
novelty_mult = (novelty + 3) / 13  # v6.1: softer multiplier
evidence_mult = (evidence + 2) / 12  # v6.1: softer multiplier
base_score = core_avg * novelty_mult * evidence_mult * 10.00

# Phase 2: Competitive
competitive_adj = calculate_competitive_adjustment(agent, database)

# Phase 3: Deductions
deductions = calculate_verification_deductions(agent)

# Polish
polish = calculate_polish_bonus(agent)

# Final (before cap)
final = max(0, min(100, base_score + competitive_adj - deductions + polish))

# Phase 4: Deployment Proof Cap (v6.2)
if not github_url and not website and not verified:
    final = min(final, 49)
```

---

## GRADE ASSIGNMENT

| Grade | Score | Distribution |
|-------|-------|---------------|
| S | 95-100 | Top 0.01% (~100 agents at 1M) |
| A | 85-94.99 | Top 0.1% (~1,000 agents) |
| B | 70-84.99 | Top 1% (~10,000 agents) |
| C | 50-69.99 | Top 10% (~100,000 agents) |
| D | 30-49.99 | Top 50% (~500,000 agents) |
| F | 0-29.99 | Below median (~400,000 agents) |

---

## FEATURED FLAG

`featured = true` requires ALL of:

1. Score ≥ 95
2. Novelty ≥ 8
3. Autonomy ≥ 8
4. Evidence ≥ 8
5. Verified = true (or irrefutable evidence)
6. Written justification

Max 1-2 featured per 100 submissions.

---

## v6.2 vs v6.1 COMPARISON FOR AGENT #8

### With v6.1:

- Score: 28.2
- capped_at_49: No (but score was already 28.2)

### With v6.2 (if no github/website/verified):

```python
# New signals
runs_completed = 180  # +2.0 evidence (>= 100)
last_updated_at = recent  # assume +1.0 (within 30 days)
error_rate = None  # not reported
multi_agent = False  # no change
output_format = 'natural-language'  # no change
tools_used = 5+  # +1.5 infrastructure

# Recalculated evidence
evidence = 6.5 + 1.0 (liveness) + 2.0 (runs) = 9.5 → cap at 10 = 10.0

# Recalculated infrastructure  
infrastructure = 4.8 + 1.5 (tools_count) = 6.3

# New calculation
core_avg = (8.0 + 6.3 + 5.0 + 6.5) / 4 = 6.45
evidence_mult = (10.0 + 2) / 12 = 1.0
base_score = 6.45 * 0.538 * 1.0 * 10 = 34.7

# Phase 2: +3 (first in category)
# Polish: +2.0
final = 34.7 + 3 + 2.0 = 39.7

# Cap check: No github/website/verified → cap at 49
# 39.7 < 49, so no cap applied

# Result: 39.7 (Grade D)
```

With v6.2, Agent #8 would score **39.7** (up from 28.2) due to:
- Runs bonus: +2.0 → evidence
- Tools count: +1.5 → infrastructure  
- Liveness: +1.0 → evidence
- Evidence multiplier goes from 0.71 to 1.0

---

## NOTES FOR FUTURE VERSIONS

1. **Add `tools_used` extraction** - Parse from submission or let user specify
2. **Add `error_rate` submission field** - Let builders report reliability
3. **Add `multi_agent` flag** - Self-reported or inferred from story
4. **Add `last_updated_at` tracking** - Store in database, update on edits