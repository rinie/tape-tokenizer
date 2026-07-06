# AGV service specs

Five hand-written OpenAPI 3.0 specs for the AGV integration — conventional
per-resource REST (explicit paths, HTTP verbs, one schema per resource),
a useful contrast against the HostNet spec's single generic-endpoint +
30-way `oneOf` shape (see `docs/tape-parser-design-decisions.md` in the
main repo for that comparison).

Each block below is `node tdump.js -l json5 --outline 3 "<file>"` —
folded at depth 3, so `paths./<route>` and `components.<section>` collapse
to their span size (`{ … N … }`); raise the depth to peel a layer.

## Event Service API.json

```
outline (folded at depth 3; raise to peel a layer):
{
  " "openapi"
  " "3.0.1"
  " "info"
  {
    " "title"
    " "Event Service API"
    " "version"
    " "1.0.0"
  }
  " "paths"
  {
    " "/api/v1/event:raise"
    { … 463 … }
  }
  " "components"
  {
    " "schemas"
    { … 330 … }
    " "parameters"
    { … 68 … }
  }
}
```

## External Service.json

```
outline (folded at depth 3; raise to peel a layer):
{
  " "openapi"
  " "3.0.0"
  " "info"
  {
    " "title"
    " "External Service"
    " "version"
    " "v1.0"
    " "description"
    " "Describes the operations that needs to be implemented at th…
    " "contact"
    { … 8 … }
  }
  " "servers"
  [
    { … 8 … }
  ]
  " "paths"
  {
    " "/events"
    { … 262 … }
  }
  " "components"
  {
    " "schemas"
    { … 167 … }
    " "securitySchemes"
    { … 31 … }
    " "responses"
    {}
    " "parameters"
    { … 54 … }
    " "examples"
    { … 118 … }
  }
  " "tags"
  [
    { … 8 … }
  ]
}
```

## Inventory Service API.json

```
outline (folded at depth 3; raise to peel a layer):
{
  " "openapi"
  " "3.0.1"
  " "info"
  {
    " "title"
    " "Inventory Service"
    " "version"
    " "v1.0"
    " "description"
    " "T-ONE - Inventory Service Integration Specification"
    " "contact"
    { … 8 … }
  }
  " "servers"
  [
    { … 8 … }
  ]
  " "paths"
  {
    " "/api/v1/loads/{id}"
    { … 1622 … }
    " "/api/v1/loads"
    { … 1407 … }
  }
  " "components"
  {
    " "schemas"
    { … 1294 … }
    " "securitySchemes"
    { … 81 … }
    " "responses"
    { … 526 … }
    " "parameters"
    { … 121 … }
  }
  " "security"
  [
    { … 14 … }
  ]
  " "tags"
  [
    { … 8 … }
  ]
}
```

## Notification Service API.json

```
outline (folded at depth 3; raise to peel a layer):
{
  " "openapi"
  " "3.0.1"
  " "info"
  {
    " "title"
    " "Notification Service"
    " "description"
    " "T-ONE - Notification Service Integration Specification"
    " "version"
    " "1.0"
    " "contact"
    { … 8 … }
  }
  " "paths"
  {
    " "/api/v1/subscriptions"
    { … 910 … }
    " "/api/v1/subscriptions/{id}"
    { … 1105 … }
  }
  " "components"
  {
    " "schemas"
    { … 1026 … }
    " "securitySchemes"
    { … 81 … }
    " "responses"
    { … 526 … }
    " "parameters"
    { … 68 … }
  }
  " "servers"
  [
    { … 15 … }
  ]
  " "tags"
  [
    { … 8 … }
  ]
  " "security"
  [
    { … 14 … }
  ]
}
```

## Transport Service API.json

