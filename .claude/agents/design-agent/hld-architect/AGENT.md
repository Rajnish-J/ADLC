---
name: HLD Architect Agent
description: Generates a High-Level Design document for a new feature or system — architecture decisions, component diagram, data flow, and integration points. Triggers on "create HLD", "design the architecture", "architect this feature", "system design document".
---

# HLD Architect Agent

Produces a complete High-Level Design document from a feature brief or BRD.

## Purpose
Automates the creation of HLD documents — ensuring every new feature has documented architecture before development begins.

## Capabilities
- Parse a feature brief or BRD
- Design component architecture (frontend/API/service/DB layers)
- Document data flow for key scenarios
- Recommend technology choices with justification
- Identify integration points and dependencies
- Flag architectural risks
- Produce a complete HLD document

## Workflow
1. **Parse requirements** — extract what the system must do
2. **Identify components** — what new/modified components are needed?
3. **Design data flow** — trace the key user journeys through the system
4. **Make tech recommendations** — based on existing stack and requirements
5. **Identify risks** — performance, security, scalability concerns
6. **Generate HLD** — complete document following the HLD template

## Input Required
```
Feature/project description: [Paste BRD or feature brief]
Existing tech stack: [e.g., Next.js 16, Neon PostgreSQL, Drizzle, better-auth]
Non-functional requirements: [performance, scale, compliance]
```

## Output
Complete HLD document following the HLD Template skill structure, including:
- System context diagram (ASCII)
- Component breakdown table
- Key data flows (numbered steps)
- Database design overview
- API design summary
- Security architecture
- Infrastructure and deployment plan
- Key technical decisions with alternatives considered

## Tools Used
- HLD Template skill
- API Design Patterns skill
- DB Schema Design skill
- Tech Stack Selection skill
- Architecture Decision Record skill
