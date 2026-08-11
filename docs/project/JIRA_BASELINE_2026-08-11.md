# Jira baseline used for the foundation - 2026-08-11

Project: `MCL - Minecraft-Legends`

This is a bootstrap evidence snapshot, not a replacement for live Jira.
Issue status/scope must be re-read from Jira before implementation.

## Architecture-driving items

### MCL-1 - Product format decision

Observed status during bootstrap: open / To Do.
The issue explicitly excludes engine, loader/framework selection, architecture and implementation from the product-format decision itself.

**Foundation consequence:** no Fabric, NeoForge or standalone-engine commitment is allowed in this bootstrap.

### MCL-22 - Web architecture and data flow

Observed architectural direction:

- thin MVP architecture,
- reliable child submissions,
- browser fallback plus later server inbox,
- later Supabase adapter without rebuilding the UI,
- explicit separation of raw audio, transcript, interpretation and confirmed source-of-truth data,
- no frontend secrets.

### MCL-33 - Local -> Server -> Supabase data flow

Observed direction:

- immutable original artifacts,
- persistence adapter boundary,
- no private keys in frontend,
- model carries idea/question/profile/timestamp/audio/status concepts.

### MCL-34 - Secure local inbox backend

Observed security requirements include:

- unauthenticated GET/listing forbidden,
- authenticated family/admin read path,
- allowlisted audio MIME/extensions,
- maximum upload size,
- reject executable HTML/script content,
- local gate must not be blindly reused as production/Supabase security.

## Sprint 1 labels observed

- MCL-37 - one current Avaloria question can be answered by text; blank/whitespace cannot submit.
- MCL-38 - local status is exactly "Nur auf diesem Gerät gespeichert" and survives reload; server-arrived status requires ACK.
- MCL-40 - stable submission ID/timestamp/question reference/original text, browser-local persistence adapter, UI independent of concrete persistence, no secrets.

## Sprint 2 direction observed

The backlog contains later server-inbox/acknowledgement and question-rotation work (including MCL-35, MCL-36 and MCL-39 in the read project state). Re-read live Jira before starting Sprint 2.

## Evidence gap: Confluence

Connected Confluence searches for `Avaloria`, `Minecraft`, `Minecraft-Legends` and `MCL-1` returned no MCL-specific page during this bootstrap run. Natural-language search produced unrelated projects/pages.

This means only: **no matching MCL Confluence source was located through the available connector/search paths in this run**. It does not prove that no MCL page exists.