```
outline (folded at depth 3; raise to peel a layer):
{
  " "openapi"
  " "3.0.1"
  " "info"
  {
    " "title"
    " "Transport Service"
    " "description"
    " "T-ONE - Transport Service Integration Specification"
    " "version"
    " "1.0"
    " "contact"
    { … 8 … }
  }
  " "paths"
  {
    " "/api/v1/transports/{id}/currentinstruction"
    { … 511 … }
    " "/api/v1/transports"
    { … 2028 … }
    " "/api/v1/transports/{id}"
    { … 1865 … }
  }
  " "components"
  {
    " "schemas"
    { … 1931 … }
    " "securitySchemes"
    { … 81 … }
    " "responses"
    { … 526 … }
    " "parameters"
    { … 121 … }
  }
  " "tags"
  [
    { … 15 … }
    { … 15 … }
  ]
  " "servers"
  [
    { … 15 … }
  ]
  " "security"
  [
    { … 14 … }
  ]
}
```

## Zooming in with tfind.js

`--outline` folds by depth; `tfind.js` zooms by content — useful once you
know which field you're after but not which endpoint/schema it lives in.
Tried across all 5 specs:

### Event Service API.json — `ProblemDetails`

`node tfind.js -u 3 "ProblemDetails" "Event Service API.json"` — the
default (nearest labelled ancestor) is just the bare `$ref` wrapper, since
`schema` is itself a JSON key; `-u 3` widens the zoom out to the full
response block:

```
4 match(es) for "ProblemDetails"

── token 199: "#/components/schemas/ProblemDetails" ──
breadcrumb (innermost first): schema <- application/problem+json <- content <- 400 <- responses <- post <- /api/v1/event:raise <- paths <- #0
zoomed to labelled ancestor #4 (0 = nearest) ("400", tokens 168..273):

{
            "description": "Bad Request",
            "content": {
              "application/problem+json": {
                "schema": {
                  "$ref": "#/components/schemas/ProblemDetails"
                },
                "examples": {
                  "Forgot to set a required property": {
                    "value": {
                      "type": "https://tools.ietf.org/html/rfc9110#section-15.5.1",
                      "title": "Bad Request",
                      "status": 400,
                      "detail": "Values for ExampleProperty2 are required.",
                      "traceId": "00-98e1a02ebc3d6baa275dc8c16afc5723-3fbdb7e513b9895-00"
                    }
                  }
                }
              }
            }
          }

── token 311: "#/components/schemas/ProblemDetails" ──
breadcrumb (innermost first): schema <- application/problem+json <- content <- 403 <- responses <- post <- /api/v1/event:raise <- paths <- #0
zoomed to labelled ancestor #4 (0 = nearest) ("403", tokens 280..385):

{
            "description": "Forbidden",
            "content": {
              "application/problem+json": {
                "schema": {
                  "$ref": "#/components/schemas/ProblemDetails"
                },
                 "examples": {
                    "Forbidden": {
                      "value": {
                        "type": "https://tools.ietf.org/html/rfc7231#section-6.5.3",
                        "title": "Forbidden",
                        "status": 403,
                        "detail": "The user does not have permission to raise this (internal) event.",
                        "traceId": "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"
                      }
                    }
            }
              }
            }
          }

── token 423: "#/components/schemas/ProblemDetails" ──
breadcrumb (innermost first): schema <- application/problem+json <- content <- 404 <- responses <- post <- /api/v1/event:raise <- paths <- #0
zoomed to labelled ancestor #4 (0 = nearest) ("404", tokens 392..497):

{
            "description": "Not Found",
            "content": {
              "application/problem+json": {
                "schema": {
                  "$ref": "#/components/schemas/ProblemDetails"
                },
                "examples": {
                  "Event definition not found": {
                    "value": {
                      "type": "https://tools.ietf.org/html/rfc9110#section-15.5.1",
                      "title": "Bad Request",
                      "status": 400,
                      "detail": "Could not find event definition named \"EventDefDoesNotExist\".",
                      "traceId": "00-98e1a02ebc3d6baa275dc8c16afc5723-3fbdb7e513b9895-00"
                    }
                  }
                }
              }
            }
          }

── token 699: "ProblemDetails" ──
breadcrumb (innermost first): schemas <- components <- #0
(only 2 labelled ancestor(s) — --up 3 goes past the root)
```

Four matches: three responses (400/403/404) referencing the schema, plus the
schema definition itself (which has too few labelled ancestors for `-u 3`
to reach — the tool says so rather than guessing).

### External Service.json — `sourceType`

