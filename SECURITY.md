# Security Policy

## Foundation rules

- Never commit credentials, API keys, service-role keys, access tokens, private certificates or real `.env` files.
- Browser code must never contain server/service credentials.
- Future server inbox reads must be authenticated; public unauthenticated listing is forbidden by the Jira architecture baseline.
- Future uploads must use an explicit MIME/extension allowlist and size limits and must reject executable HTML/script content.
- Original user submissions are source artifacts and must not be silently overwritten by transcription, normalization or AI interpretation.

## Reporting

Do not paste secrets into a public issue. Use the repository's private GitHub security reporting channel when configured, or contact the repository owner through an established private project channel.

## Scope note

This bootstrap does not yet implement authentication, production storage, media upload, Supabase, or a Minecraft loader. Their threat models are separate delivery decisions.
