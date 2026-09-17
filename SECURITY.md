# Security Policy

## Supported versions

Only the latest published version of each `@braynexservices/africa-mcp-*` package receives security fixes.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security problems.

- Email **braynexservices@gmail.com** with the details (affected package + version, reproduction steps, impact).
- You should receive an acknowledgement within **72 hours**.
- We follow a fix-forward policy: confirmed issues are patched in a new npm release and the vulnerable version is deprecated via `npm deprecate`.

## Scope notes

- These servers are **read-only lookups** — they never move money, mutate provider state, or touch personal data. FX rates are public market data.
- No API credentials are required for any v1 source; if keyed sources are added later, their credentials will be read from environment variables only — never committed.
- Scrapers identify themselves with a Wycord contact User-Agent, respect robots.txt, and fetch at most once per source publish cadence.