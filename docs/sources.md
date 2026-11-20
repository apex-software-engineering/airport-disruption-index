# Sources

## FAA NAS Status airport feed (settlement source)

- **URL:** `https://nasstatus.faa.gov/api/airport-status-information`
- **Access:** unauthenticated HTTPS `GET`, no key, no parameters (query strings are ignored and the
  full feed is returned). XML, about 2 KB. The response is `Cache-Control: no-cache`, with no ETag
  and no rate-limit headers. The NAS Status User Guide says the site updates every minute. We poll
  once per 5 minutes with the User-Agent
  `airport-disruption-index-collector/1.0 (+https://airports.apexsofteng.com)`. Errors come back as
  HTML pages, which the parser rejects by root element.
- **Format:** root `AIRPORT_STATUS_INFORMATION`; `Update_Time` like `Tue Nov 17 20:43:54 2026 GMT`;
  repeated `Delay_type` blocks, each with an optional `Name` and one list. Field-level handling is
  in [methodology.md](methodology.md#source).
- **Terms / licensing:** NAS Status is operated by the FAA. Its content is a work of the US
  Government and is not subject to copyright in the US (17 U.S.C. 105). No usage terms, licence or
  rate limit for the feed were found on nasstatus.faa.gov or in the NAS Status User Guide.
  `robots.txt` allows all agents and paths. The FAA web policies
  (https://www.faa.gov/web_policies/disclaimer) apply. We attribute it as "Source: FAA NAS Status
  (nasstatus.faa.gov)" in plain text, with no FAA or DOT logo or seal. The index is not affiliated
  with or endorsed by the FAA.
- **Archive:** every response body is stored byte for byte and served at `/api/v1/rounds/{id}/raw`,
  with its sha256 in the round receipt.

## FAA NAS Status airport events JSON (possible cross-check, not used in v1)

- **URL:** `https://nasstatus.faa.gov/api/airport-events`
- Undocumented JSON that the NAS Status List View loads. Per airport it has `groundStop`,
  `groundDelay`, `airportClosure` and others, with ISO UTC `startTime`/`endTime` and numeric delays.
- It is not the v1 settlement source: it is undocumented and may change without notice, and the
  documented XML feed is what the FAA links publicly. It is a candidate for a second, independently
  checked observation in a future version (quorum 2).

## Panel definition

- **FAA Core 30:** https://aspm.faa.gov/aspmhelp/index/Core_30.html (FAA ASPM help). This is the
  list the panel is drawn from.
- **FAA CY2024 commercial-service enplanements:**
  https://www.faa.gov/airports/planning_capacity/passenger_allcargo_stats/passenger/arp-cy2024-commercial-service-enplanements.pdf.
  This is the ranking that picks the top 20 of the Core 30.
- Both are US Government works. They fix the v1 panel, and later updates do not change v1.

## History / backfill

The index is **live-only from its first production round**. No value exists for any earlier day.

The ATCSCC advisory archive (fly.faa.gov advisories) was assessed as a backfill source. It is a
plain GET and holds history back to at least 2023. But reconstructing which airports were under a GS
or GDP in each 5-minute slot needs free-text chaining of GS, GDP, cancellation (CNX) and extension
advisories. That chaining cannot be done reliably enough for settlement. Any future backfill would
be a **separately labeled series** with its own methodology, never mixed into the live prints.

## Test fixtures

Recorded live payloads and labelled synthetic payloads are in `fixtures/feed/`; see its README.
