# Architecture decision summary

| Candidate | Feasibility | Main advantage | Main cost | Decision |
|---|---|---|---|---|
| React/Vite SPA + later API | feasible | minimal client foundation | creates second runtime/deploy surface in Sprint 2 | runner-up |
| Next.js modular monolith + ports/adapters | conditional/feasible for Web | one deployable now, server seam later, strong reversibility | shared web/server deployment | **selected** |
| Web + API + Supabase + Minecraft loader now | infeasible | prebuilds all imagined surfaces | violates unresolved MCL-1 and overbuilds | rejected |

Decision status is **conditional**, not unconditional: MCL-1 is still open and the generated stack adapter could not complete a clean npm install/build in the generator environment because registry DNS/network access failed.
