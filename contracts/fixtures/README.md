# Contract fixtures

Example responses for `../openapi.yaml`, using fictional people only.

- `apps/api/test/contract.test.ts` validates every fixture against the schema
  and validates live API responses against the same schemas.
- `apps/mobile/test/contracts/` parses each fixture into the Dart DTOs and
  checks that serializing them reproduces the fixture exactly.

When a response shape changes, update the schema, the fixture and the Dart DTO
together; the tests on both sides fail until they agree.
