# Transsmart APIv2 Postman collection

A real Transsmart APIv2 Postman collection export (~3.4MB, 46k tokens) —
kept as raw Postman JSON rather than converted to OpenAPI. It's already
lossless through `tokenizeJson5`, and `--outline` works on it directly, the
same as the AGV specs — no conversion needed just for exploration, and one
would risk misrepresenting Postman's shape (examples vs. schemas don't map
1:1 to OpenAPI).

`node tdump.js --outline 2 "Transsmart APIv2.postman_collection.json"` —
folded at depth 2, the standard Postman collection top level:

```
outline (folded at depth 2; raise to peel a layer):
{
  " "info"
  { … 36 … }
  " "item"
  [ … 46118 … ]
  " "auth"
  { … 44 … }
  " "event"
  [ … 85 … ]
}
```

`item` is the request/folder tree (46118 tokens folded above). Peeling it
open shows 10 top-level sections ("0. Introduction" through "9.0 Reports")
and ~40 requests, matching the endpoint list on
[devdocs.transsmart.com](https://devdocs.transsmart.com/#_integration_endpoints)
but with real request bodies, query params, and examples:

```
0. Introduction/
1.0 Get token/
  GET    1.1 Get token  {{base_url}}/login
2.0 Shipment management/
  2.1 Booking a shipment/
    POST   2.1.1 Book a shipment  {{base_url}}/v2/shipments/{{account}}/BOOK
    ...
  2.2 Getting shipment data/
  2.3 Deleting shipments/
  2.4 Manifesting shipments/
3.0 Rates calculation/
4.0 Document printing/
5.0 Shipment status tracking/
6.0 Address book management/
7.0 Account management/
8.0 Pick-up / Drop-off location select/
9.0 Reports/
```

## Depth 3: `info` in full, each top-level section still folded

`node tdump.js --outline 3 "Transsmart APIv2.postman_collection.json"` — the
collection metadata (`_postman_id`, `schema`) is now visible, and each of
the 10 sections shows as one folded object per array slot:

```
outline (folded at depth 3; raise to peel a layer):
{
  " "info"
  {
    " "_postman_id"
    " "c37fb3d4-67e0-43ee-988f-9b30406aed60"
    " "name"
    " "Transsmart APIv2"
    " "description"
    " "This Postman package serves as a guideline for integrating …
    " "schema"
    " "https://schema.getpostman.com/json/collection/v2.1.0/collec…
    " "_exporter_id"
    " "19164174"
  }
  " "item"
  [
    { … 116 … }
    { … 765 … }
    { … 13113 … }
    { … 2654 … }
    { … 4757 … }
    { … 4273 … }
    { … 9328 … }
    { … 7309 … }
    { … 3402 … }
    { … 350 … }
  ]
  " "auth"
  {
    " "type"
    " "bearer"
    " "bearer"
    [ … 28 … ]
  }
  " "event"
  [
    { … 37 … }
    { … 37 … }
  ]
}
```

The ten folded span sizes are "2.0 Shipment management" (13113 tokens — by
far the largest section, matching it being the richest part of the API)
down to "0. Introduction" (116 tokens, no real requests, just a description).

## Depth 4: each section's own name/item/description/auth

`node tdump.js --outline 4 "Transsmart APIv2.postman_collection.json"` —
one layer deeper, each section object opens up:

```
outline (folded at depth 4; raise to peel a layer):
{
  " "info"
  {
    " "_postman_id"
    " "c37fb3d4-67e0-43ee-988f-9b30406aed60"
    " "name"
    " "Transsmart APIv2"
    " "description"
    " "This Postman package serves as a guideline for integrating …
    " "schema"
    " "https://schema.getpostman.com/json/collection/v2.1.0/collec…
    " "_exporter_id"
    " "19164174"
  }
  " "item"
  [
    {
      " "name"
      " "0. Introduction"
      " "item"
      []
      " "description"
      " "Before you are able to actively use this Postman package, y…
      " "event"
      [ … 85 … ]
    }
    {
      " "name"
      " "1.0 Get token"
      " "item"
      [ … 649 … ]
      " "description"
      " "https://devdocs.transsmart.com/#_authenticating\r\n\r\nAPIv…
      " "event"
      [ … 85 … ]
    }
    {
      " "name"
      " "2.0 Shipment management"
      " "item"
      [ … 12945 … ]
      " "description"
      " "\nhttps://devdocs.transsmart.com/#_shipment_booking\n\nThe …
      " "auth"
      { … 44 … }
      " "event"
      [ … 85 … ]
    }
    {
      " "name"
      " "3.0 Rates calculation"
      " "item"
      [ … 2486 … ]
      " "description"
      " "https://devdocs.transsmart.com/#_rates_calculation\r\n\r\nM…
      " "auth"
      { … 44 … }
      " "event"
      [ … 85 … ]
    }
    {
      " "name"
      " "4.0 Document printing"
      " "item"
      [ … 4589 … ]
      " "description"
      " "https://devdocs.transsmart.com/#_document_printing\r\n\r\nM…
      " "auth"
      { … 44 … }
      " "event"
      [ … 85 … ]
    }
    {
      " "name"
      " "5.0 Shipment status tracking"
      " "item"
      [ … 4105 … ]
      " "description"
      " "https://devdocs.transsmart.com/#_shipment_status_tracking\n…
      " "auth"
      { … 44 … }
      " "event"
      [ … 85 … ]
    }
    {
      " "name"
      " "6.0 Address book management"
      " "item"
      [ … 9160 … ]
      " "description"
      " "https://devdocs.transsmart.com/#_address_book_management\r\…
      " "auth"
      { … 44 … }
      " "event"
      [ … 85 … ]
    }
    {
      " "name"
      " "7.0 Account management"
      " "item"
      [ … 7141 … ]
      " "description"
      " "https://devdocs.transsmart.com/#_account_management\r\n\r\n…
      " "auth"
      { … 44 … }
      " "event"
      [ … 85 … ]
    }
    {
      " "name"
      " "8.0 Pick-up / Drop-off location select"
      " "item"
      [ … 3234 … ]
      " "description"
      " "https://devdocs.transsmart.com/#_pick_up_locations_determin…
      " "auth"
      { … 44 … }
      " "event"
      [ … 85 … ]
    }
    {
      " "name"
      " "9.0 Reports"
      " "item"
      [ … 334 … ]
    }
  ]
  " "auth"
  {
    " "type"
    " "bearer"
    " "bearer"
    [
      { … 22 … }
    ]
  }
  " "event"
  [
    {
      " "listen"
      " "prerequest"
      " "script"
      { … 21 … }
    }
    {
      " "listen"
      " "test"
      " "script"
      { … 21 … }
    }
  ]
}
```

Two things worth noting from this depth: each section's `description` is a
link straight back to the matching `devdocs.transsmart.com` anchor (so the
collection and the prose docs are cross-referenced, not two independent
sources), and most sections carry their own `auth` override — only
"0. Introduction" and "9.0 Reports" don't, inheriting the collection-level
bearer auth shown at the top instead.

## Zooming in on one request instead of peeling by depth

`--outline` folds by DEPTH, which gets tedious once you know what you want
but not where it is — e.g. finding the request that hits
`{{base_url}}/v2/shipments/{{account}}/PRINT?rawJob=true` would mean
peeling all the way through "2.0 Shipment management" -> "2.1 Booking a
shipment" -> one of five requests. `tfind.js` zooms by CONTENT instead:

```
$ node tfind.js -u 2 "PRINT?rawJob=true" "Transsmart APIv2.postman_collection.json"
3 match(es) for "PRINT?rawJob=true"

── token 3437: "{{base_url}}/v2/shipments/{{account}}/PRINT?rawJob=true" ──
breadcrumb (innermost first): url <- request <- 2.1.2 Book and retrieve documents <- item <- 2.1 Booking a shipment <- item <- 2.0 Shipment management <- item <- #0
zoomed to labelled ancestor #3 (0 = nearest) ("2.1.2 Book and retrieve documents", tokens 3256..4156):

{
  "name": "2.1.2 Book and retrieve documents",
  ...
```

The breadcrumb alone (drop `-u`, the default zooms to the nearest labelled
ancestor — here that's `url`, the request's URL breakdown object, often too
narrow) already answers "where does this live"; `-u N` widens the zoom to
the Nth ancestor out. There were 3 matches, not 1 — the other two are the
recorded example *responses*' `originalRequest.url` echoing the same URL,
which the breadcrumb makes obvious without opening each one.

### A cross-cutting search: `insurance`

`node tfind.js -c "insurance" "Transsmart APIv2.postman_collection.json"` —
breadcrumb-only, 7 matches spanning three different requests:

```
7 match(es) for "insurance"

── token 1195: "[{\r\n\t\"reference\": \"postman-{{$timestamp}}\",\r\n    \"carrier\": \"DHP\",… ──
breadcrumb (innermost first): body <- request <- 2.1.1 Book a shipment <- item <- 2.1 Booking a shipment <- item <- 2.0 Shipment management <- item <- #0

── token 14868: "3.2 Calculating insurance" ──
breadcrumb (innermost first): 3.2 Calculating insurance <- item <- 3.0 Rates calculation <- item <- #0

── token 15059: "{{base_url}}/v2/rates/{{account}}/insurance?currency=EUR&countryFrom=NL&country… ──
breadcrumb (innermost first): url <- request <- 3.2 Calculating insurance <- item <- 3.0 Rates calculation <- item <- #0

── token 15094: "insurance" ──
breadcrumb (innermost first): path <- url <- request <- 3.2 Calculating insurance <- item <- 3.0 Rates calculation <- item <- #0

── token 15761: "Get insurance information" ──
breadcrumb (innermost first): Get insurance information <- item <- 3.0 Rates calculation <- item <- #0

── token 15952: "{{base_url}}/v2/rates/{{account}}/insurance/InsuranceTest1" ──
breadcrumb (innermost first): url <- request <- Get insurance information <- item <- 3.0 Rates calculation <- item <- #0

── token 15987: "insurance" ──
breadcrumb (innermost first): path <- url <- request <- Get insurance information <- item <- 3.0 Rates calculation <- item <- #0
```

Two honest things this surfaces. First, the intended matches: "3.2
Calculating insurance" and "Get insurance information" are both distinct
requests under "3.0 Rates calculation", found via their name, their URL,
and their URL's parsed `path` segments (Postman decomposes a URL into
`raw`/`host`/`path`/`query`, so one logical match can show up under several
sibling keys). Second, a real limitation: token 1195 is the ENTIRE raw
request body of "2.1.1 Book a shipment" — Postman stores a body as one
opaque string, not structured JSON, so a substring match inside it can't
zoom any further than that one (very long — the header line truncates it
at 80 chars) string token. `tfind.js` reports it honestly rather than
guessing at internal structure the tape doesn't actually have.
