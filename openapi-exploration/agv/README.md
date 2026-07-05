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