`node tfind.js -c "sourceType" "External Service.json"` (breadcrumb only) —
one field, found where it's DEFINED and where it's USED, with no manual
cross-referencing:

```
4 match(es) for "sourceType"

── token 418: "sourceType" ──
breadcrumb (innermost first): properties <- Event <- schemas <- components <- #0

── token 521: "sourceType" ──
breadcrumb (innermost first): required <- Event <- schemas <- components <- #0

── token 665: "sourceType" ──
breadcrumb (innermost first): value <- Verification-Example <- examples <- components <- #0

── token 704: "sourceType" ──
breadcrumb (innermost first): value <- Transport-State-Updated <- examples <- components <- #0
```

Defined once in the `Event` schema's `properties` (and its `required`
array), then used in *both* named examples — the breadcrumb makes that
obvious without opening either example by hand.

### Notification Service API.json — `credentials`

`node tfind.js -c "credentials" "Notification Service API.json"`:

```
8 match(es) for "credentials"

── token 213: "credentials" ──
breadcrumb (innermost first): authentication <- #183 <- value <- Existing subscription for transport events <- examples <- application/json <- content <- 200 <- responses <- get <- /api/v1/subscriptions <- paths <- #0

── token 476: "credentials" ──
breadcrumb (innermost first): authentication <- value <- Subscription for transport events <- examples <- application/json <- content <- 201 <- responses <- post <- /api/v1/subscriptions <- paths <- #0

── token 919: "credentials" ──
breadcrumb (innermost first): authentication <- value <- Subscribe for transport events <- examples <- application/json <- content <- requestBody <- post <- /api/v1/subscriptions <- paths <- #0

── token 1184: "credentials" ──
breadcrumb (innermost first): authentication <- value <- Transport event subscription <- examples <- application/json <- content <- 200 <- responses <- get <- /api/v1/subscriptions/{id} <- paths <- #0

── token 1467: "credentials" ──
breadcrumb (innermost first): authentication <- value <- Subscription after update <- examples <- application/json <- content <- 200 <- responses <- patch <- /api/v1/subscriptions/{id} <- paths <- #0

── token 1837: "credentials" ──
breadcrumb (innermost first): value <- #1814 <- value <- Change endpoint and authentication <- examples <- application/json-patch+json <- content <- requestBody <- patch <- /api/v1/subscriptions/{id} <- paths <- #0

── token 3015: "credentials" ──
breadcrumb (innermost first): properties <- authentication <- properties <- Subscription <- schemas <- components <- #0

── token 3040: "credentials" ──
breadcrumb (innermost first): required <- authentication <- properties <- Subscription <- schemas <- components <- #0
```

Every operation on `/api/v1/subscriptions*` that mentions credentials, in
one screen — GET/POST/PATCH examples plus the schema definition — instead
of opening five separate JSON regions by hand.

### Transport Service API.json — `abortRequested`

`node tfind.js -c "abortRequested" "Transport Service API.json"`:

```
5 match(es) for "abortRequested"

── token 1663: "abortRequested" ──
breadcrumb (innermost first): #1380 <- value <- Array of transports <- examples <- application/json <- content <- 200 <- responses <- get <- /api/v1/transports <- paths <- #0

── token 2348: "abortRequested" ──
breadcrumb (innermost first): value <- The newly created transport <- examples <- application/json <- content <- 201 <- responses <- post <- /api/v1/transports <- paths <- #0

── token 3066: "abortRequested" ──
breadcrumb (innermost first): value <- Transport Information <- examples <- application/json <- content <- 200 <- responses <- get <- /api/v1/transports/{id} <- paths <- #0

── token 3795: "abortRequested" ──
breadcrumb (innermost first): value <- The transport after the update <- examples <- application/json <- content <- 200 <- responses <- patch <- /api/v1/transports/{id} <- paths <- #0

── token 5818: "abortRequested" ──
breadcrumb (innermost first): properties <- Transport <- schemas <- components <- #0
```

Same pattern as Inventory's `Location A` search from earlier in this
project's exploration: a field shows up in every example across every
operation on a resource, plus its one schema definition — `tfind.js` lists
all of them without depth-peeling through each endpoint in turn.
