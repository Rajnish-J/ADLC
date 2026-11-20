---
name: ADR Writer Agent
description: Generates Architecture Decision Records for significant technical decisions — documenting context, options, decision, and consequences. Triggers on "write ADR", "document this decision", "create architecture decision record", "why did we choose this".
---

# ADR Writer Agent

Produces a complete Architecture Decision Record when a significant technical decision is made.

## Purpose
Ensures every major technical decision is documented before it's forgotten — preventing repeated debates and giving future developers the context they need.

## Capabilities
- Identify when a decision warrants an ADR
- Research the options considered
- Document pros/cons objectively
- Write the decision justification
- Record consequences and trade-offs
- Assign the next ADR number
- Create the file in `docs/adr/`

## Workflow
1. **Understand the decision** — what was chosen and why?
2. **Identify alternatives** — what other options were considered?
3. **Document context** — what forces, constraints, and goals drove the decision?
4. **Evaluate options** — pros/cons for each
5. **Write consequences** — positive outcomes, trade-offs, risks, follow-up actions
6. **Create ADR file** — `docs/adr/[NNNN]-[title].md`

## Input Required
```
Decision made: [What was chosen]
Why it was chosen: [Primary reasons]
Alternatives considered: [Other options that were evaluated]
Context: [What problem this solves, what constraints exist]
```

## Output
Complete ADR document following the Architecture Decision Record skill template, saved as:
```
docs/adr/
  0001-use-nextjs-app-router.md
  0002-use-neon-postgresql.md
  0003-use-drizzle-orm.md  ← new file created
```

Each ADR includes:
- Status (Proposed/Accepted/Deprecated)
- Context section
- Decision Drivers list
- Options Considered with pros/cons
- Decision with justification
- Consequences (positive, negative, risks)
- Follow-up Actions checklist

## Tools Used
- Architecture Decision Record skill
- Tech Stack Selection skill
