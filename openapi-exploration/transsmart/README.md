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
open shows 9 top-level sections and ~40 requests, matching the endpoint
list on [devdocs.transsmart.com](https://devdocs.transsmart.com/#_integration_endpoints)
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
